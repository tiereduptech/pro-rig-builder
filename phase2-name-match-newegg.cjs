/**
 * phase2-name-match-newegg.cjs — Backfill UPC + Newegg deals on no-UPC products via name matching
 *
 * For each no-UPC product in parts.js:
 *   1. Search the Newegg SFTP feed
 *   2. Filter to same category + same brand
 *   3. Compute name similarity (0.93+ required)
 *   4. Check model tokens match
 *   5. Check distinguishing words (PRO, MAX, X3D, etc.) match
 *   6. If confident: backfill UPC, MPN, add deals.newegg (+ openbox if available)
 *
 * USAGE:
 *   node phase2-name-match-newegg.cjs           # generate report
 *   node phase2-name-match-newegg.cjs --apply   # apply (after review)
 */

const fs = require('fs');
const zlib = require('zlib');
const readline = require('readline');

const APPLY = process.argv.includes('--apply');

const FEED_PATH = 'catalog-build/feeds/44583/44583_4681679_mp.txt.gz';
const ORDER = [
  'sku','product_name','newegg_item_number','primary_category',
  'secondary_categories','product_url','image_url','is_deleted',
  'short_description','long_description','discount','discount_type',
  'sale_price','retail_price','begin_date','end_date',
  'manufacturer','shipping','keywords','mpn',
  'brand2','is_product_link','availability','upc',
  'class_id','currency','buy_url','pixel_tag',
];

// ─── Tokenization & similarity (same as dedupe) ───
function tokenize(s) {
  return String(s || '').toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

function nameSim(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  const containment = common / Math.min(ta.size, tb.size);
  const jaccard = common / (ta.size + tb.size - common);
  return Math.max(containment, jaccard);
}

function extractModelTokens(name) {
  const tokens = tokenize(name);
  return tokens.filter(t => {
    if (t.length < 3) return false;
    return /[a-z]/.test(t) && /\d/.test(t);
  });
}

function modelTokensMatch(nameA, nameB) {
  const ta = new Set(extractModelTokens(nameA));
  const tb = new Set(extractModelTokens(nameB));
  if (!ta.size || !tb.size) return false;
  const smaller = ta.size <= tb.size ? ta : tb;
  const larger = ta.size > tb.size ? ta : tb;
  for (const t of smaller) if (!larger.has(t)) return false;
  return true;
}

// Distinguisher words (same as dedupe)
const DISTINGUISHERS = new Set([
  'PRO','PLUS','MAX','MINI','OC','RGB','ARGB','G2','V2','V3','GEN2','GEN3',
  'SUPER','TI','XT','XTX','SLIM','GAMING','WHITE','BLACK','ICE','CORE','SE','LE',
  'ELITE','EDGE','TOMAHAWK','CARBON','STRIX','TUF','PRIME','AORUS','EVA','AERO',
  'AMPLIFY','VENTUS','SUPRIM','TRIO','VANGUARD','EXPERT','ACE','UNIFY','NOVA',
  'FORMULA','EXTREME','HERO','IMPACT','TACHYON','FROZEN','STEEL','NITRO','PULSE',
  'PURE','HELLHOUND','REAPER','DEVIL','TAICHI','PHANTOM','CHALLENGER','AMP','TWIN',
  'PG','WIFI','BTF','LCD','OLED','IPS','VA','TN','X3D','3D','F','KF','KS','XE',
  'K','NON','ULTRA','LITE','OMEGA','SAGE','DELUXE',
]);

function distinguishersMatch(nameA, nameB) {
  const aTokens = new Set(nameA.toUpperCase().split(/[^A-Z0-9]+/));
  const bTokens = new Set(nameB.toUpperCase().split(/[^A-Z0-9]+/));
  for (const d of DISTINGUISHERS) {
    if (aTokens.has(d) !== bTokens.has(d)) return false;
  }
  return true;
}

// ─── Brand normalization ───
function normBrand(b) {
  return String(b || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

// ─── Category classifier (matches sftp-ingest's logic) ───
function classifyCategory(rec) {
  const cat = (rec.primary_category || '').toLowerCase();
  const sub = (rec.secondary_categories || '').toLowerCase();
  const combined = cat + ' ' + sub;
  if (/processor|cpu/i.test(combined) && !/cooler|fan/i.test(combined)) return 'CPU';
  if (/motherboard/i.test(combined)) return 'Motherboard';
  if (/memory|ram|ddr/i.test(combined) && !/storage|ssd|hdd/i.test(combined)) return 'RAM';
  if (/storage|ssd|hard drive|nvme/i.test(combined)) return 'Storage';
  if (/power supply|psu/i.test(combined)) return 'PSU';
  if (/computer case|pc case|tower|chassis/i.test(combined) && !/fan/i.test(combined)) return 'Case';
  if (/cooling.*part|cpu cooler|liquid cooler|aio/i.test(combined)) return 'CPUCooler';
  if (/fan/i.test(combined)) return 'CaseFan';
  if (/monitor|display/i.test(combined)) return 'Monitor';
  if (/graphics|gpu|video card/i.test(combined)) return 'GPU';
  if (/keyboard/i.test(combined)) return 'Keyboard';
  if (/mouse|mice/i.test(combined) && !/pad/i.test(combined)) return 'Mouse';
  if (/headset|headphone/i.test(combined)) return 'Headset';
  if (/webcam/i.test(combined)) return 'Webcam';
  if (/microphone/i.test(combined)) return 'Microphone';
  if (/mouse pad|mousepad/i.test(combined)) return 'MousePad';
  return null;
}

function detectCondition(name) {
  const N = (name || '').toUpperCase();
  if (/\bOPEN[\s\-]?BOX\b/.test(N)) return 'openbox';
  if (/\bREFURB(?:ISHED)?\b|\bRENEWED\b/.test(N)) return 'refurb';
  if (/\bUSED\b|\bPRE[\s\-]?OWNED\b/.test(N)) return 'used';
  return 'new';
}

function priceFromRecord(rec) {
  const sale = parseFloat(rec.sale_price);
  const retail = parseFloat(rec.retail_price);
  if (sale > 0 && retail > 0 && sale < retail) return { price: retail, saleprice: sale };
  if (sale > 0) return { price: sale, saleprice: null };
  if (retail > 0) return { price: retail, saleprice: null };
  return null;
}

// ─── Main ───
(async () => {
  console.log('Phase 2 — Name-match Newegg feed to no-UPC products');
  console.log('Mode:', APPLY ? 'APPLY' : 'REPORT-ONLY');

  // Load parts.js
  const partsMod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...partsMod.PARTS];
  const noUpcActive = parts.filter(p => !p.bundle && !p.needsReview && !p.upc && p.c);

  console.log('No-UPC active products to match:', noUpcActive.length);

  // Index no-UPC products by category for fast lookup
  const noUpcByCat = new Map();
  for (const p of noUpcActive) {
    if (!noUpcByCat.has(p.c)) noUpcByCat.set(p.c, []);
    noUpcByCat.get(p.c).push(p);
  }
  console.log('Categories with no-UPC products:', [...noUpcByCat.keys()].join(', '));

  // Pass 1: scan Newegg feed, collect candidates per no-UPC product
  // For memory: only keep records that could plausibly match (correct category + same brand)
  const productCandidates = new Map(); // partId → { product, matches: [] }
  for (const p of noUpcActive) {
    productCandidates.set(p.id, { product: p, matches: [] });
  }

  console.log('\nScanning Newegg feed...');
  const stream = fs.createReadStream(FEED_PATH).pipe(zlib.createGunzip());
  const rl = readline.createInterface({ input: stream });
  let feedCount = 0;
  let candidateCount = 0;

  for await (const line of rl) {
    if (line.startsWith('HDR|') || line.startsWith('TRL|')) continue;
    feedCount++;
    const f = line.split('|');
    const rec = {};
    ORDER.forEach((k, i) => rec[k] = (f[i] || '').trim());

    const cat = classifyCategory(rec);
    if (!cat) continue;
    if (!noUpcByCat.has(cat)) continue;

    const recBrand = normBrand(rec.manufacturer || rec.brand2);
    if (!recBrand) continue;

    const candidates = noUpcByCat.get(cat);
    for (const part of candidates) {
      const partBrand = normBrand(part.b);
      if (!partBrand || partBrand !== recBrand) continue;

      // Quick name similarity
      const sim = nameSim(rec.product_name, part.n);
      if (sim < 0.93) continue;

      if (!modelTokensMatch(rec.product_name, part.n)) continue;
      if (!distinguishersMatch(rec.product_name, part.n)) continue;

      const pricing = priceFromRecord(rec);
      if (!pricing) continue;

      productCandidates.get(part.id).matches.push({
        rec,
        sim,
        pricing,
        condition: detectCondition(rec.product_name),
      });
      candidateCount++;
    }
  }

  console.log('Feed records scanned:', feedCount);
  console.log('Candidate matches collected:', candidateCount);

  // Pass 2: pick best match per product per condition
  const finalMatches = []; // { product, newegg: bestNew, newegg_openbox: bestOpenbox }
  for (const [partId, entry] of productCandidates) {
    if (!entry.matches.length) continue;

    const byCondition = {};
    for (const m of entry.matches) {
      const key = m.condition;
      // Pick lowest in-stock price, fallback to lowest price
      const inStock = !/out-of-stock|unavailable|no/i.test(m.rec.availability || '');
      m.inStock = inStock;
      const price = m.pricing.saleprice || m.pricing.price;

      const cur = byCondition[key];
      if (!cur) byCondition[key] = m;
      else {
        const curPrice = cur.pricing.saleprice || cur.pricing.price;
        if (inStock && !cur.inStock) byCondition[key] = m;
        else if (cur.inStock && !inStock) {} // keep cur
        else if (price < curPrice) byCondition[key] = m;
      }
    }
    finalMatches.push({ product: entry.product, byCondition });
  }

  console.log('Products with at least one match:', finalMatches.length);

  // Distribution
  const byCat = {};
  finalMatches.forEach(m => byCat[m.product.c] = (byCat[m.product.c]||0)+1);
  console.log('\nBy category:');
  Object.entries(byCat).sort((a,b)=>b[1]-a[1]).forEach(([c,n])=>console.log('  '+c+': '+n));

  // Report
  const report = {
    generatedAt: new Date().toISOString(),
    totalNoUpcProducts: noUpcActive.length,
    matchedProducts: finalMatches.length,
    matches: finalMatches.map(m => ({
      part_id: m.product.id,
      part_name: m.product.n,
      part_brand: m.product.b,
      part_category: m.product.c,
      conditions: Object.fromEntries(
        Object.entries(m.byCondition).map(([cond, match]) => [cond, {
          newegg_sku: match.rec.sku,
          newegg_name: match.rec.product_name.slice(0, 150),
          price: match.pricing.price,
          saleprice: match.pricing.saleprice,
          upc: match.rec.upc,
          mpn: match.rec.mpn,
          similarity: Math.round(match.sim * 100) / 100,
          inStock: match.inStock,
        }])
      ),
    })),
  };
  fs.writeFileSync('phase2-report.json', JSON.stringify(report, null, 2));
  console.log('\nReport written to phase2-report.json');

  console.log('\nFirst 10 matches:');
  finalMatches.slice(0, 10).forEach((m, i) => {
    console.log('---');
    console.log((i+1)+'. ['+m.product.c+'] '+m.product.n.slice(0,90));
    Object.entries(m.byCondition).forEach(([cond, match]) => {
      console.log('   ['+cond+'] sim='+Math.round(match.sim*100)/100+' $'+match.pricing.price+(match.pricing.saleprice?' (sale $'+match.pricing.saleprice+')':'')+' UPC='+match.rec.upc);
      console.log('       Newegg: '+match.rec.product_name.slice(0,110));
    });
  });

  // Apply
  if (APPLY) {
    console.log('\n--- APPLY MODE ---');
    const partById = new Map(parts.map(p => [p.id, p]));
    let backfilled = 0;

    for (const m of finalMatches) {
      const part = partById.get(m.product.id);
      if (!part) continue;
      part.deals = part.deals || {};

      // Backfill UPC/MPN from "new" condition if available, else any
      const preferred = m.byCondition.new || Object.values(m.byCondition)[0];
      if (!part.upc && preferred.rec.upc) part.upc = preferred.rec.upc;
      if (!part.mpn && preferred.rec.mpn) part.mpn = preferred.rec.mpn;

      for (const [cond, match] of Object.entries(m.byCondition)) {
        const fieldKey = cond === 'new' ? 'newegg' : 'newegg_' + cond;
        part.deals[fieldKey] = {
          sku: match.rec.sku,
          price: match.pricing.price,
          ...(match.pricing.saleprice ? { saleprice: match.pricing.saleprice } : {}),
          linkurl: match.rec.product_url || match.rec.buy_url,
          imageurl: match.rec.image_url || undefined,
          inStock: match.inStock,
          matchedAt: new Date().toISOString(),
          matchMethod: 'phase2:name-match',
          matchScore: match.sim,
        };
      }
      backfilled++;
    }

    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log('Backfilled ' + backfilled + ' products');
  }
})();
