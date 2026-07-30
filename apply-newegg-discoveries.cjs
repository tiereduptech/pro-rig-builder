#!/usr/bin/env node
/**
 * apply-newegg-discoveries.cjs — Phase 2 discovery APPLY.
 *
 * Streams the Newegg feed, runs the discovery gate stack (identical to
 * discover-newegg-dry.cjs), dedupes by UPC+MPN, builds catalog rows in the
 * approved insert shape, and writes them via scripts/write-catalog.cjs (atomic
 * promote + mandatory re-split + shrink/GROWTH brakes).
 *
 * Quarantine policy: CPU/GPU insert needsReview:true (held until bench/cpuMark
 * backfill); every other category goes live (needsReview:false) once past its
 * min-viable-spec bar. Every inserted row is tagged source:'newegg-discovery' +
 * batchId + discoveredAt, so rollback-discovery.cjs can remove one run exactly.
 *
 * DEDUP (approved): UPC then MPN — both authoritative and variant-distinguishing.
 * Name-based dedup is deliberately NOT used intra-batch: the feed's "identical"
 * titles are often real color/platform variants (KF552C40BBK4 Black vs …BWK4
 * White) with distinct UPC+MPN, and collapsing them by name would reintroduce
 * the variant-collapse bug. Name-similarity is used ONLY against the existing
 * catalog, gated by NEG.variantMismatch.
 *
 * Usage:
 *   node apply-newegg-discoveries.cjs --category=RAM --limit=50 --dry-run
 *   node apply-newegg-discoveries.cjs --category=RAM --limit=50          # writes
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const SftpClient = require('ssh2-sftp-client');
const CC = require('./catalog-classify.cjs');
const { writeCatalog } = require('./scripts/write-catalog.cjs');

const ROOT = __dirname;
const PARTS_PATH = path.join(ROOT, 'src', 'data', 'parts.js');
const FTP_HOST = process.env.RAKUTEN_FTP_HOST || 'aftp.linksynergy.com';
const FTP_USER = process.env.RAKUTEN_FTP_USER || 'rkp_4681679';
const FTP_PASS = process.env.RAKUTEN_FTP_PASSWORD;

const argv = process.argv.slice(2);
const has = (k) => argv.includes('--' + k);
const arg = (k, d) => { const h = argv.find((a) => a.startsWith('--' + k + '=')); return h ? h.split('=')[1] : d; };
const CATEGORY = arg('category', 'RAM');
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;      // 0 = no cap
// Price-plausibility floor: reject a product whose price-per-unit is wildly out
// of line with the category median (mispriced, legacy overstock, or a bad
// listing — none belong in a catalog people trust for value comparisons). The
// unit is category-specific ($/GB for RAM/Storage, $/W for PSU). 0 disables.
// The median is taken over the survivor pool (current market).
//
// Default 3x, not 5x, chosen from the 2026-07-24 full-pool data: the RAM survivor
// $/GB p95 is ~$31 (matching the catalog's own known-good max of ~$32), so 5x
// (~$78) left $50-62/GB listings in; 3x (~$47) drops exactly the handful that
// exceed the trusted catalog range without touching any legitimate module.
const PRICE_MULT = parseFloat(arg('price-mult', '3')) || 3;
// $-per-unit for the floor, per category. Returns null when not computable.
const PRICE_UNIT = {
  RAM: (specs, price) => (price && specs.cap ? price / specs.cap : null),
  Storage: (specs, price) => (price && specs.cap ? price / specs.cap : null),
  PSU: (specs, price) => (price && specs.watts ? price / specs.watts : null),
};
const DRY_RUN = has('dry-run');
const TODAY = new Date().toISOString().slice(0, 10);
const BATCH_ID = arg('batch', `newegg-${CATEGORY.toLowerCase()}-${TODAY}`);
const REPORT_PATH = path.join(ROOT, 'catalog-build', `apply-${CATEGORY.toLowerCase()}-${DRY_RUN ? 'dry' : 'live'}.json`);

const log = (m) => console.log(`[${new Date().toISOString().substring(11, 19)}] ${m}`);

// Categories HELD for bench/cpuMark backfill; everything else goes live.
const HELD = new Set(['CPU', 'GPU']);

const FIELD_ORDER = [
  'sku', 'product_name', 'newegg_item_number', 'primary_category',
  'secondary_categories', 'product_url', 'image_url', 'is_deleted',
  'short_description', 'long_description', 'discount', 'discount_type',
  'sale_price', 'retail_price', 'begin_date', 'end_date',
  'manufacturer', 'shipping', 'keywords', 'mpn',
  'brand2', 'is_product_link', 'availability', 'upc',
  'class_id', 'currency', 'buy_url', 'pixel_tag',
  'attr_1', 'attr_2', 'attr_3', 'attr_4', 'attr_5', 'attr_6', 'attr_7', 'attr_8', 'attr_9', 'attr_10',
];
const LEAF_MATCH = {
  RAM: (s) => /~~memory~~ram$/.test(s),
  PSU: (s) => /~~computer power supplies\b/.test(s),
  Motherboard: (s) => /~~motherboards$/.test(s),
  CPU: (s) => /~~computer processors$/.test(s),
  Case: (s) => /~~desktop computer & server cases\b/.test(s),
  GPU: (s) => /~~video cards & adapters\b/.test(s),
  Storage: (s) => /~~storage devices(~~(hard drives|solid state\w*))?$/.test(s),
  Monitor: (s) => /video~~computer monitors$/.test(s),
};
const SPEC_BAR = {
  RAM: (sp) => sp.cap != null && sp.speed != null && sp.memType != null,
  PSU: (sp) => sp.watts != null,
  Storage: (sp) => sp.cap != null && sp.storageType != null,
};
const PREBUILT_RE = /\b(Custom|Workstation|Desktop PC|Pre.?built|Gaming PC|Gaming Desktop|Barebone|Bundle|Combo)\b/i;

// Per-category "wrong class for a consumer/gaming build" rejects — the same class
// of problem as wrong-category junk. For RAM the scope gate is CC.ramRejectReason
// (SINGLE SOURCE in catalog-classify.cjs): it rejects laptop (SODIMM/260-262-pin/
// "laptop"/"notebook"), server (RDIMM/R-DIMM/LRDIMM/LR-DIMM/registered/buffered)
// AND all ECC — consumer unbuffered ECC UDIMM is now OUT of scope too (2026-07-27
// audit). It gates primarily on the computed formFactor/ecc, with a name backstop.
// NOTE for later per-category gates: this enterprise/server split recurs —
// Storage (enterprise SAS drives), PSU (redundant/hot-swap server supplies),
// Cooling (rackmount/redundant fans). Add an analogous reject when those run.
const CATEGORY_REJECT = {
  RAM: (name) => CC.ramRejectReason(name),
  PSU: (name) => CC.psuRejectReason(name),   // UPS / battery-backup is not a PSU
};
const detectCondition = (n) => {
  const N = (n || '').toUpperCase();
  if (/\bOPEN[\s-]?BOX\b/.test(N)) return 'openbox';
  if (/\bREFURB(?:ISHED)?\b|\bRENEWED\b|\bRECERTIFIED\b/.test(N)) return 'refurb';
  if (/\bUSED\b|\bPRE[\s-]?OWNED\b/.test(N)) return 'used';
  return 'new';
};
const normUPC = (u) => String(u || '').replace(/\D/g, '').replace(/^0+/, '');
const normMPN = (m) => { const c = String(m || '').toUpperCase().replace(/[\s\-_/]/g, ''); return (c.length < 5 || /^\d+$/.test(c)) ? '' : c; };

// Build the catalog insert row in the approved shape. Specs from extractSpecs
// (spread top-level), plus category-specific derived flags.
function buildRow(rec, id, NEG) {
  const name = rec.product_name || '';
  const specs = CC.extractSpecs(name, CATEGORY);
  const priceRetail = parseFloat(rec.retail_price) || null;
  const priceSale = parseFloat(rec.sale_price) || null;
  const pr = priceSale && priceSale > 0 ? priceSale : priceRetail;
  const brand = CC.resolveDiscoveryBrand(name, rec.manufacturer || rec.brand2, CATEGORY);
  const itemNumber = rec.newegg_item_number || rec.sku;

  const row = {
    id, c: CATEGORY, n: name, b: brand,
    pr, msrp: priceRetail || pr,
    img: rec.image_url || null,
    r: null,
    ...specs,                        // cap, sticks, speed, cl, memType, watts, …
    deals: {
      newegg: {
        sku: rec.sku, itemNumber,
        sellerClass: NEG.sellerClass(itemNumber),
        price: priceRetail, saleprice: priceSale && priceSale > 0 ? priceSale : null,
        linkurl: rec.product_url || rec.buy_url, imageurl: rec.image_url || undefined,
        matchedAt: TODAY, matchMethod: 'discovery', matchScore: 1.0,
      },
    },
    needsReview: HELD.has(CATEGORY),   // CPU/GPU held; others live
    upc: rec.upc || undefined,
    mpn: rec.mpn || undefined,
    source: 'newegg-discovery',
    discoveredAt: TODAY,
    batchId: BATCH_ID,
  };
  if (CATEGORY === 'RAM') {
    row.ramType = specs.memType;
    const a = CC.ramAttributes(name);   // ecc (all negation forms), rgb, formFactor
    row.ecc = a.ecc; row.rgb = a.rgb; row.formFactor = a.formFactor;
  }
  return row;
}

(async () => {
  if (!FTP_PASS) throw new Error('RAKUTEN_FTP_PASSWORD required');
  const leaf = LEAF_MATCH[CATEGORY], bar = SPEC_BAR[CATEGORY];
  if (!leaf || !bar) throw new Error(`Category ${CATEGORY} not configured`);
  const NEG = await import('file://' + ROOT.replace(/\\/g, '/') + '/newegg-match.js');
  const CAP = await import('file://' + ROOT.replace(/\\/g, '/') + '/normalize-product-name.js');

  log(`Apply ${CATEGORY}  (${DRY_RUN ? 'DRY RUN' : 'LIVE WRITE'})  limit=${LIMIT || '∞'}  batch=${BATCH_ID}`);
  const partsMod = await import('file://' + PARTS_PATH.replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = [...partsMod.PARTS];
  const loadedCount = parts.length;
  const existingIds = new Set(parts.map((p) => p.id));
  let nextId = Math.max(...parts.map((p) => p.id || 0)) + 1;
  const allocId = () => { while (existingIds.has(nextId)) nextId++; existingIds.add(nextId); return nextId++; };

  const byUPC = new Map(), byMPN = new Map();
  const oursByCap = new Map();
  for (const p of parts) {
    if (p.bundle) continue;
    const u = normUPC(p.upc); if (u) byUPC.set(u, p);
    const m = normMPN(p.mpn); if (m) byMPN.set(m, p);
    if (p.c === CATEGORY) {
      const cap = p.cap != null ? p.cap : CAP.parseCapacityGB(p.n);
      const k = cap == null ? 'na' : String(cap);
      if (!oursByCap.has(k)) oursByCap.set(k, []);
      oursByCap.get(k).push(p);
    }
  }

  const catReject = CATEGORY_REJECT[CATEGORY] || (() => null);
  const stat = { leaf: 0, deletedOOS: 0, marketplace: 0, accessory: 0, prebuilt: 0, bundle: 0, condition: 0, categoryReject: 0,
    dedupeCatalog: { upc: 0, mpn: 0, name: 0 }, dedupeBatch: { upc: 0, mpn: 0 }, specBar: 0, survivors: 0 };
  const seenUpc = new Set(), seenMpn = new Set();
  // Collect ALL passing records (whole feed, no early stop), then sample ACROSS
  // the pool — feed order is by item number (oldest first), so stopping at the
  // first N front-loaded legacy DDR3/OEM modules. Streaming all then striding
  // gives a representative mix (incl. the modern DDR5 kits later in the feed).
  const survivorRecs = [];

  const sftp = new SftpClient();
  try {
    await sftp.connect({ host: FTP_HOST, port: 22, username: FTP_USER, password: FTP_PASS });
    const root = await sftp.list('/');
    const target = root.find((e) => e.type === '-' && /^44583_\d+_mp\.txt\.gz$/i.test(e.name));
    if (!target) throw new Error('Newegg _mp feed not found');
    log(`Streaming ${target.name} (${(target.size / 1048576).toFixed(0)}MB)…`);
    const gunzip = zlib.createGunzip();
    const rs = sftp.createReadStream('/' + target.name);
    rs.pipe(gunzip);
    const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });

    await new Promise((resolve, reject) => {
      let done = false;
      const stop = () => { if (done) return; done = true; try { rl.close(); } catch {} try { rs.destroy(); } catch {} resolve(); };
      rs.on('error', reject); gunzip.on('error', reject);
      rl.on('line', (line) => {
        if (done || !line || line.startsWith('HDR|') || line.startsWith('TRL|')) return;
        const f = line.split('|'); const rec = {};
        for (let i = 0; i < FIELD_ORDER.length; i++) rec[FIELD_ORDER[i]] = (f[i] || '').trim();

        if (!leaf((rec.secondary_categories || '').toLowerCase())) return;
        stat.leaf++;
        const name = rec.product_name || '';
        if (/^(1|true|yes|deleted)$/i.test(rec.is_deleted || '') || /out-of-stock|unavailable|no/i.test(rec.availability || '')) { stat.deletedOOS++; return; }
        if (NEG.sellerClass(rec.newegg_item_number || rec.sku) !== 'official') { stat.marketplace++; return; }
        if (CC.notBuildableReason(name)) { stat.accessory++; return; }
        if (PREBUILT_RE.test(name)) { stat.prebuilt++; return; }
        if (CC.bundleReason(name)) { stat.bundle = (stat.bundle || 0) + 1; return; }   // CPU+mobo combos etc.
        if (detectCondition(name) !== 'new') { stat.condition++; return; }
        if (catReject(name)) { stat.categoryReject++; return; }   // server/enterprise class

        // dedupe vs catalog: UPC -> MPN -> name(variant-guarded)
        const u = normUPC(rec.upc), m = normMPN(rec.mpn);
        if (u && byUPC.has(u)) { stat.dedupeCatalog.upc++; return; }
        if (m && byMPN.has(m)) { stat.dedupeCatalog.mpn++; return; }
        const cap = CAP.parseCapacityGB(name);
        for (const p of (oursByCap.get(cap == null ? 'na' : String(cap)) || [])) {
          if (NEG.scoreMatch(p, { name, upc: rec.upc, price: parseFloat(rec.retail_price) || null }, {}, { minSim: 0.7 })) { stat.dedupeCatalog.name++; return; }
        }
        // dedupe intra-batch: UPC -> MPN (never by name — variants share titles)
        if (u && seenUpc.has(u)) { stat.dedupeBatch.upc++; return; }
        if (m && seenMpn.has(m)) { stat.dedupeBatch.mpn++; return; }

        // min-viable-spec bar
        const specs = CC.extractSpecs(name, CATEGORY);
        if (!bar(specs)) { stat.specBar++; return; }

        if (u) seenUpc.add(u); if (m) seenMpn.add(m);
        survivorRecs.push(rec);
      });
      rl.on('close', stop);
    });
  } finally { try { await sftp.end(); } catch {} }

  stat.survivors = survivorRecs.length;

  // ── Price-plausibility floor ────────────────────────────────────────────────
  // Compute $/unit for every survivor, take the median, drop anything above
  // PRICE_MULT × median. All survivors are past the spec bar, so the unit spec
  // (cap/watts) is present and $/unit is always computable.
  const priceOf = (rec) => { const s = parseFloat(rec.sale_price); const r2 = parseFloat(rec.retail_price); return s > 0 ? s : r2; };
  const unitFn = PRICE_UNIT[CATEGORY];
  let pooled = survivorRecs;

  // ── Absolute price GATE — validatePriceBatch (floor AND ceiling) ─────────────
  // Anchored to real market, so it catches a systematically inflated feed the
  // median-relative floor below cannot. Fresh-discovery policy (2026-07-27): a
  // row that misses the real-market band is QUARANTINED — inserted needsReview:
  // true + quarantinedAt (held, hidden until a human clears it), NEVER silently
  // dropped and NEVER published. Runs BEFORE the relative floor; both apply to
  // the live-eligible pool. validatePriceBatch also emits the loud stale-ceiling /
  // table-age warnings (non-fatal). See priceValidate in normalize-product-name.js.
  const gate = CAP.validatePriceBatch(
    pooled.map((rec) => ({ category: CATEGORY, specs: CC.extractSpecs(rec.product_name, CATEGORY), price: priceOf(rec), rec })),
    { today: TODAY },
  );
  const quarantinedRecs = gate.quarantined.map((e) => ({ rec: e.row.rec, verdict: e.verdict }));
  const ceilInfo = {
    applied: true,
    quarantined: gate.quarantined.length,
    failureRate: gate.failureRate,
    calibratedAt: gate.calibratedAt,
    ceilAgeDays: gate.ceilingAgeDays,
    warnings: gate.warnings,
    samples: quarantinedRecs.slice(0, 20).map(({ rec, verdict }) => ({
      name: rec.product_name.slice(0, 70), ppu: verdict.ppu, reason: verdict.reason,
      floor: verdict.floor, ceiling: verdict.ceiling, unit: verdict.unit, key: verdict.key,
    })),
  };
  // Live-eligible pool = ok + skipped (unguarded categories / $/unit not computable
  // admit through — fail-open on missing data). Quarantined rows leave the pool.
  pooled = [...gate.ok, ...gate.skipped].map((e) => e.row.rec);

  // ── Relative price-plausibility floor (ADDITIONAL intra-pool outlier check) ──
  let floorInfo = { applied: false, median: null, threshold: null, dropped: 0, unit: null };
  if (PRICE_MULT > 0 && unitFn) {
    const withPpu = pooled.map((rec) => ({ rec, ppu: unitFn(CC.extractSpecs(rec.product_name, CATEGORY), priceOf(rec)) }));
    const vals = withPpu.map((x) => x.ppu).filter((v) => v != null && v > 0).sort((a, b) => a - b);
    const median = vals.length ? vals[Math.floor(vals.length / 2)] : null;
    if (median != null) {
      const pct = (q) => Number(vals[Math.min(vals.length - 1, Math.floor(vals.length * q))].toFixed(2));
      const threshold = median * PRICE_MULT;
      const dropped = withPpu.filter((x) => x.ppu != null && x.ppu > threshold);
      pooled = withPpu.filter((x) => x.ppu == null || x.ppu <= threshold).map((x) => x.rec);
      floorInfo = {
        applied: true, unit: CATEGORY === 'PSU' ? '$/W' : '$/GB',
        median: Number(median.toFixed(3)), threshold: Number(threshold.toFixed(3)), mult: PRICE_MULT,
        distribution: { p50: pct(0.50), p75: pct(0.75), p90: pct(0.90), p95: pct(0.95), p99: pct(0.99), max: pct(1) },
        // What each candidate multiplier would drop, so the choice is on evidence.
        droppedAt: [2.5, 3, 4, 5].reduce((o, mm) => (o[mm] = withPpu.filter((x) => x.ppu != null && x.ppu > median * mm).length, o), {}),
        dropped: dropped.length,
        droppedSamples: dropped.slice(0, 20).map((x) => ({ name: x.rec.product_name.slice(0, 70), ppu: Number(x.ppu.toFixed(2)), price: priceOf(x.rec) })),
      };
    }
  }

  // Sample ACROSS the pool: pick LIMIT items at an even stride so the batch spans
  // the whole feed (old → new), not just the front. Deterministic (no RNG).
  const strideSample = (arr, k) => {
    if (!k || k >= arr.length) return arr;
    const out = []; const step = arr.length / k;
    for (let i = 0; i < k; i++) out.push(arr[Math.floor(i * step)]);
    return out;
  };
  const selected = strideSample(pooled, LIMIT);
  const liveRows = selected.map((rec) => buildRow(rec, allocId(), NEG));
  // Quarantined discoveries: inserted HELD, and NEVER sampled away — the safety
  // net must not silently drop rows. Stamped with the same needsReview/quarantinedAt
  // convention the rest of the catalog uses, plus the failing price verdict.
  const quarantineRows = quarantinedRecs.map(({ rec, verdict }) => {
    const r = buildRow(rec, allocId(), NEG);
    r.needsReview = true;
    r.quarantinedAt = TODAY;
    r.priceQuarantine = { reason: verdict.reason, ppu: verdict.ppu, unit: verdict.unit, floor: verdict.floor, ceiling: verdict.ceiling };
    return r;
  });
  const rows = [...liveRows, ...quarantineRows];

  // Report
  const poolAfterFloor = pooled.length;
  const report = {
    generatedAt: new Date().toISOString(), category: CATEGORY, batchId: BATCH_ID,
    dryRun: DRY_RUN, limit: LIMIT || null,
    catalogBefore: loadedCount, catalogAfter: DRY_RUN ? loadedCount : loadedCount + rows.length,
    funnel: stat, totalSurvivors: stat.survivors,
    priceGate: ceilInfo, priceFloor: floorInfo,
    survivorsAfterFloor: poolAfterFloor, sampledAcrossPool: LIMIT && LIMIT < poolAfterFloor,
    insertedCount: rows.length, insertedLive: liveRows.length, insertedQuarantined: quarantineRows.length,
    insertedRows: rows,
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  log(`\nFunnel: leaf ${stat.leaf} | mkt ${stat.marketplace} | acc ${stat.accessory} | prebuilt ${stat.prebuilt} | bundle ${stat.bundle} | cond ${stat.condition} | serverEcc ${stat.categoryReject} | dedupCat ${stat.dedupeCatalog.upc + stat.dedupeCatalog.mpn + stat.dedupeCatalog.name} | dedupBatch ${stat.dedupeBatch.upc + stat.dedupeBatch.mpn} | specBar ${stat.specBar}`);
  log(`Distinct survivors: ${stat.survivors}`);
  if (ceilInfo.applied) log(`Price gate (absolute table, calibrated ${ceilInfo.calibratedAt}): quarantined ${ceilInfo.quarantined} (needsReview, held), failureRate ${(ceilInfo.failureRate * 100).toFixed(1)}%`);
  for (const w of ceilInfo.warnings || []) log(`  !! ${w}`);
  if (floorInfo.applied) log(`Price floor (${floorInfo.unit}): median ${floorInfo.median}, threshold ${floorInfo.mult}x = ${floorInfo.threshold} -> dropped ${floorInfo.dropped}, pool ${poolAfterFloor}`);
  log(`Selected this run: ${liveRows.length} live${quarantineRows.length ? ` + ${quarantineRows.length} quarantined (held)` : ''}${LIMIT && LIMIT < poolAfterFloor ? ' (live strided across pool)' : ''}`);

  if (DRY_RUN) {
    log(`DRY RUN — nothing written. Report: ${path.relative(ROOT, REPORT_PATH)}`);
    return;
  }
  if (rows.length === 0) { log('No rows to insert — not writing.'); return; }
  parts.push(...rows);
  await writeCatalog(parts, { loadedCount, reason: `newegg discovery ${CATEGORY} (${rows.length} of ${stat.survivors}, batch ${BATCH_ID})` });
  log(`\nWROTE ${rows.length} ${CATEGORY} rows (${liveRows.length} live, ${quarantineRows.length} held/needsReview). Catalog ${loadedCount} -> ${parts.length}. Report: ${path.relative(ROOT, REPORT_PATH)}`);
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
