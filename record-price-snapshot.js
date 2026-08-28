#!/usr/bin/env node
/**
 * record-price-snapshot.js
 *
 * Appends today's per-retailer prices from src/data/parts.js to
 * catalog-build/price-history.json, then trims entries older than 90 days.
 *
 * Runs daily via .github/workflows/price-history.yml.
 *
 * History is keyed by NORMALIZED PRODUCT NAME (stable across id changes).
 * Output shape:
 *   { "<norm name>": { "<retailer>": [{ d: "YYYY-MM-DD", p: <number> }, ...] } }
 *
 * One snapshot per name+retailer+date — re-running on the same day overwrites
 * that day's point rather than duplicating it (idempotent).
 *
 * ── WHY THIS FILE HAS AN EVIDENCE RULE ───────────────────────────────────────
 * It used to append a point for every priced deal, every day, unconditionally.
 * That is not a snapshot of prices; it is a snapshot of parts.js. This script
 * reads a DERIVED ARTIFACT and never contacts a retailer, so a number that has
 * not been re-read since April produced a fresh dated point every night and the
 * resulting series looked identical to one being actively maintained.
 *
 * That is not a hypothetical. It is the mechanism of the Best Buy freeze:
 * 139,080 Best Buy points across 1,591 series, of which exactly one ever
 * changed value. Density was read as liveness. It never was.
 *
 * It is still happening. As of 2026-08-28, deals.msi holds 157 rows that have
 * not been re-read since 2026-05-27, and price-history.json holds 14,130 MSI
 * day-steps across those 157 series with ZERO changes on ZERO series. Every one
 * of those points was manufactured here.
 *
 * A gap is a worse-looking chart and a better one. It says "we do not know",
 * which is true. A flat line says "we checked and it did not move", which is a
 * claim this script has no standing to make.
 *
 * ── THE RULE ─────────────────────────────────────────────────────────────────
 * A point is recorded only when there is EVIDENCE the value is an observation
 * rather than a copy. Two admissible forms, either one sufficient:
 *
 *   1. CONFIRMED — the deal carries a confirmation stamp within
 *      CONFIRMATION_WINDOW_DAYS. Something contacted the retailer and said so.
 *
 *   2. MOVED — the price differs from the most recent point already recorded
 *      for that name+retailer. A changed value cannot be produced by re-reading
 *      an unchanged file, so a change is self-evidently new information even
 *      when nothing stamped it.
 *
 * Rule 2 is why this is not simply "require a stamp". Newegg has 3,178 priced
 * rows and, today, ZERO stamped within a day — its designated re-pricer has had
 * its cron commented out since 2026-07-20, and sftp-ingest.cjs stamps matchedAt
 * only on newly attached deals. But Newegg prices demonstrably DO move (1.26% of
 * day-steps, 1,186 of 3,780 series have changed at least once), because the
 * catalog ingest rewrites them in bulk without stamping them. Requiring a stamp
 * would delete a retailer's real price history to punish a stamping gap
 * somewhere else. Rule 2 keeps the observations we can prove are observations.
 *
 * What neither rule admits is the case this file exists to stop: an unchanged
 * price with no recent confirmation. That records nothing, and MSI — unchanged
 * and unstamped on all 157 rows — records nothing at all.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────
 * It does not delete the fabricated points already in the file. Those age out on
 * their own under the existing 90-day retention, and deleting price history is
 * not something a daily snapshot job should do as a side effect. The run reports
 * how many it is carrying so the decision can be made deliberately.
 *
 * Usage:  node record-price-snapshot.js
 *         node record-price-snapshot.js --dry-run   # report only, write nothing
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PARTS_PATH = join(process.cwd(), 'src', 'data', 'parts.js');
const OUT_DIR = join(process.cwd(), 'catalog-build');
const OUT_FILE = join(OUT_DIR, 'price-history.json');
const RETENTION_DAYS = 90;
const DRY_RUN = process.argv.includes('--dry-run');

// The stamps a write path leaves when it actually talked to a retailer. Same
// three, in the same order of authority, as scripts/assert-retailer-freshness.cjs
// — the gate and the recorder must not disagree about what counts as contact.
const CONFIRMATION_STAMPS = ['priceConfirmedAt', 'matchedAt', 'refreshedAt'];

// How old a confirmation may be and still license a point.
//
// One day, not zero: this job runs at 07:00 UTC and the confirmers run around
// the clock — verify-catalog's tier 1 finishes at 20:00, so a row it confirmed
// last night is 11 hours old when this reads it, and demanding today's date
// would discard 902 genuinely fresh Amazon rows. Not two: at two days a price
// can be recorded twice after a single confirmation, which starts rebuilding
// the flat line this rule exists to prevent.
const CONFIRMATION_WINDOW_DAYS = 1;

function normName(n) {
  return String(n || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

// today's date in UTC, YYYY-MM-DD
const today = new Date().toISOString().slice(0, 10);

// ── Load parts.js ──
if (!existsSync(PARTS_PATH)) {
  console.error('parts.js not found at ' + PARTS_PATH);
  process.exit(1);
}
const partsUrl = 'file://' + PARTS_PATH.replace(/\\/g, '/') + '?t=' + Date.now();
const mod = await import(partsUrl);
const parts = mod.PARTS || mod.default;
if (!Array.isArray(parts)) {
  console.error('parts.js did not export a PARTS array');
  process.exit(1);
}
console.log('Loaded ' + parts.length + ' products from parts.js');

// ── Load existing history (or start fresh) ──
let history = {};
if (existsSync(OUT_FILE)) {
  try {
    history = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  } catch (e) {
    console.error('price-history.json exists but is unreadable — aborting to avoid data loss: ' + e.message);
    process.exit(1);
  }
  console.log('Loaded existing history: ' + Object.keys(history).length + ' products');
} else {
  console.log('No existing history — starting fresh');
}

// ── Evidence ──
const dayOnly = (t) => (t ? String(t).slice(0, 10) : null);
const cutoffConfirm = new Date(Date.now() - CONFIRMATION_WINDOW_DAYS * 86400000)
  .toISOString().slice(0, 10);

/** Newest confirmation stamp on a deal, as YYYY-MM-DD, or null. */
function newestStamp(deal) {
  let best = null;
  for (const field of CONFIRMATION_STAMPS) {
    const v = dayOnly(deal[field]);
    if (v && (best === null || v > best)) best = v;
  }
  return best;
}

/**
 * The last point recorded for this series BEFORE today. Today's own point is
 * excluded deliberately: this job is idempotent, so on a re-run today's point
 * already exists and comparing against it would make every price look unchanged
 * and silently demote a confirmed row to unrecorded.
 */
function lastPointBeforeToday(arr) {
  for (let i = arr.length - 1; i >= 0; i--) if (arr[i].d < today) return arr[i];
  return null;
}

// ── Append today's prices, where there is evidence to append ──
let recorded = 0, productsTouched = 0, skipped = 0;
const tally = {};
const bump = (retailer, field) => {
  const t = (tally[retailer] ??= { confirmed: 0, moved: 0, skippedFlat: 0, skippedNoEvidence: 0 });
  t[field]++;
};

for (const p of parts) {
  if (!p || !p.n || !p.deals || typeof p.deals !== 'object') continue;
  const key = normName(p.n);
  if (!key) continue;
  let touched = false;
  for (const [retailer, deal] of Object.entries(p.deals)) {
    if (!deal || typeof deal !== 'object') continue;
    const price = deal.price;
    if (typeof price !== 'number' || !(price > 0)) continue;

    const prior = lastPointBeforeToday(history?.[key]?.[retailer] || []);
    const stamp = newestStamp(deal);
    const confirmed = stamp !== null && stamp >= cutoffConfirm;
    const moved = prior !== null && prior.p !== price;

    // THE RULE. An unchanged price with no recent confirmation is a copy of
    // parts.js, not an observation, and recording it is what made a frozen
    // retailer look healthy for four months.
    if (!confirmed && !moved) {
      skipped++;
      bump(retailer, prior ? 'skippedFlat' : 'skippedNoEvidence');
      continue;
    }
    bump(retailer, confirmed ? 'confirmed' : 'moved');

    history[key] ??= {};
    history[key][retailer] ??= [];
    const arr = history[key][retailer];
    // idempotent: replace today's point if it exists, else append
    const existing = arr.find(pt => pt.d === today);
    if (existing) {
      existing.p = price;
    } else {
      arr.push({ d: today, p: price });
    }
    recorded++;
    touched = true;
  }
  if (touched) productsTouched++;
}
console.log('Recorded ' + recorded + ' price points across ' + productsTouched + ' products for ' + today);
console.log('Withheld ' + skipped + ' — unchanged price, no confirmation within ' + CONFIRMATION_WINDOW_DAYS + 'd. A gap, deliberately, not a flat line.');
console.log('');
console.log('retailer'.padEnd(20) + 'confirmed'.padStart(10) + 'moved'.padStart(8) + 'withheld'.padStart(10) + '   (withheld = no evidence the stored price is current)');
for (const [r, t] of Object.entries(tally).sort((a, b) => (b[1].confirmed + b[1].moved + b[1].skippedFlat + b[1].skippedNoEvidence) - (a[1].confirmed + a[1].moved + a[1].skippedFlat + a[1].skippedNoEvidence))) {
  const withheld = t.skippedFlat + t.skippedNoEvidence;
  console.log(r.padEnd(20) + String(t.confirmed).padStart(10) + String(t.moved).padStart(8) + String(withheld).padStart(10)
    + (t.confirmed + t.moved === 0 ? '   ← records NOTHING today; nothing is confirming this retailer' : ''));
}
console.log('');

// ── Trim entries older than RETENTION_DAYS ──
const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000)
  .toISOString().slice(0, 10);
let trimmed = 0;
for (const [name, retailers] of Object.entries(history)) {
  for (const [retailer, arr] of Object.entries(retailers)) {
    const before = arr.length;
    const kept = arr
      .filter(pt => pt.d >= cutoff)
      .sort((a, b) => a.d.localeCompare(b.d));
    trimmed += before - kept.length;
    retailers[retailer] = kept;
    if (kept.length === 0) delete retailers[retailer];
  }
  if (Object.keys(retailers).length === 0) delete history[name];
}
console.log('Trimmed ' + trimmed + ' points older than ' + cutoff + ' (' + RETENTION_DAYS + 'd retention)');

// ── What the file is still carrying from before the rule ─────────────────────
// Not deleted here — see the header. Reported so the decision to purge (or to
// let the 90-day retention do it) is made deliberately rather than by default.
const flatSeries = {};
for (const retailers of Object.values(history)) {
  for (const [rt, arr] of Object.entries(retailers)) {
    if (arr.length < 2) continue;
    const f = (flatSeries[rt] ??= { series: 0, flat: 0, points: 0, flatPoints: 0 });
    f.series++; f.points += arr.length;
    if (arr.every((pt) => pt.p === arr[0].p)) { f.flat++; f.flatPoints += arr.length; }
  }
}
// Reported for EVERY retailer, not only the 100%-flat ones. Open-box is 96%
// flat, which the old "all series flat" filter would have hidden behind the 4%
// that moved — and a retailer that is 96% fabricated is the finding, not the
// exception to it.
const legacy = Object.entries(flatSeries).filter(([, f]) => f.series > 0);
if (legacy.length) {
  console.log('Series carried in the file where the price has NEVER moved (points predating the');
  console.log('evidence rule; they age out within ' + RETENTION_DAYS + 'd and are not deleted here):');
  console.log('  ' + 'retailer'.padEnd(20) + 'flat series'.padStart(16) + 'share'.padStart(8) + 'points'.padStart(9));
  for (const [rt, f] of legacy.sort((a, b) => (b[1].flat / b[1].series) - (a[1].flat / a[1].series))) {
    const share = f.flat / f.series;
    console.log('  ' + rt.padEnd(20)
      + (f.flat + ' of ' + f.series).padStart(16)
      + ((100 * share).toFixed(0) + '%').padStart(8)
      + String(f.flatPoints).padStart(9)
      + (share >= 0.9 ? '   ← effectively a fabricated series' : ''));
  }
  console.log('');
}

// ── Write ──
if (DRY_RUN) {
  console.log('Dry run — price-history.json was NOT written.');
} else {
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(history), 'utf8');
}

// summary
let totalPoints = 0;
const byRetailer = {};
for (const retailers of Object.values(history)) {
  for (const [rt, arr] of Object.entries(retailers)) {
    totalPoints += arr.length;
    byRetailer[rt] = (byRetailer[rt] || 0) + arr.length;
  }
}
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('History now: ' + Object.keys(history).length + ' products, ' + totalPoints + ' points');
console.log('By retailer:', JSON.stringify(byRetailer));
console.log(DRY_RUN ? 'Written to:  (nothing — dry run)' : 'Written to:  ' + OUT_FILE);
