// Reads passmark-storage.json + src/data/parts.js
// Token-based matching: all catalog model tokens must appear in passmark key.
// Capacity match required when passmark key includes capacity.
// Handles INSERT of new bench field (storage products have no bench currently).
// Dry-run by default. --apply writes back to parts.js.

import { readFileSync, writeFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');
const PARTS_PATH = 'src/data/parts.js';

// ─── Load passmark cache ──────────────────────────────────────────
let passmarkRaw;
try {
  passmarkRaw = JSON.parse(readFileSync('passmark-storage.json', 'utf8'));
} catch {
  console.error('❌ passmark-storage.json missing. Run: node fetch-passmark-storage.js');
  process.exit(1);
}

function cleanUnicode(s) {
  return s
    .replace(/[\u00AD\u200B-\u200F\uFEFF]/g, '')
    .replace(/[\u00A0]/g, ' ')
    .replace(/[™®©]/g, '')
    .normalize('NFKC');
}

// Capacity: return GB value, handling TB/GB + optional space + OEM codes
function extractCapacityGB(text) {
  let m = text.match(/\b(\d+(?:\.\d+)?)\s*(TB|GB)\b/i);
  if (m) {
    const v = parseFloat(m[1]);
    return m[2].toUpperCase() === 'TB' ? Math.round(v * 1000) : Math.round(v);
  }
  // Crucial OEM: CT1000T710SSD8, CT2000T700SSD5, CT480BX500SSD1
  m = text.match(/\bCT(\d{3,4})[A-Z]/);
  if (m) return parseInt(m[1], 10);
  // Seagate: ST2000DM008, ST4000DM004 (TB × 1000 = GB)
  m = text.match(/\bST(\d{3,5})[A-Z]/);
  if (m) return parseInt(m[1], 10);
  return null;
}

// Token match with substring fallback for OEM codes glued together
function tokenMatches(needle, haystackSet) {
  if (haystackSet.has(needle)) return true;
  // Substring match only for tokens ≥4 chars (avoid false positives on short tokens)
  if (needle.length < 4) return false;
  for (const t of haystackSet) {
    if (t.length > needle.length && t.includes(needle)) return true;
  }
  return false;
}

// Signature tokens: only keep brand names, model numbers, and product-line words.
// Strips form factors (2280), specs (RPM, MB/s), noise (ssd/nvme/pcie), etc.
const BRANDS = new Set([
  'samsung','crucial','wd','western','digital','kingston','sandisk','corsair',
  'sk','hynix','seagate','toshiba','pny','sabrent','silicon','power','teamgroup',
  'adata','xpg','fanxiang','kioxia','patriot','lexar','transcend','mushkin',
  'intel','micron','solidigm','hp','gigabyte','msi','asus','acer','team','neo',
  'forge','goodram','netac','hikvision','verbatim','addlink','inland','tforce'
]);

const PRODUCT_LINES = new Set([
  'pro','evo','black','blue','red','green','purple','platinum','gold','plus',
  'ultra','barracuda','firecuda','ironwolf','skyhawk','exos','rocket',
  'extreme','navi','nitro','rogue','vortex','prime','predator','dreams',
  'heatsink'
]);

const NOISE_PATTERNS = [
  /\bm\.?2\s*\d{3,5}\b/gi,                   // M.2 2280
  /\b\d+\s*(mb|gb)\s*\/?\s*s\b/gi,           // 6000 MB/s
  /\b(7200|5400|15000|10000)\s*rpm\b/gi,     // spinning disk RPM
  /\b22(10|30|42|60|80|110)\b/g,             // form factors
  /\bgen\s*\d+\s*x\s*\d+\b/gi,               // PCIe Gen 4x4
  /\bgen\s*\d+\b/gi,
  /\b(solid\s*state|hard\s*drive)\b/gi,
  /\b(up\s*to|with\s*heatsink)\b/gi,
  /\bnvme\b/gi, /\bssd\b/gi, /\bhdd\b/gi, /\bpcie\b/gi, /\bsata\b/gi,
  /\bm\.?2\b/gi, /\binternal\b/gi, /\bexternal\b/gi,
  /\bdrive\b/gi, /\bstorage\b/gi,
  /\b(gaming|desktop|laptop|portable|business)\b/gi,
  /\b\d+(tb|gb|mb)\b/gi,                     // 2TB, 500GB
];

function tokenize(name) {
  let s = cleanUnicode(name).toLowerCase();
  // Normalize separators
  s = s.replace(/[_\-/.,;:()[\]™®©]+/g, ' ');
  // Merge number+unit (e.g., "2 TB" → "2tb" so NOISE catches it)
  s = s.replace(/(\d+)\s+(tb|gb|mb)\b/g, '$1$2');
  // Strip noise patterns
  for (const p of NOISE_PATTERNS) s = s.replace(p, ' ');

  const tokens = s.split(/\s+/).filter(t => t.length >= 2);
  const sig = [];
  for (const t of tokens) {
    if (BRANDS.has(t)) { sig.push(t); continue; }
    if (PRODUCT_LINES.has(t)) { sig.push(t); continue; }
    // Model number: alphanumeric with at least one digit (sn850x, t700, kc3000, p41)
    if (/[a-z]/.test(t) && /\d/.test(t) && t.length <= 14) { sig.push(t); continue; }
    // Pure number: only 3-4 digits (990, 870, 980)
    if (/^\d{3,4}$/.test(t)) { sig.push(t); continue; }
  }
  return sig;
}

// ─── Precompute passmark entries with tokens + capacity ───────────
const passmarkEntries = Object.entries(passmarkRaw).map(([name, score]) => ({
  name,
  score,
  tokens: new Set(tokenize(name)),
  capGB: extractCapacityGB(name),
}));

// ─── Best-match finder ────────────────────────────────────────────
// Split catalog tokens into categories (brand, model, series, line).
// Require brand-match (if catalog has brand), at least 1 model OR series match,
// and all product-line words. Skip noise tokens like SKU codes.
function findBestMatch(catalogName, catalogCapGB) {
  const qTokens = tokenize(catalogName);
  if (qTokens.length < 1) return null;

  const brandTokens = qTokens.filter(t => BRANDS.has(t));
  const modelTokens = qTokens.filter(t => /[a-z]/.test(t) && /\d/.test(t));  // sn850x, t700, kc3000
  const seriesTokens = qTokens.filter(t => /^\d{3,4}$/.test(t));             // 990, 870, 9100
  const lineTokens = qTokens.filter(t => PRODUCT_LINES.has(t));

  // Need at least a model or series token — brand alone is too ambiguous
  if (modelTokens.length === 0 && seriesTokens.length === 0) return null;

  const candidates = [];
  for (const entry of passmarkEntries) {
    // Brand: if catalog has brand, at least one must appear in passmark tokens
    if (brandTokens.length > 0 && !brandTokens.some(b => entry.tokens.has(b))) continue;
    // Product line: ALL catalog line words must be in passmark
    if (lineTokens.length > 0 && !lineTokens.every(l => entry.tokens.has(l))) continue;
    // At least ONE of model/series must match (either is enough; handles noise tokens in catalog)
    const anyModel = modelTokens.some(m => tokenMatches(m, entry.tokens));
    const anySeries = seriesTokens.some(s => entry.tokens.has(s));  // series: exact only (3-4 digits)
    if (!anyModel && !anySeries) continue;
    // Capacity
    if (entry.capGB != null && catalogCapGB != null) {
      const ratio = entry.capGB / catalogCapGB;
      if (ratio < 0.95 || ratio > 1.05) continue;
    }
    candidates.push(entry);
  }
  if (candidates.length === 0) return null;

  // Prefer capacity-specific matches
  const capMatched = candidates.filter(c => c.capGB != null);
  const pool = capMatched.length > 0 ? capMatched : candidates;
  return pool.reduce((a, b) => (b.score > a.score ? b : a));
}

// ─── Anchor: highest passmark score overall ──────────────────────
const anchorScore = Math.max(...passmarkEntries.map(e => e.score));
const anchorEntry = passmarkEntries.find(e => e.score === anchorScore);
const scaleFactor = 100 / anchorScore;
console.log(`Anchor: ${anchorEntry.name} = ${anchorScore.toLocaleString()} → scaleFactor ${scaleFactor.toFixed(6)}`);
console.log(`Passmark entries loaded: ${passmarkEntries.length}\n`);

// ─── Load parts.js ────────────────────────────────────────────────
const partsText = readFileSync(PARTS_PATH, 'utf8');
const mod = await import('file:///' + process.cwd().replace(/\\/g, '/') + '/' + PARTS_PATH + '?t=' + Date.now());
const PARTS = mod.PARTS || mod.default;
if (!Array.isArray(PARTS)) {
  console.error('❌ PARTS export not an array');
  process.exit(1);
}

const items = PARTS.filter(p => p.c === 'Storage' && !p.bundle && !p.needsReview);
console.log(`Storage products in catalog: ${items.length}\n`);

// ─── Compute updates ──────────────────────────────────────────────
const updates = [];
const unmatched = [];
const noChange = [];

for (const p of items) {
  const cap = p.cap ?? extractCapacityGB(p.n);
  const match = findBestMatch(p.n, cap);
  if (!match) { unmatched.push({ id: p.id, n: p.n, cap }); continue; }

  const raw = match.score * scaleFactor;
  const newBench = Math.min(100, Math.max(1, Math.round(raw)));
  const oldBench = p.bench;

  if (oldBench === newBench) {
    noChange.push({ id: p.id, n: p.n, bench: oldBench });
  } else {
    updates.push({ id: p.id, n: p.n, cap, matched: match.name, score: match.score, oldBench: oldBench ?? null, newBench });
  }
}

// ─── Report ───────────────────────────────────────────────────────
console.log(`Updates:    ${updates.length} (${updates.filter(u => u.oldBench == null).length} inserts, ${updates.filter(u => u.oldBench != null).length} replacements)`);
console.log(`Unchanged:  ${noChange.length}`);
console.log(`Unmatched:  ${unmatched.length}\n`);

console.log('Sample matches (top 30 by bench):');
console.log('  ID     CAP    OLD→NEW  CATALOG → PASSMARK');
[...updates].sort((a, b) => b.newBench - a.newBench).slice(0, 30).forEach(u => {
  const old = u.oldBench == null ? '  -' : String(u.oldBench).padStart(3);
  console.log(`  ${String(u.id).padEnd(6)} ${String(u.cap || '?').padStart(5)}  ${old}→${String(u.newBench).padStart(3)}  ${u.n.slice(0, 38).padEnd(38)} → ${u.matched.slice(0, 40)}`);
});

if (unmatched.length > 0) {
  console.log(`\nUnmatched (${unmatched.length}) — first 30:`);
  unmatched.slice(0, 30).forEach(u => console.log(`  [${u.id}] cap=${u.cap}  ${u.n.slice(0, 75)}`));
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

// Build edit list: {line, mode: 'replace'|'insert-after', newBench}
const edits = [];
let notFound = 0;
for (const u of updates) {
  const startLine = idToLine.get(u.id);
  if (startLine === undefined) { notFound++; continue; }

  let replaceLine = -1;
  let insertAfterLine = -1;
  for (let i = startLine; i < Math.min(startLine + 80, lines.length); i++) {
    if (/"?bench"?\s*:\s*\d+/.test(lines[i])) { replaceLine = i; break; }
    if (/^(\s*)"?c"?\s*:\s*"Storage"/.test(lines[i])) { insertAfterLine = i; }
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
