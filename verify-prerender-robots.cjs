#!/usr/bin/env node
// HARD GATE — run AFTER prerender, BEFORE committing dist. Exits 1 on any
// violation so CI breaks rather than shipping a de-indexed catalog.
//
// Guards the 2026-07-27 incident: server.cjs serves a 410 GONE_SHELL
// (robots=noindex) for product URLs with no dist file, and the prerender renders
// through it, so every product page silently baked noindex for ~10 days. The fix
// (prerender.cjs restores the indexable directive) is verified here on the actual
// written files — belt and suspenders, because the batched workflow tolerates
// individual prerender exit codes.
//
// Invariant:
//   • every PRODUCT page (dist/parts/<cat>/<slug>-<id>/index.html) and every key
//     indexable page (home, category index, /builder, browse) must NOT contain
//     robots=noindex and MUST contain an index directive.
//   • Missing files are NOT this gate's concern (that's a render-coverage issue).
const fs = require("fs");
const path = require("path");

const DIST = "dist";
const NOINDEX  = /content="noindex"/i;
const INDEXDIR = /name="robots" content="index/i;

function productPages() {
  const base = path.join(DIST, "parts");
  const out = [];
  if (!fs.existsSync(base)) return out;
  const stack = [base];
  while (stack.length) {
    const d = stack.pop();
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) stack.push(p);
      else if (ent.name === "index.html") {
        const parent = path.basename(path.dirname(p));
        if (/-\d+$/.test(parent)) out.push(p);   // <slug>-<id>/index.html
      }
    }
  }
  return out;
}

// A few key non-product pages the user asked to confirm are clean too.
function keyPages() {
  const list = [path.join(DIST, "index.html"), path.join(DIST, "builder", "index.html")];
  const partsDir = path.join(DIST, "parts");
  if (fs.existsSync(partsDir)) {
    for (const ent of fs.readdirSync(partsDir, { withFileTypes: true })) {
      if (ent.isDirectory()) {
        const idx = path.join(partsDir, ent.name, "index.html");   // category index
        if (fs.existsSync(idx)) list.push(idx);
      }
    }
  }
  return list.filter(f => fs.existsSync(f));
}

function check(files, label) {
  let noindex = 0, missingIndex = 0;
  const bad = [];
  for (const f of files) {
    const h = fs.readFileSync(f, "utf8");
    const ni = NOINDEX.test(h), hasIdx = INDEXDIR.test(h);
    if (ni || !hasIdx) {
      if (ni) noindex++; if (!hasIdx) missingIndex++;
      if (bad.length < 15) bad.push(`${f} ${ni ? "[noindex]" : ""}${!hasIdx ? "[no-index-directive]" : ""}`);
    }
  }
  console.log(`  ${label}: ${files.length} checked | noindex=${noindex} | missing-index-directive=${missingIndex}`);
  bad.forEach(b => console.log(`     ✗ ${b}`));
  return noindex + missingIndex;
}

const products = productPages();
const keys = keyPages();
console.log("── robots gate ──────────────────────────────────────────");
if (products.length === 0) {
  console.error("  ✗ no product pages found under dist/parts — prerender did not run? FAILING.");
  process.exit(1);
}
const pv = check(products, "product pages");
const kv = check(keys, "key pages (home / category / builder)");

if (pv + kv > 0) {
  console.error(`\n██ ROBOTS GATE FAILED: ${pv + kv} page(s) violate the indexable invariant — dist BLOCKED ██`);
  process.exit(1);
}
console.log(`\n✓ robots gate passed: ${products.length} product + ${keys.length} key pages all indexable (no noindex).`);
process.exit(0);
