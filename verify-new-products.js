#!/usr/bin/env node
/**
 * verify-new-products.js
 *
 * Verifies newly-added products from Phase 2 catalog expansion.
 * Targets: CPU id>=10211, GPU id>=30328, Motherboard id>=20452
 *
 * For each target product:
 *   1. Extract ASIN from deals.amazon.url
 *   2. Query DataForSEO for current title/price at that ASIN
 *   3. Verify title's model token matches what we stored
 *   4. Flag mismatches and price deviations for review
 *
 * USAGE:
 *   railway run node verify-new-products.js [--dry-run] [--auto-fix]
 *
 * Cost: ~$0.20 for 128 products (~$0.0015 per ASIN lookup)
 */

import { readFileSync, writeFileSync, copyFileSync, mkdirSync, existsSync } from 'node:fs';
import { extractCPUModel, extractGPUModel } from './src/data/product-specs.js';

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) {
  console.error('Missing DATAFORSEO_LOGIN or DATAFORSEO_PASSWORD');
  process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const AUTO_FIX = args.includes('--auto-fix');

// ─── Target ranges (new products from Phase 2 expansion) ───
const TARGETS = {
  CPU: { min: 10211, max: 19999 },
  GPU: { min: 30328, max: 39999 },
  Motherboard: { min: 20452, max: 29999 },
};

// ─── DataForSEO ASIN lookup ───
async function postASINTask(asin) {
  const res = await fetch(`${BASE}/merchant/amazon/asin/task_post`, {
    method: 'POST',
    headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ language_code: 'en_US', location_code: 2840, asin }]),
  });
  const json = await res.json();
  return json?.tasks?.[0]?.id || null;
}

async function getASINResult(taskId) {
  for (let i = 0; i < 15; i++) {
    await new Promise(r => setTimeout(r, i === 0 ? 15000 : 8000));
    const res = await fetch(`${BASE}/merchant/amazon/asin/task_get/advanced/${taskId}`, {
      headers: { 'Authorization': AUTH },
    });
    const json = await res.json();
    const task = json?.tasks?.[0];
    if (task?.status_code === 20000 && task?.result) {
      const item = task.result[0]?.items?.[0];
      if (!item) return null;
      return {
        title: item.title,
        price: item.price?.current ?? item.price_from ?? item.price,
        inStock: item.is_available !== false,
      };
    }
    if (task?.status_code && ![40601, 40602].includes(task.status_code)) {
      return null; // error, give up
    }
  }
  return null;
}

// ─── Title match check ───
function modelsMatch(storedName, amazonTitle, category) {
  if (!storedName || !amazonTitle) return false;
  if (category === 'CPU') {
    const stored = extractCPUModel(storedName);
    const amazon = extractCPUModel(amazonTitle);
    return stored && amazon && stored.toUpperCase() === amazon.toUpperCase();
  }
  if (category === 'GPU') {
    const stored = extractGPUModel(storedName);
    const amazon = extractGPUModel(amazonTitle);
    return stored && amazon && stored === amazon;
  }
  if (category === 'Motherboard') {
    // For mobos, require chipset match in both titles
    // Matches chipset codes including the trailing M used on Micro ATX boards (e.g., B550M=B550, A520M=A520)
    const chipsetRegex = /\b(Z\d{3}E?|B\d{3}[EA]?|H\d{3}|X\d{3}[EA]?|A\d{3})M?\b/i;
    const normalize = (c) => c ? c.toUpperCase().replace(/M$/, "") : c;
    const stored = normalize((storedName.match(chipsetRegex) || [])[1]);
    const amazon = normalize((amazonTitle.match(chipsetRegex) || [])[1]);
    return stored && amazon && stored === amazon;
  }
  return false;
}

// ─── Load catalog ───
console.log('Loading catalog...');
const mod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
const parts = [...mod.PARTS];

// Find target products (new additions only)
const targets = parts.filter(p => {
  const r = TARGETS[p.c];
  if (!r) return false;
  return p.id >= r.min && p.id <= r.max;
});
console.log(`Found ${targets.length} newly-added products to verify`);
console.log(`  CPUs: ${targets.filter(t => t.c === 'CPU').length}`);
console.log(`  GPUs: ${targets.filter(t => t.c === 'GPU').length}`);
console.log(`  Mobos: ${targets.filter(t => t.c === 'Motherboard').length}`);
console.log(`\nEstimated cost: ~$${(targets.length * 0.0015).toFixed(2)}`);
console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : AUTO_FIX ? 'AUTO-FIX' : 'REPORT ONLY'}\n`);

if (DRY_RUN) {
  console.log('Sample targets:');
  targets.slice(0, 10).forEach(t => {
    const asin = t.deals?.amazon?.url?.match(/dp\/([A-Z0-9]+)/)?.[1];
    console.log(`  id=${t.id} [${t.c}] asin=${asin} pr=$${t.pr} ${t.n.slice(0, 55)}`);
  });
  console.log('\n(Dry run — no API calls made)');
  process.exit(0);
}

// ─── Verify in batches ───
const BATCH_SIZE = 20;
const issues = [];
const fixes = {};
let verified = 0;

for (let bStart = 0; bStart < targets.length; bStart += BATCH_SIZE) {
  const batch = targets.slice(bStart, bStart + BATCH_SIZE);
  const batchNum = Math.floor(bStart / BATCH_SIZE) + 1;
  const totalBatches = Math.ceil(targets.length / BATCH_SIZE);
  console.log(`\nBatch ${batchNum}/${totalBatches} (${batch.length} items)`);

  // Post all tasks
  const batchTasks = [];
  for (const p of batch) {
    const asin = p.deals?.amazon?.url?.match(/dp\/([A-Z0-9]+)/)?.[1];
    if (!asin) {
      issues.push({ id: p.id, c: p.c, n: p.n, issue: 'no_asin' });
      continue;
    }
    try {
      const taskId = await postASINTask(asin);
      if (taskId) batchTasks.push({ p, asin, taskId });
    } catch (e) {
      issues.push({ id: p.id, c: p.c, n: p.n, issue: 'post_failed', error: e.message });
    }
  }

  // Collect results
  for (const { p, asin, taskId } of batchTasks) {
    try {
      const result = await getASINResult(taskId);
      verified++;
      if (!result) {
        issues.push({ id: p.id, c: p.c, n: p.n, asin, issue: 'asin_not_found' });
        console.log(`  ✗ id=${p.id} ${asin} — ASIN returned no data`);
        fixes[p.id] = { needsReview: true, quarantinedAt: new Date().toISOString().slice(0, 10) };
        continue;
      }

      const titleMatch = modelsMatch(p.n, result.title, p.c);
      const priceDeviation = (typeof p.pr === 'number' && typeof result.price === 'number')
        ? Math.abs(result.price - p.pr) / p.pr : 0;

      let status = '✓';
      let noteParts = [];

      if (!titleMatch) {
        issues.push({ id: p.id, c: p.c, n: p.n, asin, issue: 'title_mismatch', amazonTitle: result.title });
        fixes[p.id] = { needsReview: true, quarantinedAt: new Date().toISOString().slice(0, 10) };
        status = '✗';
        noteParts.push('TITLE_MISMATCH');
      }
      if (priceDeviation > 0.25 && result.price > 0) {
        issues.push({ id: p.id, c: p.c, n: p.n, asin, issue: 'price_deviation', stored: p.pr, actual: result.price, deviation: priceDeviation });
        fixes[p.id] = { ...(fixes[p.id] || {}), newAmazonPrice: result.price };
        if (status === '✓') status = '~';
        noteParts.push(`PRICE ${p.pr}->${result.price}`);
      }

      console.log(`  ${status} id=${p.id} ${asin} ${noteParts.join(' ') || 'OK'} | ${result.title.slice(0, 50)}`);
    } catch (e) {
      issues.push({ id: p.id, c: p.c, n: p.n, asin, issue: 'fetch_error', error: e.message });
    }
  }

  if (bStart + BATCH_SIZE < targets.length) {
    await new Promise(r => setTimeout(r, 3000));
  }
}

// ─── Apply fixes if --auto-fix ───
console.log('\n═══ VERIFICATION SUMMARY ═══');
console.log(`Verified: ${verified}/${targets.length}`);
console.log(`Issues found: ${issues.length}`);

const byIssue = {};
for (const i of issues) byIssue[i.issue] = (byIssue[i.issue] || 0) + 1;
Object.entries(byIssue).forEach(([k, v]) => console.log(`  ${k}: ${v}`));

// Save report
if (!existsSync('./verify-reports')) mkdirSync('./verify-reports');
const ts = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
const reportPath = `./verify-reports/new-products-${ts}.json`;
writeFileSync(reportPath, JSON.stringify({ verified, issues, fixes }, null, 2));
console.log(`\nReport: ${reportPath}`);

if (AUTO_FIX && Object.keys(fixes).length > 0) {
  copyFileSync('./src/data/parts.js', `./src/data/parts.js.pre-verify-fixes.backup`);
  let fixCount = 0;
  for (const p of parts) {
    const fix = fixes[p.id];
    if (!fix) continue;
    if (fix.needsReview) {
      p.needsReview = true;
      p.quarantinedAt = fix.quarantinedAt;
      fixCount++;
    }
    if (fix.newAmazonPrice != null && p.deals?.amazon) {
      p.deals.amazon.price = fix.newAmazonPrice;
      p.pr = fix.newAmazonPrice;
      fixCount++;
    }
  }
  const content = '// Auto-merged catalog. Edit with care.\nexport const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
  writeFileSync('./src/data/parts.js', content);
  console.log(`\n✓ Applied fixes to ${Object.keys(fixes).length} products`);
}
