#!/usr/bin/env node
/**
 * feed-overlap-audit.cjs — READ-ONLY. Is the Newegg MKPL (marketplace) feed redundant
 * against the main `mp` feed?
 *
 * WRITES NOTHING except a report JSON. No catalog access at all.
 *
 * WHY THIS EXISTS: the nightly sftp-ingest spends ~34 of its 60 minutes pulling
 * mp_MKPL.txt.gz (886MB, 86% of all bytes) and then gets cancelled before committing
 * anything. Moving MKPL off the nightly is only safe if we know what it carries. The Case
 * sweep showed the `mp` feed ALREADY contains marketplace rows (631 official + 1,193
 * marketplace in the Case leaf), which suggests MKPL may be largely redundant — but that
 * was one category, and "suggests" is not a basis for moving a data source.
 *
 * METHOD: stream both feeds (no download, no record accumulation), keep only rows in the
 * categories we actually sell, and ask how many MKPL rows carry an identity that `mp` does
 * not. Identity is checked in the same precedence the ingest itself uses: Newegg item
 * number, then UPC, then MPN.
 *
 * MEMORY: only category-matched rows are retained, and only their identity keys — never
 * whole records. That is what keeps a 886MB feed inside the heap.
 *
 * Run (Actions only — RAKUTEN_FTP_PASSWORD is a repo secret):
 *   node feed-overlap-audit.cjs
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
const MID = process.env.RAKUTEN_NEWEGG_MID || '44583';
const SID = process.env.RAKUTEN_SID || '4681679';
const REPORT = path.join(ROOT, 'catalog-build', 'feed-overlap-audit.json');

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

// The same leaf matchers discover-newegg-dry.cjs uses, so this measures the categories we
// actually ingest rather than the whole 1M-row feed.
const LEAF_MATCH = {
  Case: (s) => /~~desktop computer & server cases\b/.test(s),
  GPU: (s) => /~~video cards & adapters\b/.test(s),
  CPU: (s) => /~~computer processors$/.test(s),
  Motherboard: (s) => /~~motherboards$/.test(s),
  RAM: (s) => /~~memory~~ram$/.test(s),
  PSU: (s) => /~~computer power supplies\b/.test(s),
  Storage: (s) => /~~storage devices(~~(hard drives|solid state\w*))?$/.test(s),
  Monitor: (s) => /video~~computer monitors$/.test(s),
  CPUCooler: (s) => /~~(cpu )?(fans? ?& ?heatsinks?|cooling)\b/.test(s),
};
const CATS = Object.keys(LEAF_MATCH);

const normUPC = (u) => String(u || '').replace(/\D/g, '').replace(/^0+/, '');
const normMPN = (m) => { const c = String(m || '').toUpperCase().replace(/[\s\-_/]/g, ''); return (c.length < 5 || /^\d+$/.test(c)) ? '' : c; };
const catOf = (secs) => { for (const c of CATS) if (LEAF_MATCH[c](secs)) return c; return null; };

// Stream one feed, invoking onRow(cat, rec) for category-matched, non-deleted rows.
async function streamFeed(sftp, remote, sizeMB, onRow) {
  log(`Streaming ${remote} (${sizeMB}MB)…`);
  const gunzip = zlib.createGunzip();
  const rs = sftp.createReadStream(remote);
  rs.pipe(gunzip);
  const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
  let total = 0, kept = 0;
  await new Promise((resolve, reject) => {
    rs.on('error', reject); gunzip.on('error', reject);
    rl.on('line', (line) => {
      if (!line || line.startsWith('HDR|') || line.startsWith('TRL|')) return;
      total++;
      if (total % 500000 === 0) log(`  …${total} records, ${kept} in-scope`);
      const f = line.split('|');
      // cheap pre-filter before building the record object
      const secs = (f[4] || '').toLowerCase();
      const cat = catOf(secs);
      if (!cat) return;
      if (/^(1|true|yes|deleted)$/i.test((f[7] || '').trim())) return;
      const rec = {};
      for (let i = 0; i < FIELD_ORDER.length; i++) rec[FIELD_ORDER[i]] = (f[i] || '').trim();
      kept++;
      onRow(cat, rec);
    });
    rl.on('close', resolve);
  });
  log(`  done: ${total} records, ${kept} in-scope`);
  return { total, kept };
}

(async () => {
  if (!FTP_PASS) throw new Error('RAKUTEN_FTP_PASSWORD required');
  const NEG = await import('file://' + ROOT.replace(/\\/g, '/') + '/newegg-match.js');

  const sftp = new SftpClient();
  const stat = { mp: null, mkpl: null };
  // per-category identity indexes from the mp feed
  const mpIdx = {};
  for (const c of CATS) mpIdx[c] = { item: new Set(), upc: new Set(), mpn: new Set(), n: 0, official: 0, marketplace: 0 };
  const out = {};
  for (const c of CATS) out[c] = { mkplRows: 0, official: 0, marketplace: 0,
    dupItem: 0, dupUPC: 0, dupMPN: 0, unique: 0, uniqueOfficial: 0, uniqueInStock: 0, samples: [] };

  try {
    await sftp.connect({ host: FTP_HOST, port: 22, username: FTP_USER, password: FTP_PASS });
    log(`Connected to ${FTP_HOST} as ${FTP_USER}`);

    const mpPath = `/${MID}_${SID}_mp.txt.gz`;
    const mkplPath = `/${MID}_${SID}_mp_MKPL.txt.gz`;
    const sz = async (p) => { try { return ((await sftp.stat(p)).size / 1048576).toFixed(0); } catch { return '?'; } };

    // PASS 1 — index the mp feed's identities
    stat.mp = await streamFeed(sftp, mpPath, await sz(mpPath), (cat, rec) => {
      const x = mpIdx[cat];
      x.n++;
      const cls = NEG.sellerClass(rec.newegg_item_number || rec.sku);
      if (cls === 'official') x.official++; else x.marketplace++;
      const it = String(rec.newegg_item_number || '').toUpperCase();
      if (it) x.item.add(it);
      const u = normUPC(rec.upc); if (u) x.upc.add(u);
      const m = normMPN(rec.mpn); if (m) x.mpn.add(m);
    });

    // PASS 2 — ask what MKPL carries that mp does not
    stat.mkpl = await streamFeed(sftp, mkplPath, await sz(mkplPath), (cat, rec) => {
      const x = mpIdx[cat], o = out[cat];
      o.mkplRows++;
      const cls = NEG.sellerClass(rec.newegg_item_number || rec.sku);
      if (cls === 'official') o.official++; else o.marketplace++;
      const it = String(rec.newegg_item_number || '').toUpperCase();
      const u = normUPC(rec.upc), m = normMPN(rec.mpn);
      if (it && x.item.has(it)) { o.dupItem++; return; }
      if (u && x.upc.has(u)) { o.dupUPC++; return; }
      if (m && x.mpn.has(m)) { o.dupMPN++; return; }
      o.unique++;
      if (cls === 'official') o.uniqueOfficial++;
      const inStock = /in-stock/i.test(rec.availability || '');
      if (inStock) o.uniqueInStock++;
      if (o.samples.length < 8) o.samples.push({
        name: (rec.product_name || '').slice(0, 88), seller: cls,
        item: rec.newegg_item_number, price: parseFloat(rec.sale_price) || parseFloat(rec.retail_price) || null,
        availability: rec.availability, upc: rec.upc, mpn: rec.mpn,
      });
    });
  } finally { try { await sftp.end(); } catch {} }

  const report = { generatedAt: new Date().toISOString(), readOnly: true, wroteCatalog: false, stat, perCategory: {} };
  for (const c of CATS) report.perCategory[c] = { mpRows: mpIdx[c].n, mpOfficial: mpIdx[c].official, mpMarketplace: mpIdx[c].marketplace, ...out[c] };
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));

  const pad = (s, n) => String(s).padStart(n);
  log('\n══ MKPL vs mp OVERLAP — NOTHING WRITTEN ══');
  console.log(`feed totals: mp ${stat.mp.total} records (${stat.mp.kept} in-scope) · MKPL ${stat.mkpl.total} records (${stat.mkpl.kept} in-scope)\n`);
  console.log(`${'category'.padEnd(12)} ${pad('mp', 7)} ${pad('MKPL', 7)} ${pad('dup:item', 9)} ${pad('dup:upc', 8)} ${pad('dup:mpn', 8)} ${pad('UNIQUE', 7)} ${pad('uniq 1P', 8)} ${pad('uniq inStk', 10)}`);
  let tU = 0, tM = 0;
  for (const c of CATS) {
    const r = report.perCategory[c];
    tU += r.unique; tM += r.mkplRows;
    console.log(`${c.padEnd(12)} ${pad(r.mpRows, 7)} ${pad(r.mkplRows, 7)} ${pad(r.dupItem, 9)} ${pad(r.dupUPC, 8)} ${pad(r.dupMPN, 8)} ${pad(r.unique, 7)} ${pad(r.uniqueOfficial, 8)} ${pad(r.uniqueInStock, 10)}`);
  }
  console.log(`\nTOTAL in-scope MKPL rows ${tM}; UNIQUE to MKPL ${tU} (${tM ? (tU / tM * 100).toFixed(1) : 0}%)`);
  console.log(`\nVERDICT INPUT: if UNIQUE is ~0 the nightly can drop MKPL outright; if it is material,`);
  console.log(`MKPL must be RESCHEDULED (its own workflow) rather than removed.`);
  for (const c of CATS) {
    const r = report.perCategory[c];
    if (!r.unique) continue;
    console.log(`\n── ${c}: ${r.unique} unique — samples`);
    for (const s of r.samples) console.log(`   [${s.seller}] $${String(s.price ?? '—').padStart(8)} ${s.availability}  ${s.name}`);
  }
  console.log(`\nReport: ${path.relative(ROOT, REPORT)}`);
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
