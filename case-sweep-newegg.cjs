#!/usr/bin/env node
/**
 * case-sweep-newegg.cjs — CASES ONLY. Phase-1 read-only Newegg feed sweep.
 *
 * WRITES NOTHING to the catalog. Streams the Rakuten/Newegg product-catalog feed,
 * captures EVERY case-category record, and dumps them to a report JSON for offline
 * gate attribution.
 *
 * Deliberately does NOT gate during the stream. discover-newegg-dry.cjs interleaves
 * gate rejects with catalog dedupe, so a row we already have is charged to a gate and
 * the reject table lies. Here the stream only classifies feed HYGIENE (deleted /
 * out-of-stock / seller class) and records the row; dedupe-vs-catalog and the gate
 * stack are computed by the Phase-2 analyzer against the full dump.
 *
 * Runs in GitHub Actions only (RAKUTEN_FTP_PASSWORD lives in repo secrets, not local).
 *
 * Usage: node case-sweep-newegg.cjs
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const SftpClient = require('ssh2-sftp-client');

const ROOT = __dirname;
const FTP_HOST = process.env.RAKUTEN_FTP_HOST || 'aftp.linksynergy.com';
const FTP_USER = process.env.RAKUTEN_FTP_USER || 'rkp_4681679';
const FTP_PASS = process.env.RAKUTEN_FTP_PASSWORD;
const NEWEGG_MID = process.env.RAKUTEN_NEWEGG_MID || '44583';
const REPORT_PATH = path.join(ROOT, 'catalog-build', 'case-sweep-newegg.json');

const log = (m) => console.log(`[${new Date().toISOString().substring(11, 19)}] ${m}`);

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

// The leaf discover-newegg-dry.cjs uses for Case. Kept as the PRIMARY, but the sweep
// also captures any category path containing "case(s)" so a case leaf we do not know
// about shows up as a discovery hole rather than staying invisible.
const CASE_LEAF = (s) => /~~desktop computer & server cases\b/.test(s);
const CASEISH = (s) => /\bcases?\b/.test(s) && !/~~(cases?, ?(bags|covers)|laptop bags)\b/.test(s);

(async () => {
  if (!FTP_PASS) throw new Error('RAKUTEN_FTP_PASSWORD required');
  const NEG = await import('file://' + ROOT.replace(/\\/g, '/') + '/newegg-match.js');

  const stat = { feedRecords: 0, caseLeaf: 0, caseish: 0, deleted: 0, oos: 0, kept: 0 };
  const leafTally = {};        // exact leaf string -> count (which leaves cases live under)
  const sellerTally = {};      // official | marketplace | unknown
  const rows = [];             // every in-stock, non-deleted case-leaf record

  const sftp = new SftpClient();
  try {
    await sftp.connect({ host: FTP_HOST, port: 22, username: FTP_USER, password: FTP_PASS });
    log(`Connected to ${FTP_HOST} as ${FTP_USER}`);

    // list('/') on this endpoint fails intermittently ("list: Failure /") even when the
    // connection is healthy — the nightly ingest tolerates it by catching and moving on.
    // Retry it, then fall back to stat()ing the known feed path directly: the file name
    // is deterministic (<MID>_<SID>_mp.txt.gz), so listing is a convenience, not a need.
    const SID = process.env.RAKUTEN_SID || '4681679';
    const DIRECT = `/${NEWEGG_MID}_${SID}_mp.txt.gz`;
    let target = null;
    for (let attempt = 1; attempt <= 3 && !target; attempt++) {
      try {
        const root = await sftp.list('/');
        target = root.find((e) => e.type === '-' && /^44583_\d+_mp\.txt\.gz$/i.test(e.name)) || null;
        if (!target) log(`  list('/') returned ${root.length} entries but no _mp feed`);
      } catch (e) {
        log(`  list('/') attempt ${attempt} failed: ${e.message}`);
        if (attempt < 3) await new Promise((r) => setTimeout(r, 4000 * attempt));
      }
    }
    if (!target) {
      log(`  falling back to direct path ${DIRECT}`);
      const st = await sftp.stat(DIRECT);      // throws if genuinely absent
      target = { name: DIRECT.slice(1), size: st.size };
    }
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
        if (stat.feedRecords % 200000 === 0) log(`  …${stat.feedRecords} records, ${stat.kept} cases kept`);
        const f = line.split('|');
        const rec = {}; for (let i = 0; i < FIELD_ORDER.length; i++) rec[FIELD_ORDER[i]] = (f[i] || '').trim();

        const secs = (rec.secondary_categories || '').toLowerCase();
        const isLeaf = CASE_LEAF(secs);
        const isCaseish = !isLeaf && CASEISH(secs);
        if (!isLeaf && !isCaseish) return;
        if (isLeaf) stat.caseLeaf++; else stat.caseish++;
        leafTally[secs.slice(0, 120)] = (leafTally[secs.slice(0, 120)] || 0) + 1;
        if (isCaseish) return;      // tallied for visibility only; not swept as a case

        // feed hygiene — the ONLY filtering this sweep does
        if (/^(1|true|yes|deleted)$/i.test(rec.is_deleted || '')) { stat.deleted++; return; }
        if (/out-of-stock|unavailable|^no$/i.test(rec.availability || '')) { stat.oos++; return; }

        const sClass = NEG.sellerClass(rec.newegg_item_number || rec.sku);
        sellerTally[sClass] = (sellerTally[sClass] || 0) + 1;

        stat.kept++;
        rows.push({
          name: rec.product_name || '',
          brand: rec.manufacturer || rec.brand2 || '',
          sellerClass: sClass,
          itemNumber: rec.newegg_item_number, sku: rec.sku,
          retail: parseFloat(rec.retail_price) || null,
          sale: parseFloat(rec.sale_price) || null,
          upc: rec.upc, mpn: rec.mpn,
          url: rec.product_url, image: rec.image_url,
          availability: rec.availability,
        });
      });
      rl.on('close', resolve);
    });
  } finally { try { await sftp.end(); } catch {} }

  const report = {
    generatedAt: new Date().toISOString(), source: 'newegg-feed', dryRun: true, wrote: false,
    stat, sellerTally,
    leafTally: Object.fromEntries(Object.entries(leafTally).sort((a, b) => b[1] - a[1]).slice(0, 40)),
    rows,
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  log('\n══ NEWEGG CASE SWEEP — NOTHING WRITTEN ══');
  log(`feed records:            ${stat.feedRecords}`);
  log(`case leaf matched:       ${stat.caseLeaf}`);
  log(`other "case"-ish leaves: ${stat.caseish}  (tallied only — see leafTally)`);
  log(`  ✗ deleted:             ${stat.deleted}`);
  log(`  ✗ out of stock:        ${stat.oos}`);
  log(`  ✓ buyable, in stock:   ${stat.kept}   ${JSON.stringify(sellerTally)}`);
  log(`Report: ${path.relative(ROOT, REPORT_PATH)} (${(fs.statSync(REPORT_PATH).size / 1048576).toFixed(1)}MB)`);
  log('\nTop case leaves:');
  for (const [k, v] of Object.entries(report.leafTally).slice(0, 12)) log(`  ${String(v).padStart(6)}  ${k}`);
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
