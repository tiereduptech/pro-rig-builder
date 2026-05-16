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
 * Usage:  node record-price-snapshot.js
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const PARTS_PATH = join(process.cwd(), 'src', 'data', 'parts.js');
const OUT_DIR = join(process.cwd(), 'catalog-build');
const OUT_FILE = join(OUT_DIR, 'price-history.json');
const RETENTION_DAYS = 90;

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

// ── Append today's prices ──
let recorded = 0, productsTouched = 0;
for (const p of parts) {
  if (!p || !p.n || !p.deals || typeof p.deals !== 'object') continue;
  const key = normName(p.n);
  if (!key) continue;
  let touched = false;
  for (const [retailer, deal] of Object.entries(p.deals)) {
    if (!deal || typeof deal !== 'object') continue;
    const price = deal.price;
    if (typeof price !== 'number' || !(price > 0)) continue;
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

// ── Write ──
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(OUT_FILE, JSON.stringify(history), 'utf8');

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
console.log('Written to:  ' + OUT_FILE);
