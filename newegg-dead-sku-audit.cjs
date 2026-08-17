#!/usr/bin/env node
/**
 * newegg-dead-sku-audit.cjs — READ-ONLY census of every Newegg link in the catalog.
 *
 * Answers, for all 2,666 `deals.newegg` rows (plus the 60 open-box and 37
 * marketplace deals): does Newegg still carry this sku, and can it be bought?
 * This is the Newegg counterpart of bestbuy-dead-sku-audit.mjs, and it matters
 * more: 1,725 of those rows have NO other priced retailer, so Newegg's health
 * decides whether they are a catalog or a list of dead links.
 *
 * WHY THE FEED AND NOT THE SEARCH API
 * refresh-newegg-prices.cjs resolves by name/UPC through Rakuten product search.
 * A miss there is a MATCHER outcome (`no_results`, `variant_rejected`), not
 * evidence the sku is gone — the script says so itself and refuses to delete on
 * it. The product catalog feed is different: it is Newegg's own enumeration of
 * what it sells, keyed by the same item numbers the catalog stores, and it
 * carries `is_deleted` and `availability` per row. Absence from the full feed is
 * the closest thing to Best Buy's 404 that exists here.
 *
 * DISCIPLINE (same as the Best Buy census)
 *   - TWO STRIKES before any death verdict. A sku missing from one feed pull is
 *     `pending`, never `dead`. See the snapshot guard below — a second strike
 *     must come from a DIFFERENT feed snapshot, or it is the same observation
 *     counted twice.
 *   - UNKNOWN is never counted as dead. If a feed we needed did not stream to
 *     completion, every sku that feed could have carried is UNKNOWN, and the run
 *     exits 1 rather than publishing a census with holes in it.
 *   - READ-ONLY. Writes catalog-build/newegg-dead-sku-audit{,-state}.json and
 *     the downloaded feeds, all of which .gitignore excludes. Never parts.js.
 *
 * STREAMING
 * Uses streamTxtFeed() from sftp-ingest.cjs — the fixed parser, unmodified and
 * shared rather than copied, so this audit cannot drift from the ingest and
 * cannot resurrect the OOM. That parser hands over one record at a time; peak
 * heap here is the target index (~2,800 skus) plus one record, flat in feed
 * size. The MKPL feed is 886MB gzipped and several million rows; nothing about
 * this job needs it resident.
 *
 * Run (Actions only — RAKUTEN_FTP_PASSWORD is a repo secret):
 *   node newegg-dead-sku-audit.cjs [--prev <state.json>] [--skip-download]
 */

const fs = require('fs');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');
const { streamTxtFeed } = require('./sftp-ingest.cjs');

const ROOT = __dirname;
const FEED_DIR = path.join(ROOT, 'catalog-build', 'feeds');
const OUT = path.join(ROOT, 'catalog-build', 'newegg-dead-sku-audit.json');
const STATE_OUT = path.join(ROOT, 'catalog-build', 'newegg-dead-sku-audit-state.json');

const FTP_HOST = process.env.RAKUTEN_FTP_HOST || 'aftp.linksynergy.com';
const FTP_USER = process.env.RAKUTEN_FTP_USER || 'rkp_4681679';
const FTP_PASS = process.env.RAKUTEN_FTP_PASSWORD;
const NEWEGG_MID = process.env.RAKUTEN_NEWEGG_MID || '44583';

const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const PREV_PATH = argOf('--prev');
const SKIP_DOWNLOAD = argv.includes('--skip-download');
const LOCAL_FEEDS = (argOf('--local-feed') || '').split(',').filter(Boolean);
const UNKNOWN_FAIL_PCT = 5;   // same completeness gate as the Best Buy census

const bar = '─'.repeat(96);
const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : '—');
const log = (m) => console.log(`[${new Date().toISOString().substring(11, 19)}] ${m}`);
const nkey = (s) => String(s || '').trim().toUpperCase();

// The walk roots sftp-ingest uses. The MKPL feed is NOT at the root — assuming
// it was is what killed feed-overlap-audit run 31440517417 ("NoSuchKey") after
// it had already spent 11 minutes streaming the main feed. Discover, do not guess.
const WALK_ROOTS = ['/', '/ADDITIONAL', '/GLOBAL/EN-US_USD'];
const SKIP_DIRS = new Set(['/GLOBAL']);
// Full product catalogs only. A _delta feed carries CHANGES, so a sku's absence
// from one means nothing at all — feeding deltas to an absence test would
// condemn the entire catalog on the first run.
const FULL_CATALOG_RE = /^(\d+)_\d+_mp(_MKPL)?\.(txt|xml)\.gz$/i;

// ── Pure decision logic ───────────────────────────────────────────────────
// Extracted and exported so the rules that can condemn a row are testable
// without an SFTP endpoint. test/newegg-dead-sku-audit.test.js covers these.

// Least-condemning-wins ordering for a sku sighted more than once. `undefined`
// (never sighted) ranks below every real sighting.
const SIGHTING_RANK = { undefined: -1, null: -1, deleted: 1, unbuyable: 2, alive: 3 };

/** What one feed sighting of a catalog sku means. */
function classifySighting(rec) {
  const deleted = /^(1|true|yes|deleted)$/i.test((rec.is_deleted || '').trim());
  if (deleted) return 'deleted';
  // Newegg's availability strings are free text ("in-stock", "out-of-stock",
  // "backordered", ""). Only an explicit in-stock reads as buyable; everything
  // else — including empty — is unbuyable, never dead. Being listed at all is
  // proof the sku exists, which is the whole difference from absence.
  return /in-?stock/i.test((rec.availability || '').trim()) ? 'alive' : 'unbuyable';
}

/**
 * Two-strike gate. `gone` is absence-from-feed or is_deleted.
 * `sameSnapshot` means this run streamed a byte-identical feed to the last one:
 * re-reading the same file is one observation, not two, so the strike is held.
 */
function strikeVerdict({ gone, prevN = 0, sameSnapshot = false }) {
  if (!gone) return { n: 0, verdict: null };
  const n = sameSnapshot ? Math.max(prevN, 1) : prevN + 1;
  return { n, verdict: n >= 2 ? 'dead' : 'pending' };
}

async function discoverFeeds(sftp) {
  const found = [];
  const queue = [...WALK_ROOTS];
  const seen = new Set();
  while (queue.length) {
    const dir = queue.shift();
    if (seen.has(dir) || SKIP_DIRS.has(dir)) continue;
    seen.add(dir);
    let entries;
    try { entries = await sftp.list(dir); }
    catch (e) { log(`  cannot list ${dir}: ${e.message}`); continue; }
    for (const entry of entries) {
      const full = (dir === '/' ? '' : dir) + '/' + entry.name;
      if (entry.type === 'd') { if (!SKIP_DIRS.has(full)) queue.push(full); continue; }
      if (entry.type !== '-') continue;
      if (/_template|_deltatemplate/i.test(entry.name)) continue;
      const m = FULL_CATALOG_RE.exec(entry.name);
      if (!m || m[1] !== NEWEGG_MID) continue;
      if (/\.xml\.gz$/i.test(entry.name)) continue;   // parser is pipe-delimited
      found.push({
        remote: full, name: entry.name,
        kind: m[2] ? 'MKPL' : 'mp',
        size: entry.size, mtime: entry.modifyTime,
      });
    }
  }
  return found;
}

// Exported before the entrypoint so `require()` can reach the decision rules
// without connecting to SFTP or reading the catalog.
module.exports = { classifySighting, strikeVerdict, SIGHTING_RANK, FULL_CATALOG_RE };

if (require.main === module) (async () => {
  if (!FTP_PASS && !LOCAL_FEEDS.length) {
    console.error('ERROR: RAKUTEN_FTP_PASSWORD required (repo secret; Actions only), or --local-feed <path>.');
    process.exit(1);
  }

  // ── Targets ─────────────────────────────────────────────────────────────
  const mod = await import('file://' + path.join(ROOT, 'src', 'data', 'parts.js').replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = mod.PARTS || mod.default;
  if (!Array.isArray(parts)) { console.error('parts.js did not export PARTS'); process.exit(1); }

  const DEAL_KEYS = ['newegg', 'newegg_openbox', 'newegg_marketplace'];
  const OTHER_KEYS = ['amazon', 'bestbuy', 'msi'];
  const isPriced = (d) => !!d && ((typeof d.price === 'number' && d.price > 0) || (typeof d.saleprice === 'number' && d.saleprice > 0));

  const rows = [];          // one entry per Newegg-family DEAL
  const wanted = new Map(); // feed key (sku or item number) -> [row, ...]
  for (const p of parts) {
    for (const dk of DEAL_KEYS) {
      const d = p.deals && p.deals[dk];
      if (!d || typeof d !== 'object') continue;
      const sku = nkey(d.sku);
      const item = nkey(d.itemNumber);
      if (!sku && !item) continue;
      // "Orphaned" means: strip THIS Newegg deal and nothing priced is left.
      // Sibling Newegg deals count as survivors here; the roll-up below reports
      // the row-level view where every Newegg link on the row is discounted.
      const siblings = DEAL_KEYS.filter((k) => k !== dk && isPriced(p.deals[k]));
      const others = OTHER_KEYS.filter((k) => isPriced(p.deals[k]));
      const row = {
        id: p.id, name: p.n, cat: p.c, dealKey: dk, sku: sku || null, itemNumber: item || null,
        sellerClass: d.sellerClass || null,
        stored: (typeof d.saleprice === 'number' && d.saleprice > 0) ? d.saleprice
              : (typeof d.price === 'number' && d.price > 0) ? d.price : null,
        quarantined: p.needsReview === true,
        otherRetailers: others, neweggSiblings: siblings,
        status: null, feed: null, availability: null, isDeleted: null,
      };
      rows.push(row);
      for (const k of [sku, item]) {
        if (!k) continue;
        if (!wanted.has(k)) wanted.set(k, []);
        wanted.get(k).push(row);
      }
    }
  }
  const byId = new Map(parts.map((p) => [p.id, p]));
  console.log(`Catalog: ${parts.length} products → ${rows.length} Newegg deals ` +
    `(${rows.filter(r => r.dealKey === 'newegg').length} newegg, ` +
    `${rows.filter(r => r.dealKey === 'newegg_openbox').length} open-box, ` +
    `${rows.filter(r => r.dealKey === 'newegg_marketplace').length} marketplace) ` +
    `→ ${wanted.size} distinct feed keys to look for`);

  // ── Previous state (two-strike) ─────────────────────────────────────────
  let prev = { streak: {}, feeds: {} };
  if (PREV_PATH && fs.existsSync(PREV_PATH)) {
    try {
      prev = JSON.parse(fs.readFileSync(PREV_PATH, 'utf8'));
      prev.streak = prev.streak || {};
      prev.feeds = prev.feeds || {};
      console.log(`Prior state: ${Object.keys(prev.streak).length} sku(s) carrying a strike, ` +
        `from run at ${prev.updatedAt || '(unknown time)'}`);
    } catch (e) {
      console.log(`Prior state unreadable (${e.message}) — starting clean; nothing can reach two strikes this run.`);
      prev = { streak: {}, feeds: {} };
    }
  } else {
    console.log('No prior state supplied — this is a first strike run. Nothing will be declared dead.');
  }

  // ── Feeds ───────────────────────────────────────────────────────────────
  fs.mkdirSync(path.join(FEED_DIR, NEWEGG_MID), { recursive: true });
  const feeds = [];
  let discovered = [];

  // --local-feed re-parses feed files already on disk and never opens a socket.
  // Same parser, same verdicts; it exists so the matching path can be exercised
  // without the SFTP secret, and so a downloaded feed can be re-read for free.
  if (LOCAL_FEEDS.length) {
    for (const p of LOCAL_FEEDS) {
      const st = fs.statSync(p);
      feeds.push({
        remote: '(local)', name: path.basename(p), kind: /_MKPL\./i.test(p) ? 'MKPL' : 'mp',
        size: st.size, mtime: st.mtimeMs, local: p,
      });
      log(`  local feed ${p} (${(st.size / 1048576).toFixed(1)}MB)`);
    }
  } else {
  const sftp = new SftpClient();
  try {
    await sftp.connect({ host: FTP_HOST, port: 22, username: FTP_USER, password: FTP_PASS });
    log(`Connected to ${FTP_HOST} as ${FTP_USER}`);
    discovered = await discoverFeeds(sftp);
    if (!discovered.length) throw new Error(`no full-catalog feed found for MID ${NEWEGG_MID} under ${WALK_ROOTS.join(', ')}`);
    for (const f of discovered) {
      log(`  found ${f.kind.padEnd(4)} ${f.remote} (${(f.size / 1048576).toFixed(0)}MB, mtime ${new Date(f.mtime).toISOString()})`);
    }
    for (const f of discovered) {
      const local = path.join(FEED_DIR, NEWEGG_MID, f.name);
      if (SKIP_DOWNLOAD && fs.existsSync(local)) {
        log(`  ⏭  ${f.name} (--skip-download, using local copy)`);
      } else {
        const t0 = Date.now();
        // Sequential streaming get(), not fastGet() — this endpoint throttles
        // parallel range reads to under 64KB/s (see sftp-ingest.cjs).
        await sftp.get(f.remote, local);
        log(`  ⬇  ${f.name} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
      feeds.push({ ...f, local });
    }
  } finally {
    try { await sftp.end(); } catch { /* the census does not care how the socket ended */ }
  }
  }

  // ── Stream ──────────────────────────────────────────────────────────────
  // One record at a time via the ingest's own parser. A record is dropped the
  // instant it has been checked against `wanted`.
  const feedStats = [];
  const availabilityMix = {};
  let brokenFeed = null;
  for (const f of feeds) {
    log(`Streaming ${f.name}…`);
    let hits = 0, scanned = 0;
    let res;
    try {
      res = await streamTxtFeed(f.local, (rec) => {
        scanned++;
        if (scanned % 500000 === 0) log(`  …${scanned} records, ${hits} catalog skus seen`);
        const hitRows = wanted.get(nkey(rec.sku)) || wanted.get(nkey(rec.newegg_item_number));
        if (!hitRows) return;
        const deleted = /^(1|true|yes|deleted)$/i.test(rec.is_deleted || '');
        const avail = (rec.availability || '').trim();
        availabilityMix[avail || '(empty)'] = (availabilityMix[avail || '(empty)'] || 0) + 1;
        const sighting = classifySighting(rec);
        for (const row of hitRows) {
          // A sku can appear in both feeds, and in more than one row of one feed.
          // Keep the least condemning sighting: one feed saying in-stock settles
          // "can this be bought", and a `deleted` row must not override another
          // feed that still lists the sku as merely out of stock.
          if (SIGHTING_RANK[sighting] <= SIGHTING_RANK[row.status]) continue;
          hits++;
          row.feed = f.kind;
          row.isDeleted = deleted;
          row.availability = avail || null;
          row.feedPrice = parseFloat(rec.sale_price) || parseFloat(rec.retail_price) || null;
          row.status = sighting;
        }
      });
    } catch (e) {
      brokenFeed = `${f.name}: ${e.message}`;
      log(`  ✗ ${f.name} failed mid-stream: ${e.message}`);
      feedStats.push({ ...f, ok: false, error: e.message });
      break;
    }
    // Truncation guard. The feed's own TRL trailer states the record count; a
    // short read that ends cleanly would otherwise read as "these skus are gone".
    const truncated = res.trailerCount != null && res.trailerCount !== res.recordCount;
    if (truncated) {
      brokenFeed = `${f.name}: trailer says ${res.trailerCount} records, parsed ${res.recordCount}`;
      log(`  ✗ ${f.name} TRUNCATED — ${brokenFeed}`);
      feedStats.push({ ...f, ok: false, error: brokenFeed, recordCount: res.recordCount, trailerCount: res.trailerCount });
      break;
    }
    log(`  done: ${res.recordCount} records (trailer ${res.trailerCount ?? 'absent'}), ${hits} catalog sightings`);
    feedStats.push({ ...f, ok: true, recordCount: res.recordCount, trailerCount: res.trailerCount });
  }

  // ── Verdicts ────────────────────────────────────────────────────────────
  // If any feed failed, we cannot tell "absent" from "not looked at". Every
  // unseen sku becomes UNKNOWN — never dead.
  const feedsOk = !brokenFeed;
  const snapshotId = feedStats.filter((f) => f.ok).map((f) => `${f.name}@${f.mtime}:${f.size}`).sort().join('|');
  const sameSnapshotAsLastRun = !!prev.snapshotId && prev.snapshotId === snapshotId;

  const streak = {};
  for (const row of rows) {
    if (!row.status) row.status = feedsOk ? 'absent' : 'unknown';
    const gone = row.status === 'absent' || row.status === 'deleted';
    const key = row.sku || row.itemNumber;
    if (!gone) continue;
    const { n, verdict } = strikeVerdict({
      gone: true,
      prevN: prev.streak[key]?.n || 0,
      sameSnapshot: sameSnapshotAsLastRun,
    });
    streak[key] = { n, firstGoneAt: prev.streak[key]?.firstGoneAt || new Date().toISOString(), lastStatus: row.status };
    row.strikes = n;
    row.verdict = verdict;
  }
  for (const row of rows) {
    if (row.verdict) continue;
    row.verdict = row.status === 'unknown' ? 'unknown' : (row.status === 'unbuyable' ? 'unbuyable' : 'alive');
  }

  const dead = rows.filter((r) => r.verdict === 'dead');
  const pending = rows.filter((r) => r.verdict === 'pending');
  const unbuyable = rows.filter((r) => r.verdict === 'unbuyable');
  const alive = rows.filter((r) => r.verdict === 'alive');
  const unknown = rows.filter((r) => r.verdict === 'unknown');

  // Orphan = strip this deal and the ROW has nothing priced left. Computed at
  // row level so a product with two Newegg links is not counted as rescued by
  // its own second dead link.
  const condemnedIds = new Set([...dead, ...unbuyable].map((r) => r.id));
  const orphanRows = [];
  for (const id of condemnedIds) {
    const p = byId.get(id);
    if (!p) continue;
    const survivingNewegg = DEAL_KEYS.some((k) => {
      const d = p.deals[k];
      if (!isPriced(d)) return false;
      const r = rows.find((x) => x.id === id && x.dealKey === k);
      return r && (r.verdict === 'alive' || r.verdict === 'pending' || r.verdict === 'unknown');
    });
    const other = OTHER_KEYS.some((k) => isPriced(p.deals[k]));
    if (!survivingNewegg && !other) orphanRows.push({ id, name: p.n, cat: p.c, quarantined: p.needsReview === true });
  }

  const byCat = {};
  for (const r of rows) {
    const k = r.cat || '(none)';
    byCat[k] = byCat[k] || { total: 0, dead: 0, pending: 0, unbuyable: 0, alive: 0, unknown: 0 };
    byCat[k].total++;
    byCat[k][r.verdict]++;
  }

  // ── Report ──────────────────────────────────────────────────────────────
  console.log(bar);
  console.log('RESULT — Newegg link census');
  console.log(bar);
  console.log(`  deals checked .............. ${rows.length}`);
  console.log(`  DEAD (gone, 2+ strikes) .... ${dead.length}  (${pct(dead.length, rows.length)})   <- absent from the full feed, or is_deleted`);
  console.log(`  pending (1 strike) ......... ${pending.length}  <- gone this run only; NOT dead until a second, different feed snapshot agrees`);
  console.log(`  unbuyable (in feed) ........ ${unbuyable.length}  (${pct(unbuyable.length, rows.length)})   <- listed, not in stock`);
  console.log(`  alive and buyable .......... ${alive.length}  (${pct(alive.length, rows.length)})`);
  console.log(`  UNKNOWN (feed failure) ..... ${unknown.length}  <- never counted as dead`);
  console.log('');
  console.log(`  orphaned rows (dead/unbuyable Newegg link and nothing else priced): ${orphanRows.length}`);
  console.log(`    of which already quarantined: ${orphanRows.filter((o) => o.quarantined).length}`);
  console.log('');
  console.log('  availability values seen on catalog skus:');
  Object.entries(availabilityMix).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([k, v]) => console.log(`    ${k.padEnd(24)} ${v}`));
  console.log('');
  console.log('  by category (dead / pending / unbuyable / total):');
  Object.entries(byCat).sort((a, b) => (b[1].dead + b[1].pending + b[1].unbuyable) - (a[1].dead + a[1].pending + a[1].unbuyable))
    .forEach(([k, v]) => console.log(`    ${k.padEnd(18)} ${String(v.dead).padStart(5)} ${String(v.pending).padStart(6)} ${String(v.unbuyable).padStart(6)} ${String(v.total).padStart(7)}`));
  if (sameSnapshotAsLastRun) {
    console.log('');
    console.log('  NOTE: the feed snapshot is byte-identical to the previous run. No strike was');
    console.log('        advanced — re-running against the same file is not a second opinion.');
  }

  // ── Write ───────────────────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    auditedAt: new Date().toISOString(),
    readOnly: true,
    scope: { products: parts.length, deals: rows.length, distinctKeys: wanted.size, mid: NEWEGG_MID },
    feeds: feedStats.map(({ local, ...f }) => f),
    feedsComplete: feedsOk,
    brokenFeed,
    sameSnapshotAsLastRun,
    summary: {
      dead: dead.length, pending: pending.length, unbuyable: unbuyable.length,
      alive: alive.length, unknown: unknown.length,
      orphaned: orphanRows.length,
      orphanedAlreadyQuarantined: orphanRows.filter((o) => o.quarantined).length,
      byCat, availabilityMix,
    },
    deadIds: [...new Set(dead.map((r) => r.id))],
    pendingIds: [...new Set(pending.map((r) => r.id))],
    unbuyableIds: [...new Set(unbuyable.map((r) => r.id))],
    orphanRows,
    rows,
  }, null, 2));
  fs.writeFileSync(STATE_OUT, JSON.stringify({
    updatedAt: new Date().toISOString(),
    snapshotId,
    feeds: feedStats.map((f) => ({ name: f.name, kind: f.kind, size: f.size, mtime: f.mtime, ok: !!f.ok })),
    streak,
  }, null, 2));
  console.log(`\nReport -> ${path.relative(ROOT, OUT)}`);
  console.log(`State  -> ${path.relative(ROOT, STATE_OUT)}  (feed the next run with --prev)`);

  // ── Job summary ─────────────────────────────────────────────────────────
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [];
    md.push('## Newegg link census (read-only)\n');
    md.push(`Feeds streamed: ${feedStats.map((f) => `\`${f.name}\` (${f.ok ? `${f.recordCount} records` : `FAILED: ${f.error}`})`).join(', ')}\n`);
    md.push('| Verdict | Deals | Share |');
    md.push('| --- | --: | --: |');
    md.push(`| **DEAD** — gone from the feed, 2+ strikes | **${dead.length}** | ${pct(dead.length, rows.length)} |`);
    md.push(`| pending — gone once, awaiting a second snapshot | ${pending.length} | ${pct(pending.length, rows.length)} |`);
    md.push(`| **unbuyable** — listed, not in stock | **${unbuyable.length}** | ${pct(unbuyable.length, rows.length)} |`);
    md.push(`| alive and buyable | ${alive.length} | ${pct(alive.length, rows.length)} |`);
    md.push(`| UNKNOWN — feed failure, never counted as dead | ${unknown.length} | ${pct(unknown.length, rows.length)} |`);
    md.push(`\n**Orphaned rows** (dead/unbuyable Newegg link and nothing else priced): **${orphanRows.length}**` +
      ` — ${orphanRows.filter((o) => o.quarantined).length} already quarantined\n`);
    if (!feedsOk) md.push(`\n> **Incomplete census.** ${brokenFeed}. Every unseen sku is UNKNOWN, not dead.\n`);
    if (sameSnapshotAsLastRun) md.push('\n> Feed snapshot identical to the previous run — no strike advanced.\n');
    fs.writeFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n', { flag: 'a' });
  }

  // ── Completeness gate ───────────────────────────────────────────────────
  if (!feedsOk) {
    console.error(`\n✗ INCOMPLETE: ${brokenFeed}`);
    console.error('  Every sku that feed could have carried is UNKNOWN. Nothing here is a death verdict.');
    process.exit(1);
  }
  if (unknown.length / rows.length > UNKNOWN_FAIL_PCT / 100) {
    console.error(`\n✗ ${unknown.length} of ${rows.length} deals (${pct(unknown.length, rows.length)}) are UNKNOWN — over the ${UNKNOWN_FAIL_PCT}% ceiling.`);
    process.exit(1);
  }
  console.log('\n✓ Census complete. Nothing was written outside catalog-build/.');
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
