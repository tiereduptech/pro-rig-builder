#!/usr/bin/env node
// Quarantine bundle-flagged rows that are actually whole prebuilt systems (they
// trip prebuiltSystemReason) — they must not ship as indexable "combo" pages.
// Sets needsReview + reviewFlags:['prebuilt-system'] and clears the wrong bundle flag.
//   node quarantine-prebuilt-bundles.cjs            (dry run)
//   node quarantine-prebuilt-bundles.cjs --write
const path = require('path');
const CC = require('./catalog-classify.cjs');
const { writeCatalog } = require('./scripts/write-catalog.cjs');
const WRITE = process.argv.includes('--write');
const TODAY = new Date().toISOString().slice(0, 10);

(async () => {
  const mod = await import('file://' + path.resolve('src/data/parts.js').replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = [...(mod.PARTS || mod.default)];
  const loadedCount = parts.length;
  const hit = [];
  for (const p of parts) {
    if (p.bundle !== true) continue;
    const r = CC.prebuiltSystemReason(p.n);
    if (!r) continue;
    hit.push({ id: p.id, reason: r, n: (p.n || '').slice(0, 55) });
    p.needsReview = true;
    p.quarantinedAt = p.quarantinedAt || TODAY;
    p.reviewFlags = Array.from(new Set([...(p.reviewFlags || []), 'prebuilt-system']));
    delete p.bundle;                      // it's a prebuilt, not a combo
  }
  console.log('bundle rows that are actually prebuilts -> quarantined:', hit.length);
  for (const h of hit) console.log(`  ${h.id}  [${h.reason}]  ${h.n}`);
  if (!WRITE) { console.log('\nDRY RUN — nothing written.\n'); return; }
  const res = await writeCatalog(parts, { loadedCount, reason: `quarantine ${hit.length} prebuilt-in-bundle rows` });
  console.log('writeCatalog:', JSON.stringify(res));
})().catch((e) => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
