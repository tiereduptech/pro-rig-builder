/**
 * Fix the three Corsair 5000D RS rows that claim 200mm radiator support (#38).
 *
 * They hold rads [120, 140, 200]. No 200mm AIO exists — that is the case's FAN
 * compatibility, which Corsair lists as "Front: 3x 120mm, 3x 140mm, 2x 200mm".
 * rebuild-corsair-cases*.js read every three-digit mm out of whichever spec row
 * it matched, with no check that the sizes were radiator sizes.
 *
 * This was live and misleading, not merely untidy. src/App.jsx renders rads by
 * bucket off Math.max(...), and max(120,140,200) is 200, which clears none of
 * the 360/280/240 thresholds:
 *
 *   rads: v => max>=360 ? "Up to 360mm" : ... : max>=120 ? "120mm only" : "None"
 *
 * So all three product pages read "AIO Support: 120mm only" for cases that take
 * a 420mm radiator — telling someone shopping for a 360 AIO that it will not fit.
 *
 * Correct values are from CORSAIR's own tech specs for both variants, which are
 * identical:
 *
 *   Top / Front / Side  420mm, 360mm, 280mm, 240mm
 *   Rear                140mm, 120mm
 *
 *   FRAME 5000D RS       CC-9011307-WW
 *   FRAME 5000D RS ARGB  CC-9011309-WW
 *
 * Note the whitelist added to the writers would NOT by itself have produced the
 * right answer here: filtering [120,140,200] leaves [120,140], which still
 * renders "120mm only". That is why those writers now refuse the whole field
 * when it holds a non-radiator size rather than stripping it — and why these
 * three rows need setting by hand from the vendor spec.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { writeCatalog } = require('./scripts/write-catalog.cjs');
const { RAD_SIZES } = await import('./scripts/case-spec-parser.mjs');
const parts = (await import('./src/data/parts.js')).default;

const WAS = [120, 140, 200];
const NOW = [120, 140, 240, 280, 360, 420];
const IDS = [
  { id: 70120, name: 'FRAME 5000D RS' },
  { id: 70330, name: 'FRAME 5000D RS ARGB — Black' },
  { id: 70331, name: 'FRAME 5000D RS ARGB — White' },
];

if (NOW.some(n => !RAD_SIZES.includes(n))) {
  console.error('✗ Refusing to write: the replacement itself contains a non-radiator size.');
  process.exit(1);
}

const failures = [];
let changed = 0;
for (const { id, name } of IDS) {
  const row = parts.find(p => p.id === id);
  if (!row) { failures.push(`${id}: no row with that id`); continue; }
  if (row.c !== 'Case') { failures.push(`${id}: not a Case (${row.c})`); continue; }
  if (JSON.stringify(row.rads) !== JSON.stringify(WAS)) {
    failures.push(`${id}: expected rads ${JSON.stringify(WAS)}, found ${JSON.stringify(row.rads)} — not touching it`);
    continue;
  }
  row.rads = [...NOW];
  console.log(`${id} ${name}: ${JSON.stringify(WAS)} → ${JSON.stringify(NOW)}`);
  changed++;
}

if (failures.length) {
  console.error('\n✗ Refusing to write — the catalog is not in the state this pass was written against:');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}

// What the site will now show for these three.
const bucket = (rads) => {
  const arr = Array.isArray(rads) ? rads : [];
  if (!arr.length) return 'None';
  const max = Math.max(...arr);
  return max >= 360 ? 'Up to 360mm' : max >= 280 ? 'Up to 280mm' : max >= 240 ? 'Up to 240mm' : max >= 120 ? '120mm only' : 'None';
};
console.log(`\nAIO Support now reads "${bucket(NOW)}" instead of "${bucket(WAS)}".`);

const stillBogus = parts.filter(p => p.c === 'Case' && Array.isArray(p.rads) && p.rads.some(n => !RAD_SIZES.includes(n)));
if (stillBogus.length) {
  console.error(`✗ ${stillBogus.length} Case row(s) still carry a non-radiator size:`);
  for (const p of stillBogus) console.error(`  ${p.id}: ${JSON.stringify(p.rads)}`);
  process.exit(1);
}
console.log('No Case row carries a non-radiator size.');

await writeCatalog(parts, { loadedCount: parts.length, reason: `correct Corsair 5000D RS radiator support (${changed} rows)` });
