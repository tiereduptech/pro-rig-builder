#!/usr/bin/env node
/**
 * rebuild-cases-from-bestbuy.js
 *
 * Authoritative case spec rebuild from Best Buy's Products API.
 *
 * Pipeline:
 *   1. WIPE guessed fields from all Case products (maxGPU, maxCooler, rads,
 *      mobo, fans_inc, drive25, drive35).
 *   2. INDEX existing Best Buy SKUs from each product's deals.bestbuy.url
 *      (extract from prodsku=NNNN query parameter).
 *   3. SEARCH Best Buy for each major brand's PC cases that we don't already
 *      have a SKU for. Match by name similarity. Update SKU on match.
 *   4. FETCH full product details for every case with a Best Buy SKU.
 *   5. APPLY spec fields from API's structured `details` array. No guessing.
 *      Anything not in Best Buy's data stays blank.
 *   6. Save every 10 records. Ctrl-C safe.
 *
 * Env: BESTBUY_API_KEY
 * Usage: railway run node rebuild-cases-from-bestbuy.js [--dry]
 */
import { writeFileSync } from 'node:fs';

const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) { console.error('Missing BESTBUY_API_KEY'); process.exit(1); }

const API = 'https://api.bestbuy.com/v1';
const DRY = process.argv.includes('--dry');
const RATE_DELAY = 250; // 4 req/sec, well under the 5/sec limit

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];
const cases = parts.filter(p => p.c === 'Case');

console.log(`━━━ TOTAL CASES IN CATALOG: ${cases.length} ━━━\n`);

// ═══════════════════════════════════════════════════════════════════════════
// STEP 1: WIPE GUESSED FIELDS
// ═══════════════════════════════════════════════════════════════════════════
const WIPE_FIELDS = ['maxGPU', 'maxCooler', 'rads', 'mobo', 'fans_inc', 'drive25', 'drive35'];
let wiped = 0;
if (!DRY) {
  for (const p of cases) {
    for (const f of WIPE_FIELDS) {
      if (p[f] !== undefined) { delete p[f]; wiped++; }
    }
  }
}
console.log(`STEP 1: ${DRY ? '[dry] would wipe' : 'Wiped'} ${wiped} field values\n`);

function save() {
  if (DRY) return;
  const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
  writeFileSync('./src/data/parts.js', source);
}
save();

// ═══════════════════════════════════════════════════════════════════════════
// STEP 2: INDEX EXISTING BEST BUY SKUs
// ═══════════════════════════════════════════════════════════════════════════
function extractSku(p) {
  if (!p.deals?.bestbuy?.url) return null;
  // URL contains prodsku=NNNNNNN
  const m = p.deals.bestbuy.url.match(/prodsku=(\d+)/);
  return m ? m[1] : null;
}

const existingSkus = new Map(); // product.id → sku
for (const p of cases) {
  const sku = extractSku(p);
  if (sku) existingSkus.set(p.id, sku);
}
console.log(`STEP 2: Found existing Best Buy SKUs for ${existingSkus.size}/${cases.length} cases\n`);

// ═══════════════════════════════════════════════════════════════════════════
// STEP 3: SEARCH BEST BUY FOR ADDITIONAL SKUS BY BRAND
// ═══════════════════════════════════════════════════════════════════════════
// Map our DB brand names to Best Buy manufacturer values
// Best Buy uses uppercase versions for some brands; pass exact match values
const BRAND_MAP = {
  'Corsair': ['CORSAIR'],
  'NZXT': ['NZXT'],
  'Lian Li': ['Lian Li', 'Lian-Li', 'LIAN LI'],
  'Fractal Design': ['Fractal Design'],
  'Phanteks': ['Phanteks'],
  'Thermaltake': ['Thermaltake'],
  'Cooler Master': ['Cooler Master', 'COOLER MASTER'],
  'be quiet!': ['be quiet!'],
  'Jonsbo': ['Jonsbo'],
  'HYTE': ['HYTE'],
  'ASUS': ['ASUS'],
  'MSI': ['MSI'],
  'Antec': ['Antec'],
  'SilverStone': ['SilverStone'],
  'GAMDIAS': ['GAMDIAS'],
  'Montech': ['Montech'],
  'In Win': ['In Win', 'In-Win'],
  'InWin': ['In Win', 'In-Win'],
  'Rosewill': ['Rosewill'],
  'Zalman': ['Zalman'],
  'DIYPC': ['DIYPC'],
  'Okinos': ['Okinos'],
  'Shuttle': ['Shuttle'],
  'TRYX': ['TRYX'],
  'Bluegears': ['Bluegears'],
  'PCCOOLER': ['PCCOOLER'],
  'Supermicro': ['Supermicro'],
  'Panasonic': ['Panasonic'],
  'REDRAGON': ['REDRAGON'],
  'YEYIAN': ['YEYIAN'],
  'GAMEMAX': ['GAMEMAX'],
};

async function searchBestBuyByBrand(manufacturer) {
  // Computer Cases category: abcat0507006
  // Manufacturer match is case-sensitive on Best Buy's side; pass exact value
  const url = `${API}/products(manufacturer=${encodeURIComponent(manufacturer)}&categoryPath.id=abcat0507006)?show=sku,name,modelNumber,manufacturer&pageSize=100&format=json&apiKey=${KEY}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return [];
    const j = await r.json();
    return j.products || [];
  } catch (e) {
    return [];
  }
}

// Find best name match
function tokens(s) {
  return new Set(
    s.toLowerCase()
      .replace(/[^\w\s-]/g, ' ')
      .split(/\s+/)
      .filter(t => t.length > 1 &&
        !['the', 'and', 'with', 'pc', 'case', 'cases', 'mid', 'full', 'tower',
          'gaming', 'computer', 'chassis', 'atx', 'matx', 'itx', 'mini', 'micro',
          'us', 'en', 'series', 'rgb', 'argb', 'tg', 'edition', 'black', 'white',
          'gray', 'grey', 'tempered', 'glass', 'panoramic'].includes(t))
  );
}

function modelTokens(s) {
  return new Set((s.toUpperCase().match(/\b(?:\d{3,4}[A-Z]+|[A-Z]\d{3,4}[A-Z]*)\b/g) || []));
}

function matchScore(productName, candidateName) {
  const a = tokens(productName);
  const b = tokens(candidateName);
  let common = 0;
  for (const t of a) if (b.has(t)) common++;
  const am = modelTokens(productName);
  const bm = modelTokens(candidateName);
  let modelMatch = 0;
  for (const t of am) if (bm.has(t)) modelMatch++;
  return common + modelMatch * 10;
}

// Build a map: brand → array of {sku, name, modelNumber}
console.log('STEP 3: Searching Best Buy for case lineups by brand...');
const brandCatalogs = new Map();
const brandsInDb = [...new Set(cases.map(p => p.b))];
for (const dbBrand of brandsInDb) {
  const bbBrandList = BRAND_MAP[dbBrand];
  if (!bbBrandList) continue;
  let allProducts = [];
  for (const bbBrand of bbBrandList) {
    const products = await searchBestBuyByBrand(bbBrand);
    allProducts = allProducts.concat(products);
    await new Promise(r => setTimeout(r, RATE_DELAY));
  }
  // Dedupe by SKU
  const dedupe = new Map();
  for (const prod of allProducts) {
    if (!dedupe.has(prod.sku)) dedupe.set(prod.sku, prod);
  }
  if (dedupe.size > 0) {
    brandCatalogs.set(dbBrand, [...dedupe.values()]);
    console.log(`  ${dbBrand.padEnd(18)} ${dedupe.size} cases at Best Buy`);
  }
}
console.log('');

// Match each DB case to a Best Buy SKU (use existing SKU if known, else search by name)
const skuFor = new Map(); // product.id → sku
let foundFromExisting = 0, foundFromMatch = 0;
for (const p of cases) {
  if (existingSkus.has(p.id)) {
    skuFor.set(p.id, existingSkus.get(p.id));
    foundFromExisting++;
    continue;
  }
  const catalog = brandCatalogs.get(p.b);
  if (!catalog || !catalog.length) continue;
  let best = { sku: null, score: 0 };
  for (const bb of catalog) {
    const s = matchScore(p.n, bb.name);
    if (s > best.score) best = { sku: bb.sku, score: s };
  }
  if (best.score >= 1) {
    skuFor.set(p.id, best.sku);
    foundFromMatch++;
  }
}
console.log(`STEP 3 RESULT: ${skuFor.size} cases mapped to Best Buy SKUs`);
console.log(`  ${foundFromExisting} from existing deals, ${foundFromMatch} from new matches\n`);

if (DRY) {
  console.log('--dry; exiting before fetching detailed specs');
  process.exit(0);
}

// ═══════════════════════════════════════════════════════════════════════════
// STEP 4-5: FETCH SPECS + APPLY
// ═══════════════════════════════════════════════════════════════════════════
async function fetchProduct(sku) {
  const url = `${API}/products/${sku}.json?show=sku,name,manufacturer,modelNumber,details&apiKey=${KEY}`;
  try {
    const r = await fetch(url);
    if (r.status === 404) return null;
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  }
}

// Convert Best Buy's `details` array → field values
function parseFromDetails(details) {
  if (!details) return {};
  const dmap = {};
  for (const d of details) dmap[d.name.toLowerCase()] = d.value;
  function find(...keys) {
    for (const k of keys) {
      const v = dmap[k.toLowerCase()];
      if (v != null && v !== '') return String(v);
    }
    return null;
  }
  function mmFromString(s) {
    if (!s) return null;
    const m = s.match(/(\d{2,4})\s*(?:millimeter|mm|millimeters)/i);
    return m ? parseInt(m[1], 10) : null;
  }
  function intFromString(s) {
    if (!s) return null;
    const m = String(s).match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  function radSizesFromString(s) {
    if (!s) return [];
    const sizes = new Set();
    const re = /(\d{3})\s*mm/g;
    let m;
    while ((m = re.exec(s)) !== null) sizes.add(parseInt(m[1], 10));
    return [...sizes].sort((a, b) => a - b);
  }
  function moboFromString(s) {
    if (!s) return [];
    const out = [];
    if (/E-?ATX/i.test(s)) out.push('E-ATX');
    if (/(?<![Ee]-)\bATX\b/.test(s)) out.push('ATX');
    if (/Micro-?ATX|mATX|MATX/i.test(s)) out.push('mATX');
    if (/Mini-?ITX|\bITX\b/i.test(s)) out.push('ITX');
    return out;
  }

  const out = {};

  // maxGPU: "Maximum GPU Length = 450 millimeters"
  const gpu = find('Maximum GPU Length', 'Max GPU Length', 'GPU Length', 'GPU Clearance');
  if (gpu) { const v = mmFromString(gpu); if (v) out.maxGPU = v; }

  // maxCooler: "Maximum CPU Cooler Height = 190 millimeters"
  const cool = find('Maximum CPU Cooler Height', 'CPU Cooler Clearance', 'CPU Cooler Height', 'Max CPU Cooler');
  if (cool) { const v = mmFromString(cool); if (v) out.maxCooler = v; }

  // rads: combine "Cooling Support" + "Radiator Support"
  const cs = find('Cooling Support', 'Radiator Support', 'Radiator Compatibility', 'Maximum Radiator');
  if (cs) {
    const sizes = radSizesFromString(cs);
    if (sizes.length) out.rads = sizes;
  }

  // mobo: "Motherboard Form Factor = ATX" — usually a single value, but may list multiple
  // Check several fields
  const mb1 = find('Motherboard Form Factor', 'Motherboard Support');
  const mb2 = find('Form Factor');
  const moboStrs = [mb1, mb2].filter(Boolean).join(' ');
  if (moboStrs) {
    const m = moboFromString(moboStrs);
    if (m.length) out.mobo = m;
  }

  // drive35: "Number Of Internal 3.5\" Bays = 6"
  const d35 = find('Number Of Internal 3.5" Bays', 'Internal 3.5" Drive Bays', 'Internal 3.5" Bays', 'Number of 3.5" Internal Bays');
  if (d35) { const v = intFromString(d35); if (v != null) out.drive35 = v; }

  // drive25
  const d25 = find('Number Of Internal 2.5" Bays', 'Internal 2.5" Drive Bays', 'Internal 2.5" Bays', 'Number of 2.5" Internal Bays');
  if (d25) { const v = intFromString(d25); if (v != null) out.drive25 = v; }

  // fans_inc: "Number of Fans Included = 4"
  const fansInc = find('Number of Fans Included', 'Number Of Fans Included', 'Included Fans');
  if (fansInc) { const v = intFromString(fansInc); if (v != null) out.fans_inc = v; }

  return out;
}

console.log(`STEP 4-5: Fetching ${skuFor.size} product detail pages from Best Buy...\n`);
const stats = { fetched: 0, applied: 0, fields: { maxGPU: 0, maxCooler: 0, rads: 0, mobo: 0, drive25: 0, drive35: 0, fans_inc: 0 } };
let i = 0;
for (const p of cases) {
  const sku = skuFor.get(p.id);
  if (!sku) continue;
  i++;
  const num = `[${i.toString().padStart(3)}/${skuFor.size}]`;
  process.stdout.write(`${num} [${p.b.padEnd(15)}] ${p.n.slice(0, 50).padEnd(52)}`);

  const data = await fetchProduct(sku);
  await new Promise(r => setTimeout(r, RATE_DELAY));
  if (!data) {
    console.log(` (no data)`);
    continue;
  }
  stats.fetched++;
  const fields = parseFromDetails(data.details);
  const got = Object.keys(fields);
  if (!got.length) {
    console.log(` (no spec fields)`);
    continue;
  }
  for (const [k, v] of Object.entries(fields)) {
    if (v == null) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    p[k] = v;
    stats.fields[k] = (stats.fields[k] || 0) + 1;
  }
  stats.applied++;
  console.log(` ✓ ${got.join(',')}`);

  if (i % 10 === 0) save();
}
save();

// ═══════════════════════════════════════════════════════════════════════════
// REPORT
// ═══════════════════════════════════════════════════════════════════════════
console.log(`\n━━━ SUMMARY ━━━`);
console.log(`  Total cases:    ${cases.length}`);
console.log(`  Mapped to BB:   ${skuFor.size}`);
console.log(`  Fetched:        ${stats.fetched}`);
console.log(`  Applied data:   ${stats.applied}`);

console.log(`\n  Field coverage (across all ${cases.length} cases):`);
const final = parts.filter(p => p.c === 'Case');
for (const f of ['maxGPU', 'maxCooler', 'rads', 'mobo', 'drive25', 'drive35', 'fans_inc']) {
  const filled = final.filter(p => p[f] != null && (!Array.isArray(p[f]) || p[f].length > 0)).length;
  const pct = Math.round(filled / final.length * 100);
  console.log(`    ${f.padEnd(12)} ${filled}/${final.length}  (${pct}%)`);
}

console.log(`\n  Coverage by brand (mapped to Best Buy):`);
const byBrand = {};
for (const p of final) {
  if (!byBrand[p.b]) byBrand[p.b] = { total: 0, hasMaxGPU: 0 };
  byBrand[p.b].total++;
  if (p.maxGPU != null) byBrand[p.b].hasMaxGPU++;
}
const sortedBrands = Object.entries(byBrand).sort((a, b) => b[1].total - a[1].total);
for (const [brand, s] of sortedBrands) {
  if (s.total < 3) continue;
  const pct = Math.round(s.hasMaxGPU / s.total * 100);
  console.log(`    ${brand.padEnd(18)} ${s.hasMaxGPU}/${s.total} (${pct}%)`);
}

console.log('\nDone.');
