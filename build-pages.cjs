// =============================================================================
//  build-pages.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Generates the artifacts the Cloudflare Pages stack needs. Sibling of
//  build-epik.cjs: same job, different host. Run after prerender.cjs.
//
//  Emits into dist/ (the uploaded asset directory):
//    - _headers    : cache policy, and under --staging the noindex guard
//    - _redirects  : reserved; see the note in §4 for why it is deliberately
//                    NOT where the SPA fallback or the 301 map lives
//
//  Emits into functions-lib/ (bundled into the Worker, never uploaded):
//    - resolver-data.generated.js : PRODUCT_RE copied verbatim out of
//                    server.cjs, the 301 map, and the two HTML shells
//
//  ── Why the generated module is not under functions/ ────────────────────────
//  Every file under functions/ becomes a ROUTE. A generated data module placed
//  there would publish itself at /parts/<whatever> and be invoked as a handler.
//  It lives in functions-lib/ instead and is reached by a relative import, which
//  esbuild follows at bundle time. functions-lib/ is gitignored: the file is
//  regenerated on every deploy, and a stale committed copy is exactly the drift
//  this script exists to prevent. If it is missing at deploy time the wrangler
//  bundle fails loudly, which is the failure mode we want.
//
//  ── The invariant this script exists to protect ─────────────────────────────
//  PRODUCT_RE is NOT retyped here, for the same reason build-epik.cjs does not
//  retype it: the product/non-product boundary decides whether a missing URL
//  gets a 410 or the SPA shell at 200, and a mistake in it is invisible until
//  organic traffic drops. server.cjs is the single source of truth and this
//  script copies the literal out of it, then runs a truth table over the copy.
// =============================================================================

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DIST = path.join(ROOT, 'dist');
const LIB = path.join(ROOT, 'functions-lib');

// Staging builds get a blanket noindex appended to _headers. It is NEVER part
// of a production artifact — see the STAGING branch vs the production
// self-check in §5. The sentinel is what that self-check greps for.
const STAGING = process.argv.includes('--staging');
const GUARD_SENTINEL = 'PRB-PAGES-STAGING-GUARD';

if (!fs.existsSync(DIST)) {
  console.error(`  ✗ dist/ not found at ${DIST} — run the vite build + prerender first`);
  process.exit(1);
}

// ── 1. Extract PRODUCT_RE from server.cjs (copy, never retype) ───────────────
// Same extraction as build-epik.cjs §1, against the same literal.
const serverSrc = fs.readFileSync(path.join(ROOT, 'server.cjs'), 'utf8');
const m = serverSrc.match(/const PRODUCT_RE = \/(.+)\/;\s*$/m);
if (!m) {
  console.error('  ✗ could not locate `const PRODUCT_RE = /.../;` in server.cjs');
  process.exit(1);
}
const productPattern = m[1]; // e.g. ^\/parts\/[^/]+\/[^/]+-\d+\/?$

// The pattern is re-emitted as a JS regex literal, which is what it already was
// in server.cjs — byte-identical by construction, no escaping layer to get
// wrong (this is the one place the Pages port has it easier than the PHP one).
// Still assert it compiles, because a silent SyntaxError here would surface as
// a bundle failure with no hint about the cause.
let PRODUCT_RE;
try {
  PRODUCT_RE = new RegExp(productPattern);
} catch (e) {
  console.error(`  ✗ PRODUCT_RE extracted from server.cjs does not compile: ${e.message}`);
  process.exit(1);
}

// Truth table over the COPY, in the spirit of test/install-phase-a.docroot.test.sh:
// the boundary is a pure function, so its behaviour is asserted here rather than
// discovered in production. These cases are the ones that actually differ — a
// product page, its trailing-slash form, a category index, a browse page, and a
// deeper path — and each is a live URL shape on the site today.
const TRUTH_TABLE = [
  ['/parts/ram/corsair-vengeance-40001', true, 'product page'],
  ['/parts/ram/corsair-vengeance-40001/', true, 'product page, trailing slash'],
  ['/parts/ram', false, 'category index'],
  ['/parts/ram/', false, 'category index, trailing slash'],
  ['/parts/ram/browse/page-2', false, 'browse pagination'],
  ['/parts/ram/corsair-vengeance-40001/extra', false, 'deeper than a product'],
  ['/parts/ram/no-trailing-number', false, 'slug without an id'],
  ['/search', false, 'non-parts route'],
];
let tableFailures = 0;
for (const [input, expected, label] of TRUTH_TABLE) {
  const got = PRODUCT_RE.test(input);
  if (got !== expected) {
    console.error(`  ✗ PRODUCT_RE truth table: ${label} — ${input} gave ${got}, expected ${expected}`);
    tableFailures++;
  }
}
if (tableFailures) {
  console.error(`  ✗ ${tableFailures} truth-table failure(s) — server.cjs PRODUCT_RE changed shape. Reconcile deliberately; the 410/200 boundary moved.`);
  process.exit(1);
}

// ── 2. The 301 map from product-redirects.json (drop "//" comment keys) ──────
// Same source and same comment convention as build-epik.cjs §2.
let rawMap = {};
try {
  rawMap = JSON.parse(fs.readFileSync(path.join(ROOT, 'product-redirects.json'), 'utf8'));
} catch (e) {
  console.warn(`  ⚠ product-redirects.json not read (${e.message}) — emitting empty map (all 410)`);
}
const redirects = {};
let redirectCount = 0;
for (const [k, v] of Object.entries(rawMap)) {
  if (k.startsWith('//')) continue; // JSON comment convention
  redirects[k] = v;
  redirectCount++;
}

// A redirect whose target is itself missing sends a crawler from a 301 to a 410,
// which is worse than the 410 alone. The map is small and hand-maintained, so
// check every target resolves to something prerendered and say so if not.
const danglingTargets = [];
for (const [k, v] of Object.entries(redirects)) {
  if (/^https?:/i.test(v)) continue; // absolute target, not ours to verify
  const asDir = path.join(DIST, v.replace(/^\/+/, ''), 'index.html');
  if (!fs.existsSync(asDir)) danglingTargets.push(`${k} -> ${v}`);
}

// ── 3. The two HTML shells ──────────────────────────────────────────────────
// The SPA shell is dist/index.html verbatim (server.cjs Layer 5 sends the file
// as-is). The 410 shell is the same transform server.cjs applies at boot to
// build GONE_SHELL, and build-epik.cjs applies to write gone.html — kept
// character-for-character identical to both so the three stacks cannot drift.
const indexPath = path.join(DIST, 'index.html');
let spaHtml;
try {
  spaHtml = fs.readFileSync(indexPath, 'utf8');
} catch (e) {
  console.error(`  ✗ dist/index.html not readable (${e.message}) — cannot build the SPA fallback`);
  process.exit(1);
}
const goneHtml = spaHtml
  .replace(/\s*<meta name="(?:robots|googlebot|bingbot)"[^>]*>/gi, '')
  .replace(/\s*<link[^>]*rel="canonical"[^>]*>/gi, '')
  .replace(/<head>/i, '<head>\n    <meta name="robots" content="noindex">');

// Guard: a 410 shell must never advertise itself as indexable.
if (/content="index/i.test(goneHtml) || !/content="noindex"/i.test(goneHtml)) {
  console.error('  ✗ the 410 shell failed the noindex invariant — index directive present or noindex missing');
  process.exit(1);
}
// Guard: and it must not carry a canonical pointing anywhere. A canonical is an
// "index this" directive, contradictory on a Gone page (server.cjs GONE_SHELL).
if (/rel="canonical"/i.test(goneHtml)) {
  console.error('  ✗ the 410 shell still carries a <link rel="canonical"> — the strip did not match');
  process.exit(1);
}

// ── 4. Write the generated Worker module ────────────────────────────────────
const jsStr = (s) => JSON.stringify(s);
fs.mkdirSync(LIB, { recursive: true });
const generated =
  '// GENERATED by build-pages.cjs — DO NOT EDIT, DO NOT COMMIT.\n' +
  '// Regenerated on every deploy. See build-pages.cjs for provenance of each export.\n' +
  '\n' +
  '// Copied verbatim from server.cjs — the single source of truth for the\n' +
  '// product/non-product boundary. Asserted against a truth table at build time.\n' +
  `export const PRODUCT_RE = /${productPattern}/;\n` +
  '\n' +
  '// From product-redirects.json. Null-prototype so a crafted path can never\n' +
  '// reach Object.prototype and turn a lookup into a truthy inherited member.\n' +
  'export const REDIRECTS = Object.assign(Object.create(null), ' +
  JSON.stringify(redirects, null, 2) + ');\n' +
  '\n' +
  '// dist/index.html verbatim (server.cjs Layer 5).\n' +
  `export const SPA_HTML = ${jsStr(spaHtml)};\n` +
  '\n' +
  '// dist/index.html with every robots/googlebot/bingbot meta and the canonical\n' +
  '// stripped, and a single noindex forced in (server.cjs GONE_SHELL).\n' +
  `export const GONE_HTML = ${jsStr(goneHtml)};\n`;
fs.writeFileSync(path.join(LIB, 'resolver-data.generated.js'), generated, 'utf8');

// ── 4b. 404.html — the file that makes the resolver reachable at all ────────
// MEASURED with `wrangler pages dev` against this exact tree, 2026-08-15.
//
// Cloudflare's asset service has a built-in single-page-application fallback:
// when a request matches no asset AND the tree contains no 404.html, it serves
// the ROOT index.html with status 200. It is not the _redirects file that does
// this and there is no rule to switch it off — it is the default.
//
// That is fatal to the resolver, silently. functions/parts/[[path]].js decides
// "was this URL real?" from the status of its next() call, and under that
// default next() returns 200 for a deleted product exactly as it does for a
// live one. Every retired URL soft-404s at 200 and the 301/410 branch is dead
// code. The Function still runs, the deploy is green, and the only symptom is
// organic traffic. Verified directly: RESOLVER-NEXT status=200 on a path with
// no asset behind it.
//
// Writing a 404.html restores a real 404 from the asset service, which is what
// the Function tests for. It gets the SAME transform as the 410 shell rather
// than being a copy of index.html, for the same reason: a 404 response that
// carries `robots: index` and `canonical: https://prorigbuilder.com/` is
// telling a crawler the dead URL is the homepage.
//
// Consequence outside /parts/, stated because it IS a behaviour change from
// server.cjs Layer 5: an unknown non-/parts/ path now answers 404 instead of
// 200-with-the-shell. Checked against public/sitemap.xml — all 26 non-/parts/
// entries are prerendered, so no indexable URL moves. Humans still get a
// booting app shell; only the status differs, and a hard 404 on a genuinely
// unknown path is the better of the two answers.
fs.writeFileSync(path.join(DIST, '404.html'), goneHtml, 'utf8');

// ── 4c. Trailing-slash siblings for prerendered routes outside /parts/ ──────
// Same defect as the one functions/parts/[[path]].js intercepts, and the same
// measurement: a prerendered route at <path>/index.html is answered with a 308
// to <path>/, while every sitemap entry and every canonical tag publishes the
// unslashed form.
//
// The Function cannot fix these — wrangler scopes it to /parts/* (that is the
// whole reason a Worker is not in front of the rest of the site), and widening
// it to a root _middleware.js would put one there for every asset on every
// request to repair ~25 URLs.
//
// Cloudflare's asset service resolves <path> from a sibling <path>.html before
// it considers <path>/index.html, and serves it at 200 with no redirect. So the
// fix out here is a file, not code: write the sibling. Both forms then answer
// 200 with identical bytes (verified with `wrangler pages dev`).
//
// The same trick inside /parts/ would cost 5,484 extra files and ~440 MB per
// deploy and push the deployment back toward the 20,000-file ceiling that
// moving the data directories to R2 just bought headroom against. Two
// mechanisms, each used where it is the cheap one.
const SIBLING_SKIP = new Set(['parts', 'assets', 'price-history', 'reviews']);
const siblings = [];
const siblingCollisions = [];
(function walk(absDir, relParts) {
  for (const entry of fs.readdirSync(absDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (relParts.length === 0 && SIBLING_SKIP.has(entry.name)) continue;
    const abs = path.join(absDir, entry.name);
    const rel = [...relParts, entry.name];
    if (fs.existsSync(path.join(abs, 'index.html'))) {
      // Overwrite freely: the sibling is our own output and this script must be
      // idempotent — a second run regenerates it from the same source rather
      // than reporting its own previous run as a conflict.
      //
      // One target is not ours to write. A route directory literally named
      // "index" computes to <parent>/index.html, which is a PRERENDERED page —
      // for rel=[] that is the SPA shell itself. Clobbering it would replace the
      // homepage with a subpage and nothing downstream would notice.
      if (entry.name === 'index') {
        siblingCollisions.push(`/${rel.join('/')}`);
      } else {
        const target = path.join(DIST, ...rel.slice(0, -1), `${entry.name}.html`);
        fs.copyFileSync(path.join(abs, 'index.html'), target);
        siblings.push(target);
      }
    }
    walk(abs, rel);
  }
})(DIST, []);

// ── 4d. _redirects ──────────────────────────────────────────────────────────
// Deliberately carries NO rules.
//
// The obvious thing to put here is the SPA catch-all `/* /index.html 200`. It
// is a trap for the same reason as the missing 404.html above, and worse: it
// would re-introduce the 200-on-miss behaviour that 404.html exists to remove,
// this time explicitly, and the resolver would go quiet again.
//
// The 12 product 301s are not here either: the Function owns /parts/* and
// already applies them from the same generated map, and a second copy here
// would be free to drift from product-redirects.json.
//
// The file is still written so its absence is never ambiguous — an empty
// _redirects says "considered and intentionally empty", a missing one says
// "build-pages.cjs did not run".
const redirectsFile = [
  '# GENERATED by build-pages.cjs — DO NOT EDIT.',
  '#',
  '# Intentionally empty. Both things that would normally live here are handled',
  '# elsewhere, on purpose:',
  '#',
  '#   SPA fallback — a `/* /index.html 200` catch-all here would make the asset',
  '#     service answer 200 for URLs with nothing behind them, so',
  '#     functions/parts/[[path]].js would never observe a 404 and its 301/410',
  '#     branch would be unreachable. dist/404.html is what gives that Function a',
  '#     real 404 to test for. See build-pages.cjs §4b.',
  '#',
  '#   The 301 map — the Function applies it from the generated module, which is',
  '#     built from product-redirects.json. A copy here could drift from it.',
  '',
].join('\n');
fs.writeFileSync(path.join(DIST, '_redirects'), redirectsFile, 'utf8');

// ── 5. _headers, and the staging guard / production self-check ──────────────
// Two cache classes, matching server.cjs Layer 4 and Layers 1–3 respectively.
// Order matters: Pages applies every matching rule in file order and the last
// write of a given header name wins, so the broad rule goes first and the
// hashed-asset rule overrides it.
const headerLines = [
  '# GENERATED by build-pages.cjs — DO NOT EDIT.',
  '',
  '# ── Cache-Control is NOT set here, and cannot usefully be ─────────────────',
  '# MEASURED with `wrangler pages dev`, 2026-08-15.',
  '#',
  '# Cloudflare already sends `public, max-age=0, must-revalidate` on every',
  '# asset, which is exactly what server.cjs Layers 1-3 want for the prerendered',
  '# HTML — so there is nothing to add for the common case.',
  '#',
  '# For /assets/* we DO want something different: hashed build output is',
  '# content-addressed and server.cjs Layer 4 marks it immutable for a year. That',
  '# cannot be expressed here. _headers APPENDS to what Cloudflare already sent',
  '# rather than replacing it, so a rule here produces the self-contradictory',
  '#',
  '#     Cache-Control: public, max-age=0, must-revalidate, public, max-age=31536000, immutable',
  '#',
  '# and the first max-age wins. The rule looks applied and does nothing, which is',
  '# worse than not writing it, so it is not written.',
  '#',
  '# The working lever is a zone-level Cache Rule on /assets/* once the custom',
  '# domain is attached — see deploy/DESIGN-cloudflare-pages.md §6. Until then',
  '# hashed assets revalidate; they still hit the edge cache, so the cost is a',
  '# conditional request and a 304, not a re-download.',
  '',
];

let guardNote;
if (STAGING) {
  // ── The honest caveat, stated where it will be read ──────────────────────
  // On Epik, staging is guarded by Basic Auth FIRST and noindex second, and
  // that ordering is deliberate: a leaked Basic Auth 401s loudly and is caught
  // in minutes, whereas a leaked noindex de-indexes silently (the 2026-07-27
  // incident). Pages has no equivalent — Basic Auth would need a second
  // Function on every route, and this stack cannot borrow the .htpasswd
  // mechanism. So the Pages staging guard is the SILENT-FAILING layer alone.
  // That is a real weakening, it is why the production self-check below is a
  // hard refusal rather than a warning, and it is written up in
  // deploy/DESIGN-cloudflare-pages.md §7.
  headerLines.push(
    `# >>> ${GUARD_SENTINEL} (generated by build-pages.cjs --staging) — MUST NOT reach production >>>`,
    '# Preview deployments carry the full prerendered catalog on a *.pages.dev',
    '# hostname. The prerendered canonicals all point at prorigbuilder.com, which',
    '# is most of the defence; this makes it explicit rather than implied.',
    '/*',
    '  X-Robots-Tag: noindex, nofollow',
    `# <<< ${GUARD_SENTINEL} <<<`,
    ''
  );
  guardNote = '  ✓ STAGING guard appended (blanket noindex, nofollow)';
} else {
  guardNote = '  ✓ production artifact verified guard-free (no blanket noindex)';
}

const headersPath = path.join(DIST, '_headers');
fs.writeFileSync(headersPath, headerLines.join('\n'), 'utf8');

// Assert against what is now ON DISK, not against the array we just built. The
// array is ours and asserting on it proves nothing; the file is what gets
// uploaded. Checked in BOTH directions, the way publish-epik.yml checks the
// staging sentinel: a production artifact carrying the guard de-indexes the
// live site, and a staging artifact that LOST it is a fully crawlable copy of
// the whole catalog on a pages.dev hostname.
const writtenHeaders = fs.readFileSync(headersPath, 'utf8');
const hasSentinel = writtenHeaders.includes(GUARD_SENTINEL);
const hasNoindex = /X-Robots-Tag:.*noindex/i.test(writtenHeaders);
if (STAGING) {
  if (!hasSentinel || !hasNoindex) {
    console.error('  ✗ staging _headers is MISSING its noindex guard — it would be publicly crawlable. Refusing.');
    process.exit(1);
  }
} else {
  const hits = [];
  if (hasSentinel) hits.push('staging sentinel');
  if (hasNoindex) hits.push('blanket noindex header');
  if (hits.length) {
    console.error(`  ✗ production _headers contains a staging guard (${hits.join(', ')}) — refusing to build a production artifact`);
    process.exit(1);
  }
}

// ── 6. Report ───────────────────────────────────────────────────────────────
console.log('  Cloudflare Pages artifacts written:');
console.log(`  ✓ functions-lib/resolver-data.generated.js`);
console.log(`      PRODUCT_RE = /${productPattern}/  (${TRUTH_TABLE.length} truth-table cases pass)`);
console.log(`      REDIRECTS  = ${redirectCount} 301 entr${redirectCount === 1 ? 'y' : 'ies'}`);
console.log(`      SPA_HTML   = ${spaHtml.length} bytes`);
console.log(`      GONE_HTML  = ${goneHtml.length} bytes, noindex verified`);
console.log(`  ✓ dist/404.html          (${goneHtml.length} bytes — makes the resolver reachable, see §4b)`);
console.log(`  ✓ dist/*.html siblings   (${siblings.length} routes outside /parts/ now serve their canonical unslashed URL at 200)`);
console.log(`  ✓ dist/_redirects        (intentionally empty — see §4d)`);
console.log(`  ✓ dist/_headers          (${headerLines.filter((l) => l.startsWith('/')).length} rules)`);
console.log(guardNote);

if (siblingCollisions.length) {
  console.warn(`  ⚠ ${siblingCollisions.length} route director${siblingCollisions.length === 1 ? 'y is' : 'ies are'} named "index" — no sibling written, it would overwrite a prerendered page:`);
  for (const c of siblingCollisions.slice(0, 10)) console.warn(`      ${c}`);
}

if (danglingTargets.length) {
  console.warn(`  ⚠ ${danglingTargets.length} redirect target(s) have no prerendered page — those URLs 301 into a 404:`);
  for (const d of danglingTargets.slice(0, 10)) console.warn(`      ${d}`);
  if (danglingTargets.length > 10) console.warn(`      … and ${danglingTargets.length - 10} more`);
}
