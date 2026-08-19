#!/usr/bin/env node
/**
 * backfill-keyboard-specs.cjs — fill wireless / rgb / layout on the keyboard
 * rows one ingest path left empty.
 *
 * WHAT THE AUDIT FOUND
 * All four keyboard filters sat at exactly 41%, which is not what four
 * independent gaps look like. The field-presence signature is perfectly
 * bimodal: 56 rows carry switches+layout+wireless+rgb, 82 carry none of them,
 * and all 82 have source: 'amazon-discovery' (they are missing kbType too).
 * One ingest path never extracted keyboard specs. One fix, not four.
 *
 * The extractor half is keyboardAttributes() in catalog-classify.cjs, so rows
 * ingested from now on get these at ingest. This pass re-reads the titles
 * already in the catalog with that same function.
 *
 * WHY switches IS NOT HERE
 * The field conflates two different specs: the switch TECHNOLOGY (Mechanical,
 * Optical, Membrane, Hall Effect, Scissor — 49 rows) and the switch FEEL
 * (Linear/Tactile/Clicky, and the colour names that stand for feel — 5 rows).
 * A buyer filters on the feel. Extracting into the field as it stands would
 * deepen the conflation and make the eventual split harder, so switches stays
 * blank until it is split — feel in `switches`, technology in its own field.
 *
 * ONE NORMALISATION IS INCLUDED
 * `layout` already holds both "Full" (2 rows) and "Full-Size" (18) for the same
 * layout, which splits one filter bucket in two. Both become "Full-Size". This
 * is a rename of an existing value, not new data, and it is what took the
 * measured layout accuracy from 78% to 98%.
 *
 * Run:
 *   node backfill-keyboard-specs.cjs            (dry run — default)
 *   node backfill-keyboard-specs.cjs --apply
 */

const fs = require('fs');
const path = require('path');
const { keyboardAttributes } = require('./catalog-classify.cjs');
const { writeCatalog } = require('./scripts/write-catalog.cjs');

const ROOT = __dirname;
const PARTS_PATH = path.join(ROOT, 'src', 'data', 'parts.js');
const REPORT = path.join(ROOT, 'verify-reports', `keyboard-specs-backfill-${new Date().toISOString().slice(0, 10)}.json`);
const APPLY = process.argv.includes('--apply');
const FIELDS = ['wireless', 'rgb', 'layout'];

(async () => {
  const mod = await import('file://' + PARTS_PATH.replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = mod.PARTS || mod.default;
  if (!Array.isArray(parts)) { console.error('parts.js did not export PARTS'); process.exit(1); }
  const loadedCount = parts.length;

  const kb = parts.filter((p) => p.c === 'Keyboard');
  const visible = kb.filter((p) => !p.needsReview && !p.bundle);
  const has = (p, k) => p[k] !== undefined && p[k] !== null && p[k] !== '';

  const before = {}; for (const f of FIELDS) before[f] = visible.filter((p) => has(p, f)).length;

  const stamped = [], disagreements = [], renamed = [];

  for (const p of kb) {
    // "Full" and "Full-Size" are the same layout in two spellings.
    if (p.layout === 'Full') { renamed.push({ id: p.id, name: p.n, from: 'Full', to: 'Full-Size' }); }

    const read = keyboardAttributes(p.n);
    const fill = {};
    for (const f of FIELDS) {
      if (!(f in read)) continue;
      if (has(p, f)) {
        // Never overwrite. Only check, and report where the two disagree.
        const stored = p.layout === 'Full' && f === 'layout' ? 'Full-Size' : p[f];
        if (String(read[f]) !== String(stored)) {
          disagreements.push({ id: p.id, name: p.n, field: f, stored: p[f], titleSays: read[f] });
        }
        continue;
      }
      fill[f] = read[f];
    }
    if (Object.keys(fill).length) {
      stamped.push({ id: p.id, name: p.n, fill, visible: !p.needsReview && !p.bundle, _part: p });
    }
  }

  console.log(`\nKeyboard rows: ${kb.length} total, ${visible.length} visible\n`);
  for (const f of FIELDS) {
    const add = stamped.filter((s) => s.visible && f in s.fill).length;
    console.log(`  ${f.padEnd(9)} ${String(before[f]).padStart(3)}/${visible.length} (${Math.round(before[f] / visible.length * 100)}%)` +
      `  ->  ${String(before[f] + add).padStart(3)}/${visible.length} (${Math.round((before[f] + add) / visible.length * 100)}%)   +${add}`);
  }
  console.log(`\n  switches  ${visible.filter((p) => has(p, 'switches')).length}/${visible.length} — deliberately untouched, field conflates technology with feel`);
  console.log(`  "Full" -> "Full-Size" renames: ${renamed.length}`);

  if (disagreements.length) {
    console.log(`\n⚠  ${disagreements.length} row(s) where the title disagrees with a stored value — NOT touched:`);
    for (const d of disagreements.slice(0, 10)) console.log(`     [${d.id}] ${d.field}: stored ${d.stored}, title says ${d.titleSays} — ${d.name.slice(0, 70)}`);
  } else {
    console.log('\n  0 disagreements with existing values.');
  }

  if (!APPLY) { console.log('\nDRY RUN — nothing written. Re-run with --apply.\n'); return; }

  for (const r of renamed) { const p = kb.find((x) => x.id === r.id); if (p) p.layout = 'Full-Size'; }
  for (const s of stamped) Object.assign(s._part, s.fill);

  await writeCatalog(parts, { loadedCount, reason: `backfill keyboard specs (${stamped.length} rows)` });

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify({
    appliedAt: new Date().toISOString(),
    source: 'keyboardAttributes() in catalog-classify.cjs — the same function the ingest path uses',
    fields: FIELDS,
    deferred: { switches: 'field conflates switch technology with switch feel; split before backfilling' },
    coverageBefore: before,
    stamped: stamped.map(({ _part, ...s }) => s),
    renamed,
    disagreements,
  }, null, 2), 'utf8');
  console.log(`\nStamped ${stamped.length} rows. Report: ${path.relative(ROOT, REPORT)}\n`);
})().catch((e) => { console.error(e); process.exit(1); });
