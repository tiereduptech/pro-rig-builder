#!/usr/bin/env node
// =============================================================================
//  deploy/sftp-deploy.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Uploads dist/ to Epik shared cPanel over SFTP. Designed to be SAFE TO
//  INTERRUPT and to FAIL LOUDLY — a half-upload must never report green.
//
//  SAFE TO INTERRUPT — ordering, not swapping:
//    Vite content-hashes every asset (App-<hash>.js). New and old assets have
//    DIFFERENT filenames, so they coexist; nothing is overwritten in place. We
//    upload in phases:
//      A) everything that is NOT a page (hashed assets, images, .php, .htaccess,
//         sitemap/robots/llms, gone.html) — additive, referenced by nothing new
//      B) the page HTML (index.html + the 5,516 product/route pages) — each
//         references only already-uploaded hashed assets
//      C) .deploy-manifest.json — the commit marker, written ONLY after verify
//    At ANY interruption point, every page already on the server references
//    assets already on the server. No staging-dir swap, no docroot-missing gap.
//    (A --prune pass to remove orphaned old assets is OPT-IN and runs last.)
//
//  FAIL LOUDLY:
//    After upload we stat EVERY file in the manifest on the server, assert the
//    size matches, assert the remote count equals the local count, and assert
//    every asset referenced by index.html is present. Any shortfall throws and
//    exits non-zero BEFORE the manifest marker is written and BEFORE the caller
//    can print success. The manifest is only updated on a fully verified deploy,
//    so an interrupted run simply re-uploads the same delta next time.
//
//  Usage:
//    node deploy/sftp-deploy.cjs            # incremental (changed files only)
//    node deploy/sftp-deploy.cjs --full     # ignore remote manifest, upload all
//    node deploy/sftp-deploy.cjs --prune    # also delete orphaned remote files
// =============================================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SftpClient = require('ssh2-sftp-client');

const DIST = path.join(__dirname, '..', 'dist');
const LOCK = '.deploy-lock';
const MANIFEST = '.deploy-manifest.json';
const LOCK_STALE_MS = 30 * 60 * 1000; // a lock older than this is treated as abandoned

function die(msg, code = 1) { console.error(`  ✗ ${msg}`); process.exit(code); }
function reqEnv(name) { const v = process.env[name]; if (!v) die(`missing required env ${name}`, 2); return v; }

// ── Config (fail loudly on anything missing — same lesson as the PA API bug) ──
const HOST = reqEnv('EPIK_SFTP_HOST');
const PORT = parseInt(process.env.EPIK_SFTP_PORT || '22', 10);
const USER = reqEnv('EPIK_SFTP_USER');
const REMOTE_ROOT = reqEnv('EPIK_REMOTE_ROOT').replace(/\/+$/, '');
const KEY = process.env.EPIK_SFTP_PRIVATE_KEY;
const PASS = process.env.EPIK_SFTP_PASSWORD;
if (!KEY && !PASS) die('need EPIK_SFTP_PRIVATE_KEY or EPIK_SFTP_PASSWORD', 2);
const CONC = Math.max(1, parseInt(process.env.EPIK_UPLOAD_CONCURRENCY || '4', 10));
const FULL = process.argv.includes('--full');
const PRUNE = process.argv.includes('--prune');
const RUN_ID = process.env.GITHUB_RUN_ID || `local-${process.pid}`;

const connectOpts = {
  host: HOST, port: PORT, username: USER, readyTimeout: 30000,
  ...(KEY ? { privateKey: KEY, passphrase: process.env.EPIK_SFTP_PASSPHRASE } : { password: PASS }),
};
const R = (rel) => `${REMOTE_ROOT}/${rel}`;

// ── Local manifest: every file under dist/, with size + content hash ──────────
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) walk(fp, base, out);
    else out.push(path.relative(base, fp).split(path.sep).join('/'));
  }
  return out;
}
function sha256(fp) { return crypto.createHash('sha256').update(fs.readFileSync(fp)).digest('hex'); }

if (!fs.existsSync(DIST)) die(`dist/ not found at ${DIST} — build first`);
const files = walk(DIST).filter((f) => f !== MANIFEST); // never track the marker itself
const manifest = {};
for (const rel of files) {
  const st = fs.statSync(path.join(DIST, rel));
  manifest[rel] = { size: st.size, sha: sha256(path.join(DIST, rel)) };
}

// A page = HTML that references hashed assets (everything except the gone shell).
const isPage = (rel) => rel.endsWith('.html') && rel !== 'gone.html';
const phaseA = files.filter((f) => !isPage(f)); // assets + infra + gone.html
const phaseB = files.filter(isPage);            // index.html + product/route pages

// Concurrency pool across N independent connections (one connection can't do
// reliable parallel writes; shared cPanel typically allows a handful).
async function pool(items, clients, worker) {
  let i = 0;
  await Promise.all(clients.map(async (client) => {
    while (i < items.length) { const idx = i++; await worker(items[idx], client, idx); }
  }));
}

(async () => {
  const primary = new SftpClient('primary');
  const clients = [];
  let uploadedA = 0, uploadedB = 0, skipped = 0;
  try {
    await primary.connect(connectOpts);

    // ── Lock: refuse to overlap with another in-flight deploy ──────────────
    if (await primary.exists(R(LOCK))) {
      const st = await primary.stat(R(LOCK));
      const ageMs = Date.now() - st.modifyTime;
      if (ageMs < LOCK_STALE_MS) {
        die(`another deploy holds ${LOCK} (age ${Math.round(ageMs / 1000)}s). Refusing to overlap.`, 3);
      }
      console.log(`  ⚠ stale ${LOCK} (age ${Math.round(ageMs / 1000)}s) — taking over`);
    }
    await primary.put(Buffer.from(`run=${RUN_ID}\n`), R(LOCK));

    // ── Load remote manifest for incremental upload ────────────────────────
    let remote = {};
    if (!FULL) {
      try { remote = JSON.parse((await primary.get(R(MANIFEST))).toString()); }
      catch { console.log('  (no remote manifest — treating as full upload)'); }
    }
    const changed = (rel) => FULL || !remote[rel] || remote[rel].sha !== manifest[rel].sha;
    const toA = phaseA.filter(changed);
    const toB = phaseB.filter(changed);
    skipped = files.length - toA.length - toB.length;
    console.log(`  ${files.length} files: ${toA.length} infra/assets + ${toB.length} pages to upload, ${skipped} unchanged (skipped)`);

    // ── Ensure all remote directories exist (once, on primary) ─────────────
    const dirs = new Set();
    for (const rel of [...toA, ...toB]) {
      const d = path.posix.dirname(rel);
      if (d && d !== '.') dirs.add(d);
    }
    for (const d of [...dirs].sort()) {
      if (!(await primary.exists(R(d)))) await primary.mkdir(R(d), true);
    }

    // ── Open the connection pool ───────────────────────────────────────────
    for (let k = 0; k < CONC; k++) { const c = new SftpClient(`w${k}`); await c.connect(connectOpts); clients.push(c); }

    // ── PHASE A then PHASE B (barrier between: no page ships before its assets)
    await pool(toA, clients, async (rel, client) => { await client.fastPut(path.join(DIST, rel), R(rel)); uploadedA++; });
    await pool(toB, clients, async (rel, client) => { await client.fastPut(path.join(DIST, rel), R(rel)); uploadedB++; });

    // ── VERIFY LOUDLY before writing the manifest marker ───────────────────
    console.log('  verifying every file on the server…');
    const problems = [];
    let verified = 0;
    await pool(Object.keys(manifest), clients, async (rel, client) => {
      try {
        const st = await client.stat(R(rel));
        if (st.size !== manifest[rel].size) problems.push(`${rel}: size ${st.size} != ${manifest[rel].size}`);
        else verified++;
      } catch (e) { problems.push(`${rel}: MISSING on server (${e.code || e.message})`); }
    });

    // Direct guard for the exact failure we're avoiding: index.html referencing
    // an asset that isn't uploaded. Extract its asset refs and require each present.
    const indexHtml = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
    const refs = [...indexHtml.matchAll(/(?:src|href)="\/((?:assets|)[^"]+\.(?:js|css))"/g)].map((m) => m[1]);
    for (const ref of refs) {
      if (!(ref in manifest)) problems.push(`index.html references /${ref} which is not in the deploy set`);
    }

    if (verified !== Object.keys(manifest).length || problems.length) {
      console.error(`  ✗ VERIFICATION FAILED — ${verified}/${Object.keys(manifest).length} verified, ${problems.length} problem(s):`);
      for (const p of problems.slice(0, 25)) console.error(`      - ${p}`);
      if (problems.length > 25) console.error(`      … and ${problems.length - 25} more`);
      throw new Error('deploy verification failed — manifest NOT updated, site left in prior consistent state');
    }
    console.log(`  ✓ verified ${verified}/${Object.keys(manifest).length} files (${refs.length} index.html asset refs present)`);

    // ── COMMIT MARKER: manifest reflects a fully verified deploy only ───────
    await primary.put(Buffer.from(JSON.stringify(manifest)), R(MANIFEST));

    // ── OPT-IN prune of orphaned remote files (kept off by default so the old
    //    assets remain available for an instant HTML-only rollback) ──────────
    if (PRUNE) {
      const keep = new Set([...Object.keys(manifest), MANIFEST, LOCK]);
      let removed = 0;
      async function sweep(relDir) {
        const listing = await primary.list(R(relDir));
        for (const item of listing) {
          const rel = relDir ? `${relDir}/${item.name}` : item.name;
          if (item.type === 'd') await sweep(rel);
          else if (!keep.has(rel)) { await primary.delete(R(rel)); removed++; }
        }
      }
      await sweep('');
      console.log(`  ✓ prune: removed ${removed} orphaned remote file(s)`);
    }

    console.log(`\n  DEPLOY OK — uploaded ${uploadedA} infra/asset + ${uploadedB} page file(s), skipped ${skipped}, verified ${verified}.`);
  } catch (e) {
    die(`deploy failed: ${e.message}`);
  } finally {
    try { await primary.delete(R(LOCK)); } catch {}
    for (const c of clients) { try { await c.end(); } catch {} }
    try { await primary.end(); } catch {}
  }
})();
