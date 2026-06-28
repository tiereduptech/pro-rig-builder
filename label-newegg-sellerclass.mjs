// Label every existing Newegg deal with sellerClass by item-number prefix
// (N82E=official, 9SI=marketplace, else other). Pure local transform — no API.
// Run AFTER the migration refresh so kept-marketplace deals are labeled too.
//   node label-newegg-sellerclass.mjs            # dry run
//   node label-newegg-sellerclass.mjs --apply
import { writeFileSync } from 'node:fs';
import { sellerClass } from './newegg-match.js';

const APPLY = process.argv.includes('--apply');
const PARTS_PATH = process.cwd().replace(/\\/g, '/') + '/src/data/parts.js';
const mod = await import(`file://${PARTS_PATH}?t=${Date.now()}`);
const parts = mod.PARTS;

const counts = { official: 0, marketplace: 0, other: 0, none: 0, alreadyLabeled: 0, changed: 0 };
for (const p of parts) {
  const d = p.deals?.newegg;
  if (!d) continue;
  const cls = sellerClass(d.sku);
  counts[cls] = (counts[cls] || 0) + 1;
  if (d.sellerClass === cls) { counts.alreadyLabeled++; continue; }
  if (APPLY) d.sellerClass = cls;
  counts.changed++;
}
console.log(JSON.stringify(counts, null, 2));
if (APPLY) {
  const header = '// Auto-merged catalog. Edit with care.\n';
  writeFileSync(PARTS_PATH, header + 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n');
  console.log(`Applied sellerClass labels to ${counts.changed} newegg deals.`);
} else {
  console.log('DRY RUN — re-run with --apply.');
}
