// Reads passmark-cpus.json + src/data/parts.js
// Auto-anchors to top consumer desktop CPU (highest score after filters).
// Dry-run by default. --apply writes back to parts.js via line-based edit.

import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const PARTS_PATH = 'src/data/parts.js';

// ─── Load passmark cache ──────────────────────────────────────────
let passmarkRaw;
try {
  passmarkRaw = JSON.parse(readFileSync('passmark-cpus.json', 'utf8'));
} catch {
  console.error('❌ passmark-cpus.json missing. Run: node fetch-passmark-cpus.js');
  process.exit(1);
}

function cleanUnicode(s) {
  return s
    .replace(/[\u00AD\u200B-\u200F\uFEFF]/g, '')
    .replace(/[\u00A0]/g, ' ')
    .replace(/[™®©]/g, '')
    .normalize('NFKC');
}

// ─── Filter: skip workstation, server, mobile CPUs ────────────────
function isSkipped(name) {
  if (/\b(Xeon|EPYC|Threadripper|Workstation|Server)\b/i.test(name)) return true;
  // Mobile Intel suffixes: H, HX, HQ, HK, U, P, Y, G (with 7 for integrated like 1065G7)
  if (/\bi[3579]-?\d{4,5}(HX?|HQ|HK|U|P|Y|G\d)\b/i.test(name)) return true;
  // Mobile AMD: HS, HX, U (but NOT X3D/GE/X)
  if (/\bRyzen\s+[3579]\s+\d{4,5}(HS|HX|\bU\b)\b/i.test(name)) return true;
  // Core Ultra mobile: H/HX/U suffix
  if (/\bCore\s*Ultra\s*[3579][-\s]*\d{3}(H|HX|U)\b/i.test(name)) return true;
  return false;
}

// ─── Canonical model extractor ────────────────────────────────────
function extractModel(rawName) {
  const name = cleanUnicode(rawName);
  if (isSkipped(name)) return null;

  // Intel Core Ultra (2/3/5/7/9) — tolerate "Ultra5" (no space) and filler words
  // like "Processor", "Desktop" between the tier and model number.
  let u = name.match(/\bCore\s*Ultra\s*([3579])\b/i);
  if (u) {
    const after = name.slice(u.index + u[0].length, u.index + u[0].length + 60);
    const mm = after.match(/\b(\d{3})([A-Z]{1,2})?\b/);
    if (mm) return `Core Ultra ${u[1]} ${mm[1]}${mm[2] ? mm[2].toUpperCase() : ''}`;
  }

  // Intel Core iX — e.g., "Core i9-14900K", "i7-13700KF"
  let m = name.match(/\b(?:Core\s+)?i([3579])[-\s]?(\d{4,5})([A-Z]{1,3})?\b/i);
  if (m) return `i${m[1]}-${m[2]}${m[3] ? m[3].toUpperCase() : ''}`;

  // AMD Ryzen — enumerate real suffixes to prevent phantom matches
  m = name.match(/\bRyzen\s+([3579])\s+(\d{4})(X3D|XT|X|GE|G|F|E)?\b/i);
  if (m) return `Ryzen ${m[1]} ${m[2]}${m[3] ? m[3].toUpperCase() : ''}`;

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

// ─── Anchor: highest-scoring consumer desktop CPU ─────────────────
let anchorModel = null;
let anchorScore = 0;
for (const [model, score] of modelMap) {
  if (score > anchorScore) { anchorScore = score; anchorModel = model; }
}
if (!anchorModel) {
  console.error('❌ No consumer CPUs found in passmark data');
  process.exit(1);
}
const scaleFactor = 100 / anchorScore;
console.log(`Anchor (auto): ${anchorModel} = ${anchorScore.toLocaleString()} → scaleFactor ${scaleFactor.toFixed(6)}`);
console.log(`Passmark models extracted: ${modelMap.size}\n`);

// ─── Load parts.js ────────────────────────────────────────────────
const partsText = readFileSync(PARTS_PATH, 'utf8');
const mod = await import('file:///' + process.cwd().replace(/\\/g, '/') + '/' + PARTS_PATH + '?t=' + Date.now());
const PARTS = mod.PARTS || mod.default;
if (!Array.isArray(PARTS)) {
  console.error('❌ PARTS export not an array');
  process.exit(1);
}

const cpus = PARTS.filter(p => p.c === 'CPU' && !p.bundle && !p.needsReview);
console.log(`CPU products in catalog: ${cpus.length}\n`);

// ─── Compute updates ──────────────────────────────────────────────
const updates = [];
const unmatched = [];
const noChange = [];

for (const p of cpus) {
  const model = extractModel(p.n);
  if (!model) { unmatched.push({ id: p.id, n: p.n, reason: 'no model regex' }); continue; }
  const score = modelMap.get(model);
  if (!score) { unmatched.push({ id: p.id, n: p.n, reason: `no passmark for ${model}` }); continue; }

  const raw = score * scaleFactor;
  const newBench = Math.min(100, Math.max(1, Math.round(raw)));
  const oldBench = p.bench ?? 0;

  if (newBench === oldBench) {
    noChange.push({ id: p.id, n: p.n, bench: oldBench });
  } else {
    updates.push({ id: p.id, n: p.n, model, oldBench, newBench, diff: newBench - oldBench });
  }
}

// ─── Report ───────────────────────────────────────────────────────
console.log(`Updates:    ${updates.length}`);
console.log(`Unchanged:  ${noChange.length}`);
console.log(`Unmatched:  ${unmatched.length}\n`);

const sorted = [...updates].sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
console.log('Top 30 biggest swings:');
console.log('  ID     OLD→NEW  DIFF  MODEL                NAME');
sorted.slice(0, 30).forEach(u => {
  const arrow = u.diff > 0 ? '↑' : '↓';
  console.log(`  ${String(u.id).padEnd(6)} ${String(u.oldBench).padStart(3)}→${String(u.newBench).padStart(3)}  ${arrow}${String(Math.abs(u.diff)).padStart(2)}  ${u.model.padEnd(20)} ${u.n.slice(0, 55)}`);
});

const byModel = new Map();
for (const u of [...updates, ...noChange.map(n => ({ ...n, newBench: n.bench, model: extractModel(n.n) }))]) {
  if (!u.model) continue;
  if (!byModel.has(u.model)) byModel.set(u.model, []);
  byModel.get(u.model).push(u.newBench);
}
console.log('\nModel-level bench distribution (top 25 by count):');
console.log('  MODEL                COUNT  MIN  MAX  AVG');
[...byModel.entries()]
  .sort((a, b) => b[1].length - a[1].length)
  .slice(0, 25)
  .forEach(([model, vals]) => {
    const min = Math.min(...vals), max = Math.max(...vals);
    const avg = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
    console.log(`  ${model.padEnd(20)} ${String(vals.length).padStart(4)}  ${String(min).padStart(3)}  ${String(max).padStart(3)}  ${String(avg).padStart(3)}`);
  });

if (unmatched.length > 0) {
  console.log(`\nUnmatched (${unmatched.length}):`);
  unmatched.slice(0, 30).forEach(u => console.log(`  [${u.id}] ${u.n.slice(0, 70)}  → ${u.reason}`));
  if (unmatched.length > 30) console.log(`  ... and ${unmatched.length - 30} more`);
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

let applied = 0;
let failed = 0;
for (const u of updates) {
  const startLine = idToLine.get(u.id);
  if (startLine === undefined) { failed++; continue; }

  let replaced = false;
  for (let i = startLine; i < Math.min(startLine + 80, lines.length); i++) {
    if (/"?bench"?\s*:\s*\d+/.test(lines[i])) {
      lines[i] = lines[i].replace(/("?bench"?\s*:\s*)\d+/, `$1${u.newBench}`);
      replaced = true;
      applied++;
      break;
    }
    if (i > startLine && /"?id"?\s*:\s*\d+/.test(lines[i])) break;
  }
  if (!replaced) failed++;
}

writeFileSync(PARTS_PATH, lines.join('\n'));
console.log(`✔ Applied: ${applied}    Failed: ${failed}`);
console.log(`✔ Wrote ${PARTS_PATH}`);
