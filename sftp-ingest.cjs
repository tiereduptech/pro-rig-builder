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

// Day-only, matching the priceConfirmedAt / priceUnconfirmedAt convention the
// Amazon write paths and scripts/assert-retailer-freshness.cjs already use.
const TODAY = new Date().toISOString().slice(0, 10);

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
        // Skip the MKPL marketplace feed. It is 886MB — 86% of all bytes this
        // job pulls, and ~34 of its 60 minutes — which is why the nightly kept
        // being cancelled before it committed anything.
        //
        // It is skipped because it is EMPTY, not because it is expensive. Run
        // 32073301866 streamed all 2,918,315 records: of the 443 pending Newegg
        // deals it carries zero, and of the 83,508 rows it holds that mp does
        // not, every one is 3P and 83,502 claim "in-stock" in a file last
        // written 2023-03-16. Ten were fetched from newegg.com — 6 hard 404, 3
        // out-of-stock with no price, 1 resolving to a different product. See
        // DISCOVERY_IGNORE in newegg-dead-sku-audit.cjs for the full measurement.
        //
        // Do not re-add it to save a round trip on "unique" rows. They are dead.
        if (/_MKPL\./i.test(entry.name)) continue;

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
 *
 * STREAMING, one record at a time — never an array of records. The previous
 * version accumulated every parsed record and resolved with the whole array.
 * That is what killed the daily ingest: on 2026-08-17 it died with "Ineffective
 * mark-compacts near heap limit" at 6,135 MB of the 6,144 MB cap, part-way
 * through 44583_4681679_mp_MKPL.txt.gz (886 MB gzipped, several million rows of
 * 38 fields). The main feed's 1,034,587 records fit; the marketplace feed's do
 * not, and never will — the feed only grows, so raising --max-old-space-size
 * just moves the wall. Between 2026-05-14 and 2026-08-17 this workflow
 * succeeded twice in 99 runs: 88 cancelled at the 60-minute timeout while
 * GC-thrashing, 9 killed outright. The commit step is skipped on both, so the
 * daily Newegg feed wrote nothing to the catalog for 95 days.
 *
 * BACKPRESSURE is the other half of the fix, and it is not optional. The ingest
 * writes ~1M exclusives to a WriteStream; a loop that ignores write()'s false
 * return grows that stream's internal buffer without bound — the same OOM in a
 * different costume, which would have surfaced the moment the record array
 * stopped being the first thing to blow. onRecord receives (rec, ctl); calling
 * ctl.backpressure(dest) pauses the feed until dest drains.
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
    let failed = null;

    const stream = fs.createReadStream(localPath).pipe(zlib.createGunzip());
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    // reject BEFORE close(). readline emits 'close' synchronously from close(),
    // so resolving there would settle the promise first and the rejection would
    // be a silent no-op — a consumer error would surface as a successful parse
    // with a truncated record count.
    const fail = (e) => {
      if (failed) return;
      failed = e;
      reject(e);
      rl.close();
      stream.destroy();
    };

    // One pending drain at a time. Registering a fresh 'drain' listener per
    // record while already paused would leak listeners on exactly the feeds
    // that need the pause most.
    let awaitingDrain = false;
    const ctl = {
      backpressure(dest) {
        if (awaitingDrain) return;
        awaitingDrain = true;
        rl.pause();
        dest.once('drain', () => { awaitingDrain = false; rl.resume(); });
      },
    };

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
      try { onRecord(rec, ctl); } catch (e) { fail(e); }
    });

    rl.on('close', () => {
      if (failed) return;
      resolve({ header: header || DEFAULT_FIELD_ORDER, trailerCount, lineNum, recordCount });
    });
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

// The lanes this file is the ONLY writer for. deals.newegg has its own
// re-pricer (refresh-newegg-prices.cjs) which stamps refreshedAt daily; these
// have nothing else, which is how 182 open-box rows reached 90 days with 171 of
// them never once changing price while a scheduled job ran over them nightly.
//
// Confirmation stamping is limited to lanes this job SOLELY OWNS. Stamping
// deals.newegg wholesale would let a dead refresh-newegg-prices read as healthy
// on this job's stamp, which is the exact failure the freshness gate exists to
// catch. One retailer's job must never certify another's.
//
// "Solely owns" is now decided per ROW rather than per lane — see
// lanesSolelyOwned() below. The rule is unchanged; what changed is noticing
// that for a row the re-pricer structurally cannot reach, there is no other
// job, and the choice is not between two certifiers but between one and none.
const CONDITION_LANES = ['newegg_openbox', 'newegg_refurb', 'newegg_used'];
const laneKey = (part, fieldKey) => `${part.id}::${fieldKey}`;

/**
 * The lanes this job is the SOLE writer for — FOR THIS PART.
 *
 * CONDITION_LANES is the fixed half: nothing else ever writes them.
 *
 * deals.newegg is the conditional half, and the condition is per ROW rather
 * than per lane. refresh-newegg-prices.cjs owns that lane — but it can only
 * reach a row whose category has a CAT_FILTER entry, because searchNewegg()
 * returns 'no_cat_mapping' before issuing a single request otherwise. For a row
 * in an unmapped category there is no re-pricer to protect and no second
 * opinion to fight: this job is its only writer, which is precisely the
 * condition that earns a lane a stamp.
 *
 * That is not a hypothetical carve-out. 85 rows sit in unmapped categories — 68
 * GPU plus 17 peripherals — and on 2026-09-02 every one of them carried zero
 * confirmation of any kind while the freshness gate counted them in Newegg's
 * stale tail. All 85 are matched from this feed (84 via sftp:*), 79 are
 * first-party, and their prices demonstrably move: 6 of the 68 GPUs repriced
 * between the 09-01 and 09-02 ingests, one by $190. The data was arriving
 * nightly and being thrown away unstamped. See [[unstamped-is-not-unscheduled]]
 * in spirit: the rows were not unrefreshed, they were uncertified.
 *
 * GPU is the reason this exists and is deliberately NOT named here. The rule is
 * DERIVED from CAT_FILTER, so the moment GPU gains an entry the re-pricer
 * starts reaching those rows and this job stops certifying them, on the same
 * commit, with no second list to remember to update. A hardcoded category list
 * here would be a transcribed schedule by another name.
 *
 * The safety property is unchanged for every row that matters to it: for the
 * 3,104 rows the re-pricer CAN reach, this job still mints nothing, so a dead
 * refresh-newegg-prices still drives the median stale and still fails the gate.
 */
function lanesSolelyOwned(part) {
  const lanes = [...CONDITION_LANES];
  if (!NEG.CAT_FILTER[part.c]) lanes.push('newegg');
  return lanes;
}

// Every (row, lane) this run CONFIRMED — i.e. actually wrote a price to, from
// a feed record. Read after the merchant loop to stamp the complement: rows we
// hold a price for and the feed did not offer one for. See the absence sweep.
const confirmedLanes = new Set();

// Every (row, lane) whose row this run's feed POSITIVELY IDENTIFIED with a
// usable price — independent of whether we then chose to write it.
//
// ── WHY THIS IS SEPARATE FROM confirmedLanes ────────────────────────────────
// confirmedLanes answers "what did we write?". This answers "what could we
// have?", and the two differ by every row where chooseListing declined or the
// sanity gate vetoed. Only the second one can size a coverage question.
//
// ── WHY IT EXISTS AT ALL ────────────────────────────────────────────────────
// 979 deals.newegg rows are reached by NOTHING: refresh-newegg-prices searches
// by name/UPC and cannot address the itemNumber we store, so it declines or
// comes back empty on the same fixed set every run. 765 of those 979 are
// user-visible (488 the only offer on their row, 277 the cheapest), at a median
// 15d and p90 43d since last confirmation.
//
// The obvious next move is "let this feed confirm them — it is keyed by
// newegg_item_number, which is exactly what the re-pricer cannot query". That
// may be right and it may be worthless, and NOTHING IN THE REPO CAN SAY WHICH,
// because this job stamps nothing on mapped newegg rows and so leaves no trace
// of what it saw. The only coverage figure that exists anywhere is the
// condition-lane absence sweep — 83 of 205 confirmed, 122 not — and
// extrapolating single-unit open-box inventory to new-condition stock is a
// guess, not a measurement.
//
// So this counts, and only counts. One nightly run answers whether the feed
// carries 90% of that tail or 40%, which is the difference between a cheap fix
// and an expensive one, BEFORE either is built. Measuring first is the whole
// lesson of the 12.0%-vs-40.5% failure rate: the earlier number was not wrong
// arithmetic, it was a sample nobody had checked was representative.
//
// READ-ONLY BY CONSTRUCTION. This set is never consulted by a write path. It
// cannot become a confirmation stamp for deals.newegg by accident, because
// nothing downstream of it writes — asserted in test/sftp-coverage-census.test.js.
const feedOffered = new Set();

// Stamps this run dropped ON PURPOSE. A genuine listing swap must not carry
// refreshedAt across: the stamp attests to a price on a listing the row no
// longer holds, and vouching for it would be a lie about a different product.
// So a healthy night legitimately loses some, and "any loss at all" would void
// the census every time it ran — see stampIntegrity(), which subtracts these to
// isolate the loss NOTHING accounts for.
//
// Counted from the OUTCOME (`existing` had one, `newListing` will not) rather
// than from the carry rule, so it still measures the truth if that rule changes.
let stampsDroppedOnReplacement = 0;

/**
 * Read-only coverage census over deals.newegg. Pure, exported, and asserted on
 * directly — the 12.0%-vs-40.5% episode is what happens to a number computed
 * inline where nothing can check it.
 *
 * Splits the lane by whether refresh-newegg-prices has EVER reached the row,
 * then asks what share of each side this run's feed offered.
 *
 * `refreshedAt` absence is the split, not a staleness threshold. The re-pricer
 * writes it on every successful lookup INCLUDING the unchanged case, and this
 * job now carries it across rather than erasing it, so a row without one has
 * never once been reached — a fact about reachability, not a date comparison.
 * Deliberately no budget constant: transcribing the gate's policy here is how
 * two numbers drift apart, and this file has no business holding an opinion
 * about how stale is too stale.
 */
function coverageCensus(parts, offered) {
  const c = {
    rows: 0, offered: 0,
    neverRepriced: 0, neverRepricedOffered: 0,
    repriced: 0, repricedOffered: 0,
  };
  for (const p of parts) {
    const d = p && p.deals && p.deals.newegg;
    if (!d || typeof d !== 'object') continue;
    c.rows++;
    const seen = offered.has(laneKey(p, 'newegg'));
    if (seen) c.offered++;
    if (d.refreshedAt) { c.repriced++; if (seen) c.repricedOffered++; }
    else { c.neverRepriced++; if (seen) c.neverRepricedOffered++; }
  }
  // THE NUMBER THIS WHOLE THING EXISTS FOR: of the rows nothing reprices, what
  // share does this feed carry? That is the difference between "let the feed
  // confirm them" and "build a SKU-keyed lookup", and it has never been measured.
  c.rescuableShare = c.neverRepriced ? c.neverRepricedOffered / c.neverRepriced : 0;
  return c;
}

// ── IS THE EVIDENCE THE CENSUS SPLITS ON ACTUALLY THERE? ─────────────────────
//
// coverageCensus() reads "no refreshedAt" as "the re-pricer has never reached
// this row". That is only true while every stamp the re-pricer wrote is still
// on the row it wrote it to. THIS JOB IS THE ONLY THING THAT CAN DESTROY ONE:
// applyMatchToPart assigns a freshly built listing over part.deals[fieldKey]
// wholesale, so every field it does not name is gone.
//
// It has already happened once, on the 2026-09-02 ingest, before the carry
// above existed: refreshedAt 2125 -> 386 in a single run (-1739). #81 stopped
// the bleeding but restored nothing, and a deleted stamp is indistinguishable
// from a stamp that was never written. Had the census run against that tree it
// would have put 2,803 rows in neverRepriced when roughly 1,064 belonged there.
//
// AND THE ERROR HAS A DIRECTION. feedOffered.add() and the wholesale assignment
// are the same code path in applyMatchToPart, so every row that loses a stamp
// is BY CONSTRUCTION a row the feed offered. Erased rows land in the numerator
// AND the denominator of rescuableShare at ~100% coverage, dragging it upward.
// A true 40% prints as roughly 77% — "the feed covers the tail, do the cheap
// fix", which is the expensive mistake this census was built to prevent.
//
// The existing gate asks "did we look at the feed?" and says nothing when the
// answer is no. This is the same question one level down — "is the other side
// of the split still intact?" — and it has to have the same answer shape: no
// number at all, rather than a confident wrong one.

// ── THE FLOOR, DERIVED ───────────────────────────────────────────────────────
//
// The floor the plausibility check uses, DERIVED from the re-pricer's own
// measured reach rather than picked. refresh-newegg-prices.cjs commits one
// figure to src/data/newegg-reach.json — the high-water share of reachable rows
// a completed run leaves stamped — and the floor is HALF of it.
//
// WHY HALF. The floor has to separate two states: "a completed run is in this
// catalog" and "the evidence has been eaten". The first leaves `reach` of the
// reachable rows stamped; the second leaves the residue. Half of reach says a
// catalog holding less than half of what a single run writes cannot contain a
// completed run — which is the claim the check actually wants to make, stated
// in terms of the run rather than in terms of a number someone liked.
//
// It also lands almost exactly where the hand-picked constant was. The seeded
// observation is 2,031 of 3,104 (65.4%), so the floor is 32.7% against the old
// 33.3%. That agreement is the point: the constant was a good guess, and it has
// stopped being a guess. It now moves on its own — add GPU to CAT_FILTER and
// both `reachable` here and `lookupable` there grow from the same rule, and the
// floor follows the behaviour instead of being left behind by it.
//
// The numerator is the re-pricer's `stats.stamped`, not its `stats.ok`. They
// differ by the price-suspect rows, which match and then withhold the write —
// 63 of them on the seeded run. This side counts rows carrying refreshedAt, so
// the other side has to measure the same thing or the floor is calibrated
// against a population the census cannot see.
//
// FALLBACK. Until a run has committed an observation the file is absent, and
// the floor is the historical 1/3 — the same number, so the transition changes
// no verdict. A malformed or out-of-range value falls back the same way rather
// than letting a corrupt file quietly relax the gate. Both cases say which one
// they used in the void message, because a floor whose provenance is invisible
// is the thing this change exists to remove.
const HISTORICAL_MIN_STAMPED_SHARE = 1 / 3;
const REACH_FILE = path.join(__dirname, 'src', 'data', 'newegg-reach.json');

/**
 * The committed reach observation, or null when there is not a usable one.
 * Exported so the derivation can be tested against a fixture file.
 */
function loadNeweggReach(file = REACH_FILE) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  // A reach of 0 is not an observation of a working re-pricer, and >1 is not a
  // share at all. Either means the file is wrong, and a wrong file must not be
  // able to move this floor.
  if (!raw || !Number.isFinite(raw.reach) || raw.reach <= 0 || raw.reach > 1) return null;
  return raw;
}

/**
 * floor = reach / 2, with provenance so the message can say where it came from.
 */
function stampedShareFloor(reach = loadNeweggReach()) {
  if (!reach) {
    return {
      value: HISTORICAL_MIN_STAMPED_SHARE, derived: false, reach: null, observedAt: null,
      source: 'no committed reach observation (src/data/newegg-reach.json) — historical constant',
    };
  }
  return {
    value: reach.reach / 2, derived: true, reach: reach.reach, observedAt: reach.observedAt,
    source: `half the ${(100 * reach.reach).toFixed(1)}% reach the re-pricer demonstrated ` +
            `(${reach.stamped}/${reach.lookupable} on ${String(reach.observedAt).slice(0, 10)})`,
  };
}

/**
 * Count deals.newegg rows carrying a re-pricer stamp. Pure and exported so the
 * before/after pair below is a measurement rather than an assumption.
 */
function countRefreshStamps(parts) {
  let n = 0;
  for (const p of parts) {
    const d = p && p.deals && p.deals.newegg;
    if (d && typeof d === 'object' && d.refreshedAt) n++;
  }
  return n;
}

/**
 * Verdict on whether coverageCensus() is entitled to publish a number.
 *
 * TWO INDEPENDENT FAILURES, because there are two ways a stamp goes missing.
 *
 * 1. THIS RUN destroyed it, and nothing accounts for that. `before` is counted
 *    as the catalog loads and `after` once the merchant loop is done, so the
 *    total loss is a direct observation rather than an inference.
 *
 *    NOT ALL OF IT IS DAMAGE. A genuine listing swap drops refreshedAt by
 *    design — the stamp attests to a price on a listing the row no longer
 *    holds — so a healthy night loses some, and voiding on any loss at all
 *    would mean the census never publishes. `droppedOnReplacement` counts
 *    those as they happen, and what matters is the REMAINDER: stamps that
 *    vanished with no swap to explain them. That figure should be exactly
 *    zero, so it needs no threshold, and any excess is a bug by definition.
 *
 *    This is the permanent regression guard on the #81 carry. That fix is four
 *    lines inside an `if (sameListing)` and nothing downstream would notice it
 *    being dropped — the catalog would still be written, the job would still
 *    report success, and only the census would quietly skew.
 *
 *    The by-design drops are disclosed, not fatal. They do contaminate the
 *    split — a swapped row was reached by the re-pricer and will now read as
 *    never-repriced — but the count is exact and printed, so it is a caveat of
 *    known size rather than the hidden bias this guard exists to prevent.
 *
 * 2. AN EARLIER RUN destroyed it and no re-pricer run has replaced it yet.
 *    Nothing in this process saw that happen, so it cannot be measured the way
 *    (1) is; it can only be recognised by its shape. A re-pricer that has
 *    completed a run leaves stamps across the bulk of the rows it can address —
 *    it writes refreshedAt on EVERY successful lookup including the unchanged
 *    case — so a catalog where almost none of the reachable rows carry one is
 *    not a catalog whose tail is genuinely unreached. It is a catalog whose
 *    evidence has been eaten.
 *
 * `reachable` is DERIVED, not transcribed: it is the rows whose category has a
 * CAT_FILTER entry, the same source #84's lanesSolelyOwned() reads, because
 * searchNewegg() returns 'no_cat_mapping' without issuing a request otherwise.
 * A row the re-pricer structurally cannot address is not evidence of anything
 * when it has no stamp, and must not sit in this denominator.
 *
 * The floor is DERIVED the same way, and from the same kind of source: half of
 * the reach refresh-newegg-prices.cjs has demonstrated, committed to
 * src/data/newegg-reach.json by the run that demonstrated it. See
 * stampedShareFloor() for why half, and recordReach() over there for why it is
 * a high-water mark. Healthy is ~65% (2,031 of 3,104 reachable rows stamped);
 * the erased tree was ~12%; the derived floor sits at ~33%, far below anything
 * a working re-pricer produces and far above the damage, so it fires on a
 * collapse and not on an ordinary bad night.
 *
 * It remains a plausibility floor, NOT a staleness policy — it holds no opinion
 * about how old a stamp may be, and the census still refuses to own that
 * question. Deriving it changes what it is calibrated against, not what it
 * claims: `floor` is injectable so a caller can state one explicitly, and the
 * verdict carries the provenance so a void is readable without going and
 * finding out where the number came from.
 */
function stampIntegrity({ before, after, stamped, reachable, droppedOnReplacement = 0,
                          floor = stampedShareFloor() }) {
  const lostThisRun = Math.max(0, before - after);
  const unexplainedLoss = lostThisRun - droppedOnReplacement;
  const stampedShare = reachable > 0 ? stamped / reachable : 0;
  const collapsed = reachable > 0 && stampedShare < floor.value;

  const reasons = [];
  if (unexplainedLoss > 0) {
    reasons.push(
      `this run destroyed ${lostThisRun} refreshedAt stamp(s) (${before} -> ${after}) and only ` +
      `${droppedOnReplacement} are explained by a listing swap — ${unexplainedLoss} vanished with ` +
      `nothing to account for them, which means the #81 carry is not holding`);
  }
  if (collapsed) {
    reasons.push(
      `only ${stamped} of ${reachable} re-pricer-reachable rows carry refreshedAt ` +
      `(${(100 * stampedShare).toFixed(1)}%, floor ${(100 * floor.value).toFixed(1)}% = ${floor.source}) — ` +
      `no completed re-pricer run is represented in this catalog`);
  }

  return {
    intact: reasons.length === 0,
    lostThisRun, droppedOnReplacement, unexplainedLoss,
    stamped, reachable, stampedShare, reasons,
    // Carried so a void states the floor it was judged against and where that
    // floor came from, rather than leaving the reader to go looking.
    floor: floor.value, floorSource: floor.source, floorDerived: floor.derived,
  };
}

// ── Which listing do we keep? ────────────────────────────────────────────────
// Exported and pure so the rule can be asserted on directly. It was previously
// inline in applyMatchToPart, where the only way to exercise it was a live SFTP
// pull of a 226MB feed.
//
// THE DISTINCTION THIS FUNCTION EXISTS TO MAKE: a feed carries several listings
// for the same product, and picking between them is a SELECTION. Re-reading the
// listing we already stored is a REPRICE. The old code had one branch for both,
// so yesterday's stored price competed against today's price for the very same
// listing — and won whenever today's was higher, because `newPrice < oldPrice`
// is the only path that displaces a same-rank in-stock listing.
//
// A price RISE was therefore never written to any lane this file solely owns.
// That is the #70 mechanism one layer down: the frozen low number is
// disproportionately the cheapest, the cheapest wins BEST, and open-box is the
// lane whose entire proposition is being cheaper. Measured on 2026-08-28: 180
// open-box products tracked since 2026-05-30 took 10 price steps between them,
// against 2,095 for deals.newegg over the same window. deals.newegg is not
// better behaved — it has a re-pricer that overwrites this selector nightly.
//
// @param {object|null} existing   the listing already stored on the row
// @param {object} incoming        {itemNumber, sku, price, saleprice, inStock}
// @param {function} sellerRank    NEG.sellerRank — lower is better
// @returns {{shouldReplace:boolean, sameListing:boolean}}
function chooseListing(existing, incoming, sellerRank) {
  const storedId = existing ? String(existing.itemNumber || existing.sku || '') : '';
  // An empty stored id must never match an empty incoming one — that would make
  // two unidentifiable listings "the same" and reprice one from the other.
  const sameListing = !!existing && storedId !== '' &&
    (storedId === String(incoming.itemNumber || '') || storedId === String(incoming.sku || ''));

  if (!existing) return { shouldReplace: true, sameListing: false };
  if (sameListing) return { shouldReplace: true, sameListing: true };

  const newRank = sellerRank(incoming.itemNumber);
  const oldRank = sellerRank(existing.itemNumber || existing.sku);
  if (newRank !== oldRank) return { shouldReplace: newRank < oldRank, sameListing: false };

  const newPrice = incoming.saleprice || incoming.price;
  const oldPrice = existing.saleprice || existing.price;
  let shouldReplace = false;
  if (incoming.inStock && !existing.inStock) shouldReplace = true;
  else if (existing.inStock && !incoming.inStock) shouldReplace = false;
  else if (newPrice < oldPrice) shouldReplace = true;
  return { shouldReplace, sameListing: false };
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

  // Census point. Deliberately HERE: past pricing and the capacity guard, so a
  // counted row is one the feed could actually have confirmed — but before
  // chooseListing and the sanity gate, so a row we merely declined to overwrite
  // still counts as covered. Putting it after those would measure our own
  // selection rules again, which is the thing already measured everywhere else.
  feedOffered.add(laneKey(part, fieldKey));

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
  // Selection vs reprice — see chooseListing() above for why that distinction is
  // the whole bug. `let`, because the sanity gate below can still veto a write.
  const choice = chooseListing(
    existing,
    { itemNumber, sku: rec.sku, price: pricing.price, saleprice: pricing.saleprice, inStock },
    NEG.sellerRank,
  );
  const sameListing = choice.sameListing;
  let shouldReplace = choice.shouldReplace;   // let: the sanity gate can veto

  // matchedAt means "when this row was bound to this SKU", and re-reading the
  // price of a listing we already hold does not re-bind anything. Carrying it
  // keeps the field answering the question it is named for — which matters
  // because scripts/assert-retailer-freshness.cjs counts matchedAt as a
  // confirmation stamp, and letting it advance on every reprice would let this
  // job satisfy that gate without priceConfirmedAt ever being written.
  if (sameListing && existing.matchedAt) newListing.matchedAt = existing.matchedAt;

  // ── STAMPS THIS JOB MUST NOT DESTROY ────────────────────────────────────────
  //
  // newListing is built from the feed record and then assigned over
  // part.deals[fieldKey] wholesale, so every field not named above is erased.
  // For the condition lanes that is harmless — this job is their only writer.
  // For deals.newegg it is not: refresh-newegg-prices.cjs writes that lane twice
  // a day and its stamps were being wiped by this assignment every night.
  //
  // Measured across the 2026-09-02 ingest (6147e809174 -> 14c2aae18ba), one run:
  //
  //   refreshedAt       2125 -> 386    (-1739)
  //   priceLastMovedAt   703 -> 601     (-102)
  //   rematchedAt         70 ->  43      (-27)
  //   migratedAt          56 ->  29      (-27)
  //
  // The effect was an exact inversion of what the two jobs are for. matchedAt is
  // carried above deliberately, so the row KEPT a 15-day-old binding stamp and
  // LOST the 0-day-old confirmation the re-pricer had just written — which is
  // how assert-retailer-freshness read newegg at a 15d median six hours after
  // the same catalog measured 0d and passed. The re-pricer was landing on 2,102
  // of 3,189 rows every run the whole time; this line is what hid it.
  //
  // CARRIED, NOT WRITTEN. This job must never mint a confirmation for
  // deals.newegg. The CADENCE table in assert-retailer-freshness.cjs cites
  // refresh-newegg-prices.yml for that lane and deliberately not this workflow,
  // because a job certifying a lane that has its own re-pricer would let that
  // re-pricer die unnoticed — the same reason the CONDITION_LANES block below
  // writes priceConfirmedAt only for lanes this job solely owns. Preserving a
  // stamp another job wrote keeps that property exactly: with the re-pricer
  // dead these fields stop advancing and the lane goes stale on schedule.
  //
  // Gated on sameListing for the same reason matchedAt is. On a genuine
  // replacement these attest to a listing the row no longer holds, and carrying
  // them would vouch for a price nothing has confirmed.
  if (sameListing) {
    for (const f of ['refreshedAt', 'migratedAt', 'migratedFrom', 'rematchedAt', 'rematchedFrom']) {
      if (existing[f] != null) newListing[f] = existing[f];
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
    // Counted here and not at the carry above, because only this branch writes:
    // a row we decline to replace keeps its stamp untouched.
    if (existing && existing.refreshedAt && !newListing.refreshedAt) stampsDroppedOnReplacement++;

    // priceLastMovedAt advances only when the NUMBER moved, and must be carried
    // across explicitly — newListing is a fresh object, so anything not copied
    // here is erased and the row reads as never-moved forever after. Same
    // reasoning and same hazard as the skuChanged branch in
    // refresh-newegg-prices.cjs.
    //
    // HOISTED OUT OF THE CONDITION-LANE BLOCK. It used to sit below, so
    // deals.newegg — the largest lane, and the one scripts/price-movement.cjs
    // actually reports on — was the single lane whose movement history this job
    // erased: -102 rows on the 2026-09-02 ingest alone. That erasure feeds
    // straight back into the re-pricer's own movement assertion, which warned at
    // movedShare 0.0988 against a 0.1 floor on run 33607979228 while this job
    // was deleting the evidence between runs.
    //
    // Unlike priceConfirmedAt below, this is safe on every lane: it is not in
    // CONFIRMATION_STAMPS, so advancing it cannot let this job satisfy the
    // freshness gate on a lane it must not certify.
    const newEff = pricing.saleprice || pricing.price;
    const oldEff = existing ? (existing.saleprice || existing.price) : null;
    const moved = existing != null && newEff !== oldEff;
    const carried = moved ? TODAY : existing && existing.priceLastMovedAt;
    if (carried) newListing.priceLastMovedAt = carried;

    if (lanesSolelyOwned(part).includes(fieldKey)) {
      // ── The stamp that was never written ────────────────────────────────────
      // This job has repriced these lanes nightly since it was built and left no
      // trace that it had, because matchedAt is the only *At it wrote — and
      // matchedAt records when a row was BOUND TO A SKU, not when its price was
      // confirmed. src/price-freshness.js refuses it as a freshness stamp for
      // that reason, correctly: all 182 open-box rows carry matchedAt and 0
      // carry any price confirmation, so the render path could only read them as
      // never-confirmed. The rows were not unrefreshed. They were unstamped.
      newListing.priceConfirmedAt = TODAY;

      // Confirmed lanes never keep a stale negative. newListing is fresh, so
      // priceUnconfirmedAt is dropped by construction — recorded here so the
      // absence sweep below and this line are read as the pair they are.
      confirmedLanes.add(laneKey(part, fieldKey));
    }
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
// Exported so other jobs can share the parser instead of copying it, and so
// test/sftp-ingest.streaming.test.js can drive it without SFTP. Everything
// below the guard is the nightly ingest's own run.
//
// THE GUARD IS LEAD, NOT TRIM. Without `require.main === module` this file's
// main IIFE fires on `require()`, so newegg-dead-sku-audit.cjs merely importing
// the parser launched a SECOND full ingest in the background — a competing SFTP
// session on an endpoint that throttles concurrent readers, and, had it run to
// completion, a write to parts.js from a job declared read-only. Run
// 32057560889 paid for that: ~1.3GB of duplicate downloads and a 535s/2973s
// pair of feed pulls that contended with each other the whole way.
// The two ESM deps applyMatchToPart reaches through. Previously inlined in the
// main block, which meant nothing but a live SFTP pull could load them and so
// nothing but a live SFTP pull could exercise the write path. Same shape, and
// the same reason, as loadMatcher() in refresh-newegg-prices.cjs.
async function loadDeps() {
  const root = __dirname.replace(/\\/g, '/');
  if (!CAP) CAP = await import('file://' + root + '/normalize-product-name.js');
  if (!NEG) NEG = await import('file://' + root + '/newegg-match.js');
}

module.exports = { streamTxtFeed, parseTxtFeed, matchRecord, buildCatalogIndex, loadDeps,
                   DEFAULT_FIELD_ORDER, normUPC, normMPN,
                   chooseListing, detectCondition, CONDITION_LANES, lanesSolelyOwned,
                   coverageCensus, laneKey, countRefreshStamps, stampIntegrity,
                   loadNeweggReach, stampedShareFloor, REACH_FILE,
                   // Exported so the stamp-carry rules above can be asserted directly.
                   // They were previously reachable only through a live SFTP pull, which
                   // is why a wholesale assignment could erase 1,739 stamps a night
                   // without a single test noticing.
                   applyMatchToPart };

if (require.main === module) (async () => {
  await loadDeps();

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
  
  // Counted BEFORE anything mutates the catalog: half of the stamp-integrity
  // check below is a before/after pair, and "before" has to mean before the
  // merchant loop, not before the census. See stampIntegrity().
  const refreshStampsAtLoad = countRefreshStamps(parts);
  log(`Re-pricer stamps on deals.newegg at load: ${refreshStampsAtLoad}`);

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

  let fullNeweggFeedParsed = false;

  for (const dl of downloaded) {
    log(`\nâ”€â”€ Merchant ${dl.mid}: ${dl.fileName} â”€â”€`);
    
    const ms = { matched: 0, updated: 0, exclusives: 0, byMethod: { upc: 0, mpn: 0, sku: 0, 'brand+name': 0, name: 0 } };
    
    // Match + apply INSIDE the stream callback. No intermediate array exists,
    // so peak heap is the catalog index plus one record — flat in feed size.
    const onRecord = (rec, ctl) => {
      // Skip deleted products
      if (/^(1|true|yes|deleted)$/i.test(rec.is_deleted || '')) return;
      // Skip out-of-stock
      if (/out-of-stock|unavailable|no/i.test(rec.availability || '')) return;
      
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
          if (exclusivesStream) {
            // write() returning false means the buffer is full. Pause the feed
            // until it drains rather than queueing another million lines.
            if (!exclusivesStream.write(JSON.stringify(exclusiveRec) + '\n')) {
              ctl.backpressure(exclusivesStream);
            }
          }
          exclusivesCount++;
          ms.exclusives++;
        }
      }
    };

    let parsed;
    try {
      parsed = await streamTxtFeed(dl.localPath, onRecord);
    } catch (e) {
      log(`  âœ— Parse error: ${e.message}`);
      summary.totals.errors++;
      continue;
    }
    
    // A FULL feed for the Newegg MID is the only thing that licenses the absence
    // sweep below. A delta carries only what CHANGED, so a row's absence from it
    // means "unchanged", the exact opposite of "gone" — and `_deltatemplate`
    // contains `_delta`, so it is excluded here too.
    if (dl.mid === NEWEGG_MID && !/_delta/i.test(dl.fileName)) fullNeweggFeedParsed = true;

    log(`  Parsed ${parsed.recordCount} records (header has ${parsed.header.length} fields)`);
    if (parsed.trailerCount != null && parsed.trailerCount !== parsed.recordCount) {
      log(`  âš  Trailer count ${parsed.trailerCount} != parsed ${parsed.recordCount}`);
    }
    summary.totals.feedRecords += parsed.recordCount;
    
    
    log(`  Matched: ${ms.matched} | Exclusives: ${ms.exclusives}`);
    log(`  By method: ${JSON.stringify(ms.byMethod)}`);
    summary.perMerchant[dl.mid] = ms;
    summary.totals.matched += ms.matched;
    summary.totals.updated += ms.updated;
    summary.totals.exclusives += ms.exclusives;
  }

  // ── The absence sweep: "we looked and it wasn't there" ──────────────────────
  //
  // Stamping only what the feed RETURNS can never clear a row the feed has
  // stopped carrying. Those rows would simply keep the last price they were
  // given and, with no negative stamp, would look no different from a row that
  // was never due a refresh. That is the same hole #72 closed on the other side
  // of this pipeline: a question never asked is not evidence about the answer,
  // and silence is not an answer either.
  //
  // priceUnconfirmedAt is the existing vocabulary for this — the Amazon write
  // paths write it, and scripts/assert-retailer-freshness.cjs already ranks a
  // negative stamp NEWER than every positive one as "the most recent thing we
  // know is that we could not confirm". Nothing new to teach the gate.
  //
  // GATED, because a wrong absence claim is worse than no claim:
  //   - only when a FULL Newegg feed was parsed this run. Unchanged files are
  //     skipped by the manifest and the job returns early on `downloaded.length
  //     === 0`, so on a quiet day we look at nothing and must say nothing.
  //   - only the lanes this file solely owns. For a row the re-pricer can
  //     reach, deals.newegg is its business: it decides absence with a proven
  //     streak and a breaker, and a second opinion from here would fight it.
  //     For a row in a category with no CAT_FILTER entry the re-pricer never
  //     issues a request at all, so there is no opinion to fight and silence
  //     from this feed is the only evidence that will ever exist.
  //
  // What the stamp asserts is narrow and exactly what was observed: this run's
  // full feed offered no BUYABLE listing for this row. It does not distinguish
  // delisted from out-of-stock, because onRecord drops out-of-stock records
  // before matching and so this job genuinely cannot tell them apart. Either
  // way we could not confirm a price, which is what the stamp says.
  let unconfirmed = 0;
  if (fullNeweggFeedParsed) {
    for (const p of parts) {
      if (!p.deals) continue;
      // Symmetric with the confirmation above, and it has to be: a lane this
      // job may certify is a lane it must also be able to say nothing about.
      // Stamping only what the feed returns can never clear a row the feed has
      // stopped carrying, so an unmappable row that fell out of the feed would
      // keep its last price forever with no negative stamp — the same hole this
      // sweep was built to close for the condition lanes.
      for (const lane of lanesSolelyOwned(p)) {
        const d = p.deals[lane];
        if (!d || typeof d !== 'object') continue;
        if (confirmedLanes.has(laneKey(p, lane))) continue;
        d.priceUnconfirmedAt = TODAY;
        unconfirmed++;
      }
    }
    log(`\nAbsence sweep: ${confirmedLanes.size} condition-lane rows confirmed, ${unconfirmed} stamped priceUnconfirmedAt`);

    // ── COVERAGE CENSUS — deals.newegg, READ-ONLY ─────────────────────────────
    // Nothing below writes. Gated on the same fullNeweggFeedParsed as the sweep
    // above and for the same reason: on a quiet day the manifest skips the feed,
    // so "the feed did not offer this row" would mean "we did not look", and a
    // coverage number built on that is worse than none.
    //
    // ...and gated a second time on the evidence the split itself reads. The
    // gate above asks whether we looked at the feed; this one asks whether the
    // re-pricer's side of the comparison survived to be counted. A census with
    // erased stamps is not a weaker measurement, it is a WRONG one, and biased
    // toward the cheaper conclusion — see stampIntegrity() for why the error
    // only ever points one way.
    //
    // One count, used as both halves: "how many stamps survive this run" and
    // "how many stamps exist at all" are the same question asked of the same
    // catalog at the same moment.
    const refreshStampsNow = countRefreshStamps(parts);
    const integrity = stampIntegrity({
      before: refreshStampsAtLoad,
      after: refreshStampsNow,
      stamped: refreshStampsNow,
      droppedOnReplacement: stampsDroppedOnReplacement,
      reachable: parts.reduce((n, p) => {
        const d = p && p.deals && p.deals.newegg;
        return n + (d && typeof d === 'object' && NEG.CAT_FILTER[p.c] ? 1 : 0);
      }, 0),
    });
    summary.totals.stampIntegrity = integrity;

    const census = coverageCensus(parts, feedOffered);
    const pct = (n, d) => (d ? (100 * n / d).toFixed(1) : '0.0') + '%';
    log('\nCoverage census — deals.newegg (READ-ONLY, nothing stamped here)');
    log(`  rows ................................. ${census.rows}`);
    log(`  this run's feed offered a listing .... ${census.offered}  (${pct(census.offered, census.rows)})`);
    log(`  reached by refresh-newegg-prices ..... ${census.repriced}`);
    log(`     of which this feed also offered ... ${census.repricedOffered}  (${pct(census.repricedOffered, census.repriced)})`);
    log(`  NEVER reached by the re-pricer ....... ${census.neverRepriced}`);
    log(`     of which this feed offered ........ ${census.neverRepricedOffered}  (${pct(census.neverRepricedOffered, census.neverRepriced)})  <- rescuable`);

    // The counts above are printed either way — they are what a human needs to
    // SEE the damage. The share is not, because the share is the thing that
    // gets acted on.
    if (integrity.intact) {
      log(`  rescuable share ...................... ${pct(census.neverRepricedOffered, census.neverRepriced)}`);
      log('  A high rescuable share means the tail can be confirmed from this feed.');
      log('  A low one means it needs a lookup keyed on the itemNumber we store.');
      // Disclosed even when clean: these rows were reached by the re-pricer and
      // are counted on the never-repriced side anyway, so the share is high by
      // this much. Exact and stated, rather than silently baked in.
      if (integrity.droppedOnReplacement > 0) {
        log(`  CAVEAT: ${integrity.droppedOnReplacement} row(s) lost a stamp to a listing swap this run and`);
        log('  are counted as never-repriced. The share above is overstated by that many rows.');
      }
      summary.totals.coverageCensus = census;
    } else {
      log('\n  ** CENSUS VOID — the refreshedAt evidence this split reads is not intact **');
      for (const r of integrity.reasons) log(`     - ${r}`);
      log(`     stamped ${integrity.stamped} of ${integrity.reachable} re-pricer-reachable rows ` +
          `(${(100 * integrity.stampedShare).toFixed(1)}%, floor ${(100 * integrity.floor).toFixed(1)}%)`);
      log(`     floor: ${integrity.floorSource}`);
      log('     The rescuable share is NOT reported. Rows whose stamp was destroyed are');
      log('     rows the feed offered, so they inflate it toward "the feed covers the');
      log('     tail" — the cheap conclusion — and a number that is wrong in a known');
      log('     direction is worse than no number. Let a full refresh-newegg-prices run');
      log('     land, then read the next nightly.');
      summary.totals.coverageCensus = null;
    }
  } else {
    log('\nAbsence sweep SKIPPED — no full Newegg feed parsed this run (nothing was looked at, so nothing is absent)');
    log('Coverage census SKIPPED for the same reason — an unlooked-at row is not an uncovered one');
    summary.totals.coverageCensus = null;
    summary.totals.stampIntegrity = null;
  }
  summary.totals.conditionLanesConfirmed = confirmedLanes.size;
  summary.totals.conditionLanesUnconfirmed = unconfirmed;
  summary.totals.absenceSweepRan = fullNeweggFeedParsed;

  // Write outputs
  if (DRY_RUN) {
    log('\n--dry-run: not writing parts.js or exclusives.json');
  } else {
    // `unconfirmed` counts too: an absence sweep that stamped rows changed the
    // catalog even when not one price moved, and gating the write on `updated`
    // alone would drop exactly the negative evidence this run went to the
    // trouble of establishing.
    if (summary.totals.updated > 0 || unconfirmed > 0) {
      log(`\nWriting ${parts.length} products to parts.js (${summary.totals.updated} updated, ${unconfirmed} marked unconfirmed)...`);
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
