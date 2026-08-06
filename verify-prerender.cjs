#!/usr/bin/env node
// verify-prerender.cjs — HARD GATE over prerendered dist OUTPUT. Run AFTER
// prerender, BEFORE committing dist. Exit 1 on any HARD violation so a
// contaminated build can never ship; WARN checks print but never fail.
//
// Why this exists: the 2026-07-27 noindex bug shipped for ~10 days because the
// 410 soft-404 layer was verified but nothing checked the pages that got WRITTEN.
// Assert the OUTPUT, not just the input. This absorbs the old robots-only gate.
//
// SCOPE: the INDEXABLE render set only — loadParts().filter(isIndexable), whose
// dist file exists. Genuinely-gone product URLs (410 GONE_SHELL: noindex, no
// canonical) are never written to dist, so the gate never sees them; that is
// correct. A product that is indexable but has NO file is a render-coverage gap
// (the render race), reported as INFO, not a content failure.
//
// HARD (exit 1):  robots · head-tag integrity · canonical self-ref · product body · no shell/error
// WARN (print):   og:url==canonical · description present · body-size floor
//
// SHELL_CHECKS_HARD toggles assertions 4 & 5 (the render-race-sensitive pair)
// between hard-fail and warn. See the day-one measurement before trusting hard.

const fs = require("fs");
const path = require("path");
const { loadParts, isIndexable, productPath } = require("./scripts/url-slugs.cjs");

const SITE = "https://prorigbuilder.com";
const DIST = "dist";
const BODY_FLOOR = 30000;                 // real product pages are 56–99KB; 30KB only trips on broken/truncated output
const SHELL_CHECKS_HARD = true;           // flip to false to demote checks 4 & 5 to warn while the render race is open

// ── tag helpers ─────────────────────────────────────────────────────────────
const countTag = (h, re) => (h.match(re) || []).length;
const RE = {
  title:     /<title[\s>]/gi,
  ogTitle:   /<meta[^>]+property="og:title"/gi,
  canonical: /<link[^>]+rel="canonical"/gi,
  robots:    /<meta[^>]+name="robots"/gi,
};
function canonicalHref(h) {
  const tag = h.match(/<link[^>]*rel="canonical"[^>]*>/i);
  return tag ? (tag[0].match(/href="([^"]+)"/i) || [])[1] || null : null;
}
function attr(h, re) { const m = h.match(re); return m ? m[1] : null; }

// ── per-page assertions. Each returns {ok, msg} ─────────────────────────────
function assertPage(html, expectedUrl) {
  const out = { hard: [], warn: [] };
  const H = (ok, msg) => { if (!ok) out.hard.push(msg); };
  const W = (ok, msg) => { if (!ok) out.warn.push(msg); };
  const shell = (ok, msg) => { if (!ok) (SHELL_CHECKS_HARD ? out.hard : out.warn).push(msg); };

  // 1 robots: crawlable, no noindex
  H(!/content="noindex"/i.test(html) && /name="robots" content="index/i.test(html),
    "robots: noindex present or index directive missing");

  // 2 head-tag integrity: exactly one of each
  for (const [name, re] of Object.entries(RE)) {
    const n = countTag(html, re);
    H(n === 1, `head-tag: expected 1 ${name}, found ${n}`);
  }

  // 3 canonical present AND self-referencing
  const canon = canonicalHref(html);
  H(canon === expectedUrl, `canonical: ${canon === null ? "missing" : `"${canon}" != self "${expectedUrl}"`}`);

  // 4 product body present (positive sentinel) — render-race sensitive
  shell(/"@type"\s*:\s*"Product"/.test(html), "product body: no Product JSON-LD (rendered a shell?)");

  // 5 no shell/error leakage in an indexable page — render-race sensitive
  shell(!/Skip the shop visit/i.test(html) && !/Product Not Found/i.test(html),
    "shell leak: home-h1 or 'Product Not Found' present");

  // WARN 6 og:url == canonical
  const ogUrl = attr(html, /<meta[^>]*property="og:url"[^>]*content="([^"]+)"/i);
  W(ogUrl === expectedUrl, `og:url "${ogUrl}" != canonical "${expectedUrl}"`);

  // WARN 7 description present & non-empty
  const desc = attr(html, /<meta[^>]*name="description"[^>]*content="([^"]*)"/i);
  W(!!desc && desc.trim().length > 0, "description missing or empty");

  // WARN 8 body-size floor
  W(html.length >= BODY_FLOOR, `body size ${html.length} < floor ${BODY_FLOOR}`);

  return out;
}

// ── run ─────────────────────────────────────────────────────────────────────
async function main() {
  const parts = (await loadParts()).filter(isIndexable);
  const set = parts.map(p => ({ id: p.id, cat: p.c, route: productPath(p) })).filter(x => x.route);

  let checked = 0, missing = 0;
  const hardCounts = {}, warnCounts = {};
  const hardSamples = [], warnSamples = [];
  let shellHits = 0;                        // pages tripping check 4 or 5, regardless of current severity

  for (const { id, cat, route } of set) {
    const file = path.join(DIST, route.replace(/^\//, ""), "index.html");
    if (!fs.existsSync(file)) { missing++; continue; }
    checked++;
    const html = fs.readFileSync(file, "utf8");
    const { hard, warn } = assertPage(html, SITE + route);

    // count shell-specific hits independent of severity toggle
    if (/"@type"\s*:\s*"Product"/.test(html) === false ||
        /Skip the shop visit/i.test(html) || /Product Not Found/i.test(html)) shellHits++;

    for (const m of hard) { const k = m.split(":")[0]; hardCounts[k] = (hardCounts[k] || 0) + 1;
      if (hardSamples.length < 20) hardSamples.push(`id=${id} [${cat}] ${route} — ${m}`); }
    for (const m of warn) { const k = m.split(":")[0] || m.slice(0, 12); warnCounts[k] = (warnCounts[k] || 0) + 1;
      if (warnSamples.length < 12) warnSamples.push(`id=${id} [${cat}] ${route} — ${m}`); }
  }

  const hardTotal = Object.values(hardCounts).reduce((a, b) => a + b, 0);
  const warnTotal = Object.values(warnCounts).reduce((a, b) => a + b, 0);

  console.log("── verify-prerender ─────────────────────────────────────────");
  console.log(`HARD checks: 1 robots · 2 head-tag-integrity(title/og:title/canonical/robots) · 3 canonical-self-ref · 4 product-body(Product JSON-LD) · 5 no-shell/error-leak`);
  console.log(`WARN checks: 6 og:url==canonical · 7 description-present · 8 body-size-floor(${BODY_FLOOR})`);
  console.log(`indexable render set: ${set.length} | checked (file present): ${checked} | missing/uncovered: ${missing}`);
  console.log(`shell-detection hits (checks 4|5, ${SHELL_CHECKS_HARD ? "HARD" : "WARN"}): ${shellHits}`);
  console.log(`\nHARD violations: ${hardTotal}`);
  for (const [k, n] of Object.entries(hardCounts).sort((a, b) => b[1] - a[1])) console.log(`  ✗ ${k}: ${n}`);
  hardSamples.forEach(s => console.log(`     ${s}`));
  console.log(`\nWARN violations: ${warnTotal}`);
  for (const [k, n] of Object.entries(warnCounts).sort((a, b) => b[1] - a[1])) console.log(`  ! ${k}: ${n}`);
  warnSamples.forEach(s => console.log(`     ${s}`));

  if (hardTotal > 0) {
    console.error(`\n██ verify-prerender FAILED: ${hardTotal} hard violation(s) — dist BLOCKED ██`);
    process.exit(1);
  }
  console.log(`\n✓ verify-prerender passed: ${checked} pages, 0 hard violations (${warnTotal} warns).`);
  process.exit(0);
}

module.exports = { assertPage, canonicalHref, countTag, RE, SHELL_CHECKS_HARD, BODY_FLOOR };

if (require.main === module) {
  main().catch(e => { console.error("verify-prerender crashed:", e); process.exit(1); });
}
