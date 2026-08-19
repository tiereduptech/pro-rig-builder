/**
 * test/deploy-freshness-report.test.js
 *
 * The shape being tested is the one that hid for four nights: prerender green
 * every morning, deploy-pages with no failed run, and a live site four builds
 * behind main. A run-history rule calls that healthy. Only comparing the
 * artifact the world receives against the artifact main committed catches it.
 */

import test from "node:test";
import assert from "node:assert";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

const { judgeDeploy, entryBundle } = require("../scripts/deploy-freshness-report.cjs");

const page = (hash) =>
  `<!doctype html><html><head><script type="module" crossorigin src="/assets/index-${hash}.js"></script>` +
  `<link rel="modulepreload" href="/assets/react-vendor-DWXNuaWO.js"></head><body><div id="root"></div></body></html>`;

test('live matching main is not red', () => {
  const v = judgeDeploy({ liveHtml: page('DXvLsYDC'), committedHtml: page('DXvLsYDC') });
  assert.strictEqual(v.red, false);
  assert.deepStrictEqual(v.reasons, []);
  assert.strictEqual(v.live, 'assets/index-DXvLsYDC.js');
});

test('the real 2026-08-19 state goes red — four nightly builds behind', () => {
  const v = judgeDeploy({
    liveHtml: page('ivYVrIUx'),      // deployed by hand on 2026-08-15
    committedHtml: page('DXvLsYDC'), // what main has after four more nightlies
    url: 'https://prorigbuilder.com/',
  });
  assert.strictEqual(v.red, true);
  assert.ok(v.reasons.some((r) => /BEHIND main/.test(r)), v.reasons.join('; '));
  assert.ok(v.reasons.some((r) => /ivYVrIUx/.test(r) && /DXvLsYDC/.test(r)), 'names both hashes');
});

test('an unreachable site is red, not quietly green', () => {
  const v = judgeDeploy({ fetchError: 'HTTP 522', committedHtml: page('DXvLsYDC') });
  assert.strictEqual(v.red, true);
  assert.ok(v.reasons.some((r) => /does not answer/.test(r)), v.reasons.join('; '));
});

test('a shell with no entry bundle is red, not a match', () => {
  // The failure the header warns about: re-running vite build emits hashes no
  // committed HTML points at, and the page loads blank. A blank page must not
  // read as "nothing to compare, therefore fine".
  const v = judgeDeploy({ liveHtml: '<!doctype html><html><body></body></html>', committedHtml: page('DXvLsYDC') });
  assert.strictEqual(v.red, true);
  assert.ok(v.reasons.some((r) => /serving a shell/.test(r)), v.reasons.join('; '));
});

test('an unreadable committed build is red rather than judged against nothing', () => {
  const v = judgeDeploy({ liveHtml: page('DXvLsYDC'), committedHtml: '<!doctype html><html></html>' });
  assert.strictEqual(v.red, true);
  assert.ok(v.reasons.some((r) => /committed build is unreadable/.test(r)), v.reasons.join('; '));
});

test('a transport failure outranks a hash comparison it would invalidate', () => {
  // fetchError set AND liveHtml present must not be read as a live answer.
  const v = judgeDeploy({ liveHtml: page('DXvLsYDC'), committedHtml: page('DXvLsYDC'), fetchError: 'timeout' });
  assert.strictEqual(v.red, true);
});

test('entryBundle takes the entry chunk, not the first asset on the page', () => {
  const html = '<link rel="modulepreload" href="/assets/react-vendor-DWXNuaWO.js">' +
               '<script src="/assets/index-C0Dne4uB.js"></script>';
  assert.strictEqual(entryBundle(html), 'assets/index-C0Dne4uB.js');
});

// ── Second signal: sitemap.xml ───────────────────────────────────────────────
// The bundle hash alone was blind on 6 of the last 25 builds, because a nightly
// that changes only catalog content emits identical JS. Aug 12 -> Aug 13 is a
// real instance: same index-BEEWwsHg.js, different sitemap. A freeze starting on
// such a night read as healthy.

const { sitemapFacts, daysBetween } = require("../scripts/deploy-freshness-report.cjs");

const sitemap = (date, n) =>
  `<?xml version="1.0" encoding="UTF-8"?><urlset>` +
  Array.from({ length: n }, (_, i) =>
    `<url><loc>https://prorigbuilder.com/parts/cpu/p${i}</loc><lastmod>${date}</lastmod></url>`
  ).join('') +
  `</urlset>`;

test('a stale sitemap is red even when the bundle hash matches', () => {
  // The Aug 12 -> Aug 13 shape, which the bundle-only check called healthy.
  const v = judgeDeploy({
    liveHtml: page('BEEWwsHg'),
    committedHtml: page('BEEWwsHg'),
    liveSitemap: sitemap('2026-08-12', 5000),
    committedSitemap: sitemap('2026-08-13', 5000),
    url: 'https://prorigbuilder.com/',
  });
  assert.strictEqual(v.red, true);
  assert.ok(v.reasons.some((r) => /sitemap\.xml differs/.test(r)), v.reasons.join('; '));
  assert.ok(v.reasons.some((r) => /1 day\(s\) behind/.test(r)), v.reasons.join('; '));
});

test('both signals agreeing is green', () => {
  const v = judgeDeploy({
    liveHtml: page('C7Z5usPQ'),
    committedHtml: page('C7Z5usPQ'),
    liveSitemap: sitemap('2026-08-19', 5068),
    committedSitemap: sitemap('2026-08-19', 5068),
  });
  assert.strictEqual(v.red, false);
  assert.deepStrictEqual(v.reasons, []);
});

test('a same-day sitemap does not mask a bundle mismatch', () => {
  // The real 2026-08-19 state: two builds the same day, so <lastmod> is
  // identical and only the bundle hash can see the drift. This is the
  // symmetric blind spot, and the reason both signals are kept.
  const v = judgeDeploy({
    liveHtml: page('DXvLsYDC'),
    committedHtml: page('C7Z5usPQ'),
    liveSitemap: sitemap('2026-08-19', 5068),
    committedSitemap: sitemap('2026-08-19', 5068),
    url: 'https://prorigbuilder.com/',
  });
  assert.strictEqual(v.red, true);
  assert.ok(v.reasons.some((r) => /BEHIND main/.test(r)), v.reasons.join('; '));
});

test('a route-count gap is named even when the dates match', () => {
  const v = judgeDeploy({
    liveHtml: page('C7Z5usPQ'),
    committedHtml: page('C7Z5usPQ'),
    liveSitemap: sitemap('2026-08-19', 5037),
    committedSitemap: sitemap('2026-08-19', 5068),
  });
  assert.strictEqual(v.red, true);
  assert.ok(v.reasons.some((r) => /31 route\(s\) missing/.test(r)), v.reasons.join('; '));
});

test('an unreadable committed sitemap is reported, not silently skipped', () => {
  const v = judgeDeploy({
    liveHtml: page('C7Z5usPQ'),
    committedHtml: page('C7Z5usPQ'),
    liveSitemap: sitemap('2026-08-19', 5068),
    committedSitemap: '<?xml version="1.0"?><urlset></urlset>',
  });
  assert.strictEqual(v.red, true);
  assert.ok(v.reasons.some((r) => /committed sitemap is unreadable/.test(r)), v.reasons.join('; '));
});

test('a live path serving something that is not a sitemap is red', () => {
  const v = judgeDeploy({
    liveHtml: page('C7Z5usPQ'),
    committedHtml: page('C7Z5usPQ'),
    liveSitemap: '<!doctype html><html><body>Not Found</body></html>',
    committedSitemap: sitemap('2026-08-19', 5068),
    url: 'https://prorigbuilder.com/',
  });
  assert.strictEqual(v.red, true);
  assert.ok(v.reasons.some((r) => /not.*look.*like a sitemap|nothing that looks like a sitemap/.test(r)), v.reasons.join('; '));
});

test('omitting both sitemap inputs judges the bundle alone, and does not go red for it', () => {
  // The seven original tests call judgeDeploy with no sitemap at all. Absent
  // must mean "not asked", never "failed".
  const v = judgeDeploy({ liveHtml: page('DXvLsYDC'), committedHtml: page('DXvLsYDC') });
  assert.strictEqual(v.red, false);
});

test('sitemapFacts rejects a document with no <loc>, and reads the newest date', () => {
  assert.strictEqual(sitemapFacts('<html>nope</html>'), null);
  assert.strictEqual(sitemapFacts(''), null);
  const f = sitemapFacts(
    '<urlset><url><loc>a</loc><lastmod>2026-08-11</lastmod></url>' +
    '<url><loc>b</loc><lastmod>2026-08-19</lastmod></url>' +
    '<url><loc>c</loc><lastmod>2026-08-14</lastmod></url></urlset>'
  );
  assert.strictEqual(f.urls, 3);
  assert.strictEqual(f.newest, '2026-08-19', 'max, not first and not last in document order');
});

test('daysBetween is whole days and directional', () => {
  assert.strictEqual(daysBetween('2026-08-15', '2026-08-19'), 4);
  assert.strictEqual(daysBetween('2026-08-19', '2026-08-19'), 0);
  assert.strictEqual(daysBetween(null, '2026-08-19'), null);
});
