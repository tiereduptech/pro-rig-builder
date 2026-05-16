#!/usr/bin/env node
/**
 * backfill-price-history.js
 *
 * Walks every git commit that touched src/data/parts.js, extracts each
 * product's per-retailer price, and builds catalog-build/price-history.json.
 *
 * History is keyed by NORMALIZED PRODUCT NAME (not id) — product ids have
 * changed over the project's life, but names are stable.
 *
 * Captures whatever retailers exist in each historical `deals` object
 * (amazon, bestbuy, etc). Newegg is sparse historically — that's expected.
 *
 * Output shape:
 *   {
 *     "amd ryzen 9 9950x3d": {
 *       "amazon":  [{ d: "2026-04-18", p: 699 }, ...],
 *       "bestbuy": [{ d: "2026-05-02", p: 699 }, ...]
 *     },
 *     ...
 *   }
 * One entry per name+retailer+date (last commit on a given day wins).
 *
 * Usage:  node backfill-price-history.js
 */
import { execSync } from 'node:child_process';
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const PARTS_REL = 'src/data/parts.js';
const OUT_DIR = join(process.cwd(), 'catalog-build');
const OUT_FILE = join(OUT_DIR, 'price-history.json');
const TMP = join(process.cwd(), '.price-backfill-tmp.mjs');

function normName(n) {
  return String(n || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

// ── 1. All commits touching parts.js, oldest → newest ──
const log = execSync(
  `git log --follow "--format=%H|%ad" --date=short -- ${PARTS_REL}`,
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }
).trim().split('\n').filter(Boolean);
log.reverse(); // oldest first
console.log(`Found ${log.length} commits touching ${PARTS_REL}\n`);

// history[name][retailer] = Map(date -> price)
const history = {};
let parsedCommits = 0, failedCommits = 0;

for (const line of log) {
  const [hash, date] = line.split('|');
  let parts;
  try {
    const src = execSync(`git show ${hash}:${PARTS_REL}`, {
      encoding: 'utf8', maxBuffer: 128 * 1024 * 1024,
    });
    writeFileSync(TMP, src, 'utf8');
    const mod = await import('file://' + TMP.replace(/\\/g, '/') + '?h=' + hash);
    parts = mod.PARTS || mod.default;
    if (!Array.isArray(parts)) throw new Error('no PARTS array');
  } catch (e) {
    failedCommits++;
    process.stdout.write(`\r  ⚠ ${date} ${hash.slice(0, 8)} skipped: ${e.message}\n`);
    continue;
  }

  for (const p of parts) {
    if (!p || !p.n || !p.deals || typeof p.deals !== 'object') continue;
    const key = normName(p.n);
    if (!key) continue;
    for (const [retailer, deal] of Object.entries(p.deals)) {
      if (!deal || typeof deal !== 'object') continue;
      const price = deal.price;
      if (typeof price !== 'number' || !(price > 0)) continue;
      history[key] ??= {};
      history[key][retailer] ??= new Map();
      history[key][retailer].set(date, price); // last write on a date wins
    }
  }
  parsedCommits++;
  process.stdout.write(`\r  parsed ${parsedCommits}/${log.length} commits`);
}
console.log('');

if (existsSync(TMP)) rmSync(TMP);

// ── 2. Maps → sorted arrays ──
const out = {};
let nameCount = 0, pointCount = 0;
const byRetailer = {};
for (const [name, retailers] of Object.entries(history)) {
  out[name] = {};
  for (const [retailer, dateMap] of Object.entries(retailers)) {
    const arr = [...dateMap.entries()]
      .map(([d, p]) => ({ d, p }))
      .sort((a, b) => a.d.localeCompare(b.d));
    out[name][retailer] = arr;
    pointCount += arr.length;
    byRetailer[retailer] = (byRetailer[retailer] || 0) + arr.length;
  }
  nameCount++;
}

// ── 3. Write ──
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(out), 'utf8');

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log(`Commits parsed:  ${parsedCommits} (${failedCommits} skipped)`);
console.log(`Products:        ${nameCount}`);
console.log(`Price points:    ${pointCount}`);
console.log('By retailer:    ', JSON.stringify(byRetailer));
console.log(`Written to:      ${OUT_FILE}`);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
