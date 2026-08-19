/**
 * Correct the values the 2026-08-19 DataForSEO case enrichment got wrong.
 *
 * Scope: ONLY fields that run wrote (commit b938d914ea1, 81 rows). It wrote no
 * field that already had a value, so every correction here either restores the
 * pre-run empty or replaces a value nothing else depends on.
 *
 * All seven come from one bug class: parseSpecs() flattens the whole listing —
 * title, description, spec body, and A+ content — into a single string and runs
 * regexes over it. Amazon's A+ content contains a COMPARISON TABLE, one label
 * followed by that spec for this product AND up to six others. Flattened, a
 * label sits next to whichever number happens to follow it, so the extractor
 * cannot tell whose spec it just read.
 *
 * Which column belongs to the listing is checkable: the table carries a Price
 * row, and comparing its first cell to the listing's own price says whether
 * column 1 is this product. It is on some listings and is not on others, which
 * is why "take the first number after the label" is not a positional parse.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { writeCatalog } = require('./scripts/write-catalog.cjs');
const parts = (await import('./src/data/parts.js')).default;

// asin, field, and the value the run wrote — asserted before changing anything,
// so this refuses to fire twice or to touch a value some later run replaced.
const CORRECTIONS = [
  {
    asin: 'B0D7BNK6CB', field: 'maxGPU', was: 280, set: 415,
    why: 'Comparison column 1 IS this case ($89.99 = listing price), but the cell '
       + 'is a range — "Max GPU Length | 280mm - 415mm" — and the regex took the '
       + 'low end. The A+ prose gives the same upper bound: "Front fan supports '
       + 'GPUs up to 415mm, rear fan up to 390mm, and side-mounted AIO up to 280mm."',
  },
  {
    asin: 'B0GDXM372W', field: 'maxGPU', was: 420, set: undefined,
    why: 'Comparison column 1 is a $74.99 case; this listing is $99.99 (API $84.99). '
       + 'The number belongs to a different MUSETEX case.',
  },
  {
    asin: 'B0GDXM372W', field: 'maxCooler', was: 178, set: undefined,
    why: 'Same wrong column as maxGPU above.',
  },
  {
    asin: 'B0GDXM372W', field: 'fans_inc', was: 6, set: 7,
    why: 'Same wrong column ("Number Of Fans Pre-installed | 6 PWM ARGB Fans | 5 | 6 ...").'
       + ' This case\'s own title states it: "MUSETEX ATX PC Case with 7 Pre-Installed '
       + 'PWM ARGB Fans".',
  },
  {
    asin: 'B0FDKZXX93', field: 'maxGPU', was: 415, set: undefined,
    why: 'Comparison column 1 is an $89.99 case; this listing is $66.49 (API $69.99).',
  },
  {
    asin: 'B0FDKZXX93', field: 'maxCooler', was: 166, set: undefined,
    why: 'Same wrong column as maxGPU above. (fans_inc 6 stays — the title says '
       + '"6 PWM ARGB Fans Pre-Installed", so that one is corroborated.)',
  },
  {
    asin: 'B0CGFTBVCD', field: 'rads', was: '120mm', set: undefined,
    why: 'Not a column problem — a label-boundary one. The A+ line reads "... Rear: '
       + '1x 120mm | Radiator Support Top: 240mm / 280mm / 360mm ...", and '
       + '/(\\d{3})\\s*mm\\s*Radiator/ bound the rear FAN size to the next label. The '
       + 'case supports up to 360mm; the row claimed 120mm, the worst bucket there is. '
       + 'Cleared rather than set to 240/280/360 — filling it is the coverage work, '
       + 'and this pass only removes what is wrong.',
  },
];

const asinOf = (p) => p?.deals?.amazon?.asin;
let changed = 0;
const failures = [];

for (const c of CORRECTIONS) {
  const row = parts.find(p => p.c === 'Case' && asinOf(p) === c.asin);
  if (!row) { failures.push(`${c.asin}: no Case row with that ASIN`); continue; }
  if (row[c.field] !== c.was) {
    failures.push(`${c.asin}.${c.field}: expected ${JSON.stringify(c.was)}, found ${JSON.stringify(row[c.field])} — not touching it`);
    continue;
  }
  if (c.set === undefined) delete row[c.field];
  else row[c.field] = c.set;
  console.log(`${c.asin} ${c.field}: ${JSON.stringify(c.was)} → ${c.set === undefined ? '(removed)' : JSON.stringify(c.set)}`);
  changed++;
}

if (failures.length) {
  console.error('\n✗ Refusing to write — the catalog is not in the state this pass was written against:');
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}

console.log(`\n${changed} field(s) corrected across ${new Set(CORRECTIONS.map(c => c.asin)).size} rows.`);
await writeCatalog(parts, {
  loadedCount: parts.length,
  reason: `correct 7 fields mis-extracted by the case enrichment run (${changed} fields)`,
});
