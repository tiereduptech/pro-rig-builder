#!/usr/bin/env node
/**
 * backfill-value-scores.js
 *
 * Computes a `value` score for 11 categories using category-specific formulas.
 * All scores are normalized to 0-100 within their category so the sort is
 * consistent ("100 = best value in this category").
 *
 * Formulas (raw, before normalization):
 *   Case:        stars × 100 / price             (user-chosen)
 *   PSU:         watts × eff_multiplier / price  (user-chosen)
 *   Monitor:     screenSize × refresh × panel_tier / price   (user-chosen)
 *   CPUCooler:   (AIO: radSize / price) or (Air: tdp_rating / price)
 *   RAM:         capacity × speed / price
 *   Storage:     (SSD: seq_r / price)  or  (HDD: capGB / price)
 *   CaseFan:     (cfm + rgb_bonus) / price
 *   Keyboard:    stars × 100 / price
 *   Mouse:       stars × 100 / price
 *   Headset:     stars × 100 / price
 *
 * Missing-data rule: if the required inputs aren't present, value is left null
 * (not zero — so those products don't rank "worst" when sorted).
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// Use lowest deal price if available, else pr
function priceOf(p) {
  if (p.deals && typeof p.deals === 'object') {
    const prices = Object.values(p.deals)
      .map(d => (d && typeof d === 'object' ? d.price : null))
      .filter(x => typeof x === 'number' && x > 0);
    if (prices.length) return Math.min(...prices);
  }
  return p.pr || 0;
}

// ─── Efficiency tier multiplier (80+ rating) ────────────────────────────────
const EFF_MULT = {
  'Titanium': 1.20,
  'Platinum': 1.15,
  'Gold':     1.10,
  'Silver':   1.05,
  'Bronze':   1.00,
  'White':    0.95,
  'None':     0.90,
};
function effMultiplier(eff) {
  if (!eff) return 1.00;
  const key = String(eff).replace(/80\+?\s*/i, '').trim();
  return EFF_MULT[key] || 1.00;
}

// ─── Monitor panel tier ────────────────────────────────────────────────────
const PANEL_TIER = {
  'OLED': 1.5,
  'QD-OLED': 1.6,
  'Mini-LED': 1.3,
  'Mini LED': 1.3,
  'IPS': 1.0,
  'VA': 0.9,
  'TN': 0.8,
};
function panelTier(panel) {
  if (!panel) return 1.0;
  return PANEL_TIER[panel] || 1.0;
}

// ─── RAW SCORE CALCULATORS ──────────────────────────────────────────────────
const CALC = {
  Case: p => {
    const price = priceOf(p);
    if (!price || !p.r) return null;
    return p.r * 100 / price;
  },

  PSU: p => {
    const price = priceOf(p);
    if (!price || !p.watts) return null;
    return p.watts * effMultiplier(p.eff) / price;
  },

  Monitor: p => {
    const price = priceOf(p);
    if (!price || !p.screenSize || !p.refresh) return null;
    return p.screenSize * p.refresh * panelTier(p.panel) / price;
  },

  CPUCooler: p => {
    const price = priceOf(p);
    if (!price) return null;
    // AIO: rad size is the main metric
    if (p.coolerType === 'AIO' && p.radSize) return p.radSize / price;
    // Air: TDP rating
    if (p.coolerType === 'Air' && p.tdp_rating) return p.tdp_rating / price;
    return null;
  },

  RAM: p => {
    const price = priceOf(p);
    if (!price || !p.cap || !p.speed) return null;
    return p.cap * p.speed / price / 1000; // /1000 to keep numbers sane
  },

  Storage: p => {
    const price = priceOf(p);
    if (!price) return null;
    // SSD: read speed / $
    if (p.seq_r) return p.seq_r / price;
    // HDD: GB / $
    if (p.cap) return Number(p.cap) / price;
    return null;
  },

  CaseFan: p => {
    const price = priceOf(p);
    if (!price) return null;
    const cfm = typeof p.cfm === 'number' ? p.cfm : parseFloat(p.cfm) || 0;
    const rgbBonus = p.rgb ? 10 : 0;
    if (!cfm && !rgbBonus) return null;
    return (cfm + rgbBonus) / price;
  },

  Keyboard: p => {
    const price = priceOf(p);
    if (!price || !p.r) return null;
    return p.r * 100 / price;
  },

  Mouse: p => {
    const price = priceOf(p);
    if (!price || !p.r) return null;
    return p.r * 100 / price;
  },

  Headset: p => {
    const price = priceOf(p);
    if (!price || !p.r) return null;
    return p.r * 100 / price;
  },

  Motherboard: p => {
    const price = priceOf(p);
    if (!price || !p.r) return null;
    return p.r * 100 / price;
  },
};

// ─── COMPUTE RAW SCORES ─────────────────────────────────────────────────────
const rawScores = {};
for (const cat of Object.keys(CALC)) rawScores[cat] = [];

for (const p of parts) {
  const calc = CALC[p.c];
  if (!calc) continue;
  const raw = calc(p);
  if (raw != null && isFinite(raw) && raw > 0) {
    p._rawValue = raw;
    rawScores[p.c].push(raw);
  }
}

// ─── NORMALIZE TO 0-100 PER CATEGORY ─────────────────────────────────────────
// Use percentile rank so outliers don't crush the scale. p95 = 100, p5 = 0.
function percentile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx];
}

const bounds = {};
for (const [cat, scores] of Object.entries(rawScores)) {
  if (scores.length < 2) continue;
  const lo = percentile(scores, 0.05);
  const hi = percentile(scores, 0.95);
  bounds[cat] = { lo, hi };
}

let computed = 0;
for (const p of parts) {
  if (p._rawValue == null) continue;
  const b = bounds[p.c];
  if (!b) { delete p._rawValue; continue; }
  const normalized = Math.max(0, Math.min(100,
    Math.round(((p._rawValue - b.lo) / Math.max(b.hi - b.lo, 0.001)) * 100)
  ));
  p.value = normalized;
  delete p._rawValue;
  computed++;
}

// ─── REPORT ─────────────────────────────────────────────────────────────────
console.log(`Computed value scores for ${computed} products\n`);
console.log('━━━ COVERAGE BY CATEGORY ━━━');
for (const cat of Object.keys(CALC)) {
  const catParts = parts.filter(x => x.c === cat);
  const withValue = catParts.filter(x => x.value != null).length;
  const pct = catParts.length ? Math.round(withValue / catParts.length * 100) : 0;
  console.log(`  ${cat.padEnd(13)} ${withValue}/${catParts.length}  (${pct}%)`);
}

// Spot-check: show top 3 and bottom 3 by value in each category
console.log('\n━━━ SPOT CHECK (top & bottom by value) ━━━');
for (const cat of Object.keys(CALC)) {
  const withValue = parts.filter(x => x.c === cat && x.value != null);
  if (withValue.length < 3) continue;
  withValue.sort((a, b) => b.value - a.value);
  console.log(`\n  ${cat}:`);
  console.log(`    TOP  ${String(withValue[0].value).padStart(3)}: ${withValue[0].n.slice(0, 55)} ($${priceOf(withValue[0])})`);
  console.log(`    MID  ${String(withValue[Math.floor(withValue.length/2)].value).padStart(3)}: ${withValue[Math.floor(withValue.length/2)].n.slice(0, 55)}`);
  console.log(`    BOT  ${String(withValue.at(-1).value).padStart(3)}: ${withValue.at(-1).n.slice(0, 55)} ($${priceOf(withValue.at(-1))})`);
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
