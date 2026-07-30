#!/usr/bin/env node
/**
 * discover-newegg-dry.cjs — Phase 2.1 DISCOVERY DRY RUN (read-only).
 *
 * Streams the Newegg product-catalog feed, filters to ONE category via the
 * secondary_categories leaf, runs the full discovery gate stack, dedupes against
 * the existing catalog, and reports survivors + per-gate rejection counts.
 *
 * WRITES NOTHING to the catalog. Emits only a report JSON. This is the sizing +
 * quality-review step before any discovery write is designed.
 *
 * Gate stack (in order):
 *   1. secondary_categories leaf == category           (filter)
 *   2. in-stock, not deleted                            (feed hygiene)
 *   3. first-party only (N82E / 2AM- ; reject 9SI)      (seller)
 *   4. not an accessory                                 (catalog-classify.notBuildableReason)
 *   5. not a prebuilt / bundle / combo                  (title guard)
 *   6. new condition only (reject Open Box/refurb/used) (condition)
 *   7. dedupe vs catalog: UPC -> MPN -> name+capacity   (already-have)
 *   8. min-viable-spec bar (per category)               (filterable/buildable)
 *   -> survivor (would insert as needsReview:true at apply time)
 *
 * Usage:
 *   node discover-newegg-dry.cjs --category=RAM --sample=60
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const SftpClient = require('ssh2-sftp-client');
const CC = require('./catalog-classify.cjs');

const ROOT = __dirname;
const PARTS_PATH = path.join(ROOT, 'src', 'data', 'parts.js');

const FTP_HOST = process.env.RAKUTEN_FTP_HOST || 'aftp.linksynergy.com';
const FTP_USER = process.env.RAKUTEN_FTP_USER || 'rkp_4681679';
const FTP_PASS = process.env.RAKUTEN_FTP_PASSWORD;

const argv = process.argv.slice(2);
const arg = (k, d) => { const h = argv.find(a => a.startsWith('--' + k + '=')); return h ? h.split('=')[1] : d; };
const CATEGORY = arg('category', 'RAM');
const SAMPLE_N = parseInt(arg('sample', '60'), 10);
const REPORT_PATH = path.join(ROOT, 'catalog-build', `discover-${CATEGORY.toLowerCase()}-dry.json`);

const log = (m) => console.log(`[${new Date().toISOString().substring(11, 19)}] ${m}`);

// Same positional layout the ingest uses (Rakuten Product Catalog, 38 fields).
const FIELD_ORDER = [
  'sku', 'product_name', 'newegg_item_number', 'primary_category',
  'secondary_categories', 'product_url', 'image_url', 'is_deleted',
  'short_description', 'long_description', 'discount', 'discount_type',
  'sale_price', 'retail_price', 'begin_date', 'end_date',
  'manufacturer', 'shipping', 'keywords', 'mpn',
  'brand2', 'is_product_link', 'availability', 'upc',
  'class_id', 'currency', 'buy_url', 'pixel_tag',
  'attr_1', 'attr_2', 'attr_3', 'attr_4',
  'attr_5', 'attr_6', 'attr_7', 'attr_8', 'attr_9', 'attr_10',
];

// secondary_categories leaf → is this our category?
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

// Minimum viable specs per category (title-derived via catalog-classify).
// A product that can't meet this can't be filtered or used in the builder.
const SPEC_BAR = {
  RAM: (sp) => ({ ok: sp.cap != null && sp.speed != null && sp.memType != null,
                  need: 'cap+speed+memType', got: `cap=${sp.cap} speed=${sp.speed} type=${sp.memType}` }),
  PSU: (sp) => ({ ok: sp.watts != null, need: 'watts', got: `watts=${sp.watts}` }),
  Storage: (sp) => ({ ok: sp.cap != null && sp.storageType != null, need: 'cap+type', got: `cap=${sp.cap} type=${sp.storageType}` }),
};

const PREBUILT_RE = /\b(Custom|Workstation|Desktop PC|Pre.?built|Gaming PC|Gaming Desktop|Barebone|Bundle|Combo)\b/i;

// Per-category scope reject — "wrong class for a consumer/gaming desktop build".
// The SAME single-source gates the apply path uses (catalog-classify.cjs), so the
// dry-run funnel matches what apply will actually admit. Storage: enterprise SAS /
// U.2-U.3-EDSFF / hot-swap and external USB drives, plus whole NAS appliances.
// PSU: UPS / battery-backup / redundant server supplies. RAM: laptop/server/ECC.
const CATEGORY_REJECT = {
  RAM: (name) => CC.ramRejectReason(name),
  PSU: (name) => CC.psuRejectReason(name),
  Storage: (name) => CC.storageRejectReason(name),
};

function detectCondition(name) {
  const N = (name || '').toUpperCase();
  if (/\bOPEN[\s-]?BOX\b/.test(N)) return 'openbox';
  if (/\bREFURB(?:ISHED)?\b|\bRENEWED\b|\bRECERTIFIED\b/.test(N)) return 'refurb';
  if (/\bUSED\b|\bPRE[\s-]?OWNED\b/.test(N)) return 'used';
  return 'new';
}
const normUPC = (u) => String(u || '').replace(/\D/g, '').replace(/^0+/, '');
const normMPN = (m) => { const c = String(m || '').toUpperCase().replace(/[\s\-_/]/g, ''); return (c.length < 5 || /^\d+$/.test(c)) ? '' : c; };

(async () => {
  if (!FTP_PASS) throw new Error('RAKUTEN_FTP_PASSWORD required');
  const NEG = await import('file://' + ROOT.replace(/\\/g, '/') + '/newegg-match.js');
  const CAP = await import('file://' + ROOT.replace(/\\/g, '/') + '/normalize-product-name.js');
  const leaf = LEAF_MATCH[CATEGORY];
  const specBar = SPEC_BAR[CATEGORY];
  if (!leaf || !specBar) throw new Error(`Category ${CATEGORY} not configured (leaf/specBar)`);

  log(`Discovery dry run: ${CATEGORY}`);
  const partsMod = await import('file://' + PARTS_PATH.replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = partsMod.PARTS;
  const ours = parts.filter((p) => p.c === CATEGORY && !p.bundle);
  const oursActive = ours.filter((p) => !p.needsReview);
  // Dedupe index over the WHOLE catalog (a Newegg product might already live in
  // another category row too, but capacity/name dedupe is scoped to our cat).
  const byUPC = new Map(), byMPN = new Map();
  for (const p of parts) {
    if (p.bundle) continue;
    const u = normUPC(p.upc); if (u) byUPC.set(u, p);
    const m = normMPN(p.mpn); if (m) byMPN.set(m, p);
  }
  // Existing products of this category, bucketed by capacity for cheap name dedupe.
  const oursByCap = new Map();
  for (const p of ours) {
    const cap = p.cap != null ? p.cap : CAP.parseCapacityGB(p.n);
    const key = cap == null ? 'na' : String(cap);
    if (!oursByCap.has(key)) oursByCap.set(key, []);
    oursByCap.get(key).push(p);
  }
  log(`Catalog: ${ours.length} ${CATEGORY} rows (${oursActive.length} active), ${byUPC.size} UPC / ${byMPN.size} MPN indexed`);

  const stat = {
    feedRecords: 0, leafMatched: 0,
    rej: { deletedOOS: 0, marketplace: 0, accessory: 0, prebuilt: 0, condition: 0, scope: 0, specBar: 0 },
    scopeReasons: {},
    dedupe: { upc: 0, mpn: 0, name: 0 },
    survivors: 0,
  };
  const accessoryReasons = {};
  const specBarSamples = [];
  const survivorList = [];        // distinct survivors
  const seenSurvivor = new Set();  // intra-batch dedupe key

  const sftp = new SftpClient();
  try {
    await sftp.connect({ host: FTP_HOST, port: 22, username: FTP_USER, password: FTP_PASS });
    const root = await sftp.list('/');
    const target = root.find((e) => e.type === '-' && /^44583_\d+_mp\.txt\.gz$/i.test(e.name));
    if (!target) throw new Error('Newegg _mp feed not found at SFTP root');
    log(`Streaming ${target.name} (${(target.size / 1048576).toFixed(0)}MB)…`);

    const gunzip = zlib.createGunzip();
    const rs = sftp.createReadStream('/' + target.name);
    rs.pipe(gunzip);
    const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });

    await new Promise((resolve, reject) => {
      rs.on('error', reject); gunzip.on('error', reject);
      rl.on('line', (line) => {
        if (!line || line.startsWith('HDR|') || line.startsWith('TRL|')) return;
        stat.feedRecords++;
        if (stat.feedRecords % 200000 === 0) log(`  …${stat.feedRecords} records, ${stat.survivors} survivors so far`);
        const f = line.split('|');
        const rec = {}; for (let i = 0; i < FIELD_ORDER.length; i++) rec[FIELD_ORDER[i]] = (f[i] || '').trim();

        // 1. category leaf
        if (!leaf((rec.secondary_categories || '').toLowerCase())) return;
        stat.leafMatched++;
        const name = rec.product_name || '';
        // 2. feed hygiene
        if (/^(1|true|yes|deleted)$/i.test(rec.is_deleted || '') || /out-of-stock|unavailable|no/i.test(rec.availability || '')) { stat.rej.deletedOOS++; return; }
        // 3. first-party only
        const sClass = NEG.sellerClass(rec.newegg_item_number || rec.sku);
        if (sClass !== 'official') { stat.rej.marketplace++; return; }
        // 4. accessory
        const acc = CC.notBuildableReason(name);
        if (acc) { stat.rej.accessory++; accessoryReasons[acc] = (accessoryReasons[acc] || 0) + 1; return; }
        // 5. prebuilt/bundle
        if (PREBUILT_RE.test(name)) { stat.rej.prebuilt++; return; }
        if (CC.bundleReason(name)) { stat.rej.bundle = (stat.rej.bundle || 0) + 1; return; }   // multi-component combo
        // 6. condition
        if (detectCondition(name) !== 'new') { stat.rej.condition++; return; }
        // 6b. category scope (enterprise/external/server out of scope for a build)
        const scopeReject = CATEGORY_REJECT[CATEGORY];
        if (scopeReject) {
          const why = scopeReject(name);
          if (why) { stat.rej.scope = (stat.rej.scope || 0) + 1; (stat.scopeReasons || (stat.scopeReasons = {}))[why] = (stat.scopeReasons[why] || 0) + 1; return; }
        }

        // 7. dedupe vs catalog
        const u = normUPC(rec.upc), m = normMPN(rec.mpn);
        if (u && byUPC.has(u)) { stat.dedupe.upc++; return; }
        if (m && byMPN.has(m)) { stat.dedupe.mpn++; return; }
        const cap = CAP.parseCapacityGB(name);
        const bucket = oursByCap.get(cap == null ? 'na' : String(cap)) || [];
        let dupName = false;
        for (const p of bucket) {
          const mt = NEG.scoreMatch(p, { name, upc: rec.upc, price: parseFloat(rec.retail_price) || null }, {}, { minSim: 0.7 });
          if (mt) { dupName = true; break; }
        }
        if (dupName) { stat.dedupe.name++; return; }

        // 8. min-viable-spec bar
        const specs = CC.extractSpecs(name, CATEGORY);
        const bar = specBar(specs);
        if (!bar.ok) {
          stat.rej.specBar++;
          // Capture ALL spec-bar rejects (they are few) so the extractor can be
          // designed against every real Newegg title format, not a sample.
          if (specBarSamples.length < 1500) specBarSamples.push({ name, got: bar.got, mpn: rec.mpn });
          return;
        }

        // survivor — intra-batch distinct by UPC>MPN>name-key
        const dk = u || m || name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
        if (seenSurvivor.has(dk)) return;
        seenSurvivor.add(dk);
        stat.survivors++;
        survivorList.push({
          name, brand: rec.manufacturer || rec.brand2, sellerClass: sClass,
          itemNumber: rec.newegg_item_number, sku: rec.sku,
          retail: parseFloat(rec.retail_price) || null, sale: parseFloat(rec.sale_price) || null,
          upc: rec.upc, mpn: rec.mpn, url: rec.product_url, image: rec.image_url,
          specs,                                   // title-derived
          specBar: bar.got,
          detectedBrandKnown: CC.detectBrand(name, '') != null,
        });
      });
      rl.on('close', resolve);
    });
  } finally { try { await sftp.end(); } catch {} }

  // Report
  const report = {
    generatedAt: new Date().toISOString(), category: CATEGORY, dryRun: true, wrote: false,
    catalog: { rows: ours.length, active: oursActive.length },
    feedRecords: stat.feedRecords,
    leafMatched: stat.leafMatched,
    rejections: stat.rej,
    scopeReasons: stat.scopeReasons,
    dedupeHits: stat.dedupe,
    survivorsDistinct: stat.survivors,
    trueGap: stat.survivors,
    accessoryReasons,
    specBarRejectSamples: specBarSamples,
    survivorSample: survivorList.slice(0, SAMPLE_N),
    survivorCount: survivorList.length,
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  const r = stat.rej, d = stat.dedupe;
  log('\n══ DISCOVERY DRY RUN — NOTHING WRITTEN ══');
  log(`Category:            ${CATEGORY}`);
  log(`Feed records:        ${stat.feedRecords}`);
  log(`${CATEGORY} leaf matched:     ${stat.leafMatched}`);
  log(`  ✗ deleted/OOS:     ${r.deletedOOS}`);
  log(`  ✗ marketplace:     ${r.marketplace}`);
  log(`  ✗ accessory:       ${r.accessory}`);
  log(`  ✗ prebuilt/bundle: ${r.prebuilt}`);
  log(`  ✗ open-box/used:   ${r.condition}`);
  log(`  ✗ out-of-scope:    ${r.scope || 0}  ${JSON.stringify(stat.scopeReasons)}`);
  log(`  = dedupe (have):   ${d.upc + d.mpn + d.name}  (upc ${d.upc} / mpn ${d.mpn} / name ${d.name})`);
  log(`  ✗ below spec bar:  ${r.specBar}`);
  log(`  ✓ SURVIVORS:       ${stat.survivors}  (distinct)`);
  log(`\nTRUE GAP: ${stat.survivors} new ${CATEGORY} vs ${ours.length} we have (${oursActive.length} active)`);
  log(`Report: ${path.relative(ROOT, REPORT_PATH)}`);
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
