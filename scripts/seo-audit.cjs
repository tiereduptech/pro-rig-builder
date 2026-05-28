// =============================================================================
//  scripts/seo-audit.cjs
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  Audits every prerendered HTML file under dist/ for SEO health:
//    - <title> present, 30-60 chars (warns >60, fails <10 or missing)
//    - <meta name="description"> present, 120-160 chars (warns outside, fails missing)
//    - <link rel="canonical"> present and absolute
//    - <meta property="og:image"> present
//    - JSON-LD parses (any application/ld+json block is valid JSON)
//    - <body> text content > 500 chars (heuristic: not an empty shell)
//
//  Report: prints a summary to stdout + writes dist/_seo-audit.json.
//  Exit code: 0 if zero failures, 1 if any failures (warns are OK).
//
//  Usage:
//    node scripts/seo-audit.cjs
//    npm run seo:audit
// =============================================================================
const fs = require("fs");
const path = require("path");

const DIST = path.resolve("dist");
const TITLE_MIN = 30;
const TITLE_MAX = 60;
const DESC_MIN = 120;
const DESC_MAX = 160;
const BODY_MIN = 500;

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      // skip noisy asset dirs
      if (/^(assets|downloads|price-history|reviews)$/i.test(e.name)) continue;
      walk(p, out);
    } else if (e.isFile() && p.toLowerCase().endsWith(".html")) {
      out.push(p);
    }
  }
  return out;
}

function htmlDecode(s) {
  if (!s) return "";
  return s
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function extractTitle(html) {
  // Find the LAST <title>...</title> — Helmet appends after the template's <title>
  const re = /<title[^>]*>([\s\S]*?)<\/title>/gi;
  let last = null, m;
  while ((m = re.exec(html))) last = m;
  return last ? htmlDecode(last[1].trim()) : null;
}

function extractMeta(html, name, attr = "name") {
  // case-insensitive; tolerant of attribute order; prefers Helmet (data-rh) when present
  const re = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*>`, "gi");
  let last = null, m;
  while ((m = re.exec(html))) {
    if (m[0].includes('data-rh')) { last = m[0]; break; }
    last = m[0];
  }
  if (!last) return null;
  // Match content="..." or content='...' — respect the OPENING quote to allow the other quote inside
  const cm = last.match(/content="([^"]*)"|content='([^']*)'/i);
  return cm ? htmlDecode(cm[1] !== undefined ? cm[1] : cm[2]) : null;
}

function extractCanonical(html) {
  const re = /<link[^>]+rel=["']canonical["'][^>]*>/gi;
  let last = null, m;
  while ((m = re.exec(html))) {
    if (m[0].includes('data-rh')) { last = m[0]; break; }
    last = m[0];
  }
  if (!last) return null;
  const cm = last.match(/href="([^"]*)"|href='([^']*)'/i);
  return cm ? htmlDecode(cm[1] !== undefined ? cm[1] : cm[2]) : null;
}

function extractBodyText(html) {
  const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (!bodyMatch) return "";
  return bodyMatch[1]
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLdJsonBlocks(html) {
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const blocks = [];
  let m;
  while ((m = re.exec(html))) blocks.push(m[1]);
  return blocks;
}

function countH1(html) {
  const m = html.match(/<h1[\s>]/gi);
  return m ? m.length : 0;
}

// Count distinct internal links (same-site relative hrefs), excluding pure
// anchors and asset/file links. The global footer alone provides ~20, so this
// mainly catches truly orphaned shell pages.
function countInternalLinks(html) {
  const re = /<a[^>]+href=["'](\/[^"'#]*)["']/gi;
  const set = new Set();
  let m;
  while ((m = re.exec(html))) {
    const href = m[1];
    if (/\.(png|jpg|jpeg|svg|webp|ico|css|js|json|xml|exe|woff2?)$/i.test(href)) continue;
    set.add(href.replace(/\/$/, "") || "/");
  }
  return set.size;
}

// Light required-field validation per schema @type. Returns array of problems.
function validateLd(obj) {
  const problems = [];
  const types = Array.isArray(obj) ? obj.map(o => o && o["@type"]) : [obj["@type"]];
  const items = Array.isArray(obj) ? obj : [obj];
  items.forEach(o => {
    if (!o || typeof o !== "object") return;
    const t = o["@type"];
    if (t === "Product") {
      if (!o.name) problems.push("Product missing name");
      const hasOffer = o.offers && (o.offers.price != null || (Array.isArray(o.offers) && o.offers.length));
      const hasRating = o.aggregateRating && o.aggregateRating.ratingValue != null;
      if (!hasOffer && !hasRating) problems.push("Product missing offers and aggregateRating");
      if (o.offers && !Array.isArray(o.offers) && o.offers.price != null && !o.offers.priceCurrency) problems.push("Product offer missing priceCurrency");
    } else if (t === "FAQPage") {
      if (!Array.isArray(o.mainEntity) || !o.mainEntity.length) problems.push("FAQPage missing mainEntity");
    } else if (t === "ItemList") {
      if (!Array.isArray(o.itemListElement) || !o.itemListElement.length) problems.push("ItemList missing itemListElement");
    } else if (t === "BreadcrumbList") {
      if (!Array.isArray(o.itemListElement) || !o.itemListElement.length) problems.push("BreadcrumbList missing itemListElement");
    }
  });
  return problems;
}

function auditFile(file) {
  const html = fs.readFileSync(file, "utf8");
  const rel = path.relative(DIST, file).replace(/\\/g, "/");
  const issues = [];   // fail
  const warnings = []; // pass-with-warning

  const title = extractTitle(html);
  if (!title) issues.push("missing <title>");
  else if (title.length < 10) issues.push(`title too short (${title.length}): "${title}"`);
  else if (title.length < TITLE_MIN) warnings.push(`title ${title.length} chars (<${TITLE_MIN}): "${title}"`);
  else if (title.length > TITLE_MAX) warnings.push(`title ${title.length} chars (>${TITLE_MAX}): "${title}"`);

  const desc = extractMeta(html, "description");
  if (!desc) issues.push("missing meta description");
  else if (desc.length < 50) issues.push(`description too short (${desc.length})`);
  else if (desc.length < DESC_MIN) warnings.push(`description ${desc.length} chars (<${DESC_MIN})`);
  else if (desc.length > DESC_MAX) warnings.push(`description ${desc.length} chars (>${DESC_MAX})`);

  const canon = extractCanonical(html);
  if (!canon) issues.push("missing canonical");
  else if (!/^https?:\/\//.test(canon)) issues.push(`canonical not absolute: ${canon}`);

  const ogImg = extractMeta(html, "og:image", "property");
  if (!ogImg) issues.push("missing og:image");

  const ldBlocks = extractLdJsonBlocks(html);
  if (ldBlocks.length === 0) warnings.push("no JSON-LD blocks");
  ldBlocks.forEach((b, i) => {
    try {
      const parsed = JSON.parse(b);
      for (const p of validateLd(parsed)) issues.push(`JSON-LD: ${p}`);
    } catch (e) {
      issues.push(`JSON-LD #${i + 1} invalid: ${e.message.slice(0, 80)}`);
    }
  });

  const h1n = countH1(html);
  if (h1n === 0) issues.push("missing <h1>");
  else if (h1n > 1) issues.push(`${h1n} <h1> tags (must be exactly 1)`);

  const links = countInternalLinks(html);
  if (links < 3) issues.push(`only ${links} internal links (<3)`);

  const bodyLen = extractBodyText(html).length;
  if (bodyLen < BODY_MIN) issues.push(`body text ${bodyLen} chars (<${BODY_MIN})`);

  return {
    file: rel,
    title: title || null,
    titleLen: title ? title.length : 0,
    descLen: desc ? desc.length : 0,
    canonical: canon || null,
    hasOgImage: !!ogImg,
    ldJsonBlocks: ldBlocks.length,
    h1: h1n,
    internalLinks: links,
    bodyLen,
    issues,
    warnings,
    ok: issues.length === 0,
  };
}

function main() {
  if (!fs.existsSync(DIST)) {
    console.error("X dist/ not found. Run `vite build && node prerender.cjs` first.");
    process.exit(2);
  }

  const files = walk(DIST);
  if (files.length === 0) {
    console.error("X No HTML files found under dist/.");
    process.exit(2);
  }

  console.log(`SEO Audit — ${files.length} HTML files\n${"=".repeat(40)}`);
  const results = files.map(auditFile);

  const failed = results.filter(r => !r.ok);
  const withWarnings = results.filter(r => r.ok && r.warnings.length > 0);

  // Print failures
  if (failed.length > 0) {
    console.log(`\n${failed.length} FILES WITH ISSUES:`);
    const sample = failed.slice(0, 30);
    for (const r of sample) {
      console.log(`  X ${r.file}`);
      for (const i of r.issues) console.log(`      - ${i}`);
    }
    if (failed.length > sample.length) {
      console.log(`  ... and ${failed.length - sample.length} more`);
    }
  }

  // Issue-type aggregate
  const counts = {};
  for (const r of failed) {
    for (const i of r.issues) {
      const key = i.replace(/\([^)]*\)/g, "").replace(/:.*/, "").trim();
      counts[key] = (counts[key] || 0) + 1;
    }
  }
  if (Object.keys(counts).length > 0) {
    console.log("\nISSUE TYPE COUNTS:");
    for (const k of Object.keys(counts).sort((a, b) => counts[b] - counts[a])) {
      console.log(`  ${counts[k].toString().padStart(5)}  ${k}`);
    }
  }

  // Warning summary
  if (withWarnings.length > 0) {
    console.log(`\n${withWarnings.length} files with warnings (length thresholds).`);
  }

  // Persist full report
  const reportPath = path.join(DIST, "_seo-audit.json");
  fs.writeFileSync(reportPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    warned: withWarnings.length,
    counts,
    failures: failed,
    warnings: withWarnings.map(r => ({ file: r.file, warnings: r.warnings })),
  }, null, 2), "utf8");

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Total: ${results.length}`);
  console.log(`Pass:  ${results.length - failed.length}`);
  console.log(`Warn:  ${withWarnings.length}`);
  console.log(`Fail:  ${failed.length}`);
  console.log(`Report: ${path.relative(process.cwd(), reportPath)}`);

  process.exit(failed.length > 0 ? 1 : 0);
}

main();
