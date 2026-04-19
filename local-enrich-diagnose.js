/**
 * local-enrich-diagnose.js — show products that didn't get a brand extracted
 *
 * Helps us see which brand patterns are missing from local-enrich.js
 */

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const DIR = './catalog-build/enriched';
const files = readdirSync(DIR).filter(f => f.endsWith('.json'));

for (const file of files) {
  const data = JSON.parse(readFileSync(join(DIR, file), 'utf-8'));
  const noBrand = data.filter(p => !p.brand);

  if (noBrand.length === 0) continue;

  console.log(`\n═══ ${file} ═══ (${noBrand.length} products without brand)`);
  for (const p of noBrand.slice(0, 8)) {
    console.log(`  [${p.price}] ${p.fullTitle.slice(0, 95)}`);
  }
  if (noBrand.length > 8) console.log(`  ... and ${noBrand.length - 8} more`);
}
