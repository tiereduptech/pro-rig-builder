#!/usr/bin/env node
/**
 * backfill-aio-tdp.js
 *
 * Populates tdp_rating for AIO coolers based on radiator size using
 * industry-standard conservative values. Marks estimates with
 * tdp_rating_est:true so the UI can distinguish from manufacturer specs.
 *
 * Rules:
 *   120mm → 125W
 *   140mm → 150W
 *   240mm → 200W
 *   280mm → 230W
 *   360mm → 280W
 *   420mm → 320W
 *   480mm → 350W
 *
 * Preserves:
 *   - Existing tdp_rating values (doesn't overwrite manufacturer data)
 *   - Products without radSize are skipped (would need manufacturer scrape)
 *
 * Reports what it did.
 */
import { writeFileSync } from 'node:fs';

const RAD_TDP = {
  120: 125,
  140: 150,
  240: 200,
  280: 230,
  360: 280,
  420: 320,
  480: 350,
};

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];

const aios = parts.filter(p => p.c === 'CPUCooler' && p.coolerType === 'AIO');
console.log(`━━━ AIO TDP BACKFILL ━━━`);
console.log(`  Total AIOs: ${aios.length}`);
console.log(`  With existing tdp_rating: ${aios.filter(p => p.tdp_rating != null).length}`);
console.log(`  With radSize: ${aios.filter(p => p.radSize != null).length}\n`);

let added = 0;
let skippedHasReal = 0;
let skippedNoRad = 0;
let skippedUnknownRad = 0;

for (const p of aios) {
  if (p.tdp_rating != null) { skippedHasReal++; continue; }
  if (p.radSize == null) { skippedNoRad++; continue; }
  const rad = Math.round(+p.radSize);
  const tdp = RAD_TDP[rad];
  if (!tdp) {
    skippedUnknownRad++;
    console.log(`  skip id=${p.id} (rad=${p.radSize}, not a standard size): ${p.n.slice(0, 60)}`);
    continue;
  }
  p.tdp_rating = tdp;
  p.tdp_rating_est = true;
  added++;
}

console.log(`\n  Added TDP estimate: ${added}`);
console.log(`  Skipped (had real TDP): ${skippedHasReal}`);
console.log(`  Skipped (no radSize): ${skippedNoRad}`);
console.log(`  Skipped (non-standard radSize): ${skippedUnknownRad}\n`);

// Save
const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('Wrote parts.js');

// Final coverage
const final = parts.filter(p => p.c === 'CPUCooler' && p.coolerType === 'AIO');
const withTdp = final.filter(p => p.tdp_rating != null).length;
console.log(`\n━━━ FINAL COVERAGE ━━━`);
console.log(`  AIOs with TDP: ${withTdp}/${final.length} (${Math.round(withTdp/final.length*100)}%)`);
console.log(`    Manufacturer data: ${final.filter(p => p.tdp_rating != null && !p.tdp_rating_est).length}`);
console.log(`    Estimated from radSize: ${final.filter(p => p.tdp_rating_est).length}`);
