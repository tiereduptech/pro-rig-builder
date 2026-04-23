#!/usr/bin/env node
/**
 * patch-verifier-strategy2.js
 *
 * Upgrades verify-catalog-asins.js to add:
 * 1. Known-good ASIN table lookup (instant, free, authoritative)
 * 2. Strategy 2: Amazon search → verify each candidate by ASIN → strict scoring
 * 3. Quarantine: mark products with needsReview=true when no confident match
 *
 * Safe to re-run — detects prior patches and skips.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const target = './verify-catalog-asins.js';
if (!existsSync(target)) { console.error('verify-catalog-asins.js not found'); process.exit(1); }

let src = readFileSync(target, 'utf8');
const original = src;

// ─── Check if already patched ───
if (src.includes('STRATEGY 2')) {
  console.log('Already patched (STRATEGY 2 marker found). Exiting.');
  process.exit(0);
}

// ─── PATCH 1: Add imports at top ───
const newImports = `import { canonicalizeProductName, extractModelToken } from './normalize-product-name.js';
import { existsSync as fsExists } from 'node:fs';
`;

// Find existing import block (first few lines)
const importMatch = src.match(/^(import .+?\n(?:import .+?\n)*)/m);
if (importMatch) {
  src = src.replace(importMatch[1], importMatch[1] + newImports);
  console.log('  + Added imports');
}

// ─── PATCH 2: Load known-good ASIN table ───
const tableLoader = `
// ═══ STRATEGY 2: Known-good ASIN overrides table ═══
let ASIN_OVERRIDES = {};
const OVERRIDES_PATH = './src/data/asin-overrides.json';
if (fsExists(OVERRIDES_PATH)) {
  try {
    ASIN_OVERRIDES = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
    console.log(\`Loaded \${Object.keys(ASIN_OVERRIDES).length} known-good ASIN overrides\`);
  } catch (e) {
    console.warn('Failed to load asin-overrides.json:', e.message);
  }
}

function lookupKnownGoodASIN(product) {
  const key = canonicalizeProductName(product.n, product.c);
  if (!key) return null;
  const entry = ASIN_OVERRIDES[key];
  return entry ? { asin: entry.asin, source: 'known-good-table', score: 1.0 } : null;
}

// Strict model-token matching — "5900X" must NOT match "5900XT"
function hasExactModelToken(storedName, candidateTitle, category) {
  const storedModel = extractModelToken(storedName, category);
  if (!storedModel) return false;
  // Tokenize candidate title (split on whitespace/punctuation)
  const tokens = candidateTitle.toUpperCase().split(/[\\s,\\-\\/\\(\\)\\[\\]™®]+/).filter(Boolean);
  return tokens.includes(storedModel.toUpperCase());
}
`;

// Insert after the PRICE_DRIFT_THRESHOLD / ASIN_FIX_MIN_SCORE constants
const constantAnchor = "const ASIN_FIX_MIN_SCORE = 0.8;";
if (src.includes(constantAnchor)) {
  src = src.replace(constantAnchor, constantAnchor + '\n' + tableLoader);
  console.log('  + Added known-good table loader + strict model match helper');
}

// ─── PATCH 3: Replace ASIN repair logic (around line 370-400) ───
const oldRepair = `    const mismatches = allIssues.filter(e => e.issues.some(i => i.type === 'title_mismatch'));
    console.log(\`\\nASIN repair: searching for \${mismatches.length} mismatched products...\`);
    for (let i = 0; i < mismatches.length; i++) {
      const entry = mismatches[i];
      const product = byProduct.get(entry.productId);`;

const newRepair = `    // ═══ STRATEGY 2: Multi-stage ASIN repair ═══
    const mismatches = allIssues.filter(e => e.issues.some(i => i.type === 'title_mismatch'));
    console.log(\`\\nStrategy 2 ASIN repair: \${mismatches.length} candidates...\`);
    let viaTable = 0, viaSearch = 0, viaQuarantine = 0;

    for (let i = 0; i < mismatches.length; i++) {
      const entry = mismatches[i];
      const product = byProduct.get(entry.productId);`;

if (src.includes(oldRepair)) {
  src = src.replace(oldRepair, newRepair);
  console.log('  + Replaced ASIN repair header');
}

// ─── PATCH 4: Add known-good table lookup at start of each repair attempt ───
const oldLookup = `      const best = await searchAmazonForProduct(product);
      if (!best) {
        asinRepairs.push({ productId: entry.productId, category: entry.category, name: product.n,
          oldAsin: entry.asin, newAsin: null, score: 0, applied: false });
        continue;
      }
      const apply = flags.autoFix && best.score >= ASIN_FIX_MIN_SCORE && best.asin !== entry.asin;`;

const newLookup = `      // Step 1: try known-good table first (instant, free, authoritative)
      let best = lookupKnownGoodASIN(product);
      if (best && best.asin !== entry.asin) {
        viaTable++;
        console.log(\`  \${i+1}/\${mismatches.length}: "\${product.n.slice(0, 50)}" → table hit \${best.asin}\`);
      } else {
        best = null;
      }

      // Step 2: if no table hit, search Amazon with strict verification
      if (!best) {
        const searchResult = await searchAmazonForProduct(product);
        if (searchResult) {
          // STRICT CHECK: does the candidate title contain the EXACT model token?
          const strictMatch = hasExactModelToken(product.n, searchResult.title || '', product.c);
          if (strictMatch && searchResult.score >= ASIN_FIX_MIN_SCORE) {
            best = searchResult;
            viaSearch++;
            console.log(\`  \${i+1}/\${mismatches.length}: "\${product.n.slice(0, 50)}" → search hit \${best.asin} (score \${best.score})\`);
          } else {
            console.log(\`  \${i+1}/\${mismatches.length}: "\${product.n.slice(0, 50)}" → quarantine (score \${searchResult.score}, strict=\${strictMatch})\`);
          }
        }
      }

      if (!best) {
        // Step 3: Quarantine — no confident match. Mark needsReview so frontend hides product.
        viaQuarantine++;
        asinRepairs.push({ productId: entry.productId, category: entry.category, name: product.n,
          oldAsin: entry.asin, newAsin: null, score: 0, applied: false, quarantined: true });
        if (flags.autoFix) {
          if (!perProductFixes[entry.productId]) perProductFixes[entry.productId] = {};
          perProductFixes[entry.productId].needsReview = true;
          perProductFixes[entry.productId].quarantinedAt = new Date().toISOString().slice(0, 10);
        }
        continue;
      }
      const apply = flags.autoFix && best.asin !== entry.asin;`;

if (src.includes(oldLookup)) {
  src = src.replace(oldLookup, newLookup);
  console.log('  + Added Strategy 2 multi-stage repair logic');
}

// ─── PATCH 5: Add summary at the end of ASIN repair loop ───
const oldEndSummary = `      console.log(\`ASIN repair: searching for \${mismatches.length} mismatched products...\`);`;
// This pattern doesn't exist anymore after patch 3, but we need a different place for summary
// Insert after the mismatches loop ends. Find the `}` that closes the for loop followed by the code that writes reports.
const loopEndMarker = "    }\n  }\n\n  // Write report";
const loopEndReplacement = `    }
    if (flags.fixAsins && mismatches.length) {
      console.log(\`\\nStrategy 2 summary: \${viaTable} via known-good table, \${viaSearch} via search, \${viaQuarantine} quarantined\`);
    }
  }

  // Write report`;

if (src.includes(loopEndMarker)) {
  src = src.replace(loopEndMarker, loopEndReplacement);
  console.log('  + Added Strategy 2 summary output');
}

// ─── PATCH 6: Apply quarantine flag when writing parts.js ───
// Find the fixes-application loop that modifies parts.js and add needsReview handling
const oldApplyFix = "if (fix.newPrice != null && p.deals?.amazon) p.deals.amazon.price = fix.newPrice;";
const newApplyFix = `if (fix.newPrice != null && p.deals?.amazon) p.deals.amazon.price = fix.newPrice;
      if (fix.needsReview) { p.needsReview = true; p.quarantinedAt = fix.quarantinedAt; }
      if (fix.newAsinUrl && !fix.needsReview) { delete p.needsReview; delete p.quarantinedAt; }`;

if (src.includes(oldApplyFix)) {
  src = src.replace(oldApplyFix, newApplyFix);
  console.log('  + Added quarantine flag write-through');
}

// ─── Save ───
if (src === original) {
  console.log('\\nNo changes applied. Check anchor patterns.');
  process.exit(1);
}
writeFileSync(target, src);
console.log('\\n✓ Verifier patched with Strategy 2 logic.');
console.log('Run: railway run node verify-catalog-asins.js --tier 1 --auto-fix --fix-asins --limit 20');
