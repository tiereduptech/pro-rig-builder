#!/usr/bin/env node
/**
 * split-price-history.js
 *
 * Splits catalog-build/price-history.json into one small JSON file per
 * product under public/price-history/, so the frontend fetches only the
 * few KB it needs per product instead of the whole multi-MB file.
 *
 * Files are keyed by a SLUG of the normalized product name. The frontend
 * must compute the identical slug to find a product's file.
 *
 * Also writes public/price-history/_index.json — a list of slugs that
 * have data, so the frontend can skip the fetch when there's no history.
 *
 * Run at build time (and after the daily recorder).
 *
 * Usage:  node split-price-history.js
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'catalog-build', 'price-history.json');
const OUT_DIR = join(process.cwd(), 'public', 'price-history');

// Slug: normalized name → filesystem/URL-safe string.
// MUST match the frontend's slug function exactly.
function slug(normName) {
  return String(normName || '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .replace(/-$/, '');
}

if (!existsSync(SRC)) {
  console.error('price-history.json not found at ' + SRC);
  process.exit(1);
}
const history = JSON.parse(readFileSync(SRC, 'utf8'));
console.log('Loaded history: ' + Object.keys(history).length + ' products');

// Fresh output dir — clear stale per-product files first.
if (existsSync(OUT_DIR)) {
  for (const f of readdirSync(OUT_DIR)) {
    if (f.endsWith('.json')) rmSync(join(OUT_DIR, f));
  }
} else {
  mkdirSync(OUT_DIR, { recursive: true });
}

const index = [];
let written = 0, collisions = 0;
const seen = new Set();

for (const [normName, retailers] of Object.entries(history)) {
  const s = slug(normName);
  if (!s) continue;
  // collision guard: two names slugging the same — merge rather than clobber
  let target = s;
  if (seen.has(s)) {
    collisions++;
    // merge into existing file
    const existingPath = join(OUT_DIR, s + '.json');
    if (existsSync(existingPath)) {
      const existing = JSON.parse(readFileSync(existingPath, 'utf8'));
      for (const [rt, arr] of Object.entries(retailers)) {
        if (!existing[rt]) existing[rt] = arr;
        else {
          // merge by date, keep latest
          const m = new Map(existing[rt].map(pt => [pt.d, pt.p]));
          for (const pt of arr) m.set(pt.d, pt.p);
          existing[rt] = [...m.entries()].map(([d, p]) => ({ d, p }))
            .sort((a, b) => a.d.localeCompare(b.d));
        }
      }
      writeFileSync(existingPath, JSON.stringify(existing), 'utf8');
      continue;
    }
  }
  seen.add(s);
  index.push(s);
  writeFileSync(join(OUT_DIR, s + '.json'), JSON.stringify(retailers), 'utf8');
  written++;
}

// Index of slugs that have data (frontend checks this before fetching).
writeFileSync(join(OUT_DIR, '_index.json'), JSON.stringify(index), 'utf8');

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Wrote ' + written + ' per-product files to public/price-history/');
console.log('Slug collisions merged: ' + collisions);
console.log('Index: _index.json (' + index.length + ' slugs)');
