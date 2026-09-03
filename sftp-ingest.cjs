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
// The sanctioned catalog writer. See the replacement of this file's own
// writeParts() below for why the local one is gone.
const { writeCatalog } = require('./scripts/write-catalog.cjs');

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

// ── WHAT AN ENTRY IN THE MANIFEST CLAIMS ─────────────────────────────────────
//
// One entry per remote feed file, and its only reader is the unchanged-file
// skip in walkAndDownload: every file named here is a file the next run will
// decline to look at. #91 fixed WHEN the manifest is written -- after the work,
// not after the download. This fixes WHAT is in it on a run that did some of
// the work and not the rest.
//
// A feed whose parse throws part-way is counted in totals.errors and
// `continue`d past, but its entry was minted by walkAndDownload at download
// time and rode out with the rest of the manifest at the end of the run. So it
// went on record as processed on the strength of having been FETCHED -- the
// exact substitution #91 removed, surviving at the granularity of one feed.
//
// It escapes by CACHE, not by git, and the second night is the quiet one.
// sftp-ingest.yml asserts totals.errors==0 between the run and the commit, so
// the red run never commits the manifest -- but actions/cache saves in its post
// step, which runs on a failed job (unlike a cancelled one), and the next run
// restores it by prefix. Night one is red and loud. Night two skips the feed as
// unchanged, downloads nothing, returns at "Nothing new to process, done." with
// errors==0 -- and the assertion passes, because feedRecords>0 is a --warn, not
// a --require. Green, quiet, nothing ingested, and it stays that way until the
// feed's size or mtime happens to move on the server. One bad parse, one loud
// night and then an unbounded silent one: the 95-day freeze again, entered
// through a door #91 left open.
//
// So a feed that did not finish parsing is MARKED rather than trusted, and the
// mark is what the skip consults. The price is one re-fetch of an unchanged
// feed (~4 min streamed) and only after a failure -- what #91 already paid for
// the same silence.

// ── A HOLD MUST AGE ──────────────────────────────────────────────────────────
//
// #92 made a feed that threw mid-parse come back the next night instead of
// being skipped forever. It left this behind: a DETERMINISTIC failure now comes
// back every night, fails identically every night, and reports itself in
// exactly the same words every night.
//
// That is how epik-watchdog.yml earned its mute. Its own header was written
// against passive signals, and it still went red every 30 minutes until the red
// stopped carrying information and the schedule was commented out. An alarm
// that repeats is an alarm that gets turned off, and a turned-off alarm is the
// 95-day freeze with extra steps.
//
// So the hold accumulates. The manifest carries how many consecutive runs it
// has survived, when it started, and how many distinct versions of the file
// have been fetched and refused -- and past HOLD_ESCALATE_AFTER the run stops
// reporting a parse error and starts reporting a stale catalog. Different
// claim, different remedy, different failing step, so the notification itself
// changes: night two says "this may be a bad transfer", night five says "these
// rows have not reached the catalog in five days".
//
// The counters survive red nights by the same route the hold does -- the
// manifest is written at the end of this process and actions/cache saves it in
// a post step that runs on a failed job. See "WHAT AN ENTRY IN THE MANIFEST
// CLAIMS" above; escalation is only possible because that path exists.

// Consecutive failed attempts before a hold stops being a parse error. Stated,
// not magic: night one can be a truncated transfer, night two re-fetches the
// file and rules that out, and by night three the failure is deterministic and
// the merchant's rows have been missing from every ingest for three days.
const HOLD_ESCALATE_AFTER = 3;

/** Hold a feed off the skip list: it was fetched, but nothing read it through. */
function markFeedParseFailed(manifest, remotePath, err, now = new Date()) {
  const prev = (manifest.files || {})[remotePath];
  // No entry is already "not on record", which is the state we are asking for.
  // Minting one here would invent a size/mtime pair nothing measured.
  if (!prev) return null;

  const stamp = now.toISOString();
  const bytes = `${prev.size}:${prev.mtime}`;
  // parseFailedAt alone means a hold written before this counter existed (#92).
  // It is a hold in progress, not a fresh one, so it continues at the count it
  // implies rather than resetting the clock a cached manifest already started.
  const continuing = !!prev.parseFailedAt;
  // Read BEFORE the overwrite below. A #92-era entry records the failure but not
  // its age, and its parseFailedAt is the only evidence of when the hold began;
  // taking the fallback after the assignment would silently restart the clock at
  // now, every run, and an age that resets every run never reaches a threshold.
  const previouslyFailedAt = prev.parseFailedAt;

  prev.parseFailedAt = stamp;
  prev.parseError = String((err && err.message) || err || 'unknown');

  if (!continuing) {
    prev.parseFailedFirstAt = stamp;
    prev.parseFailStreak = 1;
    prev.parseFailVersions = 1;
  } else {
    prev.parseFailedFirstAt = prev.parseFailedFirstAt || previouslyFailedAt;
    prev.parseFailStreak = (prev.parseFailStreak || 1) + 1;
    // A REPUBLISHED feed that still will not parse does not reset the streak.
    // It is a worse signal, not a fresh start -- the merchant is publishing
    // broken files rather than one transfer having gone wrong -- and the streak
    // measures how long these rows have been missing from the catalog, which is
    // a clock that does not care whose fault it is. Counted separately so the
    // escalation can say which of the two it is looking at.
    if (prev.parseFailBytes !== bytes) prev.parseFailVersions = (prev.parseFailVersions || 1) + 1;
  }
  prev.parseFailBytes = bytes;
  return prev;
}

/**
 * How old is this hold, and has it stopped being a parse error?
 *
 * Pure and exported: the decision to escalate is the kind of rule that must be
 * assertable without a live SFTP pull and a calendar.
 */
function holdVerdict(entry, now = new Date()) {
  if (!entry || !entry.parseFailedAt) return { held: false };
  // Defaults cover an entry marked by the #92-era code, which recorded the
  // failure but not its age. One failure, starting whenever it was recorded.
  const streak = entry.parseFailStreak || 1;
  const firstAt = entry.parseFailedFirstAt || entry.parseFailedAt;
  const started = Date.parse(firstAt);
  const days = Number.isFinite(started)
    ? Math.max(0, Math.floor((now.getTime() - started) / 86400000))
    : 0;
  return {
    held: true,
    streak,
    firstAt,
    days,
    versions: entry.parseFailVersions || 1,
    error: entry.parseError || 'unknown',
    escalated: streak >= HOLD_ESCALATE_AFTER,
  };
}

/**
 * The manifest entry for a file that has just finished downloading.
 *
 * The hold is CARRIED, not re-minted. A completed download proves the bytes are
 * on disk, not that anything read them, so it is not the event that clears a
 * parse failure -- the next successful parse is. Returning a clean entry here
 * instead would let `--download-only` (which saves the manifest and never
 * parses) quietly promote a held feed to processed: this same bug, wearing the
 * other flag.
 */
function mintFeedEntry(prev, { size, mtime, mid, localPath }) {
  const entry = { size, mtime, mid, localPath, downloadedAt: new Date().toISOString() };
  if (prev && prev.parseFailedAt) {
    entry.parseFailedAt = prev.parseFailedAt;
    entry.parseError = prev.parseError;
    // The age travels with the hold. Dropping it here would restart the streak
    // on every re-download, which is every run -- an escalation that can never
    // reach its own threshold.
    entry.parseFailedFirstAt = prev.parseFailedFirstAt;
    entry.parseFailStreak = prev.parseFailStreak;
    entry.parseFailVersions = prev.parseFailVersions;
    entry.parseFailBytes = prev.parseFailBytes;
  }
  return entry;
}

/** Release the hold. Only a parse that ran to the end may call this. */
function clearFeedParseFailed(manifest, remotePath) {
  const prev = (manifest.files || {})[remotePath];
  if (!prev || !prev.parseFailedAt) return false;
  // Every field of the hold, not just the flag the skip reads. A surviving
  // streak would make the NEXT hold on this feed open at someone else's count
  // and escalate on its first night.
  delete prev.parseFailedAt;
  delete prev.parseError;
  delete prev.parseFailedFirstAt;
  delete prev.parseFailStreak;
  delete prev.parseFailVersions;
  delete prev.parseFailBytes;
  return true;
}

// The skip decision itself, pure and exported so it can be asserted without a
// live SFTP pull -- the same reason applyMatchToPart is exported below.
//
// Unchanged is necessary but not sufficient. The size/mtime pair says the bytes
// are the ones we already have; parseFailedAt says we never got through them.
// Skipping on the first without consulting the second is what put a feed
// permanently out of reach.
function onRecordAsProcessed(prev, remoteSize, remoteMTime) {
  if (!prev) return false;
  if (prev.parseFailedAt) return false;
  return prev.size === remoteSize && prev.mtime === remoteMTime;
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
        
        if (onRecordAsProcessed(prev, remoteSize, remoteMTime)) {
          log(`  â­  ${entry.name} (unchanged, ${(remoteSize/1024/1024).toFixed(1)}MB)`);
          continue;
        }

        // Unchanged bytes we already hold, but the last run did not get
        // through them. Re-fetched rather than re-read from disk: a truncated
        // or corrupt download is one of the likelier ways a parse throws
        // mid-stream, and that is the case where the local copy is the problem.
        if (prev && prev.parseFailedAt && prev.size === remoteSize && prev.mtime === remoteMTime) {
          log(`  ↻  ${entry.name} (unchanged, but last run failed to parse it: ${prev.parseError || 'unknown'})`);
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
        // Carries a parse hold across the re-download -- see mintFeedEntry.
        manifest.files[key] = mintFeedEntry(prev, { size: remoteSize, mtime: remoteMTime, mid, localPath });
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

// refreshedAt stamps this run dropped ON PURPOSE, and only refreshedAt: it is
// the one re-pricer stamp with a legitimate reason to go missing.
// priceLastMovedAt is carried across replacements too, so it has no counterpart
// here and stampIntegrity() nets nothing off it.
//
// A genuine listing swap must not carry
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
 * Count deals.newegg rows carrying each stamp the re-pricer writes and this job
 * must not destroy. Pure and exported so the before/after pair below is a
 * measurement rather than an assumption.
 *
 * TWO STAMPS, TALLIED SEPARATELY, because they go missing under different rules
 * and only one of them is ever allowed to:
 *
 *   refreshedAt       carried only under `sameListing`. A genuine listing swap
 *                     drops it BY DESIGN — the stamp attests to a price on a
 *                     listing the row no longer holds — so a healthy night
 *                     loses some, and stampIntegrity() subtracts
 *                     droppedOnReplacement to isolate the rest.
 *   priceLastMovedAt  carried on every branch that writes, replacement
 *                     included (see the carry under `shouldReplace`). Nothing
 *                     drops it on purpose, so it needs no allowance and no
 *                     threshold: ANY loss is a bug.
 *
 * ── WHY IT COUNTS BOTH, AS OF 2026-09-03 ────────────────────────────────────
 * It counted refreshedAt alone, and that asymmetry was a hole of exactly the
 * shape this file keeps re-learning. #81 restored both carries in the same
 * commit, but armed a regression guard over only one of them — and the carry it
 * left unwatched is four lines that nothing downstream would miss, because a
 * dropped priceLastMovedAt does not change the census, the catalog write, or
 * the job's exit code. It surfaces days later somewhere else entirely.
 *
 * That elsewhere is scripts/price-movement.cjs, whose `movedShare` divides rows
 * that moved price in 14 days by all priced rows. Erasing the stamp drains the
 * numerator only, so the alarm fires on the retailer rather than on the job
 * that ate the evidence: measured on the 2026-09-02 ingest, newegg went 315 ->
 * 202 priceLastMovedAt in one run (-113), and the re-pricer then reported
 * movedShare 0.0881 against a 0.1 floor with no row on the lane carrying a
 * stamp older than 5 days. That number was never about Newegg's prices.
 *
 * Newegg's movement warm-up ends 2026-09-12, at which point the suppressed
 * share alarm arms. A guard that measures the adjacent stamp would let the
 * regression through to that date and then blame the wrong job for it — which
 * is the same misattribution the freshness gate's max-vs-median rewrite and the
 * 12.0%-vs-40.5% sample both turned out to be. Measure the stamp the alarm
 * actually reads.
 */
function countRepricerStamps(parts) {
  const n = { refreshedAt: 0, priceLastMovedAt: 0 };
  for (const p of parts) {
    const d = p && p.deals && p.deals.newegg;
    if (!d || typeof d !== 'object') continue;
    if (d.refreshedAt) n.refreshedAt++;
    if (d.priceLastMovedAt) n.priceLastMovedAt++;
  }
  return n;
}

/**
 * Accept a tally from countRepricerStamps() and refuse anything else.
 *
 * Deliberately NOT tolerant of a bare number. This function used to take one —
 * the refreshedAt count — and coercing that shape into `{refreshedAt: n}` would
 * let a caller that has not been updated keep passing a half-measurement that
 * reads as a whole one, silently reinstating the exact blind spot the tally
 * exists to close. A caller that has not been taught about the second stamp
 * should fail loudly here, not measure one stamp and report on two.
 */
function asTally(v, which) {
  if (!v || typeof v !== 'object' || typeof v.refreshedAt !== 'number' ||
      typeof v.priceLastMovedAt !== 'number') {
    throw new Error(
      `stampIntegrity needs \`${which}\` as a countRepricerStamps() tally ` +
      `{refreshedAt, priceLastMovedAt}, got ${JSON.stringify(v)}`);
  }
  return v;
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
 *    BOTH RE-PRICER STAMPS ARE JUDGED HERE, under different rules, because #81
 *    restored two carries and this guard originally watched one. refreshedAt
 *    gets the allowance described below; priceLastMovedAt gets none, since no
 *    branch drops it deliberately. See countRepricerStamps() for why the second
 *    one is the stamp an unwatched regression surfaces through — it feeds
 *    scripts/price-movement.cjs, days later, as an alarm naming the wrong job.
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
  const b = asTally(before, 'before');
  const a = asTally(after, 'after');

  // refreshedAt. Some loss is by design, so the allowance is subtracted and the
  // REMAINDER is what convicts. See droppedOnReplacement.
  const lostThisRun = Math.max(0, b.refreshedAt - a.refreshedAt);
  const unexplainedLoss = lostThisRun - droppedOnReplacement;

  // priceLastMovedAt. No allowance and no threshold, because there is no branch
  // that drops it on purpose: the carry sits under `shouldReplace` rather than
  // under `sameListing`, so a swapped listing keeps its movement history, and a
  // row we decline to replace is never rewritten at all. Every path that can
  // touch the stamp preserves it, which makes any shortfall a defect by
  // construction rather than by policy.
  const movedLostThisRun = Math.max(0, b.priceLastMovedAt - a.priceLastMovedAt);

  const stampedShare = reachable > 0 ? stamped / reachable : 0;
  const collapsed = reachable > 0 && stampedShare < floor.value;

  // Damage THIS RUN did, and evidence that was already gone when it started.
  // Kept apart because they carry different consequences: the first is a defect
  // in this job and it stops, the second is a fact about the catalog and only
  // withholds the census. See damagedThisRun below.
  const damage = [];
  const missing = [];
  if (unexplainedLoss > 0) {
    damage.push(
      `this run destroyed ${lostThisRun} refreshedAt stamp(s) ` +
      `(${b.refreshedAt} -> ${a.refreshedAt}) and only ` +
      `${droppedOnReplacement} are explained by a listing swap — ${unexplainedLoss} vanished with ` +
      `nothing to account for them, which means the #81 carry is not holding`);
  }
  if (movedLostThisRun > 0) {
    damage.push(
      `this run destroyed ${movedLostThisRun} priceLastMovedAt stamp(s) ` +
      `(${b.priceLastMovedAt} -> ${a.priceLastMovedAt}). Nothing drops this stamp on purpose, so ` +
      `there is no legitimate loss to net off and the #81 carry is not holding. ` +
      `This is the stamp scripts/price-movement.cjs divides by: erasing it drains movedShare's ` +
      `numerator and the freeze alarm then fires on the retailer instead of on this job`);
  }
  if (collapsed) {
    missing.push(
      `only ${stamped} of ${reachable} re-pricer-reachable rows carry refreshedAt ` +
      `(${(100 * stampedShare).toFixed(1)}%, floor ${(100 * floor.value).toFixed(1)}% = ${floor.source}) — ` +
      `no completed re-pricer run is represented in this catalog`);
  }

  return {
    // Nothing is wrong at all: safe to publish the census.
    intact: damage.length === 0 && missing.length === 0,
    // THIS RUN ate evidence. A strictly stronger statement than !intact, and
    // the one with teeth: the caller stops the ingest on it rather than merely
    // withholding a number. Kept separate from `intact` on purpose — the
    // collapse reason describes a catalog an EARLIER run damaged, and refusing
    // to write because somebody else broke something would block this job's
    // legitimate work for a condition that heals itself the next time the
    // re-pricer lands.
    damagedThisRun: damage.length > 0,
    lostThisRun, droppedOnReplacement, unexplainedLoss,
    movedLostThisRun,
    stamped, reachable, stampedShare, reasons: [...damage, ...missing],
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

// -- THERE IS NO writeParts() HERE ANY MORE ----------------------------------
//
// It was a bare fs.writeFileSync of a JSON literal over src/data/parts.js: no
// size brake, no temp-and-rename, no check that the result parsed, and a
// SEPARATE workflow step responsible for re-splitting the literal back into the
// per-category chunks the frontend actually imports.
//
// That arrangement is the one scripts/write-catalog.cjs exists to abolish. Its
// header says it plainly -- the re-split "used to live in YAML, so nothing
// stopped a literal write from being the last thing that happened", and on
// 2026-06-27 that is exactly what went wrong: parts.js ended up with a literal
// PARTS *and* a stray spread barrel, a hard SyntaxError that broke prerender and
// the sitemap until it was repaired by hand. Around 30 scripts write the catalog
// through writeCatalog(), refresh-newegg-prices.cjs among them. This file was
// the holdout, which also made prerender.yml's comment ("every writer goes
// through scripts/write-catalog.cjs") untrue about the single largest writer.
//
// It matters more now than it did. The commit step is moving to run on a
// partially-failed run, so the bytes on disk have to be self-verifying rather
// than merely probably-fine: writeCatalog() does literal -> verify -> atomic
// same-filesystem promote -> re-split -> assertBarrelShape(), keeps a rolling
// pre-write backup of the barrel AND every chunk, and refuses a catastrophic
// shrink or growth. This ingest only ever mutates existing rows -- it never
// pushes or splices `parts` -- so those brakes cannot fire on it, and they cost
// nothing to carry.

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
                   coverageCensus, laneKey, countRepricerStamps, stampIntegrity,
                   loadNeweggReach, stampedShareFloor, REACH_FILE,
                   // Exported so the stamp-carry rules above can be asserted directly.
                   // They were previously reachable only through a live SFTP pull, which
                   // is why a wholesale assignment could erase 1,739 stamps a night
                   // without a single test noticing.
                   applyMatchToPart,
                   // Same reason: the manifest skip decided whether a feed is
                   // ever looked at again, and was reachable only through a
                   // live SFTP pull.
                   onRecordAsProcessed, mintFeedEntry, markFeedParseFailed, clearFeedParseFailed,
                   holdVerdict, HOLD_ESCALATE_AFTER };

if (require.main === module) (async () => {
  await loadDeps();

  const summary = {
    startedAt: new Date().toISOString(),
    dryRun: DRY_RUN,
    downloaded: [],
    perMerchant: {},
    // Named, not just counted. totals.errors is what sftp-ingest.yml asserts on;
    // this is what tells whoever opens the artifact WHICH feed did not land and
    // is therefore being held for a re-fetch.
    parseFailures: [],
    totals: { feedRecords: 0, matched: 0, updated: 0, exclusives: 0, errors: 0,
              // Zero here, not merely absent. The quiet early return below
              // ("Nothing new to process, done.") writes this summary too, and
              // sftp-ingest.yml asserts escalatedHolds==0 on every run -- a
              // missing path is an assertion failure, which would turn every
              // legitimately quiet night red.
              heldFeeds: 0, escalatedHolds: 0 }
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
      // NOT saved here. walkAndDownload has filled in manifest.files for what it
      // pulled, but the record is only written once the run has done something
      // with them -- see "THE MANIFEST IS EARNED" at the write-outputs block.
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
    // --download-only earns the record: fetching IS the declared work in that
    // mode, and --skip-download reads manifest.files to find what was left on
    // disk, so the two flags only compose if this writes. The other side of the
    // `||` downloaded nothing, so there is nothing new in the manifest to write.
    if (DOWNLOAD_ONLY && downloaded.length > 0) saveManifest(manifest);
    log(DOWNLOAD_ONLY ? 'Download-only mode, done.' : 'Nothing new to process, done.');
    fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
    return;
  }

  // PHASE 2-4: Parse, match, apply per merchant
  log('â”â”â” PHASE 2: Parse, Match, Apply â”â”â”');
  log('Loading catalog...');
  const partsModule = await import('file://' + PARTS_PATH.replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = partsModule.PARTS;
  // Taken at load and passed to writeCatalog() at the far end of the run, where
  // it is the reference for the shrink/growth brakes. Read here rather than at
  // the write because `parts` is mutated in between, and a brake that compares
  // the array against itself is not a brake.
  const loadedCount = parts.length;
  log(`Loaded ${parts.length} products`);
  
  // Counted BEFORE anything mutates the catalog: half of the stamp-integrity
  // check below is a before/after pair, and "before" has to mean before the
  // merchant loop, not before the census. See stampIntegrity().
  const refreshStampsAtLoad = countRepricerStamps(parts);
  log(`Re-pricer stamps on deals.newegg at load: ${refreshStampsAtLoad.refreshedAt} refreshedAt, ` +
      `${refreshStampsAtLoad.priceLastMovedAt} priceLastMovedAt`);

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
      summary.parseFailures.push({ mid: dl.mid, file: dl.fileName, remotePath: dl.remotePath, error: e.message });

      // This feed does not go on record as processed. Its manifest entry was
      // minted at download time and, without this, would ride out with the rest
      // at the end of the run -- and the next run would skip it as unchanged and
      // never look at it again. See "WHAT AN ENTRY IN THE MANIFEST CLAIMS".
      //
      // MARKED, not deleted. --skip-download rebuilds its work list from
      // manifest.files, so dropping the entry would strand the one feed an
      // operator re-runs to debug the parse, and would throw away the localPath
      // pointing at the copy already on disk. The entry stays readable; the skip
      // is what refuses it.
      const heldEntry = markFeedParseFailed(manifest, dl.remotePath, e);
      if (heldEntry) {
        log(`    held: manifest entry marked unprocessed, next run re-fetches ${dl.fileName}` +
            ` (attempt ${heldEntry.parseFailStreak} of this hold)`);
      }
      continue;
    }

    // Parsed end to end -- the only event that earns the release. Ordered after
    // the catch and before anything reads `parsed` so the two paths are
    // exhaustive: every feed in `downloaded` leaves this block either held or
    // released, never in whatever state the last run left it.
    const endedHold = holdVerdict((manifest.files || {})[dl.remotePath]);
    if (clearFeedParseFailed(manifest, dl.remotePath)) {
      log(`  ✓ Parsed after a previous failure — hold released on ${dl.fileName}` +
          ` (had failed ${endedHold.streak} attempt(s) over ${endedHold.days} day(s))`);
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

  // ── HOW LONG HAS EACH HELD FEED BEEN OUT OF THE CATALOG? ────────────────────
  //
  // Built from this run's OWN failures, not from every hold in the manifest. A
  // feed held by an earlier run that `--merchant=` filtered out of this one was
  // not looked at, and a run that did not look must not report a verdict -- the
  // same rule the absence sweep below obeys for the same reason.
  const holds = summary.parseFailures.map(f => ({ ...f, ...holdVerdict((manifest.files || {})[f.remotePath]) }));
  const escalatedHolds = holds.filter(h => h.escalated);
  summary.parseFailures = holds;
  summary.totals.heldFeeds = holds.length;
  summary.totals.escalatedHolds = escalatedHolds.length;

  if (holds.length) {
    log(`\n── Feeds held off the skip list: ${holds.length} ──`);
    for (const h of holds) {
      log(`  ${h.file} (merchant ${h.mid}) — ${h.error}`);
      log(`      attempt ${h.streak} of this hold, ${h.days} day(s) since ${String(h.firstAt).slice(0, 10)}` +
          (h.versions > 1 ? `, across ${h.versions} versions of the file` : ''));
    }
  }

  if (escalatedHolds.length) {
    // The words change here, and that is the entire point of the block. Up to
    // the threshold this is a parse error and a retry is a reasonable thing to
    // be doing. Past it, the retry is not working and the fact that matters is
    // no longer about parsing: it is that a merchant's rows have been missing
    // from every ingest for N days. sftp-ingest.yml fails this at its own
    // named step so the notification says so too.
    log('\n** HOLD ESCALATED — this has stopped being a parse error **');
    for (const h of escalatedHolds) {
      log(`   ${h.file} (merchant ${h.mid}) has failed ${h.streak} consecutive attempts,`);
      log(`   first on ${String(h.firstAt).slice(0, 10)} — ${h.days} day(s) in which no ingest has`);
      log(`   carried this feed's rows. Last error: ${h.error}`);
      if (h.versions > 1) {
        log(`   ${h.versions} DIFFERENT versions of this file have been fetched and none parsed,`);
        log('   so the feed is being published broken. Re-fetching is not the remedy and');
        log('   nothing on this side will become the remedy by waiting.');
      } else {
        log('   The same bytes have failed every attempt, so the ~4 min re-fetch this run');
        log('   just paid bought nothing and the next one will not either.');
      }
    }
    log(`   Threshold: ${HOLD_ESCALATE_AFTER} consecutive attempts (HOLD_ESCALATE_AFTER).`);
    log('   The feed is still re-fetched every run. #92 chose that deliberately and this');
    log('   does not revisit it — a feed nobody fetches is a feed nobody notices.');
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
  // ── STAMP INTEGRITY — measured on EVERY run, not only a full-feed night ────
  //
  // Counted here, straight after the merchant loop, because that loop holds the
  // only line in this file that can destroy a stamp: applyMatchToPart's
  // wholesale `part.deals[fieldKey] = newListing`. Nothing below replaces a
  // deal object — the absence sweep assigns one property onto the object that
  // is already there — so this is the moment the damage is complete.
  //
  // DELIBERATELY OUTSIDE `fullNeweggFeedParsed`. It used to sit inside the
  // census block, which armed it only on nights the full Newegg feed parsed. A
  // Newegg DELTA feed is matched and applied to deals.newegg exactly like a
  // full one and leaves that flag false, so it could erase stamps with nothing
  // measuring it. The census genuinely needs the whole feed to ask its question
  // — "what share of these rows did this feed offer" is meaningless over a
  // partial one — but a before/after stamp count needs nothing of the kind, and
  // a gate that arms only on some nights is not a gate.
  //
  // One count, used as both halves: "how many stamps survive this run" and
  // "how many stamps exist at all" are the same question asked of the same
  // catalog at the same moment.
  const refreshStampsNow = countRepricerStamps(parts);
  const integrity = stampIntegrity({
    before: refreshStampsAtLoad,
    after: refreshStampsNow,
    // The collapse check is a refreshedAt question specifically — it asks
    // whether a completed re-pricer run is represented in this catalog, and
    // refreshedAt is the stamp written on EVERY successful lookup. Only a
    // fraction of rows ever carry priceLastMovedAt even when everything is
    // healthy, because most prices simply did not move, so it has no
    // plausibility floor to be judged against and must not be summed in here.
    stamped: refreshStampsNow.refreshedAt,
    droppedOnReplacement: stampsDroppedOnReplacement,
    reachable: parts.reduce((n, p) => {
      const d = p && p.deals && p.deals.newegg;
      return n + (d && typeof d === 'object' && NEG.CAT_FILTER[p.c] ? 1 : 0);
    }, 0),
  });
  summary.totals.stampIntegrity = integrity;


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
    // only ever points one way. `integrity` is computed above the sweep, on
    // every run; this block only READS it, and publishes on `intact`.

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
      log('\n  ** CENSUS VOID — the re-pricer stamp evidence is not intact **');
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
    log('Stamp integrity was still checked — it does not depend on the feed being whole.');
    summary.totals.coverageCensus = null;
  }
  summary.totals.conditionLanesConfirmed = confirmedLanes.size;
  summary.totals.conditionLanesUnconfirmed = unconfirmed;
  summary.totals.absenceSweepRan = fullNeweggFeedParsed;

  // Write outputs
  if (DRY_RUN) {
    log('\n--dry-run: not writing parts.js or exclusives.json');
    log('  ...nor the manifest: a dry run applied nothing, and a manifest saying');
    log('  otherwise would make the next real run skip these feeds as already seen.');
  } else if (integrity.damagedThisRun) {
    // -- THE CATALOG IS NOT WRITTEN --------------------------------------------
    // This run destroyed re-pricer stamps that nothing accounts for, so `parts`
    // in memory is the damaged version and writing it is what makes the loss
    // permanent. Keeping yesterday's catalog costs one night of price updates;
    // writing this one costs the stamps themselves, and those do not come back
    // -- you cannot reconstruct WHEN a price last moved once the record of it
    // is gone. The next run re-reads the feed and redoes the updates. Nothing
    // redoes the history.
    //
    // The workflow's own steps stop here too, because the process exits
    // non-zero below and no step is marked `if: always()`. This branch is not
    // redundant with that: it is what keeps a manual or local run from leaving
    // a damaged parts.js on disk, and what makes the refusal legible in the log
    // rather than inferable from an exit code.
    log('\n** parts.js NOT WRITTEN -- this run destroyed re-pricer stamps **');
    for (const r of integrity.reasons) log(`     - ${r}`);
    log('     The in-memory catalog carries the loss, so committing it would make');
    log('     the erasure permanent. Yesterday\'s catalog stands. Fix the carry in');
    log('     applyMatchToPart, then re-run -- the price updates come back, the');
    log('     stamps would not have.');
    log('     The manifest is not saved either, so the next run re-reads these feeds');
    log('     instead of skipping them as unchanged and idling on an empty download.');
  } else {
    // `unconfirmed` counts too: an absence sweep that stamped rows changed the
    // catalog even when not one price moved, and gating the write on `updated`
    // alone would drop exactly the negative evidence this run went to the
    // trouble of establishing.
    if (summary.totals.updated > 0 || unconfirmed > 0) {
      log(`\nWriting ${parts.length} products to parts.js (${summary.totals.updated} updated, ${unconfirmed} marked unconfirmed)...`);
      // loadedCount is the count taken at load, before the merchant loop -- the
      // shrink/growth brakes compare against it. Throws rather than returning on
      // any failure, and the throw lands in the .catch() below without reaching
      // the manifest save, which is the same rule every other refusal here obeys.
      const written = await writeCatalog(parts, { loadedCount, reason: 'sftp newegg ingest' });
      log(`  parts.js + ${written.chunks} chunk(s) written and verified; backup at ${path.relative(ROOT, written.backup)}`);
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

    // -- THE MANIFEST IS EARNED, NOT FETCHED -----------------------------------
    //
    // Written here, at the far end of the run, because the manifest is a record
    // of what has been PROCESSED. Its only reader is walkAndDownload's
    // unchanged-file skip, so every file it names is a file the next run will
    // decline to look at. It used to be written the instant the download
    // finished, which made it a record of what had been FETCHED -- the same
    // thing only on a run that goes on to succeed.
    //
    // On a run that does not, the difference costs a second night. #90 made
    // this ingest hard-fail and withhold parts.js when it eats re-pricer
    // stamps; that guard fails closed, so it will fire more often than the bug
    // it guards against. A red run used to leave the manifest behind it: the
    // feed is on record as seen, the next nightly skips it as unchanged,
    // `downloaded` comes back empty, and the job returns at "Nothing new to
    // process, done." having ingested nothing -- green, quiet, and idle. That
    // is the same shape as the 95-day freeze, where the work never ran and the
    // check never went red.
    //
    // The cost of withholding it is one re-download of an unchanged feed (~4
    // min at the measured streamed rate), and only after a failure. The cost of
    // saving it early is a night of prices plus the silence about it.
    //
    // So the manifest is written exactly where parts.js is: not on --dry-run,
    // not when the stamp guard withheld the catalog, and not on the fatal path
    // -- a throw from anywhere above lands in the .catch() below without
    // passing here, which is the point.
    //
    // A parse error on ONE feed does not reach that .catch(): the merchant loop
    // counts it and moves on, and the rest of the run is real work that has
    // earned its record. So the manifest still saves -- with that one feed's
    // entry marked parseFailedAt, which onRecordAsProcessed refuses to skip.
    // Whole manifest written, one feed held back.
    const held = Object.values(manifest.files || {}).filter(f => f && f.parseFailedAt).length;
    const onRecord = Object.keys(manifest.files || {}).length - held;
    saveManifest(manifest);
    log(`Manifest saved: ${onRecord} feed file(s) on record as processed` +
        (held ? `, ${held} held for re-fetch (parse failed)` : ''));
  }
  
  summary.finishedAt = new Date().toISOString();
  fs.writeFileSync(SUMMARY_PATH, JSON.stringify(summary, null, 2));
  
  log('\nâ”â”â” SUMMARY â”â”â”');
  log(`Feed records:    ${summary.totals.feedRecords}`);
  log(`Matched/updated: ${summary.totals.updated}`);
  log(`Exclusives:      ${summary.totals.exclusives}`);
  log(`Errors:          ${summary.totals.errors}`);

  // -- AND THE RUN FAILS -------------------------------------------------------
  //
  // Voiding the census was the whole consequence of stamp damage until now: the
  // job logged a void, exited 0, and the workflow committed and went green. An
  // ingest that ate evidence handed a hole to something downstream and told
  // nobody, which is the shape of every bug this file has a paragraph about. A
  // job that destroys another job's evidence has not partially succeeded.
  //
  // Set AFTER the summary is on disk so the artifact carries the diagnosis: a
  // throw here would lose summary.totals.stampIntegrity, which is the only
  // record of what was destroyed and how much of it a listing swap explained.
  //
  // Only `damagedThisRun` fails. The collapse reason -- a catalog whose stamps
  // an EARLIER run ate -- still voids the census and still exits 0, because
  // refusing to ingest until somebody else's damage heals would block this
  // job's work over a condition that clears on its own the next time
  // refresh-newegg-prices lands.
  if (integrity.damagedThisRun) {
    log('\nFAILED -- this run destroyed re-pricer stamps; parts.js was not written');
    process.exitCode = 1;
  }
})().catch(e => {
  console.error('\nâœ— FATAL:', e.stack || e.message);
  process.exit(1);
});
