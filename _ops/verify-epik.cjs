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
//
//  ORIGIN PINNING: before DNS moves, prorigbuilder.com answers from Railway, so
//  a run against that hostname measures the stack we are migrating AWAY from and
//  reports the difference as the new box's fault. <BASE>_RESOLVE=<ip> pins that
//  base to one origin — curl's --resolve, done with a custom dns lookup so the
//  Host header and the TLS SNI stay the real hostname and only the address
//  changes. <BASE>_INSECURE=1 additionally skips cert validation, for the window
//  where the origin's cert has not been issued for that name yet (AutoSSL's DNS
//  validation resolves to Railway until cutover). Every run PRINTS which origin
//  each base went to — a parity table that cannot tell you what it measured is
//  how a clean flip gets called a failure.
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
  // Optional per-base origin pin: <NAME>_RESOLVE=<ip>, <NAME>_INSECURE=1.
  const resolve = (process.env[`${name.toUpperCase()}_RESOLVE`] || '').trim() || null;
  const insecure = process.env[`${name.toUpperCase()}_INSECURE`] === '1';
  bases.push({ name, url: arg.slice(i + 1).replace(/\/$/, ''), auth, resolve, insecure });
}
if (!bases.length) {
  console.error('  usage: node test/verify-epik.cjs railway=https://prorigbuilder.com epik=https://staging...');
  process.exit(2);
}

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'epik-fixture.json'), 'utf8'));
const cases = fixture.cases;

function fetchNoRedirect(base, urlPath, auth) {
  return new Promise((resolve) => {
    let target;
    try { target = new URL(base.url + urlPath); } catch (e) { return resolve({ error: e.message }); }
    const mod = target.protocol === 'https:' ? https : http;
    const opts = { method: 'GET' };
    if (auth) opts.auth = auth; // Node sets the Authorization: Basic header
    if (base.resolve) {
      // Address only. Node still derives the Host header and the TLS servername
      // from the URL, so the origin is asked for the real hostname's vhost —
      // which is what curl --resolve does. A Host: header against https://<ip>
      // is NOT the same thing: SNI would become the IP and the box would answer
      // from its default vhost, which is a different site.
      const ip = base.resolve;
      const family = ip.includes(':') ? 6 : 4;
      // Three call shapes, because this file runs on CI's node AND on whatever
      // node the box has: (host, cb), (host, opts, cb), and opts.all — node 24
      // asks with {all:true} and expects an ARRAY, older ones want the tuple.
      // Getting this wrong fails as "Invalid IP address: undefined", which reads
      // like a config error and is not one.
      opts.lookup = (hostname, o, cb) => {
        const done = typeof o === 'function' ? o : cb;
        if (o && typeof o === 'object' && o.all) return done(null, [{ address: ip, family }]);
        return done(null, ip, family);
      };
    }
    // Only meaningful for https; harmless on http.
    if (base.insecure) opts.rejectUnauthorized = false;
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

  // Say what each base actually is BEFORE any verdict. A table of statuses with
  // no record of which origin answered is unreadable during a cutover, when the
  // same hostname means two different stacks depending on the day.
  for (const b of bases) {
    console.log(`  [base] ${b.name}: ${b.url}` +
      (b.resolve ? `  -> pinned to ${b.resolve}${b.insecure ? ' (cert not validated)' : ''}`
                 : '  -> whatever DNS resolves it to'));
  }

  // ── Basic Auth ENFORCEMENT: for every base with credentials, an UNauthenticated
  //    request to / must return 401. If it returns 200, the guard is missing —
  //    on staging that means it's crawlable; on prod it means a guard leaked. Either
  //    way it's a blocker before we bother comparing status codes.
  for (const b of bases.filter((x) => x.auth)) {
    const r = await fetchNoRedirect(b, '/', null);
    const ok = r.status === 401;
    if (!ok) blockers++;
    console.log(`  [auth] ${b.name}: GET / without creds -> ${r.error ? 'ERR:' + r.error : r.status} ` +
      `${ok ? '(enforced ✓)' : 'EXPECTED 401 — BLOCKER'}`);
  }

  const rows = [];
  for (const c of cases) {
    const perBase = {};
    for (const b of bases) {
      const r = await fetchNoRedirect(b, c.path, b.auth);
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
