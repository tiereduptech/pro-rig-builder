#!/usr/bin/env node
/**
 * import-expansion-cards-bb.js
 *
 * Best Buy only. DataForSEO Merchant API requires task POST + task GET flow
 * (no live endpoint), too complex for this pass.
 *
 * Key changes vs v1:
 *   - Filters loosened (we were throwing out ~80% of valid results)
 *   - Added more query variants per category
 *   - Uses Best Buy category IDs for better targeting on SoundCard + OpticalDrive
 */
import { writeFileSync } from 'node:fs';

const BESTBUY_KEY = process.env.BESTBUY_API_KEY;
if (!BESTBUY_KEY) { console.error('Missing BESTBUY_API_KEY'); process.exit(1); }

const CATEGORIES = {
  SoundCard: {
    queries: [
      'sound card pcie',
      'internal sound card',
      'creative sound blaster',
      'asus xonar sound card',
      'pcie audio card',
    ],
    // Looser matcher: anything with sound/audio/dac + computer/pc/pcie
    accept: (name) => /sound\s*card|sound\s*blaster|audio\s*card|xonar|\bDAC\b|\bamp(?:lifier)?\b/i.test(name)
                   && !/speaker|soundbar|headphone|earbud|microphone|wireless\s*audio/i.test(name),
  },
  EthernetCard: {
    queries: [
      '10gbe pcie ethernet',
      '2.5gbe pcie network',
      'pcie ethernet adapter',
      'pcie network card',
      '10gbe network card',
    ],
    accept: (name) => /ethernet|network\s*(?:interface\s*)?(?:card|adapter)|10gbe|2\.5\s*gbe|5gbe|\bNIC\b|gigabit\s*adapter|PCIe.*LAN/i.test(name)
                   && !/USB|wireless|wi-?fi|bluetooth|switch\b|router\b|cable\b|modem\b/i.test(name),
  },
  OpticalDrive: {
    queries: [
      'internal blu-ray drive',
      'internal dvd writer',
      'dvd-rw internal',
      'internal optical drive',
      'blu-ray burner',
    ],
    accept: (name) => /blu-?ray|DVD|optical\s*drive|CD-?RW|DVD-?RW|disc\s*(?:drive|burner)/i.test(name)
                   && !/external|portable|USB|player\b|movie|\bfilm\b|game\s*console|PS[45]|Xbox|software/i.test(name),
  },
  WiFiCard: {
    queries: [
      'wifi 6e pcie card',
      'wifi 7 pcie adapter',
      'pcie wifi card',
      'pcie wireless adapter',
      'wifi pcie bluetooth',
    ],
    accept: (name) => /wi-?fi|wireless.*(?:card|adapter|pcie)|bluetooth.*adapter|PCIe.*(?:wireless|wifi)/i.test(name)
                   && !/router\b|range\s*extender|mesh|access\s*point|USB\s*(?:3|2|dongle)|keyboard|mouse|speaker|earbud|headphone|camera/i.test(name),
  },
};

async function bbSearch(keyword) {
  const q = encodeURIComponent(keyword);
  const show = 'sku,name,manufacturer,salePrice,regularPrice,customerReviewAverage,customerReviewCount,image,upc,url,modelNumber,onlineAvailability';
  const url = `https://api.bestbuy.com/v1/products((search=${q}))?apiKey=${BESTBUY_KEY}&format=json&pageSize=50&show=${show}&sort=bestSellingRank.asc`;
  const res = await fetch(url);
  if (!res.ok) {
    console.error(`  Best Buy error ${res.status} for "${keyword}"`);
    return [];
  }
  const json = await res.json();
  return json.products || [];
}

let nextId;
function bbToProduct(p, category) {
  if (!p.sku || !p.name) return null;
  if (p.onlineAvailability === false) return null;
  const price = p.salePrice ?? p.regularPrice;
  if (!price || price <= 0) return null;
  return {
    id: nextId++,
    n: p.name.substring(0, 200),
    img: p.image || '',
    c: category,
    b: p.manufacturer || 'Unknown',
    pr: Math.round(price),
    msrp: Math.round(p.regularPrice || price),
    r: p.customerReviewAverage || 0,
    reviews: p.customerReviewCount || 0,
    upc: p.upc || null,
    mpn: p.modelNumber || null,
    deals: {
      bestbuy: {
        price: Math.round(price),
        url: p.url,
        inStock: p.onlineAvailability !== false,
        sku: String(p.sku),
      },
    },
  };
}

function normalizeTitle(s) {
  return String(s).toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
}
function mergeIntoExisting(newProduct, existing) {
  if (newProduct.deals?.bestbuy) existing.deals = { ...(existing.deals || {}), bestbuy: newProduct.deals.bestbuy };
  if (newProduct.upc && !existing.upc) existing.upc = newProduct.upc;
  if (newProduct.mpn && !existing.mpn) existing.mpn = newProduct.mpn;
  if ((newProduct.reviews || 0) > (existing.reviews || 0)) {
    existing.reviews = newProduct.reviews;
    if (newProduct.r) existing.r = newProduct.r;
  }
  if (newProduct.pr && newProduct.pr < existing.pr) existing.pr = newProduct.pr;
}

async function main() {
  const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
  const parts = [...mod.PARTS];
  nextId = Math.max(...parts.map(p => p.id || 0)) + 1;

  const byKey = new Map();
  const byUpc = new Map();
  for (const p of parts) {
    if (!Object.keys(CATEGORIES).includes(p.c)) continue;
    byKey.set(normalizeTitle(p.n), p);
    if (p.upc) byUpc.set(p.upc, p);
  }
  console.log(`Starting ID: ${nextId}`);
  console.log(`Existing products in target categories: ${byKey.size}\n`);

  const imported = {};
  const rejected = {};

  for (const [category, config] of Object.entries(CATEGORIES)) {
    console.log(`━━━ ${category} ━━━`);
    imported[category] = 0;
    rejected[category] = 0;
    const seen = new Set();

    for (const q of config.queries) {
      process.stdout.write(`  "${q}" ... `);
      const results = await bbSearch(q);
      await new Promise(r => setTimeout(r, 500));

      let added = 0;
      for (const bb of results) {
        if (seen.has(bb.sku)) continue;
        seen.add(bb.sku);

        if (!config.accept(bb.name)) { rejected[category]++; continue; }

        const prod = bbToProduct(bb, category);
        if (!prod) { rejected[category]++; continue; }

        const existing = (prod.upc && byUpc.get(prod.upc)) || byKey.get(normalizeTitle(prod.n));
        if (existing) { mergeIntoExisting(prod, existing); continue; }

        parts.push(prod);
        byKey.set(normalizeTitle(prod.n), prod);
        if (prod.upc) byUpc.set(prod.upc, prod);
        imported[category]++;
        added++;
      }
      console.log(`+${added} (${results.length} results)`);
    }
    console.log(`  Total new: ${imported[category]}  rejected: ${rejected[category]}\n`);
  }

  const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
  writeFileSync('./src/data/parts.js', source);

  console.log('━━━ SUMMARY ━━━');
  for (const cat of Object.keys(CATEGORIES)) {
    const total = parts.filter(p => p.c === cat).length;
    console.log(`  ${cat.padEnd(14)} +${imported[cat]} new  = ${total} total`);
  }
  console.log('\nWrote parts.js');
}

main().catch(e => { console.error(e); process.exit(1); });
