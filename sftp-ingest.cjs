#!/usr/bin/env node
/**
 * sftp-ingest.cjs â€” Rakuten Product Catalog SFTP ingestion pipeline.
 * 
 * Connects to Rakuten SFTP, walks all directories, downloads new/changed
 * product catalog files (.txt.gz or .xml.gz), parses pipe-delimited or XML,
 * matches against existing parts.js by UPC > MPN > SKU > brand+name, and
 * writes Newegg deals back to parts.js. Newegg-exclusive products go to
 * catalog-build/newegg-exclusives.json for manual review.
 * 
 * Idempotent â€” uses sftp-manifest.json to skip unchanged files.
 * 
 * Required env vars:
 *   RAKUTEN_FTP_HOST     (default: aftp.linksynergy.com)
 *   RAKUTEN_FTP_USER     (default: rkp_4681679)
 *   RAKUTEN_FTP_PASSWORD
 * 
 * CLI flags:
 *   --dry-run        Don't write parts.js, just report
 *   --download-only  Skip parse/match/apply phases
 *   --skip-download  Use existing local files (for re-parsing)
 *   --merchant=44583 Only process this MID (default: all)
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const SftpClient = require('ssh2-sftp-client');

// Capacity guard (shared, ESM) — loaded at startup. Retailer-agnostic guard that
// blocks attaching a deal of a different storage capacity than the product.
const STORAGE_CATS = new Set(['Storage', 'ExternalStorage']);
let CAP = null;
// Newegg first-party-preference + sanity gate (shared ESM, dynamic-imported at startup).
let NEG = null;

const ROOT = __dirname;
const FEED_DIR = path.join(ROOT, 'catalog-build', 'feeds');
const MANIFEST_PATH = path.join(ROOT, 'catalog-build', 'sftp-manifest.json');
const PARTS_PATH = path.join(ROOT, 'src', 'data', 'parts.js');
const EXCLUSIVES_PATH = path.join(ROOT, 'catalog-build', 'newegg-exclusives.json');
const SUMMARY_PATH = path.join(ROOT, 'catalog-build', 'sftp-ingest-summary.json');

const FTP_HOST = process.env.RAKUTEN_FTP_HOST || 'aftp.linksynergy.com';
const FTP_USER = process.env.RAKUTEN_FTP_USER || 'rkp_4681679';
const FTP_PASS = process.env.RAKUTEN_FTP_PASSWORD;
const NEWEGG_MID = '44583';

const args = new Set(process.argv.slice(2));
const DRY_RUN = args.has('--dry-run');
const DOWNLOAD_ONLY = args.has('--download-only');
const SKIP_DOWNLOAD = args.has('--skip-download');
const ONLY_MERCHANT = (process.argv.find(a => a.startsWith('--merchant=')) || '').split('=')[1] || null;
// Phase 2.0 MEASUREMENT ONLY (read-only). In --dry-run, collect up to N exclusive
// records PER CATEGORY into a small sample file so per-category gap sizing and
// field-coverage can be reviewed without a live catalog write. 0 = disabled.
const SAMPLE_PER_CAT = parseInt((process.argv.find(a => a.startsWith('--sample-exclusives=')) || '').split('=')[1] || '0', 10) || 0;
const SAMPLE_PATH = path.join(ROOT, 'catalog-build', 'newegg-exclusives-sample.json');
// { ourCategory -> [records] }, capped at SAMPLE_PER_CAT each; dry-run only.
const exclusiveSample = {};
// Phase 2.0 STREAMING MEASUREMENT (read-only). The full Newegg feed is ~226MB
// gz and does not finish downloading inside the 60-min CI budget (fastGet at
// <64KB/s). This mode streams the feed through gunzip, parses the FIRST N data
// records inline, tallies per-category records/matched/exclusives + a field
// sample, then ABORTS the stream — no full download, no catalog write. Numbers
// are a leading-N sample; per-category totals are extrapolated, not exact.
const MEASURE_FIRST = parseInt((process.argv.find(a => a.startsWith('--measure-first=')) || '').split('=')[1] || '0', 10) || 0;

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
ensureDir(FEED_DIR);

function log(msg) { console.log(`[${new Date().toISOString().substring(11,19)}] ${msg}`); }

function loadManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) return { files: {} };
  try { return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8')); } catch { return { files: {} }; }
}
function saveManifest(m) {
  ensureDir(path.dirname(MANIFEST_PATH));
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(m, null, 2));
}

// â”€â”€â”€ PHASE 1: SFTP DISCOVERY + DOWNLOAD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Only walk these top-level dirs - skip the 200+ locale folders
const WALK_ROOTS = ['/', '/ADDITIONAL', '/GLOBAL/EN-US_USD'];
const SKIP_DIRS = new Set(['/GLOBAL']);

async function walkAndDownload(sftp, manifest) {
  const toProcess = [...WALK_ROOTS];
  const visited = new Set();
  const downloaded = [];

  while (toProcess.length) {
    const dir = toProcess.shift();
    if (visited.has(dir)) continue;
    if (SKIP_DIRS.has(dir)) continue;
    visited.add(dir);

    let entries;
    try { entries = await sftp.list(dir); }
    catch (e) { log(`  Cannot list ${dir}: ${e.message}`); continue; }

    for (const entry of entries) {
      const fullPath = (dir === '/' ? '' : dir) + '/' + entry.name;
      if (entry.type === 'd') {
        if (!SKIP_DIRS.has(fullPath)) toProcess.push(fullPath);
      } else if (entry.type === '-') {
        // Only care about Product Catalog feed files
        if (!/_mp(?:_delta|_MKPL|_delta_MKPL)?(?:_template|_deltatemplate|_template_MKPL|_deltatemplate_MKPL)?\.(txt|xml)\.gz$/i.test(entry.name)) continue;
        // Skip template files - they are schema examples, not real data
        if (/_template/i.test(entry.name)) continue;
        
        // Extract MID from filename
        const midMatch = entry.name.match(/^(\d+)_/);
        const mid = midMatch ? midMatch[1] : 'unknown';
        if (ONLY_MERCHANT && mid !== ONLY_MERCHANT) continue;

        const key = fullPath;
        const prev = manifest.files[key];
        const remoteSize = entry.size;
        const remoteMTime = entry.modifyTime;
        
        if (prev && prev.size === remoteSize && prev.mtime === remoteMTime) {
          log(`  â­  ${entry.name} (unchanged, ${(remoteSize/1024/1024).toFixed(1)}MB)`);
          continue;
        }

        const localDir = path.join(FEED_DIR, mid);
        ensureDir(localDir);
        const localPath = path.join(localDir, entry.name);
        log(`  â¬‡  ${entry.name} (${(remoteSize/1024/1024).toFixed(1)}MB) â†’ ${path.relative(ROOT, localPath)}`);
        await sftp.fastGet(fullPath, localPath);
        manifest.files[key] = { size: remoteSize, mtime: remoteMTime, mid, localPath, downloadedAt: new Date().toISOString() };
        downloaded.push({ mid, localPath, remotePath: fullPath, fileName: entry.name });
      }
    }
  }
  return downloaded;
}

// â”€â”€â”€ PHASE 2: PARSE PIPE-DELIMITED .txt.gz â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function parseTxtFeed(localPath) {
  return new Promise((resolve, reject) => {
    const records = [];
    let header = null;
    let lineNum = 0;
    let trailerCount = null;
    
    const stream = fs.createReadStream(localPath).pipe(zlib.createGunzip());
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    
    rl.on('line', (line) => {
      lineNum++;
      if (!line) return;
      
      // Trailer line: TRL|<count>
      if (line.startsWith('TRL|')) {
        trailerCount = parseInt(line.split('|')[1], 10);
        return;
      }
      
      // Skip HDR metadata line: HDR|<mid>|<merchant>|<timestamp>
      if (line.startsWith('HDR|')) {
        return;
      }
      const fields = line.split('|');
      // Rakuten feeds have no header row, always use positional defaults
      if (!header) {
        header = DEFAULT_FIELD_ORDER;
      }
      
      const rec = {};
      for (let i = 0; i < header.length; i++) {
        rec[header[i]] = (fields[i] || '').trim();
      }
      records.push(rec);
    });
    
    rl.on('close', () => resolve({ records, header, trailerCount, lineNum }));
    rl.on('error', reject);
    stream.on('error', reject);
  });
}

function normalizeFieldName(s) {
  return s.toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

// Default field positions per Rakuten Product Catalog Appendix A (38 fields)
// Used as fallback if header detection fails
const DEFAULT_FIELD_ORDER = [
  'sku', 'product_name', 'newegg_item_number', 'primary_category',
  'secondary_categories', 'product_url', 'image_url', 'is_deleted',
  'short_description', 'long_description', 'discount', 'discount_type',
  'sale_price', 'retail_price', 'begin_date', 'end_date',
  'manufacturer', 'shipping', 'keywords', 'mpn',
  'brand2', 'is_product_link', 'availability', 'upc',
  'class_id', 'currency', 'buy_url', 'pixel_tag',
  'attr_1', 'attr_2', 'attr_3', 'attr_4',
  'attr_5', 'attr_6', 'attr_7', 'attr_8',
  'attr_9', 'attr_10'
];

// â”€â”€â”€ PHASE 3: MATCH FEED RECORDS TO CATALOG â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function normUPC(u) {
  if (!u) return '';
  return String(u).replace(/\D/g, '').replace(/^0+/, '');
}
function normMPN(m) {
  if (!m) return '';
  const cleaned = String(m).toUpperCase().replace(/[\s\-_/]/g, '');
  // Reject MPNs that are too short (would match too many unrelated products)
  if (cleaned.length < 5) return '';
  // Reject pure numbers (often quantity codes/SKU fragments, not real MPNs)
  if (/^\d+$/.test(cleaned)) return '';
  return cleaned;
}
function normBrand(b) {
  if (!b) return '';
  return String(b).toLowerCase().replace(/[^a-z0-9]/g, '');
}
function tokenize(s) {
  return String(s || '').toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/).filter(t => t.length >= 2);
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

function buildCatalogIndex(parts) {
  const byUPC = new Map();
  const byMPN = new Map();
  const bySKU = new Map(); // existing newegg SKU â†’ part
  const byCat = new Map(); // category â†’ [parts]
  
  for (const p of parts) {
    if (p.bundle || p.needsReview) continue;
    
    const upc = normUPC(p.upc);
    if (upc) byUPC.set(upc, p);
    
    const mpn = normMPN(p.mpn);
    if (mpn) byMPN.set(mpn, p);
    
    if (p.deals?.newegg?.sku) {
      bySKU.set(String(p.deals.newegg.sku).trim(), p);
    }
    
    if (p.c) {
      if (!byCat.has(p.c)) byCat.set(p.c, []);
      byCat.get(p.c).push(p);
    }
  }
  return { byUPC, byMPN, bySKU, byCat };
}

function classifyCategory(rec) {
  // Newegg primary category â†’ our category names
  const cat = (rec.primary_category || '').toLowerCase();
  if (/processor|cpu/.test(cat) && !/cooler|fan/.test(cat)) return 'CPU';
  if (/motherboard/.test(cat)) return 'Motherboard';
  if (/memory|ram|ddr/.test(cat) && !/storage|ssd|hdd/.test(cat)) return 'RAM';
  if (/storage|ssd|hard drive|nvme/.test(cat)) return 'Storage';
  if (/power supply|psu/.test(cat)) return 'PSU';
  if (/case|chassis|tower/.test(cat) && !/fan/.test(cat)) return 'Case';
  if (/cooling.*part|cpu cooler|liquid cooler|aio/.test(cat)) return 'CPUCooler';
  if (/fan/.test(cat)) return 'CaseFan';
  if (/monitor|display/.test(cat)) return 'Monitor';
  if (/graphics|gpu|video card/.test(cat)) return 'GPU';
  return null;
}

function matchRecord(rec, idx) {
  const upc = normUPC(rec.upc);
  if (upc && idx.byUPC.has(upc)) {
    return { part: idx.byUPC.get(upc), confidence: 1.0, method: 'upc' };
  }
  
  const mpn = normMPN(rec.mpn);
  if (mpn && idx.byMPN.has(mpn)) {
    const candidate = idx.byMPN.get(mpn);
    const recBrand = normBrand(rec.manufacturer || rec.brand2);
    const partBrand = normBrand(candidate.b);
    // Require brand match to prevent false positives from short/generic MPNs
    if (recBrand && partBrand && (recBrand === partBrand || recBrand.includes(partBrand) || partBrand.includes(recBrand))) {
      return { part: candidate, confidence: 0.95, method: 'mpn' };
    }
  }
  
  const sku = String(rec.sku || '').trim();
  if (sku && idx.bySKU.has(sku)) {
    return { part: idx.bySKU.get(sku), confidence: 0.9, method: 'sku' };
  }
  
  // Brand + name similarity within category
  const ourCat = classifyCategory(rec);
  if (!ourCat) return null;
  
  const candidates = idx.byCat.get(ourCat) || [];
  const recName = rec.product_name || '';
  const recBrand = (rec.manufacturer || '').toLowerCase();
  
  let best = null;
  for (const p of candidates) {
    const sim = nameSim(recName, p.n);
    if (sim < 0.7) continue;
    // Token overlap alone happily merges distinct variants that share most of
    // their words ("AIR 903 Series" vs "AIR 903 MAX" — one differing token out
    // of five). Gate name matches on the shared variant guard, same as
    // NEG.scoreMatch does for the Rakuten/refresh path. UPC/MPN/SKU matches
    // above are strong evidence and never reach here.
    if (NEG.variantMismatch(p.n, recName)) continue;
    const brandMatch = recBrand && p.b && recBrand.includes(p.b.toLowerCase());
    const confidence = brandMatch ? Math.min(0.85, sim) : sim * 0.7;
    if (confidence < 0.7) continue;
    if (!best || confidence > best.confidence) {
      best = { part: p, confidence, method: brandMatch ? 'brand+name' : 'name' };
    }
  }
  return best;
}

// â”€â”€â”€ PHASE 4: APPLY UPDATES TO PARTS.JS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function priceFromRecord(rec) {
  const sale = parseFloat(rec.sale_price);
  const retail = parseFloat(rec.retail_price);
  if (sale > 0 && retail > 0 && sale < retail) return { price: retail, saleprice: sale };
  if (sale > 0) return { price: sale, saleprice: null };
  if (retail > 0) return { price: retail, saleprice: null };
  return null;
}

function detectCondition(name) {
  const N = (name || '').toUpperCase();
  if (/\bOPEN[\s\-]?BOX\b/.test(N)) return 'openbox';
  if (/\bREFURB(?:ISHED)?\b|\bRENEWED\b/.test(N)) return 'refurb';
  if (/\bUSED\b|\bPRE[\s\-]?OWNED\b/.test(N)) return 'used';
  return 'new';
}

function applyMatchToPart(part, rec, match) {
  const pricing = priceFromRecord(rec);
  if (!pricing) return false;

  // Capacity guard — never attach a different-size or impossibly-priced listing,
  // regardless of match method (UPC/MPN/SKU/name). A reassigned UPC or feed error
  // that disagrees on capacity is rejected here, the single deal-write choke point.
  const storedCap = part.cap != null ? part.cap : CAP.parseCapacityGB(part.n);
  if (!CAP.capacityCompatible(storedCap, CAP.parseCapacityGB(rec.product_name))) return false;
  if (STORAGE_CATS.has(part.c) &&
      !CAP.isPricePlausibleForCapacity(pricing.price, storedCap, { isHDD: CAP.isHardDrive(part) })) return false;

  const inStock = !/out-of-stock|unavailable|no/i.test(rec.availability || '');
  const condition = detectCondition(rec.product_name);
  const fieldKey = condition === 'new' ? 'newegg' : 'newegg_' + condition;

  part.deals = part.deals || {};
  // The Newegg item number (col `newegg_item_number`, NOT `sku`) is what carries the
  // N82E (first-party) / 9SI (marketplace) prefix used for seller classification.
  const itemNumber = rec.newegg_item_number || rec.sku;
  const sClass = NEG.sellerClass(itemNumber);
  const newListing = {
    sku: rec.sku,
    itemNumber,
    sellerClass: sClass,
    price: pricing.price,
    ...(pricing.saleprice ? { saleprice: pricing.saleprice } : {}),
    linkurl: rec.product_url || rec.buy_url,
    imageurl: rec.image_url || undefined,
    inStock,
    matchedAt: new Date().toISOString(),
    matchMethod: 'sftp:' + match.method,
    matchScore: match.confidence
  };

  // Per condition, prefer a FIRST-PARTY (N82E) listing over marketplace (9SI)
  // regardless of price; only within the same seller tier fall back to
  // in-stock-then-lowest-price. (B2: marketplace fix is price-independent.)
  const existing = part.deals[fieldKey];
  let shouldReplace = !existing;
  if (existing) {
    const newRank = NEG.sellerRank(itemNumber);
    const oldRank = NEG.sellerRank(existing.itemNumber || existing.sku);
    if (newRank !== oldRank) {
      shouldReplace = newRank < oldRank;          // first-party wins outright
    } else {
      const newPrice = pricing.saleprice || pricing.price;
      const oldPrice = existing.saleprice || existing.price;
      if (inStock && !existing.inStock) shouldReplace = true;
      else if (existing.inStock && !inStock) shouldReplace = false;
      else if (newPrice < oldPrice) shouldReplace = true;
    }
  }

  // Sanity gate on the primary (new-condition) listing: never attach a price that's
  // a wild outlier vs the product's other retailers — flag for review instead.
  if (shouldReplace && fieldKey === 'newegg') {
    const effPrice = pricing.saleprice || pricing.price;
    if (!NEG.neweggSanity(part, effPrice).pass) {
      part.needsReview = true;
      part.quarantinedAt = new Date().toISOString().slice(0, 10);
      shouldReplace = false;
    }
  }
  if (shouldReplace) {
    part.deals[fieldKey] = newListing;
  }

  // Opportunistic UPC/MPN backfill if missing (always do this, not condition-gated)
  if (!part.upc && rec.upc) part.upc = rec.upc;
  if (!part.mpn && rec.mpn) part.mpn = rec.mpn;

  return true;
}

function writeParts(parts) {
  const header = '// Auto-merged catalog. Edit with care.\n';
  const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
  fs.writeFileSync(PARTS_PATH, header + body, 'utf8');
}

// â”€â”€â”€ PHASE 2.0: STREAMING MEASUREMENT (read-only, early-abort) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Streams the Newegg product-catalog feed through gunzip, parses the first N
// data records, and aborts — bypassing the 226MB full download that overruns
// the CI budget. Writes ONLY the measurement summary + sample, never parts.js.
async function measureStreamFirst(n) {
  if (!FTP_PASS) throw new Error('RAKUTEN_FTP_PASSWORD env var required');
  const CC = require('./catalog-classify.cjs');
  log(`â”â”â” PHASE 2.0: STREAMING MEASUREMENT (first ${n} records) â”â”â”`);
  log('Loading catalog for dedupe index...');
  const partsModule = await import('file://' + PARTS_PATH.replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = partsModule.PARTS;
  const idx = buildCatalogIndex(parts);
  log(`Loaded ${parts.length} products; index ${idx.byUPC.size} UPC / ${idx.byMPN.size} MPN / ${idx.bySKU.size} SKU`);

  const sftp = new SftpClient();
  const byCategory = {};
  const bump = (cat, key) => {
    const c = cat || '(unclassified)';
    byCategory[c] = byCategory[c] || { records: 0, matched: 0, exclusives: 0, priced: 0 };
    byCategory[c][key]++;
  };
  // Raw Newegg taxonomy histograms so we can see how coarse primary_category is
  // and whether the finer signal lives in secondary_categories.
  const primaryHist = {};
  const secondaryHist = {};
  // Title-based classification (catalog-classify.detectCategory) as a comparison
  // against feed-category classification — which actually finds PC components?
  const byTitleCat = {};
  // Field-presence tally, per our-category, over ALL sampled records (not just
  // exclusives) so coverage reflects the feed itself.
  const fieldCov = {};
  const FIELDS = ['product_name', 'manufacturer', 'brand2', 'primary_category', 'upc', 'mpn', 'retail_price', 'sale_price', 'image_url', 'product_url', 'short_description', 'attr_1'];
  const covBump = (cat, rec) => {
    const c = cat || '(unclassified)';
    fieldCov[c] = fieldCov[c] || { n: 0 };
    fieldCov[c].n++;
    for (const f of FIELDS) { if (String(rec[f] || '').trim()) fieldCov[c][f] = (fieldCov[c][f] || 0) + 1; }
  };

  let dataRecords = 0, deletedOrOOS = 0;
  try {
    await sftp.connect({ host: FTP_HOST, port: 22, username: FTP_USER, password: FTP_PASS });
    log(`Connected to ${FTP_HOST} as ${FTP_USER}`);
    // Locate the Newegg full product-catalog file (not delta/template) at the root.
    const rootEntries = await sftp.list('/');
    const target = rootEntries.find((e) => e.type === '-'
      && /^44583_\d+_mp\.txt\.gz$/i.test(e.name));
    if (!target) throw new Error('Newegg _mp.txt.gz not found at SFTP root: ' + rootEntries.filter(e => e.type === '-').map(e => e.name).slice(0, 20).join(', '));
    const remotePath = '/' + target.name;
    log(`Streaming ${target.name} (${(target.size / 1024 / 1024).toFixed(1)}MB) — reading first ${n} records`);

    const gunzip = zlib.createGunzip();
    const readStream = sftp.createReadStream(remotePath);
    readStream.pipe(gunzip);
    const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });

    await new Promise((resolve, reject) => {
      let done = false;
      const finish = () => { if (done) return; done = true; try { rl.close(); } catch {} try { readStream.destroy(); } catch {} resolve(); };
      readStream.on('error', (e) => { if (!done) { done = true; reject(e); } });
      gunzip.on('error', (e) => { if (!done) { done = true; reject(e); } });
      rl.on('line', (line) => {
        if (done || !line) return;
        if (line.startsWith('HDR|') || line.startsWith('TRL|')) return;
        const fields = line.split('|');
        const rec = {};
        for (let i = 0; i < DEFAULT_FIELD_ORDER.length; i++) rec[DEFAULT_FIELD_ORDER[i]] = (fields[i] || '').trim();
        dataRecords++;
        if (/^(1|true|yes|deleted)$/i.test(rec.is_deleted || '') || /out-of-stock|unavailable|no/i.test(rec.availability || '')) {
          deletedOrOOS++;
        } else {
          const recCat = classifyCategory(rec);
          // Raw taxonomy histograms (bounded — a few hundred distinct values).
          const pc = rec.primary_category || '(empty)';
          primaryHist[pc] = (primaryHist[pc] || 0) + 1;
          const sc0 = (rec.secondary_categories || '').split(/[>|,;]/)[0].trim() || '(empty)';
          secondaryHist[sc0] = (secondaryHist[sc0] || 0) + 1;
          // Title-based classification comparison.
          const tCat = CC.detectCategory(CC.stripCompatClauses(rec.product_name || ''));
          if (tCat) byTitleCat[tCat] = (byTitleCat[tCat] || 0) + 1;
          bump(recCat, 'records');
          covBump(recCat, rec);
          const match = matchRecord(rec, idx);
          if (match && match.part) {
            bump(recCat, 'matched');
          } else {
            const pricing = priceFromRecord(rec);
            if (pricing && pricing.price > 0) {
              bump(recCat, 'exclusives');
              // Sample keyed by the TITLE category (falls back to feed category),
              // so real PC-component exclusives are captured even when the coarse
              // feed primary_category does not resolve to one of our categories.
              const sampleCat = tCat || recCat;
              if (SAMPLE_PER_CAT > 0 && sampleCat) {
                exclusiveSample[sampleCat] = exclusiveSample[sampleCat] || [];
                if (exclusiveSample[sampleCat].length < SAMPLE_PER_CAT) {
                  exclusiveSample[sampleCat].push({
                    sku: rec.sku, newegg_item_number: rec.newegg_item_number,
                    sellerClass: NEG.sellerClass(rec.newegg_item_number || rec.sku),
                    name: rec.product_name, manufacturer: rec.manufacturer, brand2: rec.brand2,
                    primary_category: rec.primary_category, secondary_categories: rec.secondary_categories,
                    feedCategory: recCat, titleCategory: tCat,
                    upc: rec.upc, mpn: rec.mpn, retail_price: rec.retail_price, sale_price: rec.sale_price,
                    availability: rec.availability, image_url: rec.image_url, product_url: rec.product_url,
                    attrs: [rec.attr_1, rec.attr_2, rec.attr_3, rec.attr_4, rec.attr_5].filter(Boolean),
                    short_description: (rec.short_description || '').slice(0, 200),
                  });
                }
              }
            }
          }
        }
        if (dataRecords % 25000 === 0) log(`  …${dataRecords} records parsed`);
        if (dataRecords >= n) finish();
      });
      rl.on('close', finish);
    });
  } finally {
    try { await sftp.end(); } catch {}
  }

  ensureDir(path.dirname(SAMPLE_PATH));
  const topHist = (h, k) => Object.entries(h).sort((a, b) => b[1] - a[1]).slice(0, k)
    .reduce((o, [key, v]) => (o[key] = v, o), {});
  const out = {
    generatedAt: new Date().toISOString(), mode: 'measure-first', requested: n,
    dataRecordsParsed: dataRecords, skippedDeletedOrOOS: deletedOrOOS,
    byCategory,                              // classified from feed primary_category
    byTitleCategory: byTitleCat,             // classified from title (catalog-classify)
    primaryCategoryTop: topHist(primaryHist, 40),
    secondaryCategoryTop: topHist(secondaryHist, 60),
    // Full secondary_categories histogram, PC-relevant leaves only, so the exact
    // leaf→category mapping and clean per-leaf gap counts can be read off.
    secondaryPcLeaves: Object.entries(secondaryHist)
      .filter(([s]) => /processor|power suppl|motherboard|memory|storage device|hard drive|cooling|desktop computer & server case|video card|graphic|monitor|solid state/i.test(s))
      .sort((a, b) => b[1] - a[1])
      .reduce((o, [k, v]) => (o[k] = v, o), {}),
    fieldCoverage: fieldCov,
    exclusiveSampleCap: SAMPLE_PER_CAT, sample: exclusiveSample,
  };
  fs.writeFileSync(SAMPLE_PATH, JSON.stringify(out, null, 2));
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify({ measureFirst: out.byCategory, dataRecordsParsed: dataRecords }, null, 2));

  log(`\nParsed ${dataRecords} data records (${deletedOrOOS} deleted/OOS skipped).`);
  log('FEED-category (records / matched / NEW exclusives):');
  for (const [cat, c] of Object.entries(byCategory).sort((a, b) => b[1].records - a[1].records)) {
    log(`  ${cat.padEnd(16)} records ${String(c.records).padStart(6)}  matched ${String(c.matched).padStart(5)}  exclusive ${String(c.exclusives).padStart(6)}`);
  }
  log('TITLE-category counts (catalog-classify.detectCategory over all records):');
  for (const [cat, v] of Object.entries(byTitleCat).sort((a, b) => b[1] - a[1])) {
    log(`  ${cat.padEnd(16)} ${v}`);
  }
  log(`\nWrote ${path.relative(ROOT, SAMPLE_PATH)} and ${path.relative(ROOT, SUMMARY_PATH)}`);
}

// â”€â”€â”€ MAIN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(async () => {
  CAP = await import('file://' + process.cwd().replace(/\\/g, '/') + '/normalize-product-name.js');
  NEG = await import('file://' + process.cwd().replace(/\\/g, '/') + '/newegg-match.js');

  // Phase 2.0 streaming measurement short-circuits the normal download/parse/apply
  // flow entirely. Read-only: writes only the measurement summary + sample.
  if (MEASURE_FIRST > 0) { await measureStreamFirst(MEASURE_FIRST); return; }

  const summary = {
    startedAt: new Date().toISOString(),
    dryRun: DRY_RUN,
    downloaded: [],
    perMerchant: {},
    totals: { feedRecords: 0, matched: 0, updated: 0, exclusives: 0, errors: 0 }
  };

  let downloaded = [];
  const manifest = loadManifest();

  // PHASE 1: Download
  if (!SKIP_DOWNLOAD) {
    if (!FTP_PASS) throw new Error('RAKUTEN_FTP_PASSWORD env var required');
    log('â”â”â” PHASE 1: SFTP Discovery + Download â”â”â”');
    const sftp = new SftpClient();
    try {
      await sftp.connect({ host: FTP_HOST, port: 22, username: FTP_USER, password: FTP_PASS });
      log(`Connected to ${FTP_HOST} as ${FTP_USER}`);
      downloaded = await walkAndDownload(sftp, manifest);
      saveManifest(manifest);
      log(`Downloaded ${downloaded.length} new/changed files`);
      summary.downloaded = downloaded.map(d => ({ mid: d.mid, file: d.fileName }));
    } finally {
      await sftp.end();
    }
  } else {
    // Re-process all locally-known files
    for (const [remotePath, entry] of Object.entries(manifest.files)) {
      if (ONLY_MERCHANT && entry.mid !== ONLY_MERCHANT) continue;
      if (fs.existsSync(entry.localPath)) {
        downloaded.push({ mid: entry.mid, localPath: entry.localPath, remotePath, fileName: path.basename(entry.localPath) });
      }
    }
    log(`Re-parsing ${downloaded.length} local files (--skip-download)`);
  }

  if (DOWNLOAD_ONLY || downloaded.length === 0) {
    log(DOWNLOAD_ONLY ? 'Download-only mode, done.' : 'Nothing new to process, done.');
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
    return;
  }

  // PHASE 2-4: Parse, match, apply per merchant
  log('â”â”â” PHASE 2: Parse, Match, Apply â”â”â”');
  log('Loading catalog...');
  const partsModule = await import('file://' + PARTS_PATH.replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = partsModule.PARTS;
  log(`Loaded ${parts.length} products`);
  
  const idx = buildCatalogIndex(parts);
  log(`Indexed: ${idx.byUPC.size} UPCs, ${idx.byMPN.size} MPNs, ${idx.bySKU.size} existing Newegg SKUs`);

  // Stream exclusives directly to disk to avoid OOM on 900k+ records
  let exclusivesCount = 0;
  let exclusivesStream = null;
  let exclusivesJsonlPath = null;
  let exclusivesMetaPath = null;
  if (!DRY_RUN) {
    ensureDir(path.dirname(EXCLUSIVES_PATH));
    exclusivesJsonlPath = EXCLUSIVES_PATH.replace(/\.json$/i, '.jsonl');
    exclusivesMetaPath = EXCLUSIVES_PATH.replace(/\.json$/i, '.meta.json');
    exclusivesStream = fs.createWriteStream(exclusivesJsonlPath, { encoding: 'utf8' });
  }

  for (const dl of downloaded) {
    log(`\nâ”€â”€ Merchant ${dl.mid}: ${dl.fileName} â”€â”€`);
    
    const ms = { matched: 0, updated: 0, exclusives: 0, byMethod: { upc: 0, mpn: 0, sku: 0, 'brand+name': 0, name: 0 },
      // Phase 2.0 gap sizing: per-category feed record / match / exclusive counts.
      byCategory: {} };
    const bumpCat = (cat, key) => {
      const c = cat || '(unclassified)';
      ms.byCategory[c] = ms.byCategory[c] || { records: 0, matched: 0, exclusives: 0 };
      ms.byCategory[c][key]++;
    };
    
    let parsed;
    try {
      parsed = await parseTxtFeed(dl.localPath);
    } catch (e) {
      log(`  âœ— Parse error: ${e.message}`);
      summary.totals.errors++;
      continue;
    }
    
    log(`  Parsed ${parsed.records.length} records (header has ${parsed.header.length} fields)`);
    if (parsed.trailerCount != null && parsed.trailerCount !== parsed.records.length) {
      log(`  âš  Trailer count ${parsed.trailerCount} != parsed ${parsed.records.length}`);
    }
    summary.totals.feedRecords += parsed.records.length;
    
    for (const rec of parsed.records) {
      // Skip deleted products
      if (/^(1|true|yes|deleted)$/i.test(rec.is_deleted || '')) continue;
      // Skip out-of-stock
      if (/out-of-stock|unavailable|no/i.test(rec.availability || '')) continue;

      const recCat = classifyCategory(rec);
      bumpCat(recCat, 'records');

      const match = matchRecord(rec, idx);
      if (match && match.part) {
        bumpCat(recCat, 'matched');
        if (applyMatchToPart(match.part, rec, match)) {
          ms.matched++;
          ms.updated++;
          ms.byMethod[match.method] = (ms.byMethod[match.method] || 0) + 1;
        }
      } else if (dl.mid === NEWEGG_MID) {
        // Unmatched Newegg product = potential exclusive (only collect for Newegg MID)
        const pricing = priceFromRecord(rec);
        if (pricing && pricing.price > 0) {
          bumpCat(recCat, 'exclusives');
          // Phase 2.0: capture a capped, per-category sample of raw exclusive
          // records so field coverage can be reviewed. Sample only — never a write.
          if (SAMPLE_PER_CAT > 0) {
            const sc = recCat || '(unclassified)';
            exclusiveSample[sc] = exclusiveSample[sc] || [];
            if (exclusiveSample[sc].length < SAMPLE_PER_CAT) {
              exclusiveSample[sc].push({
                sku: rec.sku, newegg_item_number: rec.newegg_item_number,
                sellerClass: NEG.sellerClass(rec.newegg_item_number || rec.sku),
                name: rec.product_name, manufacturer: rec.manufacturer, brand2: rec.brand2,
                primary_category: rec.primary_category, secondary_categories: rec.secondary_categories,
                ourCategory: recCat, upc: rec.upc, mpn: rec.mpn,
                retail_price: rec.retail_price, sale_price: rec.sale_price,
                availability: rec.availability, image_url: rec.image_url,
                product_url: rec.product_url,
                attrs: [rec.attr_1, rec.attr_2, rec.attr_3, rec.attr_4, rec.attr_5].filter(Boolean),
                short_description: (rec.short_description || '').slice(0, 200),
              });
            }
          }
          const exclusiveRec = {
            mid: dl.mid,
            sku: rec.sku,
            name: rec.product_name,
            brand: rec.manufacturer,
            category: rec.primary_category,
            ourCategory: classifyCategory(rec),
            price: pricing.price,
            saleprice: pricing.saleprice,
            upc: rec.upc,
            mpn: rec.mpn,
            url: rec.product_url || rec.buy_url,
            image: rec.image_url,
            availability: rec.availability
          };
          if (exclusivesStream) exclusivesStream.write(JSON.stringify(exclusiveRec) + '\n');
          exclusivesCount++;
          ms.exclusives++;
        }
      }
    }
    
    log(`  Matched: ${ms.matched} | Exclusives: ${ms.exclusives}`);
    log(`  By method: ${JSON.stringify(ms.byMethod)}`);
    summary.perMerchant[dl.mid] = ms;
    summary.totals.matched += ms.matched;
    summary.totals.updated += ms.updated;
    summary.totals.exclusives += ms.exclusives;
  }

  // Phase 2.0: aggregate per-category gap numbers across merchants (Newegg-only
  // in practice) into the summary for easy review.
  summary.byCategory = {};
  for (const ms of Object.values(summary.perMerchant)) {
    for (const [cat, c] of Object.entries(ms.byCategory || {})) {
      const s = summary.byCategory[cat] = summary.byCategory[cat] || { records: 0, matched: 0, exclusives: 0 };
      s.records += c.records; s.matched += c.matched; s.exclusives += c.exclusives;
    }
  }
  // Phase 2.0: write the capped exclusives SAMPLE (never the catalog). Allowed in
  // dry-run precisely because it is not a catalog mutation — it is measurement.
  if (SAMPLE_PER_CAT > 0) {
    ensureDir(path.dirname(SAMPLE_PATH));
    const totalSample = Object.values(exclusiveSample).reduce((n, a) => n + a.length, 0);
    fs.writeFileSync(SAMPLE_PATH, JSON.stringify({
      generatedAt: new Date().toISOString(), dryRun: DRY_RUN,
      perCatCap: SAMPLE_PER_CAT, totalSampled: totalSample,
      byCategory: summary.byCategory, sample: exclusiveSample,
    }, null, 2));
    log(`Wrote exclusives sample (${totalSample} records) to ${path.relative(ROOT, SAMPLE_PATH)}`);
  }

  // Write outputs
  if (DRY_RUN) {
    log('\n--dry-run: not writing parts.js or exclusives.json');
  } else {
    if (summary.totals.updated > 0) {
      log(`\nWriting ${parts.length} products to parts.js (${summary.totals.updated} updated)...`);
      writeParts(parts);
    } else {
      log('\nNo parts updated, skipping parts.js write');
    }
    
    if (exclusivesStream) {
      exclusivesStream.end();
      await new Promise(r => exclusivesStream.on('finish', r));
      fs.writeFileSync(exclusivesMetaPath, JSON.stringify({
        generatedAt: new Date().toISOString(),
        count: exclusivesCount,
        format: 'jsonl',
        dataFile: path.basename(exclusivesJsonlPath),
      }, null, 2));
      log(`Wrote ${exclusivesCount} exclusives to ${path.relative(ROOT, exclusivesJsonlPath)} (JSONL streamed) + meta`);
    }
  }
  
  summary.finishedAt = new Date().toISOString();
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  
  log('\nâ”â”â” SUMMARY â”â”â”');
  log(`Feed records:    ${summary.totals.feedRecords}`);
  log(`Matched/updated: ${summary.totals.updated}`);
  log(`Exclusives:      ${summary.totals.exclusives}`);
  log(`Errors:          ${summary.totals.errors}`);
  log('\nPer-category gap (records / matched-to-existing / NEW exclusives):');
  for (const [cat, c] of Object.entries(summary.byCategory || {}).sort((a, b) => b[1].exclusives - a[1].exclusives)) {
    log(`  ${cat.padEnd(16)} records ${String(c.records).padStart(7)}  matched ${String(c.matched).padStart(6)}  exclusive ${String(c.exclusives).padStart(7)}`);
  }
})().catch(e => {
  console.error('\nâœ— FATAL:', e.stack || e.message);
  process.exit(1);
});
