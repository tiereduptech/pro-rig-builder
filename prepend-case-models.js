#!/usr/bin/env node
/**
 * prepend-case-models.js
 *
 * For cases whose product name doesn't display a model code, match them
 * to scraped manufacturer data and prepend the SKU. Then re-run the
 * case spec dictionary since enhanced names will match more patterns.
 *
 * Only touches cases in MUSETEX, DARKROCK, FOIFKIN, DARKFLASH, OKINOS.
 * Skips any case that already has a recognizable model code in its name.
 *
 * Uses pre-scraped data in ./catalog-build/shopify-scrape/{BRAND}.json
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// ─── LOAD SCRAPED SHOPIFY DATA ───────────────────────────────────────────────
function loadCache(brand) {
  const f = `./catalog-build/shopify-scrape/${brand}.json`;
  if (!existsSync(f)) return [];
  return JSON.parse(readFileSync(f, 'utf8'));
}

const shopifyData = {
  MUSETEX:  loadCache('MUSETEX'),
  DARKROCK: loadCache('DARKROCK'),
};

// ─── DETECT IF NAME ALREADY HAS A MODEL CODE ─────────────────────────────────
function stripBrand(name, brand) {
  const re = new RegExp(`^\\s*${brand}\\s+`, 'i');
  return name.replace(re, '').trim();
}

function hasModelCode(name, brand) {
  const rest = stripBrand(name, brand);

  // SKU-like token at start (e.g., "EC2", "F600", "H9 Flow", "Y60", "XR-B",
  // "NR200", "O11", "iCUE 7000X"). Must have at least one digit.
  const firstWord = rest.split(/[\s,.]/)[0];
  if (/[A-Za-z]/.test(firstWord) && /\d/.test(firstWord) && firstWord.length >= 2) {
    return true;
  }
  // Known named-series tokens anywhere in first 30 chars
  const head = rest.slice(0, 40);
  if (/\b(?:iCUE|Meshify|Define|Torrent|Pop|North|Terra|Ridge|Mood|Era|Epoch|Lancool|Eclipse|Evolv|Enthoo|Shadow|Silent|Pure|Dark|Light|Hyperion|Vector|Vision|Dynamic|Flow|Elite|Compact|Mini|Max|KING|AIR|SKY|Versa|Sekira|Classico|Morpheus)\b/i.test(head)) {
    return true;
  }
  return false;
}

// ─── TOKENIZE FOR SIMILARITY MATCHING ────────────────────────────────────────
function tokenize(text) {
  const t = String(text).toLowerCase();
  // Fan count: "6 PWM ARGB fans", "3 x 120mm fans", "7 fans"
  const fanMatch = t.match(/(\d+)\s*(?:x\s*\d+\s*mm\s*)?(?:pwm\s*)?(?:argb\s*)?(?:non[\s-]?led\s*)?fans?/);
  // Color: black/white/pink
  const colorMatch = t.match(/\b(black|white|pink|pure\s*white|pure\s*black)\b/);
  return {
    fanCount: fanMatch ? parseInt(fanMatch[1], 10) : null,
    color: colorMatch ? colorMatch[1].replace(/^pure\s+/, '') : null,
    argb: /argb/.test(t),
    nonLed: /non[\s-]?led/.test(t),
    rgb: /\brgb\b/.test(t) && !/argb/.test(t),
    typeC: /type[\s-]?c/.test(t),
    rad360: /360\s*mm\s*rad/.test(t),
    meshFront: /polygonal\s*mesh|mesh\s*(?:front|panel)/.test(t),
    openingGlass: /opening\s*tempered\s*glass/.test(t),
    fullView: /270\s*°?\s*full[\s-]*view|full[\s-]*view\s*dual\s*tempered/.test(t),
    // Form factor hints
    eatx: /\be[\s-]?atx\b/.test(t),
    matx: /\bm[\s-]?atx\b|micro[\s-]?atx/.test(t),
    itx: /mini[\s-]?itx|\bitx\b/.test(t) && !/matx/.test(t),
  };
}

function similarity(a, b) {
  let score = 0;
  let total = 0;
  // Fan count is a hard constraint — mismatch = instant disqualify
  if (a.fanCount !== null && b.fanCount !== null) {
    if (a.fanCount !== b.fanCount) return 0;
    score += 3;
    total += 3;
  }
  // Color hard constraint
  if (a.color && b.color) {
    if (a.color !== b.color) return 0;
    score += 2;
    total += 2;
  }
  // Feature flags
  for (const key of ['argb', 'nonLed', 'rgb', 'typeC', 'rad360', 'meshFront', 'openingGlass', 'fullView']) {
    total += 1;
    if (a[key] === b[key]) score += 1;
  }
  // Form factor
  for (const key of ['eatx', 'matx', 'itx']) {
    if (a[key] || b[key]) {
      total += 1;
      if (a[key] === b[key]) score += 1;
    }
  }
  return total === 0 ? 0 : score / total;
}

// ─── EXTRACT SKU FROM SHOPIFY TITLE ──────────────────────────────────────────
function extractSku(shopifyTitle) {
  // "Y6-N6-W MUSETEX ATX PC Case..." → "Y6-N6-W"
  // "K2-3-B MUSETEX PC CASE..." → "K2-3-B"
  // "DARKROCK EC2 Black ATX..." → "EC2"
  // "DARKROCK Classico Max ..." → "Classico Max" (no)
  const m = shopifyTitle.match(/^([A-Z][A-Z0-9]+(?:-[A-Z0-9]+)+)\b/);
  if (m) return m[1];
  // Try "BRAND XYZ123" pattern
  const m2 = shopifyTitle.match(/^[A-Z]+\s+([A-Z][A-Z0-9]+\d+[A-Z0-9]*)\b/);
  if (m2) return m2[1];
  return null;
}

// ─── MATCH AND PREPEND ───────────────────────────────────────────────────────
const BRANDS = ['MUSETEX', 'DARKROCK', 'FOIFKIN', 'DARKFLASH', 'OKINOS'];
let prepended = 0;
let skipped = 0;
let noMatch = 0;
const noMatchSamples = [];

for (const p of parts) {
  if (p.c !== 'Case') continue;
  const brand = (p.b || '').toUpperCase();
  if (!BRANDS.includes(brand)) continue;

  // Already has a model code? Leave alone.
  if (hasModelCode(p.n, p.b)) {
    skipped++;
    continue;
  }

  // For brands with Shopify data, try to match
  const shopifyList = shopifyData[brand] || [];
  if (shopifyList.length === 0) {
    noMatch++;
    if (noMatchSamples.length < 5) noMatchSamples.push(`[no data for ${brand}]  ${p.n.slice(0, 70)}`);
    continue;
  }

  const amazonTokens = tokenize(p.n);
  let bestMatch = null;
  let bestScore = 0;

  for (const shop of shopifyList) {
    const shopTokens = tokenize(shop.title);
    const s = similarity(amazonTokens, shopTokens);
    if (s > bestScore) {
      bestScore = s;
      bestMatch = shop;
    }
  }

  if (!bestMatch || bestScore < 0.75) {
    noMatch++;
    if (noMatchSamples.length < 10) {
      noMatchSamples.push(`[${brand}, best=${bestScore.toFixed(2)}]  ${p.n.slice(0, 70)}`);
    }
    continue;
  }

  const sku = extractSku(bestMatch.title);
  if (!sku) {
    noMatch++;
    continue;
  }

  // Prepend: "MUSETEX ATX PC Case..." → "MUSETEX Y6-N6-W — ATX PC Case..."
  const restAfterBrand = stripBrand(p.n, p.b);
  p.n = `${p.b} ${sku} — ${restAfterBrand}`;
  prepended++;
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Prepended SKU to: ${prepended}`);
console.log(`Already had model: ${skipped}`);
console.log(`Could not match:   ${noMatch}`);
if (noMatchSamples.length) {
  console.log('\nSample unmatched:');
  noMatchSamples.forEach(s => console.log('  ' + s));
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
console.log('Next: re-run backfill-case-specs.js to pick up the new SKU-tagged names');
