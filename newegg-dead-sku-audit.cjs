#!/usr/bin/env node
/**
 * newegg-dead-sku-audit.cjs — READ-ONLY census of every Newegg link in the catalog.
 *
 * Answers, for all 2,666 `deals.newegg` rows (plus the 60 open-box and 37
 * marketplace deals): does Newegg still carry this sku, and can it be bought?
 * This is the Newegg counterpart of bestbuy-dead-sku-audit.mjs, and it matters
 * more: 1,725 of those rows have NO other priced retailer, so Newegg's health
 * decides whether they are a catalog or a list of dead links.
 *
 * WHY THE FEED AND NOT THE SEARCH API
 * refresh-newegg-prices.cjs resolves by name/UPC through Rakuten product search.
 * A miss there is a MATCHER outcome (`no_results`, `variant_rejected`), not
 * evidence the sku is gone — the script says so itself and refuses to delete on
 * it. The product catalog feed is different: it is Newegg's own enumeration of
 * what it sells, keyed by the same item numbers the catalog stores, and it
 * carries `is_deleted` and `availability` per row. Absence from the full feed is
 * the closest thing to Best Buy's 404 that exists here.
 *
 * DISCIPLINE (same as the Best Buy census)
 *   - TWO STRIKES before any death verdict. A sku missing from one feed pull is
 *     `pending`, never `dead`. See the snapshot guard below — a second strike
 *     must come from a DIFFERENT feed snapshot, or it is the same observation
 *     counted twice.
 *   - UNKNOWN is never counted as dead. If a feed we needed did not stream to
 *     completion, every sku that feed could have carried is UNKNOWN, and the run
 *     exits 1 rather than publishing a census with holes in it.
 *   - READ-ONLY. Writes catalog-build/newegg-dead-sku-audit{,-state}.json and
 *     the downloaded feeds, all of which .gitignore excludes. Never parts.js.
 *
 * STREAMING
 * Uses streamTxtFeed() from sftp-ingest.cjs — the fixed parser, unmodified and
 * shared rather than copied, so this audit cannot drift from the ingest and
 * cannot resurrect the OOM. That parser hands over one record at a time; peak
 * heap here is the target index (~2,800 skus) plus one record, flat in feed
 * size. The MKPL feed is 886MB gzipped and several million rows; nothing about
 * this job needs it resident.
 *
 * PREFLIGHT BEFORE BYTES
 * Everything this job needs from another module is proven in preflight(), which
 * runs before a socket is opened. Run 32057560889 downloaded ~1.3GB over 58
 * minutes and then died on `streamTxtFeed is not a function`; the check that
 * would have caught it costs about a millisecond. It asserts more than
 * existence — it streams a synthetic feed and checks that the columns the
 * census actually reads still land where it expects, because a silently
 * renamed field would not crash, it would report the whole catalog as absent.
 *
 * FEED FRESHNESS
 * A stale feed is worse than no feed here. Sightings resolve least-condemning-
 * wins, so a three-year-old snapshot listing a sku as in-stock MASKS a death
 * the current feed would have shown. Feeds older than MAX_FEED_AGE_DAYS are
 * therefore excluded at discovery, before they are downloaded — which is also
 * where the runtime goes.
 *
 * Run (Actions only — RAKUTEN_FTP_PASSWORD is a repo secret):
 *   node newegg-dead-sku-audit.cjs [--prev <state.json>] [--skip-download]
 *                                  [--max-feed-age-days N] [--allow-stale-feeds]
 */

const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');
const ingest = require('./sftp-ingest.cjs');
const { streamTxtFeed } = ingest;

const ROOT = __dirname;
const FEED_DIR = path.join(ROOT, 'catalog-build', 'feeds');
const OUT = path.join(ROOT, 'catalog-build', 'newegg-dead-sku-audit.json');
const STATE_OUT = path.join(ROOT, 'catalog-build', 'newegg-dead-sku-audit-state.json');

const FTP_HOST = process.env.RAKUTEN_FTP_HOST || 'aftp.linksynergy.com';
const FTP_USER = process.env.RAKUTEN_FTP_USER || 'rkp_4681679';
const FTP_PASS = process.env.RAKUTEN_FTP_PASSWORD;
const NEWEGG_MID = process.env.RAKUTEN_NEWEGG_MID || '44583';

const argv = process.argv.slice(2);
const argOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : null;
};
const PREV_PATH = argOf('--prev');
const SKIP_DOWNLOAD = argv.includes('--skip-download');
const LOCAL_FEEDS = (argOf('--local-feed') || '').split(',').filter(Boolean);
const UNKNOWN_FAIL_PCT = 5;   // same completeness gate as the Best Buy census

// A full catalog feed is Newegg's statement of what it sells TODAY. The main mp
// feed regenerates daily; 14 days is slack for a holiday gap, not a licence to
// read a 2023 file. Raise with --max-feed-age-days, or take the whole gate off
// with --allow-stale-feeds, and the report will say you did.
const MAX_FEED_AGE_DAYS = Number(argOf('--max-feed-age-days') || process.env.NEWEGG_FEED_MAX_AGE_DAYS || 14);
const ALLOW_STALE_FEEDS = argv.includes('--allow-stale-feeds');
const feedAgeDays = (mtime, now = Date.now()) => (now - new Date(mtime).getTime()) / 86400000;

const bar = '─'.repeat(96);
const pct = (n, d) => (d ? `${(100 * n / d).toFixed(1)}%` : '—');
const log = (m) => console.log(`[${new Date().toISOString().substring(11, 19)}] ${m}`);
const nkey = (s) => String(s || '').trim().toUpperCase();

// The walk roots sftp-ingest uses. The MKPL feed is NOT at the root — assuming
// it was is what killed feed-overlap-audit run 31440517417 ("NoSuchKey") after
// it had already spent 11 minutes streaming the main feed. Discover, do not guess.
const WALK_ROOTS = ['/', '/ADDITIONAL', '/GLOBAL/EN-US_USD'];
const SKIP_DIRS = new Set(['/GLOBAL']);
// Full product catalogs only. A _delta feed carries CHANGES, so a sku's absence
// from one means nothing at all — feeding deltas to an absence test would
// condemn the entire catalog on the first run.
const FULL_CATALOG_RE = /^(\d+)_\d+_mp(_MKPL)?\.(txt|xml)\.gz$/i;

/**
 * Feeds discovery must not surface at all.
 *
 * THIS IS NOT THE FRESHNESS GATE, AND THE DIFFERENCE IS LOAD-BEARING.
 * An EXCLUDED feed (partitionFeedsByFreshness, below) is coverage the census
 * did not read. A sku carried only by it is indistinguishable from a dead one,
 * so every death verdict is withheld until somebody reads it. That is the
 * correct response to an unknown, and it stays exactly as strict as it is.
 *
 * An IGNORED feed is not an unknown. MKPL was measured, in full, by run
 * 32073301866 (mkpl-verdict.cjs) — all 2,918,315 records streamed against both
 * the catalog and the mp feed:
 *
 *   · Of the 443 pending Newegg deals, MKPL carries ZERO. All 443 are absent
 *     from both feeds. Its exclusion was protecting an empty set.
 *   · Of its 95,175 in-scope rows, 83,508 (87.7%) are absent from mp — but
 *     every single one is 3P (uniq 1P = 0 in all nine categories), and 83,502
 *     of 83,508 claim "in-stock" in a file last written 2023-03-16.
 *   · 10 of those "in-stock" rows were fetched from newegg.com: 6 returned a
 *     hard 404, 3 load out-of-stock with no price and no cart, 1 resolves to a
 *     different product at a different price. Zero were buyable as described.
 *
 * So it is a 2023 snapshot of dead marketplace inventory — MEASURED AND FOUND
 * EMPTY, not assumed stale because the file is old and large. Treating it as
 * withheld coverage suppressed every death verdict in the catalog on the
 * strength of a file that contains none of the rows in question.
 *
 * The 87.7% is why this needs writing down. A future reader who checks only
 * whether MKPL overlaps mp will find that it mostly does not, conclude it
 * carries unique inventory, and put it back. It does not carry unique
 * inventory; it carries unique *corpses*. Re-run mkpl-verdict.cjs before
 * re-adding this feed, and re-add it only if Q2 comes back non-zero.
 */
const DISCOVERY_IGNORE = [{
  re: /_mp_MKPL\.(txt|xml)\.gz$/i,
  why: 'MKPL — measured empty of catalog pendings by run 32073301866; 2023-03-16 snapshot of dead 3P inventory',
}];

// ── Pure decision logic ───────────────────────────────────────────────────
// Extracted and exported so the rules that can condemn a row are testable
// without an SFTP endpoint. test/newegg-dead-sku-audit.test.js covers these.

// Least-condemning-wins ordering for a sku sighted more than once. `undefined`
// (never sighted) ranks below every real sighting.
const SIGHTING_RANK = { undefined: -1, null: -1, deleted: 1, unbuyable: 2, alive: 3 };

/** What one feed sighting of a catalog sku means. */
function classifySighting(rec) {
  const deleted = /^(1|true|yes|deleted)$/i.test((rec.is_deleted || '').trim());
  if (deleted) return 'deleted';
  // Newegg's availability strings are free text ("in-stock", "out-of-stock",
  // "backordered", ""). Only an explicit in-stock reads as buyable; everything
  // else — including empty — is unbuyable, never dead. Being listed at all is
  // proof the sku exists, which is the whole difference from absence.
  return /in-?stock/i.test((rec.availability || '').trim()) ? 'alive' : 'unbuyable';
}

/**
 * Two-strike gate. `gone` is absence-from-feed or is_deleted.
 * `sameSnapshot` means this run streamed a byte-identical feed to the last one:
 * re-reading the same file is one observation, not two, so the strike is held.
 *
 * `coverageComplete` is false when any discovered feed was excluded from this
 * census. A SKIPPED feed and a FAILED feed are the same epistemic state — the
 * sku was not looked at — and the completeness gate below already refuses to
 * condemn on a failed feed. A sku carried only by the excluded MKPL feed reads
 * as absent against mp alone, so without this it takes strike two on evidence
 * nobody read.
 *
 * The strike is HELD as well as the verdict. Letting n climb through blind runs
 * would only defer the false death: the first complete run would find a pile of
 * skus already at n>=2 and condemn them all on the strength of runs that never
 * opened MKPL. Deaths already confirmed under complete coverage keep their n in
 * the state file and re-assert the moment coverage returns — the census abstains
 * from the verdict, it does not forget the evidence.
 */
function strikeVerdict({ gone, prevN = 0, sameSnapshot = false, coverageComplete = true }) {
  if (!gone) return { n: 0, verdict: null };
  const held = sameSnapshot || !coverageComplete;
  const n = held ? Math.max(prevN, 1) : prevN + 1;
  return { n, verdict: (coverageComplete && n >= 2) ? 'dead' : 'pending' };
}

/**
 * Were the strikes in a prior state file earned while a feed went unread?
 *
 * A strike earned blind is not evidence, and carrying it forward would let one
 * blind run plus one good run add up to a death the moment coverage returns —
 * the same false condemnation, just deferred. State written before
 * `coverageComplete` existed is identified by having recorded an exclusion.
 */
function priorStreakIsBlind(prev = {}) {
  if (prev.coverageComplete === true) return false;
  if (prev.coverageComplete === false) return true;
  return (prev.excludedFeeds || []).length > 0;   // pre-flag state file
}

/**
 * Describe what an excluded feed is costing this census, every run, in one line.
 *
 * WHY THIS IS NOT JUST LOGGING
 * bestbuy-dead-sku-audit sat frozen for 95 days. The suppression mechanism was
 * working the whole time — it was reported once, quietly, and then nobody read
 * it again. A guard that goes silent is indistinguishable from a guard that is
 * not needed, and the longer it holds the more it looks like the steady state.
 *
 * So the census re-asserts the excluded feed's mtime on EVERY run and says what
 * it is costing, with the age in days and the consecutive-run count so the drift
 * is visible as a number that grows rather than a condition you have to remember.
 * `runs` comes from the prior state; the first suppressed run reports 1.
 */
function describeSuppression(staleFeeds = [], { now = Date.now(), priorRuns = 0 } = {}) {
  if (!staleFeeds.length) return null;
  const feeds = staleFeeds
    .map((f) => ({
      name: f.name,
      kind: f.kind,
      mtime: f.mtime,
      ageDays: Math.round(feedAgeDays(f.mtime, now)),
      lastRegeneratedAt: new Date(f.mtime).toISOString().slice(0, 10),
    }))
    .sort((a, b) => b.ageDays - a.ageDays);
  const runs = priorRuns + 1;
  return {
    feeds,
    runs,
    maxAgeDays: feeds[0].ageDays,
    // The line the user reads. One per excluded feed, oldest first.
    headlines: feeds.map((f) =>
      `${f.kind} last regenerated ${f.ageDays} days ago (${f.lastRegeneratedAt}), deaths suppressed.`),
  };
}

/**
 * A feed that was excluded last run and is fresh now. Coverage returning is as
 * newsworthy as coverage going, and it is the event that un-suppresses deaths.
 */
function describeRestoredFeeds(freshFeeds = [], prevExcluded = []) {
  const excludedNames = new Set(prevExcluded.map((f) => f.name));
  return freshFeeds.filter((f) => excludedNames.has(f.name)).map((f) => f.name);
}

async function discoverFeeds(sftp, ignored = []) {
  const found = [];
  const queue = [...WALK_ROOTS];
  const seen = new Set();
  while (queue.length) {
    const dir = queue.shift();
    if (seen.has(dir) || SKIP_DIRS.has(dir)) continue;
    seen.add(dir);
    let entries;
    try { entries = await sftp.list(dir); }
    catch (e) { log(`  cannot list ${dir}: ${e.message}`); continue; }
    for (const entry of entries) {
      const full = (dir === '/' ? '' : dir) + '/' + entry.name;
      if (entry.type === 'd') { if (!SKIP_DIRS.has(full)) queue.push(full); continue; }
      if (entry.type !== '-') continue;
      if (/_template|_deltatemplate/i.test(entry.name)) continue;
      const m = FULL_CATALOG_RE.exec(entry.name);
      if (!m || m[1] !== NEWEGG_MID) continue;
      if (/\.xml\.gz$/i.test(entry.name)) continue;   // parser is pipe-delimited
      // Measured-empty feeds never become coverage, so they never suppress.
      const ig = DISCOVERY_IGNORE.find((r) => r.re.test(entry.name));
      if (ig) { ignored.push({ remote: full, name: entry.name, size: entry.size, mtime: entry.modifyTime, why: ig.why }); continue; }
      found.push({
        remote: full, name: entry.name,
        kind: m[2] ? 'MKPL' : 'mp',
        size: entry.size, mtime: entry.modifyTime,
      });
    }
  }
  return found;
}

/**
 * Split discovered feeds into the ones this census may trust and the ones it
 * must not, by age.
 *
 * WHY AGE IS A CORRECTNESS CONCERN AND NOT A TIDINESS ONE
 * Sightings resolve least-condemning-wins (see SIGHTING_RANK): across feeds,
 * the most generous verdict for a sku is the one that sticks. That is right
 * when every feed is a current statement — one feed saying in-stock settles
 * "can this be bought". It is exactly wrong when a feed is a 2023 snapshot: an
 * `alive` from it OVERRIDES the current feed and hides a sku that has since
 * died. A stale feed cannot reveal a death; it can only conceal one.
 *
 * The MKPL feed measured mtime 2023-03-16 against mp's 2026-08-17 — same
 * listing call, same field, so this is Newegg's timestamp and not a unit bug.
 */
function partitionFeedsByFreshness(discovered, { maxAgeDays = MAX_FEED_AGE_DAYS, allowStale = ALLOW_STALE_FEEDS, now = Date.now() } = {}) {
  const fresh = [], stale = [];
  for (const f of discovered) {
    const ageDays = feedAgeDays(f.mtime, now);
    const entry = { ...f, ageDays };
    // An unparseable mtime is not evidence of staleness — keep the feed and let
    // the census read it rather than dropping coverage on a bad timestamp.
    if (!Number.isFinite(ageDays) || ageDays <= maxAgeDays || allowStale) fresh.push(entry);
    else stale.push({ ...entry, reason: `mtime ${new Date(f.mtime).toISOString().slice(0, 10)} is ${ageDays.toFixed(0)}d old, over the ${maxAgeDays}d ceiling` });
  }
  return { fresh, stale };
}

/**
 * Prove every cross-module dependency BEFORE the download phase.
 *
 * Cheap enough to be unconditional, and it checks the contract rather than the
 * symbol: a synthetic feed goes through the real streamTxtFeed, and the columns
 * the census reads are asserted to land where it expects. A renamed field would
 * not throw at import — it would quietly make every sku look absent, which on
 * this catalog means condemning 1,725 rows that have no other retailer.
 *
 * Throws on the first failure. Returns a short list of what it proved.
 */
async function preflight() {
  const checked = [];
  const need = (name, val, kind = 'function') => {
    if (typeof val !== kind) {
      throw new Error(`preflight: ${name} is ${val === undefined ? 'missing' : typeof val} — expected a ${kind}. ` +
        `Check that sftp-ingest.cjs still exports it (it must also keep its \`require.main === module\` guard, ` +
        `or requiring it starts a second ingest).`);
    }
    checked.push(name);
  };

  // 1. The imports this file cannot run without.
  need('sftp-ingest.streamTxtFeed', streamTxtFeed);
  need('sftp-ingest.DEFAULT_FIELD_ORDER', ingest.DEFAULT_FIELD_ORDER, 'object');
  need('classifySighting', classifySighting);
  need('strikeVerdict', strikeVerdict);
  need('discoverFeeds', discoverFeeds);
  need('partitionFeedsByFreshness', partitionFeedsByFreshness);

  // 2. Requiring the ingest must not have started one. If the guard is ever
  //    removed, a background SFTP session competes with ours for the same
  //    throttled endpoint — which is what made one feed take 2,973 seconds.
  if (typeof ingest.parseTxtFeed !== 'function') {
    throw new Error('preflight: sftp-ingest.cjs did not export parseTxtFeed — the module shape changed');
  }

  // 3. The parser contract, end to end, on a feed we build here.
  //
  //    The fixture is written at ABSOLUTE column positions from the Rakuten
  //    Product Catalog spec (Appendix A), deliberately NOT derived from
  //    DEFAULT_FIELD_ORDER. Building it from the same array it is meant to
  //    check would agree with itself no matter what the array said, and a
  //    column inserted upstream would slide `availability` one place left
  //    without a single test going red — every sku would then read as
  //    unbuyable or absent, and this census condemns on absence.
  const WIRE_POSITIONS = {
    sku: 0, newegg_item_number: 2, is_deleted: 7,
    sale_price: 12, retail_price: 13, availability: 22,
  };
  const FIELD_COUNT = 38;
  const cell = (f) => `${f}#v`;
  const cells = new Array(FIELD_COUNT).fill('');
  for (const [f, i] of Object.entries(WIRE_POSITIONS)) cells[i] = cell(f);
  const line = cells.join('|');
  const fixture = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'newegg-preflight-')), 'fixture.txt.gz');
  fs.writeFileSync(fixture, zlib.gzipSync(Buffer.from(
    [`HDR|${NEWEGG_MID}|Newegg|20260817`, line, line, 'TRL|2', ''].join('\n'), 'utf8')));

  const seen = [];
  let res;
  try {
    res = await streamTxtFeed(fixture, (rec) => { seen.push(rec); });
  } finally {
    try { fs.rmSync(path.dirname(fixture), { recursive: true, force: true }); } catch { /* tmp */ }
  }

  if (seen.length !== 2) throw new Error(`preflight: streamTxtFeed yielded ${seen.length} records from a 2-record feed`);
  if (res.recordCount !== 2) throw new Error(`preflight: streamTxtFeed reported recordCount=${res.recordCount}, expected 2`);
  // The truncation guard is only as good as this number being real.
  if (res.trailerCount !== 2) throw new Error(`preflight: streamTxtFeed reported trailerCount=${res.trailerCount}, expected 2 — the TRL trailer is no longer parsed, so a short read would read as "these skus are gone"`);
  for (const [f, i] of Object.entries(WIRE_POSITIONS)) {
    if (seen[0][f] !== cell(f)) {
      throw new Error(`preflight: the census reads \`${f}\`, which the feed spec puts at column ${i}, ` +
        `but the parser returned ${JSON.stringify(seen[0][f] === undefined ? '(no such field)' : seen[0][f])}. ` +
        `DEFAULT_FIELD_ORDER in sftp-ingest.cjs and this census disagree about the wire format — ` +
        `every sku would read as absent, and absence is how this job condemns a row.`);
    }
  }
  checked.push(`streamTxtFeed contract (2 records, TRL trailer, ${Object.keys(WIRE_POSITIONS).length} columns at spec positions)`);

  // 4. The catalog this census is about.
  const partsPath = path.join(ROOT, 'src', 'data', 'parts.js');
  if (!fs.existsSync(partsPath)) throw new Error(`preflight: ${path.relative(ROOT, partsPath)} not found`);
  checked.push('src/data/parts.js present');

  return checked;
}

// Exported before the entrypoint so `require()` can reach the decision rules
// without connecting to SFTP or reading the catalog.
module.exports = { classifySighting, strikeVerdict, priorStreakIsBlind, describeSuppression, describeRestoredFeeds, SIGHTING_RANK, FULL_CATALOG_RE, DISCOVERY_IGNORE, discoverFeeds, partitionFeedsByFreshness, preflight, feedAgeDays };

if (require.main === module) (async () => {
  // ── Preflight ───────────────────────────────────────────────────────────
  // Before the socket, before the bytes. Everything here is local and takes
  // about a millisecond; the alternative is finding out at minute 58.
  const t0 = Date.now();
  let proved;
  try {
    proved = await preflight();
  } catch (e) {
    console.error(`\n✗ PREFLIGHT FAILED: ${e.message}`);
    console.error('  Nothing was downloaded. Fix the above and re-dispatch.');
    process.exit(1);
  }
  log(`Preflight OK in ${Date.now() - t0}ms — ${proved.length} checks:`);
  for (const c of proved) log(`    ✓ ${c}`);

  if (!FTP_PASS && !LOCAL_FEEDS.length) {
    console.error('ERROR: RAKUTEN_FTP_PASSWORD required (repo secret; Actions only), or --local-feed <path>.');
    process.exit(1);
  }

  // ── Targets ─────────────────────────────────────────────────────────────
  const mod = await import('file://' + path.join(ROOT, 'src', 'data', 'parts.js').replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = mod.PARTS || mod.default;
  if (!Array.isArray(parts)) { console.error('parts.js did not export PARTS'); process.exit(1); }

  const DEAL_KEYS = ['newegg', 'newegg_openbox', 'newegg_marketplace'];
  const OTHER_KEYS = ['amazon', 'bestbuy', 'msi'];
  const isPriced = (d) => !!d && ((typeof d.price === 'number' && d.price > 0) || (typeof d.saleprice === 'number' && d.saleprice > 0));

  const rows = [];          // one entry per Newegg-family DEAL
  const wanted = new Map(); // feed key (sku or item number) -> [row, ...]
  for (const p of parts) {
    for (const dk of DEAL_KEYS) {
      const d = p.deals && p.deals[dk];
      if (!d || typeof d !== 'object') continue;
      const sku = nkey(d.sku);
      const item = nkey(d.itemNumber);
      if (!sku && !item) continue;
      // "Orphaned" means: strip THIS Newegg deal and nothing priced is left.
      // Sibling Newegg deals count as survivors here; the roll-up below reports
      // the row-level view where every Newegg link on the row is discounted.
      const siblings = DEAL_KEYS.filter((k) => k !== dk && isPriced(p.deals[k]));
      const others = OTHER_KEYS.filter((k) => isPriced(p.deals[k]));
      const row = {
        id: p.id, name: p.n, cat: p.c, dealKey: dk, sku: sku || null, itemNumber: item || null,
        sellerClass: d.sellerClass || null,
        stored: (typeof d.saleprice === 'number' && d.saleprice > 0) ? d.saleprice
              : (typeof d.price === 'number' && d.price > 0) ? d.price : null,
        quarantined: p.needsReview === true,
        otherRetailers: others, neweggSiblings: siblings,
        status: null, feed: null, availability: null, isDeleted: null,
      };
      rows.push(row);
      for (const k of [sku, item]) {
        if (!k) continue;
        if (!wanted.has(k)) wanted.set(k, []);
        wanted.get(k).push(row);
      }
    }
  }
  const byId = new Map(parts.map((p) => [p.id, p]));
  console.log(`Catalog: ${parts.length} products → ${rows.length} Newegg deals ` +
    `(${rows.filter(r => r.dealKey === 'newegg').length} newegg, ` +
    `${rows.filter(r => r.dealKey === 'newegg_openbox').length} open-box, ` +
    `${rows.filter(r => r.dealKey === 'newegg_marketplace').length} marketplace) ` +
    `→ ${wanted.size} distinct feed keys to look for`);

  // ── Previous state (two-strike) ─────────────────────────────────────────
  let prev = { streak: {}, feeds: {} };
  if (PREV_PATH && fs.existsSync(PREV_PATH)) {
    try {
      prev = JSON.parse(fs.readFileSync(PREV_PATH, 'utf8'));
      prev.streak = prev.streak || {};
      prev.feeds = prev.feeds || {};
      console.log(`Prior state: ${Object.keys(prev.streak).length} sku(s) carrying a strike, ` +
        `from run at ${prev.updatedAt || '(unknown time)'}`);

      if (priorStreakIsBlind(prev)) {
        const dropped = Object.keys(prev.streak).length;
        console.log(`  ⚠  Prior run excluded ${(prev.excludedFeeds || []).map((f) => f.name).join(', ') || 'a feed'} — ` +
          `its ${dropped} strike(s) were earned without full coverage.`);
        console.log('     Discarding them. Strikes restart from the first complete census; a death');
        console.log('     must rest on two runs that both actually read every discovered feed.');
        prev.streak = {};
      }
    } catch (e) {
      console.log(`Prior state unreadable (${e.message}) — starting clean; nothing can reach two strikes this run.`);
      prev = { streak: {}, feeds: {} };
    }
  } else {
    console.log('No prior state supplied — this is a first strike run. Nothing will be declared dead.');
  }

  // ── Feeds ───────────────────────────────────────────────────────────────
  fs.mkdirSync(path.join(FEED_DIR, NEWEGG_MID), { recursive: true });
  const feeds = [];
  let discovered = [];
  let staleFeeds = [];    // discovered, deliberately not downloaded, SUPPRESSES verdicts
  const ignoredFeeds = [];  // measured empty, not coverage, does NOT suppress

  // --local-feed re-parses feed files already on disk and never opens a socket.
  // Same parser, same verdicts; it exists so the matching path can be exercised
  // without the SFTP secret, and so a downloaded feed can be re-read for free.
  if (LOCAL_FEEDS.length) {
    const localCandidates = LOCAL_FEEDS.map((p) => {
      const st = fs.statSync(p);
      return {
        remote: '(local)', name: path.basename(p), kind: /_MKPL\./i.test(p) ? 'MKPL' : 'mp',
        size: st.size, mtime: st.mtimeMs, local: p,
      };
    });
    // The same age gate as the SFTP path. A stale feed masks deaths whether it
    // arrived over the wire this run or was left on disk by the last one.
    const parted = partitionFeedsByFreshness(localCandidates);
    staleFeeds = parted.stale;
    for (const f of staleFeeds) log(`  ⏭  SKIPPING local ${f.name} — ${f.reason}`);
    for (const f of parted.fresh) {
      feeds.push(f);
      log(`  local feed ${f.local} (${(f.size / 1048576).toFixed(1)}MB)`);
    }
    if (!feeds.length) throw new Error(`every --local-feed is over the ${MAX_FEED_AGE_DAYS}-day freshness ceiling`);
  } else {
  const sftp = new SftpClient();
  try {
    await sftp.connect({ host: FTP_HOST, port: 22, username: FTP_USER, password: FTP_PASS });
    log(`Connected to ${FTP_HOST} as ${FTP_USER}`);
    discovered = await discoverFeeds(sftp, ignoredFeeds);
    // Say it out loud every run. A feed that vanishes from the log silently is
    // how somebody re-adds it in six months on the theory that a big file must
    // contain something.
    for (const f of ignoredFeeds) {
      log(`  ⊘  IGNORING ${f.name} (${(f.size / 1048576).toFixed(0)}MB) — ${f.why}`);
      log('      Not coverage, so it does NOT withhold verdicts. Re-run mkpl-verdict.cjs before re-adding.');
    }
    if (!discovered.length) throw new Error(`no full-catalog feed found for MID ${NEWEGG_MID} under ${WALK_ROOTS.join(', ')}`);
    for (const f of discovered) {
      log(`  found ${f.kind.padEnd(4)} ${f.remote} (${(f.size / 1048576).toFixed(0)}MB, mtime ${new Date(f.mtime).toISOString()})`);
    }

    // Age gate BEFORE download — a feed we will not read is a feed we must not
    // spend half an hour pulling. Skipping the 886MB MKPL file here is the
    // difference between a ~10 minute job and a ~58 minute one.
    const parted = partitionFeedsByFreshness(discovered);
    staleFeeds = parted.stale;
    for (const f of staleFeeds) {
      log(`  ⏭  SKIPPING ${f.kind} ${f.name} — ${f.reason}`);
      log(`      ${(f.size / 1048576).toFixed(0)}MB not downloaded. A stale feed cannot reveal a death, only mask one.`);
    }
    if (!parted.fresh.length) {
      throw new Error(`every discovered feed is over the ${MAX_FEED_AGE_DAYS}-day freshness ceiling — ` +
        `refusing to run a census with no current feed. Re-dispatch with --allow-stale-feeds only if you mean it.`);
    }
    for (const f of parted.fresh) {
      const local = path.join(FEED_DIR, NEWEGG_MID, f.name);
      if (SKIP_DOWNLOAD && fs.existsSync(local)) {
        log(`  ⏭  ${f.name} (--skip-download, using local copy)`);
      } else {
        const t0 = Date.now();
        // Sequential streaming get(), not fastGet() — this endpoint throttles
        // parallel range reads to under 64KB/s (see sftp-ingest.cjs).
        await sftp.get(f.remote, local);
        log(`  ⬇  ${f.name} in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
      feeds.push({ ...f, local });
    }
  } finally {
    try { await sftp.end(); } catch { /* the census does not care how the socket ended */ }
  }
  }

  // ── Stream ──────────────────────────────────────────────────────────────
  // One record at a time via the ingest's own parser. A record is dropped the
  // instant it has been checked against `wanted`.
  const feedStats = [];
  const availabilityMix = {};
  let brokenFeed = null;
  for (const f of feeds) {
    log(`Streaming ${f.name}…`);
    let hits = 0, scanned = 0;
    let res;
    try {
      res = await streamTxtFeed(f.local, (rec) => {
        scanned++;
        if (scanned % 500000 === 0) log(`  …${scanned} records, ${hits} catalog skus seen`);
        const hitRows = wanted.get(nkey(rec.sku)) || wanted.get(nkey(rec.newegg_item_number));
        if (!hitRows) return;
        const deleted = /^(1|true|yes|deleted)$/i.test(rec.is_deleted || '');
        const avail = (rec.availability || '').trim();
        availabilityMix[avail || '(empty)'] = (availabilityMix[avail || '(empty)'] || 0) + 1;
        const sighting = classifySighting(rec);
        for (const row of hitRows) {
          // A sku can appear in both feeds, and in more than one row of one feed.
          // Keep the least condemning sighting: one feed saying in-stock settles
          // "can this be bought", and a `deleted` row must not override another
          // feed that still lists the sku as merely out of stock.
          if (SIGHTING_RANK[sighting] <= SIGHTING_RANK[row.status]) continue;
          hits++;
          row.feed = f.kind;
          row.isDeleted = deleted;
          row.availability = avail || null;
          row.feedPrice = parseFloat(rec.sale_price) || parseFloat(rec.retail_price) || null;
          row.status = sighting;
        }
      });
    } catch (e) {
      brokenFeed = `${f.name}: ${e.message}`;
      log(`  ✗ ${f.name} failed mid-stream: ${e.message}`);
      feedStats.push({ ...f, ok: false, error: e.message });
      break;
    }
    // Truncation guard. The feed's own TRL trailer states the record count; a
    // short read that ends cleanly would otherwise read as "these skus are gone".
    const truncated = res.trailerCount != null && res.trailerCount !== res.recordCount;
    if (truncated) {
      brokenFeed = `${f.name}: trailer says ${res.trailerCount} records, parsed ${res.recordCount}`;
      log(`  ✗ ${f.name} TRUNCATED — ${brokenFeed}`);
      feedStats.push({ ...f, ok: false, error: brokenFeed, recordCount: res.recordCount, trailerCount: res.trailerCount });
      break;
    }
    log(`  done: ${res.recordCount} records (trailer ${res.trailerCount ?? 'absent'}), ${hits} catalog sightings`);
    feedStats.push({ ...f, ok: true, recordCount: res.recordCount, trailerCount: res.trailerCount });
  }

  // ── Verdicts ────────────────────────────────────────────────────────────
  // If any feed failed, we cannot tell "absent" from "not looked at". Every
  // unseen sku becomes UNKNOWN — never dead.
  const feedsOk = !brokenFeed;
  const snapshotId = feedStats.filter((f) => f.ok).map((f) => `${f.name}@${f.mtime}:${f.size}`).sort().join('|');
  const sameSnapshotAsLastRun = !!prev.snapshotId && prev.snapshotId === snapshotId;

  // Coverage is complete only when every feed DISCOVERED on the endpoint was
  // actually read. An excluded feed is un-read evidence, not absent evidence.
  const coverageComplete = staleFeeds.length === 0;

  // Re-asserted every run, suppressed or not. See describeSuppression().
  const suppression = describeSuppression(staleFeeds, { priorRuns: prev.suppression?.runs || 0 });
  const restoredFeeds = describeRestoredFeeds(feedStats.filter((f) => f.ok), prev.excludedFeeds || []);

  // Reasons this census may not issue a death verdict. Both are measurement-is-
  // fine, conclusion-is-not conditions: the counts below stay meaningful, the
  // word "dead" does not.
  const withheldReasons = [];
  if (!coverageComplete) {
    withheldReasons.push(
      `${staleFeeds.length} discovered feed(s) excluded and unread (${staleFeeds.map((f) => f.name).join(', ')}) ` +
      '— a sku carried only by an excluded feed is indistinguishable from a dead one');
  }
  if (sameSnapshotAsLastRun) {
    withheldReasons.push(
      'the feed snapshot is byte-identical to the previous run — a re-read of the same file is not a second opinion');
  }
  const verdictsBinding = withheldReasons.length === 0;

  const streak = {};
  for (const row of rows) {
    if (!row.status) row.status = feedsOk ? 'absent' : 'unknown';
    const gone = row.status === 'absent' || row.status === 'deleted';
    const key = row.sku || row.itemNumber;
    if (!gone) continue;
    const { n, verdict } = strikeVerdict({
      gone: true,
      prevN: prev.streak[key]?.n || 0,
      sameSnapshot: sameSnapshotAsLastRun,
      coverageComplete,
    });
    streak[key] = { n, firstGoneAt: prev.streak[key]?.firstGoneAt || new Date().toISOString(), lastStatus: row.status };
    row.strikes = n;
    row.verdict = verdict;
  }
  for (const row of rows) {
    if (row.verdict) continue;
    row.verdict = row.status === 'unknown' ? 'unknown' : (row.status === 'unbuyable' ? 'unbuyable' : 'alive');
  }

  const dead = rows.filter((r) => r.verdict === 'dead');
  const pending = rows.filter((r) => r.verdict === 'pending');
  const unbuyable = rows.filter((r) => r.verdict === 'unbuyable');
  const alive = rows.filter((r) => r.verdict === 'alive');
  const unknown = rows.filter((r) => r.verdict === 'unknown');

  // Orphan = strip this deal and the ROW has nothing priced left. Computed at
  // row level so a product with two Newegg links is not counted as rescued by
  // its own second dead link.
  const condemnedIds = new Set([...dead, ...unbuyable].map((r) => r.id));
  const orphanRows = [];
  for (const id of condemnedIds) {
    const p = byId.get(id);
    if (!p) continue;
    const survivingNewegg = DEAL_KEYS.some((k) => {
      const d = p.deals[k];
      if (!isPriced(d)) return false;
      const r = rows.find((x) => x.id === id && x.dealKey === k);
      return r && (r.verdict === 'alive' || r.verdict === 'pending' || r.verdict === 'unknown');
    });
    const other = OTHER_KEYS.some((k) => isPriced(p.deals[k]));
    if (!survivingNewegg && !other) orphanRows.push({ id, name: p.n, cat: p.c, quarantined: p.needsReview === true });
  }

  const byCat = {};
  for (const r of rows) {
    const k = r.cat || '(none)';
    byCat[k] = byCat[k] || { total: 0, dead: 0, pending: 0, unbuyable: 0, alive: 0, unknown: 0 };
    byCat[k].total++;
    byCat[k][r.verdict]++;
  }

  // ── Report ──────────────────────────────────────────────────────────────
  // ── Suppression banner ──────────────────────────────────────────────────
  // Printed before the numbers, every run, so the condition cannot go quiet the
  // way the Best Buy census did for 95 days. Also emitted as a workflow warning
  // so it surfaces on the run page without opening the log.
  if (suppression) {
    console.log('');
    console.log(bar);
    for (const h of suppression.headlines) console.log(`  ⚠  ${h}`);
    console.log(`  Suppressed on ${suppression.runs} consecutive run(s). No sku can be declared dead`);
    console.log('  until every discovered feed is read. This is a coverage gap, not a clean bill.');
    console.log(bar);
    for (const h of suppression.headlines) console.log(`::warning title=Newegg census suppressed::${h}`);
  }
  if (restoredFeeds.length) {
    console.log('');
    console.log(`  ✓ COVERAGE RESTORED: ${restoredFeeds.join(', ')} is fresh again and was read this run.`);
    console.log('    Strikes earned under the previous gap were discarded; deaths resume from here.');
    console.log(`::notice title=Newegg census coverage restored::${restoredFeeds.join(', ')} regenerated — death verdicts are live again.`);
  }

  console.log(bar);
  console.log(verdictsBinding ? 'RESULT — Newegg link census' : 'CENSUS ONLY — NOT A VERDICT — Newegg link census');
  console.log(bar);
  if (!verdictsBinding) {
    console.log('  No death verdict is issued by this run:');
    for (const r of withheldReasons) console.log(`    · ${r}`);
    console.log('  The counts below are a measurement of what the read feeds show.');
    console.log('  Nothing here is a basis for quarantine.');
    console.log('');
  }
  console.log(`  deals checked .............. ${rows.length}`);
  console.log(`  DEAD (gone, 2+ strikes) .... ${dead.length}  (${pct(dead.length, rows.length)})   <- absent from the full feed, or is_deleted`);
  console.log(`  pending (1 strike) ......... ${pending.length}  <- gone this run only; NOT dead until a second, different feed snapshot agrees`);
  console.log(`  unbuyable (in feed) ........ ${unbuyable.length}  (${pct(unbuyable.length, rows.length)})   <- listed, not in stock`);
  console.log(`  alive and buyable .......... ${alive.length}  (${pct(alive.length, rows.length)})`);
  console.log(`  UNKNOWN (feed failure) ..... ${unknown.length}  <- never counted as dead`);
  console.log('');
  console.log(`  orphaned rows (dead/unbuyable Newegg link and nothing else priced): ${orphanRows.length}`);
  console.log(`    of which already quarantined: ${orphanRows.filter((o) => o.quarantined).length}`);
  console.log('');
  console.log('  availability values seen on catalog skus:');
  Object.entries(availabilityMix).sort((a, b) => b[1] - a[1]).slice(0, 12)
    .forEach(([k, v]) => console.log(`    ${k.padEnd(24)} ${v}`));
  console.log('');
  console.log('  by category (dead / pending / unbuyable / total):');
  Object.entries(byCat).sort((a, b) => (b[1].dead + b[1].pending + b[1].unbuyable) - (a[1].dead + a[1].pending + a[1].unbuyable))
    .forEach(([k, v]) => console.log(`    ${k.padEnd(18)} ${String(v.dead).padStart(5)} ${String(v.pending).padStart(6)} ${String(v.unbuyable).padStart(6)} ${String(v.total).padStart(7)}`));
  if (staleFeeds.length) {
    console.log('');
    console.log('  COVERAGE: this census read only the feeds below the freshness ceiling.');
    for (const f of staleFeeds) {
      console.log(`    excluded ${f.kind.padEnd(4)} ${f.name} — ${f.reason}`);
    }
    console.log(`    Read: ${feedStats.filter((f) => f.ok).map((f) => f.kind).join(', ') || '(none)'}.`);
    console.log('    A sku carried ONLY by an excluded feed reads as absent here. While any');
    console.log('    discovered feed is unread, absence is not evidence of death: no strike');
    console.log('    advances and no sku is condemned, however many runs it sits out.');
  }
  if (sameSnapshotAsLastRun) {
    console.log('');
    console.log('  NOTE: the feed snapshot is byte-identical to the previous run. No strike was');
    console.log('        advanced — re-running against the same file is not a second opinion.');
  }

  // ── Write ───────────────────────────────────────────────────────────────
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    auditedAt: new Date().toISOString(),
    readOnly: true,
    scope: { products: parts.length, deals: rows.length, distinctKeys: wanted.size, mid: NEWEGG_MID },
    feeds: feedStats.map(({ local, ...f }) => f),
    feedsComplete: feedsOk,
    brokenFeed,
    sameSnapshotAsLastRun,
    // Consumers must gate on this. When false, `dead` is guaranteed empty
    // because the census abstained, NOT because nothing died.
    verdictsBinding,
    verdictsWithheld: withheldReasons.length ? withheldReasons : null,
    coverageComplete,
    suppression,
    restoredFeeds,
    freshness: { maxAgeDays: MAX_FEED_AGE_DAYS, allowStale: ALLOW_STALE_FEEDS },
    // Discovered and deliberately not read. A consumer of this report needs to
    // know which feeds a verdict was NOT checked against.
    excludedFeeds: staleFeeds.map(({ local, ...f }) => f),
    // Discovered, measured, and deliberately not treated as coverage. Distinct
    // from excludedFeeds: these do NOT withhold a verdict. Kept in the report so
    // the decision is visible to anyone auditing why a death was allowed.
    ignoredFeeds,
    summary: {
      dead: dead.length, pending: pending.length, unbuyable: unbuyable.length,
      alive: alive.length, unknown: unknown.length,
      orphaned: orphanRows.length,
      orphanedAlreadyQuarantined: orphanRows.filter((o) => o.quarantined).length,
      byCat, availabilityMix,
    },
    deadIds: [...new Set(dead.map((r) => r.id))],
    pendingIds: [...new Set(pending.map((r) => r.id))],
    unbuyableIds: [...new Set(unbuyable.map((r) => r.id))],
    orphanRows,
    rows,
  }, null, 2));
  fs.writeFileSync(STATE_OUT, JSON.stringify({
    updatedAt: new Date().toISOString(),
    snapshotId,
    // The next run reads this to decide whether these strikes are trustworthy.
    coverageComplete,
    // Carries the consecutive-suppressed-run counter so the number keeps climbing.
    suppression: suppression ? { runs: suppression.runs, maxAgeDays: suppression.maxAgeDays, feeds: suppression.feeds } : null,
    feeds: feedStats.map((f) => ({ name: f.name, kind: f.kind, size: f.size, mtime: f.mtime, ok: !!f.ok })),
    excludedFeeds: staleFeeds.map((f) => ({ name: f.name, kind: f.kind, mtime: f.mtime, ageDays: Math.round(f.ageDays) })),
    // NOT read by priorStreakIsBlind — an ignored feed never made the prior run
    // blind, so its strikes stay good.
    ignoredFeeds: ignoredFeeds.map((f) => ({ name: f.name, why: f.why })),
    streak,
  }, null, 2));
  console.log(`\nReport -> ${path.relative(ROOT, OUT)}`);
  console.log(`State  -> ${path.relative(ROOT, STATE_OUT)}  (feed the next run with --prev)`);

  // ── Job summary ─────────────────────────────────────────────────────────
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [];
    md.push('## Newegg link census (read-only)\n');
    if (!verdictsBinding) {
      md.push('> [!WARNING]\n> **No death verdict was issued by this run.**\n>\n' +
        withheldReasons.map((r) => `> - ${r}`).join('\n') +
        '\n>\n> The table below is a measurement, not a basis for quarantine.\n');
    }
    md.push(`Feeds streamed: ${feedStats.map((f) => `\`${f.name}\` (${f.ok ? `${f.recordCount} records` : `FAILED: ${f.error}`})`).join(', ')}\n`);
    md.push('| Verdict | Deals | Share |');
    md.push('| --- | --: | --: |');
    md.push(`| **DEAD** — gone from the feed, 2+ strikes | **${dead.length}** | ${pct(dead.length, rows.length)} |`);
    md.push(`| pending — gone once, awaiting a second snapshot | ${pending.length} | ${pct(pending.length, rows.length)} |`);
    md.push(`| **unbuyable** — listed, not in stock | **${unbuyable.length}** | ${pct(unbuyable.length, rows.length)} |`);
    md.push(`| alive and buyable | ${alive.length} | ${pct(alive.length, rows.length)} |`);
    md.push(`| UNKNOWN — feed failure, never counted as dead | ${unknown.length} | ${pct(unknown.length, rows.length)} |`);
    md.push(`\n**Orphaned rows** (dead/unbuyable Newegg link and nothing else priced): **${orphanRows.length}**` +
      ` — ${orphanRows.filter((o) => o.quarantined).length} already quarantined\n`);
    if (!feedsOk) md.push(`\n> **Incomplete census.** ${brokenFeed}. Every unseen sku is UNKNOWN, not dead.\n`);
    if (staleFeeds.length) {
      md.push(`\n> **Feeds excluded as stale** (ceiling ${MAX_FEED_AGE_DAYS}d): ` +
        staleFeeds.map((f) => `\`${f.name}\` — ${f.reason}`).join('; ') +
        `. Not downloaded. A stale feed cannot reveal a death, only mask one — sightings resolve` +
        ` least-condemning-wins, so an old \`in-stock\` would override the current feed.\n`);
    }
    if (sameSnapshotAsLastRun) md.push('\n> Feed snapshot identical to the previous run — no strike advanced.\n');
    fs.writeFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n', { flag: 'a' });
  }

  // ── Completeness gate ───────────────────────────────────────────────────
  if (!feedsOk) {
    console.error(`\n✗ INCOMPLETE: ${brokenFeed}`);
    console.error('  Every sku that feed could have carried is UNKNOWN. Nothing here is a death verdict.');
    process.exit(1);
  }
  if (unknown.length / rows.length > UNKNOWN_FAIL_PCT / 100) {
    console.error(`\n✗ ${unknown.length} of ${rows.length} deals (${pct(unknown.length, rows.length)}) are UNKNOWN — over the ${UNKNOWN_FAIL_PCT}% ceiling.`);
    process.exit(1);
  }
  // A census that cannot condemn must not exit green. A green check on a run
  // reporting "0 dead" reads as "nothing died" when it means "we did not look".
  // The artifacts still upload — the workflow's upload steps are `if: always()`.
  if (!verdictsBinding) {
    console.error('\n✗ VERDICTS WITHHELD — this census is not a basis for quarantine:');
    for (const r of withheldReasons) console.error(`    · ${r}`);
    console.error('  dead = 0 here because the census abstained, not because nothing died.');
    console.error('  Resolve the cause and re-run before acting on any row.');
    process.exit(1);
  }
  console.log('\n✓ Census complete. Nothing was written outside catalog-build/.');
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
