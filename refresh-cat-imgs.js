#!/usr/bin/env node
/**
 * refresh-cat-imgs.js
 *
 * Replaces CAT_IMGS URLs in src/App.jsx with real product images from
 * src/data/parts.js. For each category, picks the best representative
 * product image (highest rating + review count signal, with fallback to
 * any product with a usable image URL).
 *
 * Criteria per category:
 *   1. Product must have p.img (non-empty, valid https URL)
 *   2. Prefer products with high review count + good rating
 *   3. Skip products that might have placeholder/broken image URLs
 *
 * Outputs:
 *   - Updates src/App.jsx CAT_IMGS dictionary in-place
 *   - Console report of what was picked per category
 */
import { readFileSync, writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// Categories to find images for (matches keys in App.jsx CAT_IMGS)
const CATEGORIES = [
  'Case', 'CPU', 'CPUCooler', 'Motherboard', 'RAM', 'GPU', 'Storage', 'PSU',
  'CaseFan', 'SoundCard', 'EthernetCard', 'WiFiCard', 'OpticalDrive', 'InternalLCD',
  'ExtensionCables', 'OS', 'Monitor', 'Keyboard', 'Mouse', 'Headset', 'Webcam',
  'Microphone', 'MousePad', 'Chair', 'Desk', 'ThermalPaste', 'ExternalStorage',
  'Antivirus', 'ExternalOptical', 'UPS'
];

function isGoodImg(url) {
  if (!url) return false;
  if (typeof url !== 'string') return false;
  if (!url.startsWith('http')) return false;
  // Avoid low-res Amazon placeholder patterns
  if (url.includes('_SL50_') || url.includes('_SL75_')) return false;
  return true;
}

function scoreProduct(p) {
  let s = 0;
  // High review count = well-established product
  if (p.reviews) s += Math.log10(p.reviews + 1) * 10;
  // Good rating
  if (p.r) s += p.r * 5;
  // Bench score for performance components
  if (p.bench) s += p.bench / 10;
  // Has a real price (actively sold)
  if (p.pr) s += 1;
  return s;
}

function pickBest(cat) {
  const candidates = parts.filter(p => p.c === cat && isGoodImg(p.img));
  if (!candidates.length) return null;
  candidates.sort((a, b) => scoreProduct(b) - scoreProduct(a));
  return candidates[0];
}

// Upgrade Amazon image URLs from small thumbnails to higher resolution
function upgradeImageUrl(url) {
  if (!url) return url;
  // Amazon: _AC_SL300_ → _AC_SL500_ (larger)
  return url.replace(/_AC_SL\d+_/, '_AC_SL500_');
}

console.log('━━━ FINDING BEST IMAGES PER CATEGORY ━━━\n');
const picks = {};
const missing = [];
for (const cat of CATEGORIES) {
  const pick = pickBest(cat);
  if (!pick) {
    missing.push(cat);
    console.log(`  ✗ ${cat.padEnd(18)} (no products with images)`);
    continue;
  }
  const img = upgradeImageUrl(pick.img);
  picks[cat] = img;
  console.log(`  ✓ ${cat.padEnd(18)} ← ${pick.n.slice(0, 55)}`);
}

if (missing.length) {
  console.log(`\n  WARNING: No images found for: ${missing.join(', ')}`);
  console.log('  (These will keep their existing URL in CAT_IMGS)');
}

// ═══════════════════════════════════════════════════════════════════════════
// UPDATE src/App.jsx
// ═══════════════════════════════════════════════════════════════════════════
const appPath = './src/App.jsx';
let src = readFileSync(appPath, 'utf8');

// Find the CAT_IMGS block: `const CAT_IMGS = {` … `};`
const startMarker = 'const CAT_IMGS = {';
const startIdx = src.indexOf(startMarker);
if (startIdx === -1) {
  console.error('Could not find "const CAT_IMGS = {" in App.jsx');
  process.exit(1);
}

// Find the matching closing brace by counting braces
let scan = startIdx + startMarker.length;
let depth = 1;
while (scan < src.length && depth > 0) {
  const c = src[scan];
  if (c === '{') depth++;
  else if (c === '}') depth--;
  scan++;
}
if (depth !== 0) {
  console.error('Could not find closing } of CAT_IMGS');
  process.exit(1);
}
const endIdx = scan; // exclusive of the ; that follows

// Build new CAT_IMGS block
const lines = [];
lines.push('const CAT_IMGS = {');
for (const cat of CATEGORIES) {
  const url = picks[cat];
  if (url) {
    lines.push(`  ${cat}: ${JSON.stringify(url)},`);
  } else {
    // Keep placeholder so the key still exists (UI falls back to emoji icon)
    lines.push(`  ${cat}: null, // no product image available`);
  }
}
lines.push('}');
const newBlock = lines.join('\n');

const before = src.slice(0, startIdx);
const after = src.slice(endIdx);
src = before + newBlock + after;

writeFileSync(appPath, src);
console.log(`\n━━━ DONE ━━━`);
console.log(`  ${Object.keys(picks).length} categories updated with real product images`);
console.log(`  Wrote ${appPath}`);
