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
        // Streaming get(), NOT fastGet(). fastGet issues many parallel range
        // reads, which this SFTP endpoint (aftp.linksynergy.com) throttles hard —
        // measured under 64KB/s, so the 226MB Newegg feed never finished inside
        // the 60-min job budget and the daily ingest silently timed out. A single
        // sequential stream measures at MB/s (full feed in ~4 min). See the
        // 2026-07-23 measurement (300k records parsed in 72s via a streamed read).
        await sftp.get(fullPath, localPath);
        manifest.files[key] = { size: remoteSize, mtime: remoteMTime, mid, localPath, downloadedAt: new Date().toISOString() };
        downloaded.push({ mid, localPath, remotePath: fullPath, fileName: entry.name });
      }
    }
  }
  return downloaded;
}

// â”€â”€â”€ PHASE 2: PARSE PIPE-DELIMITED .txt.gz â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
/**
 * streamTxtFeed(localPath, onRecord) — parse a gzipped pipe-delimited Rakuten
 * product catalog, handing ONE record at a time to onRecord and keeping none.
 *
 * This is the primitive; parseTxtFeed() below is the buffering wrapper. They are
 * one parser rather than two so a consumer that cannot afford to buffer (the
 * dead-SKU census against the 886MB MKPL feed) and the nightly ingest cannot
 * drift apart in how they read a row.
 *
 * Resolves { recordCount, trailerCount, header, lineNum }. The caller compares
 * recordCount against trailerCount to detect a short read — a truncated feed
 * that ends cleanly is indistinguishable from "these skus are gone" without it.
 */
async function streamTxtFeed(localPath, onRecord) {
  if (typeof onRecord !== 'function') {
    throw new TypeError('streamTxtFeed(localPath, onRecord): onRecord must be a function');
  }
  return new Promise((resolve, reject) => {
    let header = null;
    let lineNum = 0;
    let recordCount = 0;
    let trailerCount = null;
    let failed = false;

    const stream = fs.createReadStream(localPath).pipe(zlib.createGunzip());
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    const fail = (e) => { if (failed) return; failed = true; rl.close(); stream.destroy(); reject(e); };

    rl.on('line', (line) => {
      if (failed) return;
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
      recordCount++;
      // A throw from the consumer must abort the stream, not surface later as a
      // silently short read that the truncation guard would call "gone".
      try { onRecord(rec, recordCount); } catch (e) { fail(e); }
    });

    rl.on('close', () => { if (!failed) resolve({ recordCount, trailerCount, header, lineNum }); });
    rl.on('error', fail);
    stream.on('error', fail);
  });
}

async function parseTxtFeed(localPath) {
  const records = [];
  const res = await streamTxtFeed(localPath, (rec) => { records.push(rec); });
  return { records, header: res.header, trailerCount: res.trailerCount, lineNum: res.lineNum };
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

// Newegg's feed `primary_category` is coarse Google-taxonomy ("Electronics"
// covers CPUs AND ink cartridges AND tablets), so keying off it classified 100%
// of the 1.07M-record Newegg feed as unmatched — the category/name-similarity
// match fallback never fired and every Newegg product looked "exclusive". The
// real component taxonomy lives in `secondary_categories`, a "~~"-delimited path
// whose LEAF names the product type. Classify on the leaf; keep the old
// primary_category heuristics as a fallback for other merchants' feeds.
//
// Leaves verified against the full live Newegg feed on 2026-07-23 (counts are
// in-stock listings): RAM 29482, Cooling 8856, PSU 5522, Monitors 3869,
// Motherboards 3687, Storage/Hard Drives ~5500, Cases 1716, Processors 1257,
// Video Cards 226. Accessory/adjacent leaves (monitor accessories, mounts, USB
// flash, card readers, enclosures, NAS, optical drives) are deliberately NOT
// mapped, so they fall through to null rather than polluting a core category.
function classifyCategory(rec) {
  const sec = (rec.secondary_categories || '').toLowerCase();
  if (sec) {
    // Internal storage only: generic "Storage Devices" (SSDs land here) or the
    // "Hard Drives" leaf. Deeper leaves (USB Flash Drives, Network Storage
    // Systems, Optical Drives, Hard Drive Accessories/Enclosures, Card Readers,
    // Disk Duplicators) are NOT core Storage and are left unmapped.
    if (/~~storage devices(~~(hard drives|solid state\w*))?$/.test(sec)) return 'Storage';
    if (/~~memory~~ram$/.test(sec)) return 'RAM';
    if (/~~computer power supplies\b/.test(sec)) return 'PSU';
    if (/~~motherboards$/.test(sec)) return 'Motherboard';
    if (/~~computer processors$/.test(sec)) return 'CPU';
    if (/~~desktop computer & server cases\b/.test(sec)) return 'Case';
    if (/~~video cards & adapters\b/.test(sec)) return 'GPU';
    if (/~~computer system cooling parts\b/.test(sec)) {
      // Shared cooling leaf covers CPU coolers AND case fans — split on title.
      const n = (rec.product_name || '').toLowerCase();
      if (/\b(cpu cooler|aio|liquid cooler|air cooler|heat ?sink|liquid freezer|water cool\w*|tower cooler)\b/.test(n)) return 'CPUCooler';
      if (/\b(case fan|chassis fan|\d{2,3}mm fan|radiator|fan pack|fans?)\b/.test(n)) return 'CaseFan';
      return 'CPUCooler';
    }
    if (/video~~computer monitors$/.test(sec)) return 'Monitor';
  }
  // Fallback: original primary_category heuristics (inert on Newegg, but other
  // merchants' feeds may populate primary_category).
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

// â”€â”€â”€ MAIN â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Exported so other jobs can share the parser instead of copying it. Everything
// below the guard is the nightly ingest's own run.
//
// THE GUARD IS LEAD, NOT TRIM. Without `require.main === module` this file's
// main IIFE fires on `require()`, so newegg-dead-sku-audit.cjs merely importing
// the parser launched a SECOND full ingest in the background — a competing SFTP
// session on an endpoint that throttles concurrent readers, and, had it run to
// completion, a write to parts.js from a job declared read-only. Run
// 32057560889 paid for that: ~1.3GB of duplicate downloads and a 535s/2973s
// pair of feed pulls that contended with each other the whole way.
module.exports = { streamTxtFeed, parseTxtFeed, DEFAULT_FIELD_ORDER, normUPC, normMPN };

if (require.main === module) (async () => {
  CAP = await import('file://' + process.cwd().replace(/\\/g, '/') + '/normalize-product-name.js');
  NEG = await import('file://' + process.cwd().replace(/\\/g, '/') + '/newegg-match.js');

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
    
    const ms = { matched: 0, updated: 0, exclusives: 0, byMethod: { upc: 0, mpn: 0, sku: 0, 'brand+name': 0, name: 0 } };
    
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
      
      const match = matchRecord(rec, idx);
      if (match && match.part) {
        if (applyMatchToPart(match.part, rec, match)) {
          ms.matched++;
          ms.updated++;
          ms.byMethod[match.method] = (ms.byMethod[match.method] || 0) + 1;
        }
      } else if (dl.mid === NEWEGG_MID) {
        // Unmatched Newegg product = potential exclusive (only collect for Newegg MID)
        const pricing = priceFromRecord(rec);
        if (pricing && pricing.price > 0) {
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
})().catch(e => {
  console.error('\nâœ— FATAL:', e.stack || e.message);
  process.exit(1);
});
