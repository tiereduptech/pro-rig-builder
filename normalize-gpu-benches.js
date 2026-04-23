// Reads passmark-gpus.json + src/data/parts.js
// Computes finalBench = passmarkScore × scaleFactor × variantMultiplier
// Dry-run by default. --apply writes back to parts.js via line-based edit.

import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const ANCHOR_MODEL = 'RTX 4090';
const PARTS_PATH = 'src/data/parts.js';

// ─── Load passmark cache ──────────────────────────────────────────
let passmarkRaw;
try {
  passmarkRaw = JSON.parse(readFileSync('passmark-gpus.json', 'utf8'));
} catch {
  console.error('❌ passmark-gpus.json missing. Run: node fetch-passmark-gpus.js');
  process.exit(1);
}

// Clean up invisible/unicode chars that break regex matching
function cleanUnicode(s) {
  return s
    .replace(/[\u00AD\u200B-\u200F\uFEFF]/g, '')  // soft hyphen, zero-widths, BOM
    .replace(/[\u00A0]/g, ' ')                    // nbsp → space
    .replace(/[™®©]/g, '')                        // trademark symbols
    .normalize('NFKC');                           // canonical unicode form
}

// ─── Canonical model extractor ────────────────────────────────────
function extractModel(rawName) {
  const name = cleanUnicode(rawName);

  // Skip mobile/laptop/workstation/pro variants
  if (/\b(Laptop|Mobile|Max-Q|Max-P|Workstation|Quadro|Tesla|Ada Generation|Ada\b|RTX\s*PRO|RTX\s*A\d|Radeon\s*Pro\s*W\d|Pro\s*W\d)\b/i.test(name)) return null;
  if (/\b(4090\s*D|5090\s*D)\b/i.test(name)) return null;

  const c = name
    .replace(/\bNVIDIA\b/gi, '')
    .replace(/\bGeForce\b/gi, '')
    .replace(/\bAMD\b/gi, '')
    .replace(/\bRadeon\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  let m = c.match(/\b(RTX|GTX)\s*(\d{3,4})\s*(Ti\s*Super|Ti|Super)?\b/i);
  if (m) {
    const prefix = m[1].toUpperCase();
    const num = m[2];
    let suf = '';
    if (m[3]) {
      const raw = m[3].replace(/\s+/g, ' ').toLowerCase();
      if (/ti\s*super/.test(raw)) suf = ' Ti Super';
      else if (/ti/.test(raw)) suf = ' Ti';
      else if (/super/.test(raw)) suf = ' Super';
    }
    return `${prefix} ${num}${suf}`;
  }

  m = c.match(/\bRX\s*(\d{3,4})\s*(XTX|XT|GRE)?\b/i);
  if (m) return `RX ${m[1]}${m[2] ? ' ' + m[2].toUpperCase() : ''}`;

  m = c.match(/\bArc\s+([AB]\d{3})\b/i);
  if (m) return `Arc ${m[1].toUpperCase()}`;

  return null;
}

// ─── Build passmark lookup keyed by model ─────────────────────────
const modelMap = new Map();
for (const [rawName, score] of Object.entries(passmarkRaw)) {
  const model = extractModel(rawName);
  if (!model) continue;
  if (!modelMap.has(model) || modelMap.get(model) < score) {
    modelMap.set(model, score);
  }
}

const anchorScore = modelMap.get(ANCHOR_MODEL);
if (!anchorScore) {
  console.error(`❌ Anchor ${ANCHOR_MODEL} not found in passmark data`);
  process.exit(1);
}
const scaleFactor = 100 / anchorScore;
console.log(`Anchor: ${ANCHOR_MODEL} = ${anchorScore.toLocaleString()} → scaleFactor ${scaleFactor.toFixed(6)}`);
console.log(`Passmark models extracted: ${modelMap.size}\n`);

// ─── Variant multiplier ───────────────────────────────────────────
function detectVariant(name) {
  let mult = 1.000;
  let tag = 'reference';
  if (/\b(ventus|windforce|eagle)\b/i.test(name)) { mult = 1.005; tag = 'ventus/windforce/eagle'; }
  if (/\b(tuf gaming|aorus master)\b/i.test(name)) { mult = 1.010; tag = 'tuf/aorus'; }
  if (/\b(rog strix|gaming x trio|suprim)\b/i.test(name)) { mult = 1.015; tag = 'strix/trio/suprim'; }
  if (/\b(oc edition|oc)\b/i.test(name)) { mult = Math.max(mult, 1.020); tag = tag === 'reference' ? 'oc' : tag + '+oc'; }
  return { mult, tag };
}

// ─── Load parts.js ────────────────────────────────────────────────
const partsText = readFileSync(PARTS_PATH, 'utf8');
const mod = await import('file:///' + process.cwd().replace(/\\/g, '/') + '/' + PARTS_PATH + '?t=' + Date.now());
const PARTS = mod.PARTS || mod.default;
if (!Array.isArray(PARTS)) {
  console.error('❌ PARTS export not an array');
  process.exit(1);
}

const gpus = PARTS.filter(p => p.c === 'GPU' && !p.bundle && !p.needsReview);
console.log(`GPU products in catalog: ${gpus.length}\n`);

// ─── Compute updates ──────────────────────────────────────────────
const updates = [];
const unmatched = [];
const noChange = [];

for (const p of gpus) {
  const model = extractModel(p.n);
  if (!model) { unmatched.push({ id: p.id, n: p.n, reason: 'no model regex' }); continue; }
  const score = modelMap.get(model);
  if (!score) { unmatched.push({ id: p.id, n: p.n, reason: `no passmark for ${model}` }); continue; }

  const { mult, tag } = detectVariant(p.n);
  const raw = score * scaleFactor * mult;
  const newBench = Math.min(100, Math.max(1, Math.round(raw)));
  const oldBench = p.bench ?? 0;

  if (newBench === oldBench) {
    noChange.push({ id: p.id, n: p.n, bench: oldBench });
  } else {
    updates.push({ id: p.id, n: p.n, model, tag, oldBench, newBench, diff: newBench - oldBench });
  }
}

// ─── Report ───────────────────────────────────────────────────────
console.log(`Updates:    ${updates.length}`);
console.log(`Unchanged:  ${noChange.length}`);
console.log(`Unmatched:  ${unmatched.length}\n`);

const sorted = [...updates].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
console.log('Top 30 biggest swings:');
console.log('  ID     OLD→NEW  DIFF  MODEL            TAG                NAME');
sorted.slice(0, 30).forEach(u => {
  const arrow = u.diff > 0 ? '↑' : '↓';
  console.log(`  ${String(u.id).padEnd(6)} ${String(u.oldBench).padStart(3)}→${String(u.newBench).padStart(3)}  ${arrow}${String(Math.abs(u.diff)).padStart(2)}  ${u.model.padEnd(16)} ${u.tag.padEnd(18)} ${u.n.slice(0, 55)}`);
});

const byModel = new Map();
for (const u of [...updates, ...noChange.map(n => ({ ...n, newBench: n.bench, model: extractModel(n.n) }))]) {
  if (!u.model) continue;
  if (!byModel.has(u.model)) byModel.set(u.model, []);
  byModel.get(u.model).push(u.newBench);
}
console.log('\nModel-level bench distribution (top 25 by count):');
console.log('  MODEL            COUNT  MIN  MAX  AVG');
[...byModel.entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 25)
  .forEach(([model, vals]) => {
    const min = Math.min(...vals), max = Math.max(...vals);
    const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    console.log(`  ${model.padEnd(16)} ${String(vals.length).padStart(4)}  ${String(min).padStart(3)}  ${String(max).padStart(3)}  ${String(avg).padStart(3)}`);
  });

if (unmatched.length > 0) {
  console.log(`\nUnmatched (${unmatched.length}):`);
  unmatched.forEach(u => console.log(`  [${u.id}] ${u.n.slice(0, 70)}  → ${u.reason}`));
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
  const m = line.match(/\bid\s*:\s*(\d+)/);
  if (m) {
    const id = parseInt(m[1], 10);
    if (!idToLine.has(id)) idToLine.set(id, i);
  }
});

let applied = 0;
let failed = 0;
for (const u of updates) {
  const startLine = idToLine.get(u.id);
  if (startLine === undefined) { failed++; continue; }

  let replaced = false;
  for (let i = startLine; i < Math.min(startLine + 80, lines.length); i++) {
    if (/\bbench\s*:\s*\d+/.test(lines[i])) {
      lines[i] = lines[i].replace(/\bbench\s*:\s*\d+/, `bench: ${u.newBench}`);
      replaced = true;
      applied++;
      break;
    }
    if (i > startLine && /\bid\s*:\s*\d+/.test(lines[i])) break;
  }
  if (!replaced) failed++;
}

writeFileSync(PARTS_PATH, lines.join('\n'));
console.log(`✔ Applied: ${applied}    Failed: ${failed}`);
console.log(`✔ Wrote ${PARTS_PATH}`);
