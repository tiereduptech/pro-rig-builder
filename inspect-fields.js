#!/usr/bin/env node
/**
 * inspect-fields.js — show actual field names Best Buy uses per category
 *
 * For each category, prints the top N products' _details field names
 * so we can fix the spec mappers to match.
 *
 * Usage:
 *   node inspect-fields.js RAM
 *   node inspect-fields.js Storage
 *   node inspect-fields.js all    (all categories)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = './catalog-build/bestbuy-enriched';
const arg = process.argv[2] || 'all';

const files = (arg === 'all')
  ? readdirSync(dir).filter(f => f.endsWith('.json'))
  : [arg + '.json'];

for (const file of files) {
  const path = join(dir, file);
  let data;
  try {
    data = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    console.log(`${file}: not found or empty`);
    continue;
  }
  if (data.length === 0) {
    console.log(`\n━━━ ${file.replace('.json', '')} (0 products) ━━━`);
    continue;
  }

  // Union of all field names across first 5 products (to get a variety)
  const sample = data.slice(0, 5);
  const allFields = new Map(); // name → count

  for (const p of sample) {
    for (const k of Object.keys(p._details || {})) {
      allFields.set(k, (allFields.get(k) || 0) + 1);
    }
  }

  console.log(`\n━━━ ${file.replace('.json', '')} (${data.length} products, showing fields from first 5) ━━━`);
  console.log(`Sample product name: ${sample[0].name.slice(0, 70)}`);
  console.log(`Current parsed specs: ${JSON.stringify(sample[0].specs)}`);
  console.log('Available _details fields (with sample values):');
  for (const [name, count] of [...allFields.entries()].sort()) {
    const value = sample[0]._details[name] || sample.find(p => p._details?.[name])?._details[name] || '';
    console.log(`  [${count}/5] ${name.padEnd(45)} = ${String(value).slice(0, 50)}`);
  }
}
