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
const detectCondition = (n) => {
  const N = (n || '').toUpperCase();
  if (/\bOPEN[\s-]?BOX\b/.test(N)) return 'openbox';
  if (/\bREFURB(?:ISHED)?\b|\bRENEWED\b|\bRECERTIFIED\b/.test(N)) return 'refurb';
  if (/\bUSED\b|\bPRE[\s-]?OWNED\b/.test(N)) return 'used';
  return 'new';
};
const normUPC = (u) => String(u || '').replace(/\D/g, '').replace(/^0+/, '');
const normMPN = (m) => { const c = String(m || '').toUpperCase().replace(/[\s\-_/]/g, ''); return (c.length < 5 || /^\d+$/.test(c)) ? '' : c; };
const cleanBrand = (s) => String(s || '').replace(/\b(technology|technologies|corp\.?|corporation|inc\.?|co\.?|ltd\.?|memory)\b/gi, '').replace(/\s+/g, ' ').trim();

// Build the catalog insert row in the approved shape. Specs from extractSpecs
// (spread top-level), plus category-specific derived flags.
function buildRow(rec, id, NEG) {
  const name = rec.product_name || '';
  const specs = CC.extractSpecs(name, CATEGORY);
  const priceRetail = parseFloat(rec.retail_price) || null;
  const priceSale = parseFloat(rec.sale_price) || null;
  const pr = priceSale && priceSale > 0 ? priceSale : priceRetail;
  const brand = CC.detectBrand(name, '') || cleanBrand(rec.manufacturer || rec.brand2) || null;
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
    row.ecc = /\becc\b|\brdimm\b|\blrdimm\b/i.test(name);
    row.rgb = /\brgb\b/i.test(name);
    row.formFactor = /so-?dimm/i.test(name) ? 'SODIMM' : /\blrdimm\b/i.test(name) ? 'LRDIMM' : /\brdimm\b/i.test(name) ? 'RDIMM' : 'UDIMM';
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

  const stat = { leaf: 0, deletedOOS: 0, marketplace: 0, accessory: 0, prebuilt: 0, condition: 0,
    dedupeCatalog: { upc: 0, mpn: 0, name: 0 }, dedupeBatch: { upc: 0, mpn: 0 }, specBar: 0, inserted: 0 };
  const seenUpc = new Set(), seenMpn = new Set();
  const rows = [];

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
        if (detectCondition(name) !== 'new') { stat.condition++; return; }

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
        rows.push(buildRow(rec, allocId(), NEG));
        stat.inserted++;
        if (LIMIT && rows.length >= LIMIT) stop();
      });
      rl.on('close', stop);
    });
  } finally { try { await sftp.end(); } catch {} }

  // Report
  const report = {
    generatedAt: new Date().toISOString(), category: CATEGORY, batchId: BATCH_ID,
    dryRun: DRY_RUN, limit: LIMIT || null,
    catalogBefore: loadedCount, catalogAfter: DRY_RUN ? loadedCount : loadedCount + rows.length,
    funnel: stat, insertedCount: rows.length, insertedRows: rows,
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  log(`\nFunnel: leaf ${stat.leaf} | mkt ${stat.marketplace} | acc ${stat.accessory} | prebuilt ${stat.prebuilt} | cond ${stat.condition} | dedupCat ${stat.dedupeCatalog.upc + stat.dedupeCatalog.mpn + stat.dedupeCatalog.name} | dedupBatch ${stat.dedupeBatch.upc + stat.dedupeBatch.mpn} | specBar ${stat.specBar}`);
  log(`Rows to insert: ${rows.length}`);

  if (DRY_RUN) {
    log(`DRY RUN — nothing written. Report: ${path.relative(ROOT, REPORT_PATH)}`);
    return;
  }
  if (rows.length === 0) { log('No rows to insert — not writing.'); return; }
  parts.push(...rows);
  await writeCatalog(parts, { loadedCount, reason: `newegg discovery ${CATEGORY} (${rows.length}, batch ${BATCH_ID})` });
  log(`\nWROTE ${rows.length} ${CATEGORY} rows. Catalog ${loadedCount} -> ${parts.length}. Report: ${path.relative(ROOT, REPORT_PATH)}`);
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
