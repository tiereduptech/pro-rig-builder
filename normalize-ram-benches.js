// Computes RAM bench from structured fields (ramType + speed + cap).
// No PassMark scrape — RAM perf depends on type+speed, not brand.
// Tiers calibrated against PassMark Memory Mark ranges.
// Dry-run by default. --apply writes back to parts.js (inserts bench field).

import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const PARTS_PATH = 'src/data/parts.js';

// ─── Bench formula ────────────────────────────────────────────────
function computeRamBench(ramType, speedMhz, cap) {
  if (!ramType || !speedMhz) return null;
  const t = ramType.toUpperCase();
  const s = Number(speedMhz);
  if (!Number.isFinite(s) || s <= 0) return null;

  let base = 0;

  if (t === 'DDR5') {
    if (s >= 8000) base = 95;
    else if (s >= 7600) base = 90;
    else if (s >= 7200) base = 85;
    else if (s >= 6800) base = 80;
    else if (s >= 6400) base = 75;
    else if (s >= 6000) base = 65;
    else if (s >= 5600) base = 55;
    else if (s >= 5200) base = 48;
    else if (s >= 4800) base = 40;
    else base = 35;
  } else if (t === 'DDR4') {
    if (s >= 4000) base = 35;
    else if (s >= 3600) base = 30;
    else if (s >= 3200) base = 25;
    else if (s >= 2933) base = 18;
    else if (s >= 2666) base = 15;
    else if (s >= 2400) base = 12;
    else if (s >= 2133) base = 10;
    else base = 8;
  } else if (t === 'DDR3') {
    if (s >= 1866) base = 6;
    else if (s >= 1600) base = 5;
    else base = 4;
  } else {
    return null;
  }

  // Small capacity modifier: very small kits (<16GB) take a hit
  if (cap != null) {
    if (cap < 8) base -= 8;
    else if (cap < 16) base -= 4;
    // 16GB+ no bonus/penalty (bench is about bandwidth, not capacity)
  }

  return Math.min(100, Math.max(1, Math.round(base)));
}

// ─── Fallback name parsers ────────────────────────────────────────
function parseRamTypeFromName(name) {
  const m = String(name || '').match(/DDR(2|3|4|5)\b/i);
  return m ? `DDR${m[1]}` : null;
}
function parseSpeedFromName(name) {
  // Prefer "N MHz" pattern; fall back to first 4-digit number in typical speed range
  const m1 = String(name || '').match(/\b(\d{4})\s*MHz\b/i);
  if (m1) return parseInt(m1[1], 10);
  const m2 = String(name || '').match(/\b(DDR[345])[\s-]*(\d{4})\b/i);
  if (m2) return parseInt(m2[2], 10);
  return null;
}

// ─── Load parts.js ────────────────────────────────────────────────
const partsText = readFileSync(PARTS_PATH, 'utf8');
const mod = await import('file:///' + process.cwd().replace(/\\/g, '/') + '/' + PARTS_PATH + '?t=' + Date.now());
const PARTS = mod.PARTS || mod.default;
if (!Array.isArray(PARTS)) {
  console.error('❌ PARTS export not an array');
  process.exit(1);
}

const items = PARTS.filter(p => p.c === 'RAM' && !p.bundle && !p.needsReview);
console.log(`RAM products in catalog: ${items.length}\n`);

// ─── Compute updates ──────────────────────────────────────────────
const updates = [];
const unmatched = [];
const noChange = [];

for (const p of items) {
  const ramType = p.ramType || parseRamTypeFromName(p.n);
  const speed = p.speed || parseSpeedFromName(p.n);
  const newBench = computeRamBench(ramType, speed, p.cap);
  if (newBench == null) {
    unmatched.push({ id: p.id, n: p.n, reason: `missing fields (ramType=${ramType}, speed=${speed})` });
    continue;
  }
  const oldBench = p.bench;
  if (oldBench === newBench) {
    noChange.push({ id: p.id, n: p.n, bench: oldBench });
  } else {
    updates.push({ id: p.id, n: p.n, ramType, speed, cap: p.cap, oldBench: oldBench ?? null, newBench });
  }
}

// ─── Report ───────────────────────────────────────────────────────
console.log(`Updates:    ${updates.length} (${updates.filter(u => u.oldBench == null).length} inserts, ${updates.filter(u => u.oldBench != null).length} replacements)`);
console.log(`Unchanged:  ${noChange.length}`);
console.log(`Unmatched:  ${unmatched.length}\n`);

// Distribution by type + speed
const byTier = new Map();
for (const u of updates) {
  const key = `${u.ramType}-${u.speed}`;
  if (!byTier.has(key)) byTier.set(key, []);
  byTier.get(key).push(u.newBench);
}
console.log('Bench by type+speed tier:');
console.log('  TIER          COUNT  BENCH');
[...byTier.entries()]
  .sort((a, b) => {
    const [ta, sa] = a[0].split('-');
    const [tb, sb] = b[0].split('-');
    if (ta !== tb) return ta.localeCompare(tb);
    return Number(sb) - Number(sa);
  })
  .forEach(([tier, vals]) => {
    console.log(`  ${tier.padEnd(13)} ${String(vals.length).padStart(4)}  ${vals[0]}`);
  });

if (unmatched.length > 0) {
  console.log(`\nUnmatched (${unmatched.length}):`);
  unmatched.slice(0, 20).forEach(u => console.log(`  [${u.id}] ${u.n.slice(0, 60)}  → ${u.reason}`));
}

// ─── Apply ────────────────────────────────────────────────────────
if (!APPLY) {
  console.log('\nDRY RUN — no changes written. Re-run with --apply to write.');
  process.exit(0);
}

console.log('\nApplying changes to parts.js...');
const lines = partsText.split('\n');
const idToLine = new Map();
lines.forEach((line, i) => {
  const m = line.match(/"?id"?\s*:\s*(\d+)/);
  if (m) {
    const id = parseInt(m[1], 10);
    if (!idToLine.has(id)) idToLine.set(id, i);
  }
});

// Build edit list: replace or insert-after category line
const edits = [];
let notFound = 0;
for (const u of updates) {
  const startLine = idToLine.get(u.id);
  if (startLine === undefined) { notFound++; continue; }

  let replaceLine = -1;
  let insertAfterLine = -1;
  for (let i = startLine; i < Math.min(startLine + 80, lines.length); i++) {
    if (/"?bench"?\s*:\s*\d+/.test(lines[i])) { replaceLine = i; break; }
    if (/^(\s*)"?c"?\s*:\s*"RAM"/.test(lines[i])) { insertAfterLine = i; }
    if (i > startLine && /"?id"?\s*:\s*\d+/.test(lines[i])) break;
  }

  if (replaceLine >= 0) {
    edits.push({ line: replaceLine, mode: 'replace', newBench: u.newBench });
  } else if (insertAfterLine >= 0) {
    edits.push({ line: insertAfterLine, mode: 'insert-after', newBench: u.newBench });
  } else {
    notFound++;
  }
}

// Apply bottom-up so inserts don't shift earlier line indexes
edits.sort((a, b) => b.line - a.line);
let applied = 0;
for (const e of edits) {
  if (e.mode === 'replace') {
    lines[e.line] = lines[e.line].replace(/("?bench"?\s*:\s*)\d+/, `$1${e.newBench}`);
  } else {
    const indent = (lines[e.line].match(/^(\s*)/) || ['', ''])[1];
    lines.splice(e.line + 1, 0, `${indent}"bench": ${e.newBench},`);
  }
  applied++;
}

writeFileSync(PARTS_PATH, lines.join('\n'));
console.log(`✔ Applied: ${applied}    Not found: ${notFound}`);
console.log(`✔ Wrote ${PARTS_PATH}`);
