/**
 * dedupe-products.cjs — Phase 1 catalog dedupe
 *
 * Finds duplicate product entries in parts.js where:
 *   - Multiple entries exist for the same physical product
 *   - At least one has UPC, at least one doesn't
 *   - Strict matching: same category + brand + name similarity ≥0.85 + model token match
 *
 * Outputs a JSON report (dedupe-report.json) for review.
 * Does NOT modify parts.js. Apply step is separate (after you approve).
 *
 * USAGE:
 *   node dedupe-products.cjs                # generate report
 *   node dedupe-products.cjs --apply        # apply merges (after review)
 */

const fs = require('fs');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');

// Drop_ids to EXCLUDE from merging (false positives confirmed by manual review)
const EXCLUDE_DROP_IDS = new Set([60103, 85225, 85247]);

// ─── Tokenization & similarity ───
function tokenize(s) {
  return String(s || '').toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 2);
}

function nameSim(a, b) {
  const ta = new Set(tokenize(a));
  const tb = new Set(tokenize(b));
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  const containment = common / Math.min(ta.size, tb.size);
  const jaccard = common / (ta.size + tb.size - common);
  return Math.max(containment, jaccard);
}

// Extract distinctive model tokens (alphanumeric mix, looks like a model number)
function extractModelTokens(name) {
  const tokens = tokenize(name);
  return tokens.filter(t => {
    if (t.length < 3) return false;
    const hasLetter = /[a-z]/.test(t);
    const hasDigit = /\d/.test(t);
    return hasLetter && hasDigit;  // e.g., "x870e", "rtx5090", "b650m", "ddr5"
  });
}

function modelTokensMatch(nameA, nameB) {
  const ta = new Set(extractModelTokens(nameA));
  const tb = new Set(extractModelTokens(nameB));
  if (!ta.size || !tb.size) return false;
  // ALL model tokens in A must appear in B (or vice versa, whichever is shorter)
  const smaller = ta.size <= tb.size ? ta : tb;
  const larger = ta.size > tb.size ? ta : tb;
  for (const t of smaller) {
    if (!larger.has(t)) return false;
  }
  return true;
}

// ─── Brand normalization ───
function normBrand(b) {
  return String(b || '').toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/^msi$/, 'msi')
    .replace(/^asus$/, 'asus');
}

// ─── Main ───
(async () => {
  const partsMod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...partsMod.PARTS];
  const active = parts.filter(p => !p.bundle && !p.needsReview);

  console.log('Active products:', active.length);

  // Group by category
  const byCat = new Map();
  for (const p of active) {
    if (!p.c) continue;
    if (!byCat.has(p.c)) byCat.set(p.c, []);
    byCat.get(p.c).push(p);
  }

  // Find duplicate pairs
  const merges = []; // { keep: part_with_upc, drop: part_without_upc, similarity, reasons[] }
  let scanned = 0;
  let totalPairs = 0;

  for (const [cat, products] of byCat) {
    const withUpc = products.filter(p => p.upc);
    const withoutUpc = products.filter(p => !p.upc);
    if (!withoutUpc.length || !withUpc.length) continue;

    for (const noUpcProduct of withoutUpc) {
      scanned++;
      let best = null;

      for (const hasUpcProduct of withUpc) {
        totalPairs++;
        // Quick reject: different brands
        const brandA = normBrand(noUpcProduct.b);
        const brandB = normBrand(hasUpcProduct.b);
        if (brandA && brandB && brandA !== brandB) continue;

        // Name similarity (stricter threshold)
        const sim = nameSim(noUpcProduct.n, hasUpcProduct.n);
        if (sim < 0.93) continue;

        // Model tokens must match (e.g., "X870E" in both)
        if (!modelTokensMatch(noUpcProduct.n, hasUpcProduct.n)) continue;

        // Distinguishing-word check: reject if one has a SKU-differentiating word the other lacks
        const DISTINGUISHERS = ['PRO', 'PLUS', 'MAX', 'MINI', 'OC', 'RGB', 'ARGB', 'G2', 'V2', 'V3', 'GEN2', 'GEN3', 'SUPER', 'TI', 'XT', 'XTX', 'SLIM', 'GAMING', 'WHITE', 'BLACK', 'ICE', 'CORE', 'SE', 'LE', 'ELITE', 'EDGE', 'TOMAHAWK', 'CARBON', 'STRIX', 'TUF', 'PRIME', 'AORUS', 'EVA', 'AERO', 'AMPLIFY', 'VENTUS', 'SUPRIM', 'TRIO', 'VANGUARD', 'EXPERT', 'ACE', 'UNIFY', 'NOVA', 'FORMULA', 'EXTREME', 'HERO', 'IMPACT', 'TACHYON', 'FROZEN', 'STEEL', 'NITRO', 'PULSE', 'PURE', 'HELLHOUND', 'REAPER', 'DEVIL', 'TAICHI', 'PHANTOM', 'CHALLENGER', 'AMP', 'TWIN', 'PG', 'WIFI', 'BTF', 'LCD', 'OLED', 'IPS', 'VA', 'TN', 'X3D', '3D', 'F', 'KF', 'KS', 'XE', 'K', 'NON', 'KIRIN', 'MASTER', 'PRO', 'ULTRA', 'LITE', 'OMEGA', 'SAGE', 'ENCORE', 'ELITAX', 'TOR', 'SLAYER', 'SHADOW', 'OBSIDIAN', 'BLUR', 'FUSION', 'STORM', 'CYCLONE', 'EAGLE', 'INFINITE', 'NIGHTHAWK', 'STARSHIP', 'TITAN', 'DELUXE'];
        const aTokens = new Set(noUpcProduct.n.toUpperCase().split(/[^A-Z0-9]+/));
        const bTokens = new Set(hasUpcProduct.n.toUpperCase().split(/[^A-Z0-9]+/));
        let distMismatch = false;
        for (const d of DISTINGUISHERS) {
          if (aTokens.has(d) !== bTokens.has(d)) { distMismatch = true; break; }
        }
        if (distMismatch) continue;

        // Skip if drop_id is in manual exclusion list
        if (EXCLUDE_DROP_IDS.has(noUpcProduct.id)) continue;

        if (!best || sim > best.similarity) {
          best = { keep: hasUpcProduct, drop: noUpcProduct, similarity: sim };
        }
      }

      if (best) merges.push(best);
    }
  }

  console.log('No-UPC products scanned:', scanned);
  console.log('Pair comparisons:', totalPairs);
  console.log('Duplicate merges found:', merges.length);

  // Report
  const report = {
    generatedAt: new Date().toISOString(),
    totalActive: active.length,
    totalNoUpc: active.filter(p => !p.upc).length,
    duplicatePairsFound: merges.length,
    merges: merges.map(m => ({
      keep_id: m.keep.id,
      keep_name: m.keep.n,
      keep_upc: m.keep.upc,
      keep_mpn: m.keep.mpn,
      keep_has_amazon: !!m.keep.deals?.amazon,
      keep_has_bestbuy: !!m.keep.deals?.bestbuy,
      keep_has_newegg: !!m.keep.deals?.newegg,
      drop_id: m.drop.id,
      drop_name: m.drop.n,
      drop_mpn: m.drop.mpn,
      drop_has_amazon: !!m.drop.deals?.amazon,
      drop_has_bestbuy: !!m.drop.deals?.bestbuy,
      drop_category: m.drop.c,
      similarity: Math.round(m.similarity * 100) / 100,
    })),
  };

  fs.writeFileSync('dedupe-report.json', JSON.stringify(report, null, 2));
  console.log('\nReport written to dedupe-report.json');

  // Summary
  console.log('\nBy category:');
  const byCatCount = {};
  merges.forEach(m => byCatCount[m.drop.c] = (byCatCount[m.drop.c] || 0) + 1);
  Object.entries(byCatCount).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log('  ' + c + ': ' + n));

  console.log('\nFirst 10 proposed merges:');
  merges.slice(0, 10).forEach((m, i) => {
    console.log('---');
    console.log((i + 1) + '. [' + m.drop.c + '] sim=' + Math.round(m.similarity * 100) / 100);
    console.log('   KEEP id=' + m.keep.id + ' upc=' + m.keep.upc);
    console.log('     ' + m.keep.n.slice(0, 100));
    console.log('   DROP id=' + m.drop.id);
    console.log('     ' + m.drop.n.slice(0, 100));
  });

  // Apply phase
  if (APPLY) {
    console.log('\n--- APPLY MODE ---');

    // Build map: drop_id → keep
    const dropMap = new Map();
    merges.forEach(m => dropMap.set(m.drop.id, m.keep));

    // Build new parts list
    const newParts = [];
    let dropped = 0;
    let mergedData = 0;

    for (const p of parts) {
      const replacement = dropMap.get(p.id);
      if (replacement) {
        // This is a duplicate to drop. Merge any unique data into the keeper first.
        // Mainly: ratings/reviews count (use higher), Amazon/BestBuy deals (keep both if differ).
        // Note: keeper already has its own deals; we only add from drop if keeper is missing.
        if (p.deals?.amazon && !replacement.deals?.amazon) {
          replacement.deals = replacement.deals || {};
          replacement.deals.amazon = p.deals.amazon;
          mergedData++;
        }
        if (p.deals?.bestbuy && !replacement.deals?.bestbuy) {
          replacement.deals = replacement.deals || {};
          replacement.deals.bestbuy = p.deals.bestbuy;
          mergedData++;
        }
        if (p.r && (!replacement.r || replacement.r < p.r)) {
          // Don't change rating - they're independent products even if same physical product
        }
        if (!replacement.mpn && p.mpn) replacement.mpn = p.mpn;
        dropped++;
        continue;
      }
      newParts.push(p);
    }

    console.log('Products dropped:', dropped);
    console.log('Data fields merged into keepers:', mergedData);

    // Write parts.js
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(newParts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log('Wrote ' + newParts.length + ' products to parts.js (was ' + parts.length + ')');
  }
})();
