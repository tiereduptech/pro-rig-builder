/**
 * merge-to-parts.js — merge DataForSEO-enriched products into src/data/parts.js
 *
 * Input:  catalog-build/enriched/*.json  (2,977 discovered products)
 *         src/data/parts.js              (582 existing hand-curated products)
 *
 * Output: src/data/parts.js              (updated, backed up first)
 *
 * Behavior:
 *   - Reads all 10 category files from catalog-build/enriched/
 *   - Reads existing parts.js products
 *   - Dedupes new products against existing ones (by ASIN first, then by brand+name)
 *   - Assigns new IDs starting at 6000 (existing use 5000-5999)
 *   - Converts to existing schema (id, n, img, c, b, pr, msrp, r, deals, etc.)
 *   - Lifts category-specific specs (socket/chipset/capacity/etc) to top-level fields
 *   - Writes updated parts.js, preserving existing products
 *   - Backs up original to src/data/parts.js.backup-{timestamp}
 *
 * USAGE:
 *   node merge-to-parts.js --dry-run   # preview only, don't write
 *   node merge-to-parts.js             # execute merge
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'fs';
import { join } from 'path';

// Prefer enriched-v2 (with full Amazon specs) if it exists, fall back to enriched (title-only)
const ENRICHED_DIR = existsSync('./catalog-build/enriched-v2')
  ? './catalog-build/enriched-v2'
  : './catalog-build/enriched';
const PARTS_PATH = './src/data/parts.js';

const args = process.argv.slice(2);
const flags = {
  dryRun: args.includes('--dry-run'),
};

// ─────────────────────────────────────────────────────────────────────────────
// Read existing parts.js
// ─────────────────────────────────────────────────────────────────────────────

async function loadExistingParts() {
  // parts.js uses ES module syntax. Use dynamic import with file:// URL.
  // Handle both `export const PARTS = [...]` and `export default [...]` patterns.
  const path = `file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`;
  const mod = await import(path);
  // Prefer named PARTS export (what App.jsx imports), fall back to default
  return mod.PARTS || mod.default || mod.parts || Object.values(mod).find(v => Array.isArray(v));
}

// ─────────────────────────────────────────────────────────────────────────────
// Category mapping: enriched filename → parts.js `c` value
// ─────────────────────────────────────────────────────────────────────────────

const FILE_TO_CATEGORY = {
  'motherboard.json': 'Motherboard',
  'cpu.json':         'CPU',
  'gpu.json':         'GPU',
  'ram.json':         'RAM',
  'storage.json':     'Storage',
  'psu.json':         'PSU',
  'case.json':        'Case',
  'cpucooler.json':   'CPUCooler',
  'monitor.json':     'Monitor',
  'casefan.json':     'CaseFan',
};

// ─────────────────────────────────────────────────────────────────────────────
// Convert enriched product → parts.js schema
// ─────────────────────────────────────────────────────────────────────────────

// Brand canonicalization — collapse case variants like "MSI"/"msi", "Asus"/"ASUS"
// Map of lowercase brand → canonical display form.
const BRAND_CANONICAL = {
  'msi': 'MSI',
  'asus': 'ASUS',
  'gigabyte': 'Gigabyte',
  'asrock': 'ASRock',
  'nzxt': 'NZXT',
  'evga': 'EVGA',
  'pny': 'PNY',
  'zotac': 'ZOTAC',
  'xfx': 'XFX',
  'xpg': 'XPG',
  'adata': 'ADATA',
  'wd': 'WD',
  'sk hynix': 'SK Hynix',
  'hp': 'HP',
  'lg': 'LG',
  'aoc': 'AOC',
  'ktc': 'KTC',
  'amd': 'AMD',
  'intel': 'Intel',
  'fsp': 'FSP',
  'benq': 'BenQ',
  'viewsonic': 'ViewSonic',
  'inno3d': 'INNO3D',
  'teamgroup': 'TeamGroup',
  'be quiet!': 'be quiet!',
  'be quiet': 'be quiet!',
  'g.skill': 'G.Skill',
  'gskill': 'G.Skill',
  'id-cooling': 'ID-COOLING',
  'idcooling': 'ID-COOLING',
  'endorfy': 'ENDORFY',
  'powercolor': 'PowerColor',
  'sapphire': 'Sapphire',
  'gainward': 'Gainward',
  'galax': 'Galax',
  'kingston': 'Kingston',
  'corsair': 'Corsair',
  'crucial': 'Crucial',
  'patriot': 'Patriot',
  'silicon power': 'Silicon Power',
  'samsung': 'Samsung',
  'seagate': 'Seagate',
  'sabrent': 'Sabrent',
  'western digital': 'WD',
  'lexar': 'Lexar',
  'addlink': 'Addlink',
  'solidigm': 'Solidigm',
  'netac': 'Netac',
  'sandisk': 'SanDisk',
  'seasonic': 'Seasonic',
  'thermaltake': 'Thermaltake',
  'silverstone': 'SilverStone',
  'cooler master': 'Cooler Master',
  'coolermaster': 'Cooler Master',
  'montech': 'Montech',
  'super flower': 'Super Flower',
  'superflower': 'Super Flower',
  'lian li': 'Lian Li',
  'lianli': 'Lian Li',
  'fractal design': 'Fractal Design',
  'fractal': 'Fractal Design',
  'hyte': 'HYTE',
  'phanteks': 'Phanteks',
  'deepcool': 'Deepcool',
  'darkrock': 'DARKROCK',
  'musetex': 'MUSETEX',
  'jonsbo': 'Jonsbo',
  'antec': 'Antec',
  'segotep': 'Segotep',
  'sama': 'SAMA',
  'inwin': 'InWin',
  'in win': 'InWin',
  'gamdias': 'Gamdias',
  'aerocool': 'Aerocool',
  'raidmax': 'Raidmax',
  'noctua': 'Noctua',
  'arctic': 'Arctic',
  'thermalright': 'Thermalright',
  'dell': 'Dell',
  'alienware': 'Alienware',
  'acer': 'Acer',
  'philips': 'Philips',
  'innocn': 'Innocn',
  'sceptre': 'Sceptre',
  'sansui': 'Sansui',
  'cocopar': 'cocopar',
  'amazon basics': 'Amazon Basics',
  'koorui': 'Koorui',
  'viotek': 'Viotek',
  'pixio': 'Pixio',
  'titan army': 'Titan Army',
  'biostar': 'Biostar',
  'gigastone': 'Gigastone',
  'timetec': 'Timetec',
  'oloy': 'OLOy',
  'a-tech': 'A-Tech',
  'atech': 'A-Tech',
  'yeston': 'Yeston',
  'machinist': 'MACHINIST',
  'inland': 'INLAND',
  'supermicro': 'Supermicro',
  'shangzhaoyuan': 'SHANGZHAOYUAN',
  'stonestorm': 'StoneStorm',
  'micro center': 'Micro Center',
  'microcenter': 'Micro Center',
};

function canonicalizeBrand(b) {
  if (!b || typeof b !== 'string') return b;
  const trimmed = b.trim();
  const lower = trimmed.toLowerCase();
  if (BRAND_CANONICAL[lower]) return BRAND_CANONICAL[lower];
  // Unknown brand — return title-cased version (first letter of each word uppercase)
  return trimmed.replace(/\b\w/g, c => c.toUpperCase());
}

// ─────────────────────────────────────────────────────────────────────────────
// Socket canonicalization — collapse variants like "LGA 1718" + "AMD AM5"
//
// Each CPU socket has ONE canonical name. Amazon & vendors use many aliases:
//   AM5 physical socket = LGA 1718 technical name
//   Some listings prefix "AMD" or "Intel" unnecessarily
//   Some add variants like "LGA 1851RL-ILM" (regional) — normalize to base
// ─────────────────────────────────────────────────────────────────────────────

function canonicalizeSocket(s) {
  if (!s || typeof s !== 'string') return s;
  // Uppercase, strip "Socket" prefix (including foreign: "SOQUET" = Spanish/French "socket")
  // Remove "AMD "/"Intel " prefix, strip whitespace AND hyphens
  let v = s.toUpperCase().trim();
  v = v.replace(/^SOCKET\s+/, '');
  v = v.replace(/^SOQUET[EA]?\s*/, ''); // "SOQUET AM4" or mangled "SOQUETEAM4"
  v = v.replace(/^(AMD|INTEL)\s+/, '');
  v = v.replace(/[\s\-]/g, ''); // "LGA 1700", "LGA-1700" → "LGA1700"

  // AM5 family (AM5 = LGA 1718 physical spec)
  if (/^AM5$/.test(v))           return 'AM5';
  if (/^LGA1718/.test(v))        return 'AM5';  // Catches LGA1718, LGA1718(SOCKETAM5), etc.

  // AM4 family
  if (/^AM4$/.test(v))           return 'AM4';

  // Intel LGA 1851 family (Core Ultra current)
  if (/^LGA1851/.test(v))        return 'LGA1851';   // Catches LGA1851, LGA1851RL-ILM
  if (/^1851$/.test(v))          return 'LGA1851';

  // Intel LGA 1700 family (12/13/14 gen)
  if (/^LGA1700/.test(v))        return 'LGA1700';

  // Older Intel sockets — keep as-is but normalized
  if (/^LGA1200$/.test(v))       return 'LGA1200';
  if (/^LGA1151$/.test(v))       return 'LGA1151';
  if (/^LGA1150$/.test(v))       return 'LGA1150';
  if (/^LGA1155$/.test(v))       return 'LGA1155';
  if (/^LGA1156$/.test(v))       return 'LGA1156';

  // HEDT/workstation — keep
  if (/^LGA2066$/.test(v))       return 'LGA2066';
  if (/^LGA2011[-]?3?$/.test(v)) return 'LGA2011-3';
  if (/^STR5$/.test(v))          return 'sTR5';
  if (/^TR4$/.test(v))           return 'TR4';

  // B850/X870/etc. are CHIPSETS not sockets — data error, just return null so it doesn't pollute socket filter
  if (/^B\d{3}$|^X\d{3}$|^A\d{3}$|^H\d{3}$|^Z\d{3}$/.test(v)) return null;

  // Re-space LGA variants we didn't catch above
  if (/^LGA\d+$/.test(v))        return 'LGA' + v.slice(3); // "LGA1850" stays as LGA1850

  // Unknown — return as-is but cleaned up
  return v.replace(/^LGA/, 'LGA ');
}

function toPartsSchema(enriched, nextId) {
  // listPrice: if enriched-v2 has listPrice, use it as MSRP; else use current
  const msrp = enriched.listPrice || enriched.price;

  const p = {
    id: nextId,
    n: enriched.name || enriched.fullTitle?.slice(0, 90) || 'Unknown',
    img: enriched.imageUrl,
    c: enriched.category,
    b: canonicalizeBrand(enriched.brand) || 'Unknown',
    pr: enriched.price,
    msrp,
    r: enriched.rating || 0,
    asin: enriched.asin,        // preserve ASIN for future refresh lookups
    reviews: enriched.reviews,
    deals: {
      amazon: {
        price: enriched.price,
        url: enriched.amazonUrl,
        inStock: enriched.isAvailable !== false, // v2 gives explicit signal; v1 we assume true
      },
    },
  };

  // Capture v2 fields if present (discount/UPC/dimensions etc.)
  // Skip description — bloats parts.js and users won't read it; Amazon has it.
  if (enriched.percentageDiscount) p.discount = enriched.percentageDiscount;
  if (enriched.additionalImages?.length) p.additionalImages = enriched.additionalImages.slice(0, 3);

  // Lift category-specific specs to top-level fields (matching existing schema)
  const specs = enriched.specs || {};

  // Common extended fields available on v2 (from Amazon product_information table)
  if (specs.upc)         p.upc = specs.upc;
  if (specs.modelNumber) p.mpn = specs.modelNumber;
  if (specs.weight)      p.weight = specs.weight;
  if (specs.dimensions)  p.dimensions = specs.dimensions;

  switch (enriched.category) {
    case 'Motherboard':
      if (specs.socket)     p.socket = canonicalizeSocket(specs.socket);
      if (specs.chipset)    p.chipset = specs.chipset;
      if (specs.formFactor) p.formFactor = specs.formFactor;
      if (specs.memType)    p.memType = specs.memType;
      if (specs.maxMem)     p.maxMem = specs.maxMem;
      if (specs.memSlots)   p.memSlots = specs.memSlots;
      break;
    case 'CPU':
      if (specs.socket)     p.socket = canonicalizeSocket(specs.socket);
      if (specs.cores)      p.cores = specs.cores;
      if (specs.threads)    p.threads = specs.threads;
      if (specs.baseClock)  p.baseClock = specs.baseClock;
      if (specs.boostClock) p.boostClock = specs.boostClock;
      if (specs.tdp)        p.tdp = specs.tdp;
      if (specs.arch)       p.arch = specs.arch;
      if (specs.model)      p.model = specs.model;
      if (specs.series)     p.series = specs.series;
      break;
    case 'GPU':
      if (specs.model)      p.model = specs.model;
      if (specs.vram)       p.vram = specs.vram;
      if (specs.vramType)   p.vramType = specs.vramType;
      if (specs.chipset)    p.chipset = specs.chipset;
      if (specs.interface)  p.interface = specs.interface;
      if (specs.generation) p.generation = specs.generation;
      if (specs.fans)       p.fans = specs.fans;
      if (specs.rgb !== undefined) p.rgb = specs.rgb;
      if (specs.color)      p.color = specs.color;
      break;
    case 'RAM':
      if (specs.type || specs.memType) p.memType = specs.type || specs.memType;
      // Prefer kit format "2x16GB" over flat total "32GB" for capacity display
      // NB: App.jsx uses "cap" field (SF.cap formatter), not "capacity"
      p.cap = specs.kit || specs.capacity;
      if (specs.speed)      p.speed = specs.speed;
      // App.jsx uses "cl" not "cas"
      if (specs.cas)        p.cl = specs.cas;
      break;
    case 'Storage':
      // App.jsx uses "cap" not "capacity"
      if (specs.capacity)   p.cap = specs.capacity;
      if (specs.form)       p.form = specs.form;
      if (specs.pcie)       p.pcie = specs.pcie;
      if (specs.interface)  p.interface = specs.interface;
      if (specs.formFactor) p.formFactor = specs.formFactor;
      if (specs.rpm)        p.rpm = specs.rpm;
      break;
    case 'PSU':
      // App.jsx uses "watts" not "wattage", "eff" not "efficiency"
      if (specs.wattage)    p.watts = specs.wattage;
      if (specs.efficiency) p.eff = specs.efficiency;
      if (specs.modular)    p.modular = specs.modular;
      if (specs.rgb !== undefined) p.rgb = specs.rgb;
      if (specs.color)      p.color = specs.color;
      break;
    case 'Case':
      if (specs.formFactor) p.formFactor = specs.formFactor;
      if (specs.tower)      p.tower = specs.tower;
      // App.jsx uses "tg" (tempered glass) not "glass"
      if (specs.glass)      p.tg = specs.glass;
      if (specs.color)      p.color = specs.color;
      break;
    case 'CPUCooler':
      if (specs.type)          p.coolerType = specs.type;
      // App.jsx uses "radSize" not "radiator"
      if (specs.radiator)      p.radSize = specs.radiator;
      if (specs.noise)         p.noise = specs.noise;
      if (specs.compatibility) p.compatibility = specs.compatibility;
      break;
    case 'Monitor':
      if (specs.size)         p.screenSize = specs.size;  // App.jsx uses "screenSize"
      // App.jsx uses "res" not "resolution"
      if (specs.resolution)   p.res = specs.resolution;
      if (specs.refresh)      p.refresh = specs.refresh;
      if (specs.panel)        p.panel = specs.panel;
      // App.jsx uses "response" not "responseTime"
      if (specs.responseTime) p.response = specs.responseTime;
      if (specs.curved !== undefined) p.curved = specs.curved;
      if (specs.contrast)     p.contrast = specs.contrast;
      break;
    case 'CaseFan':
      if (specs.size)        p.fanSize = specs.size;   // App.jsx uses "fanSize"
      if (specs.rgb !== undefined) p.rgb = specs.rgb;
      if (specs.pwm)         p.pwm = specs.pwm;
      if (specs.pack)        p.fans_inc = specs.pack;  // App.jsx uses "fans_inc" for count
      if (specs.noise)       p.noise = specs.noise;
      if (specs.cfm)         p.cfm = specs.cfm;
      break;
  }

  return p;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dedup keys
// ─────────────────────────────────────────────────────────────────────────────

function existingAsins(parts) {
  const s = new Set();
  for (const p of parts) {
    if (p.asin) s.add(p.asin);
    if (p.deals?.amazon?.url) {
      const m = p.deals.amazon.url.match(/\/dp\/([A-Z0-9]{10})/i);
      if (m) s.add(m[1]);
    }
  }
  return s;
}

function existingNameKeys(parts) {
  const s = new Set();
  for (const p of parts) {
    const key = `${(p.b || '').toLowerCase()}|${(p.n || '').toLowerCase().slice(0, 40)}`;
    s.add(key);
  }
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// Serialize parts array back to JS module source
// ─────────────────────────────────────────────────────────────────────────────

function serializeParts(parts) {
  const body = parts.map(p => '  ' + JSON.stringify(p)).join(',\n');
  return `// Auto-generated + hand-curated PC parts catalog.
// Last merge: ${new Date().toISOString()}
// Total products: ${parts.length}

export const PARTS = [
${body}
];

export default PARTS;
`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n── Merge DataForSEO catalog → parts.js ──\n');

  // Load existing
  const existing = await loadExistingParts();
  console.log(`Existing parts.js:  ${existing.length} products`);

  // Compute max existing ID to allocate new IDs safely
  const maxId = existing.reduce((max, p) => Math.max(max, p.id || 0), 0);
  let nextId = Math.max(maxId + 1, 6000);
  console.log(`Next ID will start at: ${nextId}`);

  // Load enriched files
  if (!existsSync(ENRICHED_DIR)) {
    console.error(`\n✗ Enriched dir not found: ${ENRICHED_DIR}. Run local-enrich.js first.`);
    process.exit(1);
  }

  // Dedup prep
  const asins = existingAsins(existing);
  const nameKeys = existingNameKeys(existing);

  // Process each category file
  const files = readdirSync(ENRICHED_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));

  const newProducts = [];
  const stats = {};

  for (const file of files) {
    const category = FILE_TO_CATEGORY[file];
    if (!category) { console.log(`  ⚠ no category mapping for ${file}, skipping`); continue; }

    const enriched = JSON.parse(readFileSync(join(ENRICHED_DIR, file), 'utf-8'));

    let kept = 0, dupAsin = 0, dupName = 0, noBrand = 0;

    for (const e of enriched) {
      // Skip if we already have this ASIN
      if (e.asin && asins.has(e.asin)) { dupAsin++; continue; }

      // Skip if brand+name collides with existing
      const key = `${(e.brand || '').toLowerCase()}|${(e.name || '').toLowerCase().slice(0, 40)}`;
      if (nameKeys.has(key)) { dupName++; continue; }

      // Skip products with no brand and no strong name — they'll be useless in filter UI
      if (!e.brand) { noBrand++; continue; }

      const product = toPartsSchema(e, nextId++);
      newProducts.push(product);
      asins.add(e.asin);
      nameKeys.add(key);
      kept++;
    }

    stats[category] = { enriched: enriched.length, kept, dupAsin, dupName, noBrand };
    console.log(`  ${category.padEnd(12)} ${enriched.length.toString().padStart(4)} → kept ${kept.toString().padStart(4)}  (dup-asin ${dupAsin}, dup-name ${dupName}, no-brand ${noBrand})`);
  }

  const finalCount = existing.length + newProducts.length;
  console.log(`\nFinal catalog: ${existing.length} existing + ${newProducts.length} new = ${finalCount} total`);

  // Show sample
  if (newProducts.length > 0) {
    console.log('\nSample new product:');
    console.log(JSON.stringify(newProducts[0], null, 2).split('\n').map(l => '  ' + l).join('\n'));
  }

  if (flags.dryRun) {
    console.log('\nDRY RUN — not writing parts.js. Run without --dry-run to execute.');
    return;
  }

  // Backup original
  const backupPath = `${PARTS_PATH}.backup-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  copyFileSync(PARTS_PATH, backupPath);
  console.log(`\nBacked up existing parts.js → ${backupPath}`);

  // Canonicalize brands AND sockets on ALL products (existing + new) so case
  // variants like "GIGABYTE"+"Gigabyte" or socket variants like "AM5"+"LGA 1718"
  // collapse to one filter entry.
  let brandFixed = 0;
  let socketFixed = 0;
  for (const p of existing) {
    const beforeBrand = p.b;
    p.b = canonicalizeBrand(p.b) || p.b;
    if (beforeBrand !== p.b) brandFixed++;

    if (p.socket) {
      const beforeSocket = p.socket;
      const canon = canonicalizeSocket(p.socket);
      if (canon === null) {
        // This was a chipset-in-socket-field data error; remove it
        delete p.socket;
      } else {
        p.socket = canon;
      }
      if (beforeSocket !== p.socket) socketFixed++;
    }
  }
  if (brandFixed > 0)  console.log(`\nNormalized brand casing on ${brandFixed} existing products`);
  if (socketFixed > 0) console.log(`Normalized socket names on ${socketFixed} existing products`);

  // Merge and write
  const merged = [...existing, ...newProducts];
  const source = serializeParts(merged);
  writeFileSync(PARTS_PATH, source);

  const sizeMB = (Buffer.byteLength(source) / 1024 / 1024).toFixed(2);
  console.log(`✓ Wrote ${merged.length} products to ${PARTS_PATH} (${sizeMB} MB)`);

  console.log('\nNext steps:');
  console.log('  1. npm run dev              # verify locally');
  console.log('  2. git add . && git commit  # commit changes');
  console.log('  3. git push                 # trigger Railway deploy');
}

main().catch(e => { console.error('\n✗ FATAL:', e); process.exit(1); });
