// =============================================================================
//  verify-epik.cjs  —  Phase 3 parity harness for the Railway -> Epik migration.
//
//  Runs test/epik-fixture.json against one or more base URLs WITHOUT following
//  redirects, and prints a side-by-side table of expected vs actual status for
//  each stack. Any mismatch (status, Location on a 301, or an asserted header)
//  is a BLOCKER and makes the process exit non-zero.
//
//  Usage (Phase 3 — Railway vs staged Epik, side by side):
//    node test/verify-epik.cjs \
//      railway=https://prorigbuilder.com \
//      epik=https://prb-staging.tieroneshipping.com
//
//  A base is `name=url`. One base is fine (e.g. post-cutover re-check).
//
//  BASIC AUTH: staging sits behind HTTP Basic Auth. Set an env var named
//  <BASE>_BASIC_AUTH ("user:password") — e.g. EPIK_BASIC_AUTH for the `epik`
//  base — and this harness (a) confirms auth is ENFORCED (an unauthenticated
//  request to / returns 401) and (b) sends the credentials on every fixture
//  request so the status codes compare cleanly against un-authed Railway.
//  No external dependencies — Node http/https only.
// =============================================================================

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const bases = [];
for (const arg of process.argv.slice(2)) {
  const i = arg.indexOf('=');
  if (i === -1) { console.error(`  ✗ bad base arg (want name=url): ${arg}`); process.exit(2); }
  const name = arg.slice(0, i);
  // Optional per-base Basic Auth from env <NAME>_BASIC_AUTH ("user:password").
  const auth = process.env[`${name.toUpperCase()}_BASIC_AUTH`] || null;
  bases.push({ name, url: arg.slice(i + 1).replace(/\/$/, ''), auth });
}
if (!bases.length) {
  console.error('  usage: node test/verify-epik.cjs railway=https://prorigbuilder.com epik=https://staging...');
  process.exit(2);
}

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'epik-fixture.json'), 'utf8'));
const cases = fixture.cases;

function fetchNoRedirect(baseUrl, urlPath, auth) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(baseUrl + urlPath); } catch (e) { return resolve({ error: e.message }); }
    const mod = target.protocol === 'https:' ? https : http;
    const opts = { method: 'GET' };
    if (auth) opts.auth = auth; // Node sets the Authorization: Basic header
    const req = mod.request(target, opts, (res) => {
      // Drain and discard the body — we only need status + headers.
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }));
    });
    req.setTimeout(20000, () => { req.destroy(); resolve({ error: 'timeout' }); });
    req.on('error', (e) => resolve({ error: e.message }));
    req.end();
  });
}

// Evaluate one case against one base. Returns { ok, actual, reasons[] }.
function evaluate(c, r) {
  const reasons = [];
  if (r.error) return { ok: false, actual: `ERR:${r.error}`, reasons: [r.error] };
  if (r.status !== c.status) reasons.push(`status ${r.status} != ${c.status}`);
  if (c.expectLocation) {
    const loc = (r.headers.location || '').replace(/^https?:\/\/[^/]+/, ''); // compare path-only
    if (loc !== c.expectLocation) reasons.push(`Location "${loc}" != "${c.expectLocation}"`);
  }
  if (c.expectHeader) {
    for (const [h, want] of Object.entries(c.expectHeader)) {
      const got = r.headers[h.toLowerCase()] || '';
      if (!got.toLowerCase().includes(String(want).toLowerCase())) {
        reasons.push(`${h} "${got}" !~ "${want}"`);
      }
    }
  }
  return { ok: reasons.length === 0, actual: String(r.status), reasons };
}

(async () => {
  let blockers = 0;

  // ── Basic Auth ENFORCEMENT: for every base with credentials, an UNauthenticated
  //    request to / must return 401. If it returns 200, the guard is missing —
  //    on staging that means it's crawlable; on prod it means a guard leaked. Either
  //    way it's a blocker before we bother comparing status codes.
  for (const b of bases.filter((x) => x.auth)) {
    const r = await fetchNoRedirect(b.url, '/', null);
    const ok = r.status === 401;
    if (!ok) blockers++;
    console.log(`  [auth] ${b.name}: GET / without creds -> ${r.error ? 'ERR:' + r.error : r.status} ` +
      `${ok ? '(enforced ✓)' : 'EXPECTED 401 — BLOCKER'}`);
  }

  const rows = [];
  for (const c of cases) {
    const perBase = {};
    for (const b of bases) {
      const r = await fetchNoRedirect(b.url, c.path, b.auth);
      const ev = evaluate(c, r);
      perBase[b.name] = ev;
      if (!ev.ok) blockers++;
    }
    rows.push({ c, perBase });
  }

  // ── Render table ──
  const pathW = Math.min(64, Math.max(4, ...cases.map((c) => c.path.length)));
  const col = (s, w) => String(s).padEnd(w).slice(0, w);
  let header = col('PATH', pathW) + ' | ' + col('EXP', 4);
  for (const b of bases) header += ' | ' + col(b.name, 10);
  header += ' | RESULT';
  console.log('\n' + header);
  console.log('-'.repeat(header.length));

  for (const { c, perBase } of rows) {
    let allOk = true;
    let line = col(c.path, pathW) + ' | ' + col(c.status, 4);
    for (const b of bases) {
      const ev = perBase[b.name];
      allOk = allOk && ev.ok;
      line += ' | ' + col(ev.actual, 10);
    }
    line += ' | ' + (allOk ? 'ok' : 'BLOCKER');
    console.log(line);
    if (!allOk) {
      for (const b of bases) {
        const ev = perBase[b.name];
        if (!ev.ok) console.log('      ' + col('', pathW) + `   ↳ ${b.name}: ${ev.reasons.join('; ')}`);
      }
    }
  }

  console.log('-'.repeat(header.length));
  if (blockers === 0) {
    console.log(`ALL CLEAR — ${cases.length} cases × ${bases.length} base(s), no mismatches.\n`);
    process.exit(0);
  } else {
    console.log(`${blockers} BLOCKER(S) across ${cases.length} cases × ${bases.length} base(s). Do not cut over.\n`);
    process.exit(1);
  }
})();
