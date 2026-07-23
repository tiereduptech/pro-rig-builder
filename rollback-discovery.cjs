#!/usr/bin/env node
/**
 * rollback-discovery.cjs — undo one discovery run by its batchId.
 *
 * Every row inserted by apply-newegg-discoveries.cjs is tagged
 * source:'newegg-discovery' + batchId. This removes exactly the rows of one
 * batch and rewrites via scripts/write-catalog.cjs. The batchId filter is the
 * real safety — only tagged rows of that batch are touched; everything else
 * (including later edits to other rows) is untouched.
 *
 * Because a large batch removal exceeds the 5% shrink brake, rollback passes an
 * explicit maxShrink sized to the batch — this is an intentional, targeted
 * removal, not a lost array.
 *
 * Usage:
 *   node rollback-discovery.cjs --batch=newegg-ram-2026-07-23 --dry-run
 *   node rollback-discovery.cjs --batch=newegg-ram-2026-07-23          # writes
 */

const fs = require('fs');
const path = require('path');
const { writeCatalog } = require('./scripts/write-catalog.cjs');

const ROOT = __dirname;
const PARTS_PATH = path.join(ROOT, 'src', 'data', 'parts.js');
const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const arg = (k, d) => { const h = argv.find((a) => a.startsWith('--' + k + '=')); return h ? h.split('=')[1] : d; };
const BATCH = arg('batch', null);
const SOURCE = arg('source', 'newegg-discovery');
const DRY_RUN = has('dry-run');

(async () => {
  if (!BATCH) throw new Error('--batch=<batchId> is required');
  const m = await import('file://' + PARTS_PATH.replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = [...m.PARTS];
  const loadedCount = parts.length;

  const toRemove = parts.filter((p) => p.source === SOURCE && p.batchId === BATCH);
  const kept = parts.filter((p) => !(p.source === SOURCE && p.batchId === BATCH));

  console.log(`Rollback batch "${BATCH}" (source=${SOURCE})`);
  console.log(`  matched rows: ${toRemove.length}`);
  console.log(`  catalog: ${loadedCount} -> ${kept.length}`);
  if (toRemove.length) {
    const byCat = {};
    for (const p of toRemove) byCat[p.c] = (byCat[p.c] || 0) + 1;
    console.log('  by category:', JSON.stringify(byCat));
    console.log('  sample:', toRemove.slice(0, 5).map((p) => `${p.id}:${(p.n || '').slice(0, 40)}`).join(' | '));
  }

  if (toRemove.length === 0) { console.log('Nothing to remove.'); return; }
  if (DRY_RUN) { console.log('DRY RUN — nothing written.'); return; }

  // Intentional targeted removal: size the shrink allowance to this batch + margin.
  const shrinkNeeded = Math.min(0.9, (toRemove.length / loadedCount) + 0.02);
  await writeCatalog(kept, { loadedCount, reason: `rollback discovery batch ${BATCH} (${toRemove.length})`, maxShrink: shrinkNeeded });
  console.log(`\nREMOVED ${toRemove.length} rows. Catalog ${loadedCount} -> ${kept.length}.`);
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
