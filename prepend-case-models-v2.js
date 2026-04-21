#!/usr/bin/env node
/**
 * prepend-case-models-v2.js
 *
 * Improved model-code detection for all 5 target brands:
 *   - "Aqua 3", "Mirage 4", "Cypress 7" (Word N) — Okinos
 *   - "DS950V", "HM1", "C365", "A305", "B275 Pro" — DarkFlash
 *   - "Y6-N6-W", "K2-3-B" — MUSETEX
 *   - "EC2", "Classico Max" — DARKROCK
 *   - "F600", "F1", "F300" — FOIFKIN
 *
 * Reports which cases STILL need a model code after detection, so we know
 * what actually needs scraping vs what already has the code in the title.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// ─── MODEL CODE DETECTION ────────────────────────────────────────────────────
function stripBrand(name, brand) {
  const re = new RegExp(`^\\s*${brand}\\s+`, 'i');
  return name.replace(re, '').trim();
}

function hasModelCode(name, brand) {
  const rest = stripBrand(name, brand);
  const firstFewWords = rest.split(/[\s,.]+/).slice(0, 4);

  // Pattern 1: Alphanumeric SKU anywhere in first 4 words
  // Matches: "EC2", "F600", "H9", "Y6-N6-W", "DS950V", "HM1", "A305", "Y60", "NR200"
  for (const w of firstFewWords) {
    if (w.length >= 2 && /[A-Za-z]/.test(w) && /\d/.test(w)) {
      return true;
    }
  }

  // Pattern 2: "Word Number" as first two tokens
  // Matches: "Aqua 3", "Mirage 4", "Cypress 7", "AQUA UNO 4"
  if (firstFewWords.length >= 2 &&
      /^[A-Za-z]+$/.test(firstFewWords[0]) &&
      /^\d+$/.test(firstFewWords[1])) {
    return true;
  }

  // Pattern 3: Known named series tokens
  const head = rest.slice(0, 50);
  if (/\b(?:iCUE|Meshify|Define|Torrent|Pop|North|Terra|Ridge|Mood|Era|Epoch|Lancool|Eclipse|Evolv|Enthoo|Shadow|Silent|Pure|Dark|Light|Hyperion|Vector|Vision|Dynamic|Elite|Compact|Versa|Sekira|Classico|Morpheus|Aqua|Mirage|Cypress|MiniArt|FLOATRON|Air\s+Cross|AQUA\s+UNO)\b/i.test(head)) {
    return true;
  }

  return false;
}

// ─── DIAGNOSTIC ──────────────────────────────────────────────────────────────
const BRANDS = ['MUSETEX', 'DARKROCK', 'FOIFKIN', 'DARKFLASH', 'OKINOS'];
const buckets = { has: {}, missing: {} };

for (const b of BRANDS) {
  buckets.has[b] = [];
  buckets.missing[b] = [];
}

for (const p of parts) {
  if (p.c !== 'Case') continue;
  const brand = (p.b || '').toUpperCase();
  if (!BRANDS.includes(brand)) continue;
  const slot = hasModelCode(p.n, p.b) ? 'has' : 'missing';
  buckets[slot][brand].push(p.n);
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('DIAGNOSTIC — Model code detection per brand');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
for (const b of BRANDS) {
  const has = buckets.has[b].length;
  const missing = buckets.missing[b].length;
  const total = has + missing;
  if (total === 0) continue;
  console.log(`\n${b}: ${has}/${total} have model codes`);
  if (has > 0) {
    console.log('  ✓ HAS (first 3):');
    buckets.has[b].slice(0, 3).forEach(n => console.log('    ' + n.slice(0, 90)));
  }
  if (missing > 0) {
    console.log('  ✗ MISSING (all):');
    buckets.missing[b].forEach(n => console.log('    ' + n.slice(0, 90)));
  }
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Total products needing model code lookup:');
for (const b of BRANDS) {
  if (buckets.missing[b].length > 0) {
    console.log(`  ${b}: ${buckets.missing[b].length}`);
  }
}
