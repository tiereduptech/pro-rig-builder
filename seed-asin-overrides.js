#!/usr/bin/env node
/**
 * seed-asin-overrides.js
 *
 * One-time script to seed src/data/asin-overrides.json from products in
 * parts.js whose current ASINs PASSED the last verifier run (i.e., were
 * NOT flagged as title_mismatch).
 *
 * USAGE:
 *   node seed-asin-overrides.js [--report <report-file.md>]
 *
 * If no --report flag, uses the latest report in verify-reports/.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalizeProductName } from './normalize-product-name.js';

// Find latest report file if not specified
function findLatestReport() {
  const dir = './verify-reports';
  if (!existsSync(dir)) {
    console.error('No verify-reports directory found. Run the verifier first.');
    process.exit(1);
  }
  const reports = readdirSync(dir)
    .filter(f => f.startsWith('report-') && f.endsWith('.md'))
    .map(f => ({ name: f, path: join(dir, f), mtime: statSync(join(dir, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!reports.length) {
    console.error('No report files found.');
    process.exit(1);
  }
  return reports[0].path;
}

const args = process.argv.slice(2);
const reportFlag = args.indexOf('--report');
const reportPath = reportFlag >= 0 ? args[reportFlag + 1] : findLatestReport();

console.log(`Reading report: ${reportPath}`);
const reportText = readFileSync(reportPath, 'utf8');

// Extract IDs of products that had ANY issue (these are NOT trustworthy for seeding)
const failedIds = new Set();
const idMatches = reportText.matchAll(/id=(\d+)/g);
for (const m of idMatches) failedIds.add(parseInt(m[1]));
console.log(`Products with issues (excluded from seed): ${failedIds.size}`);

// Load parts.js
const partsModule = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
const parts = partsModule.PARTS;
console.log(`Loaded ${parts.length} total products`);

// Build overrides from VERIFIED products (passed verification)
const overrides = {};
const stats = { total: 0, canonicalized: 0, skipped: 0, collisions: 0 };

for (const p of parts) {
  if (!p.id || !p.c || !p.n) continue;
  if (failedIds.has(p.id)) { stats.skipped++; continue; }

  const asin = p.deals?.amazon?.url?.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
  if (!asin) continue;

  stats.total++;
  const key = canonicalizeProductName(p.n, p.c);
  if (!key) { stats.skipped++; continue; }
  stats.canonicalized++;

  // If the key already exists with a different ASIN, prefer the higher-rated product
  if (overrides[key] && overrides[key].asin !== asin) {
    const existing = parts.find(x => x.deals?.amazon?.url?.includes(overrides[key].asin));
    if (existing && (p.r || 0) > (existing.r || 0)) {
      overrides[key] = { asin, productId: p.id, source: 'verified', verifiedAt: new Date().toISOString().slice(0, 10) };
    }
    stats.collisions++;
  } else {
    overrides[key] = { asin, productId: p.id, source: 'verified', verifiedAt: new Date().toISOString().slice(0, 10) };
  }
}

// Write overrides file
const outPath = './src/data/asin-overrides.json';
writeFileSync(outPath, JSON.stringify(overrides, null, 2));

console.log(`\n─── Seed Results ───`);
console.log(`  Total products checked: ${stats.total}`);
console.log(`  Successfully canonicalized: ${stats.canonicalized}`);
console.log(`  Skipped (no canonical name or failed verification): ${stats.skipped}`);
console.log(`  Collisions (same canonical key, different ASINs): ${stats.collisions}`);
console.log(`  Unique entries written: ${Object.keys(overrides).length}`);
console.log(`\nWritten to: ${outPath}`);
console.log(`\nSample entries:`);
const sample = Object.entries(overrides).slice(0, 5);
sample.forEach(([k, v]) => console.log(`  ${k} → ${v.asin}`));
