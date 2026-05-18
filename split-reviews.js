#!/usr/bin/env node
/**
 * split-reviews.js
 *
 * Splits catalog-build/reviews.json into one small JSON file per product
 * under public/reviews/, so the frontend fetches only the few KB it needs.
 *
 * Files are keyed by the SAME slug as split-price-history.js / the
 * frontend productSlug() — normalized name → slug, capped at 80 chars.
 *
 * Also writes public/reviews/_index.json — the list of slugs that have
 * reviews, so the frontend can skip the fetch when there are none.
 *
 * Run at build time.  Usage:  node split-reviews.js
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(process.cwd(), 'catalog-build', 'reviews.json');
const OUT_DIR = join(process.cwd(), 'public', 'reviews');

// Slug — converts a reviews store key into a filename.
// Keys: "tok:<brand>|<cat>|<token>", "asin:<ASIN>", or "name:<norm name>".
// MUST match the frontend reviewSlug().
function slug(key) {
  const k = String(key || '');
  const safe = s => s.toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80)
    .replace(/-$/, '');
  if (k.startsWith('tok:'))  return 'tok-' + safe(k.slice(4));
  if (k.startsWith('asin:')) return 'asin-' + k.slice(5).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (k.startsWith('name:')) return safe(k.slice(5));
  // legacy / bare keys — treat as name
  return safe(k);
}

if (!existsSync(SRC)) {
  console.log('reviews.json not found — nothing to split (skipping)');
  // Not an error: build should still succeed if reviews haven't been fetched.
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, '_index.json'), '[]', 'utf8');
  process.exit(0);
}

const store = JSON.parse(readFileSync(SRC, 'utf8'));
console.log('Loaded reviews store: ' + Object.keys(store).length + ' products');

// Fresh output dir.
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

for (const [storeKey, entry] of Object.entries(store)) {
  if (!entry || !Array.isArray(entry.reviews) || !entry.reviews.length) continue;
  const s = slug(storeKey);
  if (!s) continue;

  if (seen.has(s)) {
    // collision — merge review lists, keep up to 5
    collisions++;
    const existingPath = join(OUT_DIR, s + '.json');
    if (existsSync(existingPath)) {
      const existing = JSON.parse(readFileSync(existingPath, 'utf8'));
      const merged = [...(existing.reviews || []), ...entry.reviews].slice(0, 5);
      writeFileSync(existingPath, JSON.stringify({ reviews: merged }), 'utf8');
      continue;
    }
  }
  seen.add(s);
  index.push(s);
  writeFileSync(join(OUT_DIR, s + '.json'), JSON.stringify({ reviews: entry.reviews.slice(0, 5) }), 'utf8');
  written++;
}

writeFileSync(join(OUT_DIR, '_index.json'), JSON.stringify(index), 'utf8');

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Wrote ' + written + ' per-product review files to public/reviews/');
console.log('Slug collisions merged: ' + collisions);
console.log('Index: _index.json (' + index.length + ' slugs)');
