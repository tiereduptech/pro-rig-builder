#!/usr/bin/env node
// cp3-pages.mjs — CP-3 for the Cloudflare Pages stack.
//
// The five HARD checks from verify-prerender.cjs, applied to what a HOST
// SERVES rather than to dist/, plus the response status and the X-Robots-Tag
// response header. Same division as PHASE-B-INSTALL.md §5: a page can be
// perfect in dist/ and still be de-indexed by what the server attaches on the
// way out, which is what happened for ~10 days in July 2026.
//
// Canonicals are asserted against https://prorigbuilder.com regardless of which
// host serves the bytes. That is deliberate — the canonical is baked into dist/,
// so a page served from pages.dev or from a canary hostname must still declare
// the production URL. See CUTOVER-cloudflare-pages.md §4.
//
//   HOST=https://prorigbuilder.pages.dev node deploy/cp3-pages.mjs
//   HOST=https://pages-canary.prorigbuilder.com SAMPLE=40 node deploy/cp3-pages.mjs
//
// Exits non-zero on any hard violation.

import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { assertPage } = require(path.join(ROOT, "verify-prerender.cjs"));

const SITE = "https://prorigbuilder.com";
const HOST = (process.env.HOST || SITE).replace(/\/$/, "");
const SAMPLE = Number(process.env.SAMPLE || 20);
const SITEMAP = process.env.SITEMAP || path.join(ROOT, "public", "sitemap.xml");

// ── sample the product URLs ─────────────────────────────────────────────────
// Evenly spaced with a rotating offset rather than a fixed head: a sample that
// is the same every run cannot detect a defect correlated with category or age.
const xml = fs.readFileSync(SITEMAP, "utf8");
const products = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)]
  .map(m => m[1])
  .filter(u => /\/parts\/[^/]+\/[^/]+$/.test(u));

if (products.length === 0) {
  console.error(`✗ no product URLs in ${SITEMAP} — refusing to report a pass on an empty sample`);
  process.exit(1);
}

const step = Math.max(1, Math.floor(products.length / SAMPLE));
const offset = Number(process.env.OFFSET ?? Math.floor(Date.now() / 86400000) % step);
const urls = Array.from({ length: Math.min(SAMPLE, products.length) },
  (_, i) => products[(i * step + offset) % products.length]);

// ── check ───────────────────────────────────────────────────────────────────
let clean = 0;
const failures = [];
const suppressed = [];

for (const canonical of urls) {
  const route = canonical.replace(SITE, "");
  const hard = [];
  let bytes = 0;

  try {
    const res = await fetch(HOST + route, { redirect: "manual" });
    const html = await res.text();
    bytes = html.length;

    // A live product URL must answer a plain 200. A 308 here is the §4.2
    // trailing-slash regression; a 410 is the resolver misclassifying a live
    // page; a 403/503 is the zone challenging the request (CUTOVER §3.5).
    if (res.status !== 200) hard.push(`status: ${res.status} (expected 200)`);

    // The response-header half of CP-3's noindex line.
    //
    // ALLOW_NOINDEX_HEADER=1 demotes it, for one case only: a canary hostname
    // deliberately carrying a noindex Transform Rule (CUTOVER §2). Without the
    // escape every canary run reports a failure that is not one, which trains
    // the alarm to be ignored in the exact window meant to build confidence in
    // it — the same defect PHASE-B-INSTALL.md §8 records for an unflipped-docroot
    // cron. The header is proven on pages.dev and again on the apex, where it is
    // not suppressed; the canary exists to test the zone's HTML rewriting, which
    // lands on the five content checks below and is unaffected by this.
    const xrt = res.headers.get("x-robots-tag");
    if (xrt && /noindex/i.test(xrt)) {
      const msg = `X-Robots-Tag: "${xrt}" carries noindex`;
      if (process.env.ALLOW_NOINDEX_HEADER === "1") suppressed.push(msg);
      else hard.push(msg);
    }

    hard.push(...assertPage(html, canonical).hard);
  } catch (e) {
    // A check that cannot RUN counts as a failure, never as a pass.
    hard.push(`fetch failed: ${e.message}`);
  }

  if (hard.length === 0) clean++;
  else failures.push({ route, bytes, hard });
  process.stdout.write(hard.length === 0 ? "." : "X");
}

// ── report ──────────────────────────────────────────────────────────────────
console.log(`\n\n── CP-3 rendered output ─────────────────────────────────────`);
console.log(`host:      ${HOST}`);
console.log(`canonical: asserted against ${SITE} (baked into dist/)`);
console.log(`sampled:   ${urls.length} of ${products.length} product pages (offset ${offset})`);
console.log(`clean:     ${clean} | failing: ${failures.length}`);
if (suppressed.length)
  console.log(`suppressed: ${suppressed.length} X-Robots-Tag noindex (ALLOW_NOINDEX_HEADER=1 — canary only)`);

for (const f of failures) {
  console.log(`\n  ✗ ${f.route}  (${f.bytes} bytes)`);
  f.hard.forEach(m => console.log(`      ${m}`));
}

if (failures.length) {
  console.error(`\n██ CP-3 FAILED: ${failures.length}/${urls.length} pages with hard violations ██`);
  process.exit(1);
}
console.log(`\n✓ CP-3 passed: ${urls.length} pages, 0 hard violations.`);
