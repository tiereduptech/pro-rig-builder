#!/usr/bin/env node
/**
 * rematch-musetex.js — with a tight case-only filter so we don't
 * match to fans/coolers/accessories.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

function stripBrand(name, brand) {
  return name.replace(new RegExp(`^\\s*${brand}\\s+`, 'i'), '').trim();
}

function hasModelCode(name, brand) {
  const rest = stripBrand(name, brand);
  const words = rest.split(/[\s,.]+/).slice(0, 4);
  for (const w of words) {
    if (w.length >= 2 && /[A-Za-z]/.test(w) && /\d/.test(w)) return true;
  }
  if (words.length >= 2 && /^[A-Za-z]+$/.test(words[0]) && /^\d+$/.test(words[1])) return true;
  const head = rest.slice(0, 50);
  if (/\b(?:iCUE|Meshify|Define|Torrent|Pop|North|Terra|Ridge|Mood|Era|Epoch|Lancool|Eclipse|Evolv|Enthoo|Shadow|Silent|Pure|Dark|Light|Hyperion|Vector|Vision|Dynamic|Elite|Compact|Versa|Sekira|Classico|Morpheus|Aqua|Mirage|Cypress|MiniArt|FLOATRON|Air\s+Cross|AQUA\s+UNO)\b/i.test(head)) return true;
  return false;
}

function tokenize(text) {
  const t = String(text).toLowerCase();
  const fanMatch = t.match(/(\d+)\s*(?:×|x)?\s*(?:\d+\s*mm\s*)?(?:pwm\s*|argb\s*|non[\s-]?pwm\s*|non[\s-]?led\s*|3[\s-]?pin\s*)*fans?/);
  return {
    fanCount: fanMatch ? parseInt(fanMatch[1], 10) : null,
    wood: /walnut|wood/.test(t),
    argb: /argb/.test(t),
    rgb: /\brgb\b/.test(t) && !/argb/.test(t),
    typeC: /type[\s-]?c/.test(t),
    vertical: /vertical\s*gpu/.test(t),
    rad360: /360\s*mm/.test(t),
    rad240: /240\s*mm/.test(t),
    mesh: /polygonal\s*mesh|mesh\s*(?:front|panel|computer)/.test(t),
    fullView: /270\s*°?\s*full[\s-]*view|full[\s-]*view/.test(t),
    eatx: /\be[\s-]?atx\b/.test(t),
    matx: /\bm[\s-]?atx\b|micro[\s-]?atx/.test(t),
    itx: /mini[\s-]?itx|\bitx\b/.test(t) && !/m[\s-]?atx/.test(t),
  };
}

function similarity(a, b) {
  let score = 0, total = 0;
  if (a.fanCount !== null && b.fanCount !== null) {
    total += 3;
    if (a.fanCount === b.fanCount) score += 3;
  }
  for (const key of ['wood', 'argb', 'rgb', 'typeC', 'vertical', 'rad360', 'rad240', 'mesh', 'fullView']) {
    total += 1;
    if (a[key] === b[key]) score += 1;
  }
  for (const key of ['eatx', 'matx', 'itx']) {
    if (a[key] || b[key]) {
      total += 2;
      if (a[key] === b[key]) score += 2;
    }
  }
  return total === 0 ? 0 : score / total;
}

// ─── LOAD + FILTER MUSETEX CASES (STRICT) ────────────────────────────────────
const p = './catalog-build/shopify-scrape/MUSETEX.json';
if (!existsSync(p)) {
  console.error('MUSETEX cache not found');
  process.exit(1);
}
const all = JSON.parse(readFileSync(p, 'utf8'));
console.log(`Total MUSETEX Shopify products: ${all.length}`);

// Strict filter: must be a case, not a fan/cooler/PSU/accessory
const cases = all.filter(x => {
  const title = (x.title || '').toLowerCase();
  // Exclude non-cases
  if (/\bliquid\s*(?:cpu\s*)?cooler\b|\bpower\s*supply\b|\bpsu\b|\bcpu\s*cooler\b|reversed[\s-]?blade|\bpc\s*fans?\b|\bargb\s*controller\b|\bfan\s*controller\b|cable\s*for\s*fan|\bmobile\b|\bphone\b/.test(title)) return false;
  // Must affirmatively be a case
  return /\bpc\s*case\b|\bcomputer\s*case\b|\batx\s*case\b|\b(?:mid|full|mini)\s*tower\b|\bchassis\b/.test(title);
});
console.log(`After case-only filter: ${cases.length}`);
console.log(`Sample cases: ${cases.slice(0, 3).map(c => c.title.slice(0, 60)).join(' | ')}`);

function extractSku(title) {
  const m = title.match(/^([A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+)\b/);
  if (m) return m[1];
  const m2 = title.match(/^[A-Z]+\s+([A-Z][A-Z0-9]*\d+[A-Z0-9]*)\b/);
  if (m2) return m2[1];
  return null;
}

// ─── MATCH MUSETEX UNMATCHED PRODUCTS ────────────────────────────────────────
const results = [];
const misses = [];
const usedSkus = new Set();

for (const prod of parts) {
  if (prod.c !== 'Case') continue;
  if ((prod.b || '').toUpperCase() !== 'MUSETEX') continue;
  if (hasModelCode(prod.n, prod.b)) continue;

  const pt = tokenize(prod.n);
  let best = null, bestScore = 0;
  for (const c of cases) {
    const sku = extractSku(c.title);
    if (!sku || usedSkus.has(sku)) continue;
    const ct = tokenize(c.title);
    const s = similarity(pt, ct);
    if (s > bestScore) { bestScore = s; best = c; }
  }

  if (best && bestScore >= 0.45) {
    const sku = extractSku(best.title);
    usedSkus.add(sku);
    prod.n = `MUSETEX ${sku} — ${stripBrand(prod.n, prod.b)}`;
    results.push({ sku, score: bestScore.toFixed(2), name: prod.n.slice(0, 95), source: best.title.slice(0, 70) });
  } else {
    misses.push({ score: bestScore.toFixed(2), src: stripBrand(prod.n, prod.b).slice(0, 70), best: best?.title?.slice(0, 70) });
  }
}

console.log('\n━━━ RESULTS ━━━');
console.log(`Matched: ${results.length}, Missed: ${misses.length}`);
for (const x of results) {
  console.log(`  ✓ [${x.sku}] score=${x.score}`);
  console.log(`      ${x.name}`);
  console.log(`      ← ${x.source}`);
}
for (const x of misses) {
  console.log(`  ✗ best score=${x.score}`);
  console.log(`      src:  ${x.src}`);
  console.log(`      best: ${x.best}`);
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
