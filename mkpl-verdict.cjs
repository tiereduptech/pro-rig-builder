#!/usr/bin/env node
/**
 * mkpl-verdict.cjs — READ-ONLY. Settle whether mp_MKPL.txt.gz earns its place.
 *
 * WRITES NOTHING except two report files under catalog-build/. No catalog access,
 * no state file, no commit. It cannot change a verdict; it only measures.
 *
 * WHY THIS EXISTS: the census (newegg-dead-sku-audit.cjs) refuses to condemn any
 * sku while a discovered feed goes unread, and mp_MKPL.txt.gz is excluded for being
 * 1,251 days stale (mtime 2023-03-16). That is the right rule — a sku carried only
 * by an excluded feed is indistinguishable from a dead one — but it means the
 * suppression holds until somebody resolves MKPL, and Rakuten's setup email
 * ("these files are updated daily") contradicts the mtime we can see. Rather than
 * wait on a support reply, measure the feed itself.
 *
 * THREE QUESTIONS, one pass over each feed:
 *
 *   Q1 REDUNDANCY — how many in-scope MKPL rows carry an identity `mp` does not?
 *      Identity in the ingest's own precedence: Newegg item number, then UPC, then
 *      MPN. Near-zero means MKPL is redundant and the nightly can drop it outright.
 *
 *   Q2 BLAST RADIUS — of the catalog's pending Newegg deals (absent from `mp`, so
 *      currently held at one strike), how many does MKPL actually carry? That set,
 *      and only that set, is what MKPL's exclusion is protecting. Matching uses the
 *      census's own rule: catalog sku OR itemNumber against feed sku OR
 *      newegg_item_number, uppercased and trimmed. NOT category-filtered — the
 *      census isn't either.
 *
 *   Q3 LIVENESS CANDIDATES — emit MKPL-only skus with a product_url so their
 *      Newegg pages can be spot-checked by hand. If they 404, MKPL is a 2023
 *      snapshot of dead inventory and excluding it was always correct.
 *      Deliberately NOT fetched here: a GitHub runner hitting newegg.com gets a
 *      bot-block, and a 403 answers nothing. This job emits the list; the fetch
 *      happens from a residential address.
 *
 * MEMORY: identity keys only, never whole records. Objects are built for the few
 * hundred rows that end up in a report, not for the ~1M rows that stream past.
 * That is what keeps an 886MB feed inside the heap.
 *
 * Run (Actions only — RAKUTEN_FTP_PASSWORD is a repo secret):
 *   node mkpl-verdict.cjs
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
const OUTDIR = path.join(ROOT, 'catalog-build');
const REPORT = path.join(OUTDIR, 'mkpl-verdict.json');
const CANDIDATES = path.join(OUTDIR, 'mkpl-spotcheck-candidates.json');

// How many MKPL-only skus to emit for the hand spot-check. 10 get checked; the
// surplus is so a few unusable urls don't force a second hour-long run.
const CANDIDATE_TARGET = 60;

const log = (m) => console.log(`[${new Date().toISOString().substring(11, 19)}] ${m}`);

// Pipe-delimited field order, same as the ingest and the overlap audit.
const F = {
  sku: 0, product_name: 1, newegg_item_number: 2, primary_category: 3,
  secondary_categories: 4, product_url: 5, is_deleted: 7,
  sale_price: 12, retail_price: 13, mpn: 19, availability: 22, upc: 23,
};

// The same leaf matchers discover-newegg-dry.cjs uses, so Q1 measures the
// categories we actually ingest rather than the whole 1M-row feed.
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
const nkey = (s) => String(s || '').trim().toUpperCase();   // census's key rule, verbatim
const catOf = (secs) => { for (const c of CATS) if (LEAF_MATCH[c](secs)) return c; return null; };
const isDeleted = (v) => /^(1|true|yes|deleted)$/i.test(String(v || '').trim());

// Census's sighting vocabulary, verbatim: being listed at all is proof the sku
// exists, which is the whole difference from absence.
const SIGHTING_RANK = { undefined: -1, null: -1, deleted: 1, unbuyable: 2, alive: 3 };
const classifySighting = (del, avail) => del ? 'deleted' : (/in-?stock/i.test(String(avail || '').trim()) ? 'alive' : 'unbuyable');

/** Stream one gzipped pipe feed straight off SFTP. onRow gets the raw split fields. */
async function streamFeed(sftp, remote, label, onRow) {
  let sizeMB = '?', mtime = null;
  try { const st = await sftp.stat(remote); sizeMB = (st.size / 1048576).toFixed(0); mtime = st.modifyTime; } catch {}
  const ageDays = mtime ? ((Date.now() - mtime) / 86400000).toFixed(0) : null;
  log(`Streaming ${label} ${remote} (${sizeMB}MB, mtime ${mtime ? new Date(mtime).toISOString().slice(0, 10) : '?'}, ${ageDays ?? '?'}d old)…`);
  const gunzip = zlib.createGunzip();
  const rs = sftp.createReadStream(remote);
  rs.pipe(gunzip);
  const rl = readline.createInterface({ input: gunzip, crlfDelay: Infinity });
  let total = 0;
  await new Promise((resolve, reject) => {
    rs.on('error', reject); gunzip.on('error', reject);
    rl.on('line', (line) => {
      if (!line || line.startsWith('HDR|') || line.startsWith('TRL|')) return;
      total++;
      if (total % 500000 === 0) log(`  …${total} records`);
      onRow(line.split('|'));
    });
    rl.on('close', resolve);
  });
  log(`  done: ${total} records`);
  return { remote, sizeMB: Number(sizeMB), mtime, mtimeISO: mtime ? new Date(mtime).toISOString() : null, ageDays: ageDays === null ? null : Number(ageDays), total };
}

(async () => {
  if (!FTP_PASS) throw new Error('RAKUTEN_FTP_PASSWORD required (repo secret; Actions only)');
  const NEG = await import('file://' + ROOT.replace(/\\/g, '/') + '/newegg-match.js');

  // ── Catalog targets — the census's scope, rebuilt here ────────────────────
  const mod = await import('file://' + path.join(ROOT, 'src', 'data', 'parts.js').replace(/\\/g, '/'));
  const parts = mod.PARTS || mod.default;
  if (!Array.isArray(parts)) throw new Error('parts.js did not export PARTS');

  const DEAL_KEYS = ['newegg', 'newegg_openbox', 'newegg_marketplace'];
  const rows = [];
  const wanted = new Map();   // feed key -> [row, ...]
  for (const p of parts) {
    for (const dk of DEAL_KEYS) {
      const d = p.deals && p.deals[dk];
      if (!d || typeof d !== 'object') continue;
      const sku = nkey(d.sku), item = nkey(d.itemNumber);
      if (!sku && !item) continue;
      const row = {
        id: p.id, name: p.n, cat: p.c, dealKey: dk, sku: sku || null, itemNumber: item || null,
        sellerClass: d.sellerClass || null,
        stored: (typeof d.saleprice === 'number' && d.saleprice > 0) ? d.saleprice
              : (typeof d.price === 'number' && d.price > 0) ? d.price : null,
        mp: null, mkpl: null, mkplRec: null,   // sighting in each feed
      };
      rows.push(row);
      for (const k of [sku, item]) {
        if (!k) continue;
        if (!wanted.has(k)) wanted.set(k, []);
        wanted.get(k).push(row);
      }
    }
  }
  log(`Catalog: ${parts.length} products → ${rows.length} Newegg deals → ${wanted.size} distinct feed keys`);

  // Record a sighting under the census's least-condemning-wins rule.
  const sight = (row, field, s) => { if (SIGHTING_RANK[s] > SIGHTING_RANK[row[field]]) row[field] = s; };

  const sftp = new SftpClient();
  const feedStat = {};
  const mpIdx = {};   // Q1: per-category identity index from mp
  for (const c of CATS) mpIdx[c] = { item: new Set(), upc: new Set(), mpn: new Set(), n: 0, official: 0, marketplace: 0 };
  const q1 = {};
  for (const c of CATS) q1[c] = { mkplRows: 0, official: 0, marketplace: 0, dupItem: 0, dupUPC: 0, dupMPN: 0, unique: 0, uniqueOfficial: 0, uniqueInStock: 0, samples: [] };
  const candidates = [];

  try {
    await sftp.connect({ host: FTP_HOST, port: 22, username: FTP_USER, password: FTP_PASS });
    log(`Connected to ${FTP_HOST} as ${FTP_USER}`);

    const mpPath = `/${MID}_${SID}_mp.txt.gz`;
    const mkplPath = `/${MID}_${SID}_mp_MKPL.txt.gz`;

    // ── PASS 1 — mp: index identities (Q1) and sight catalog skus (Q2) ──────
    let mpKept = 0;
    feedStat.mp = await streamFeed(sftp, mpPath, 'mp', (f) => {
      const del = isDeleted(f[F.is_deleted]);

      // Q2 — catalog sighting, every row, no category filter (census parity)
      const hitRows = wanted.get(nkey(f[F.sku])) || wanted.get(nkey(f[F.newegg_item_number]));
      if (hitRows) {
        const s = classifySighting(del, f[F.availability]);
        for (const row of hitRows) sight(row, 'mp', s);
      }

      // Q1 — identity index, in-scope non-deleted rows only
      if (del) return;
      const cat = catOf((f[F.secondary_categories] || '').toLowerCase());
      if (!cat) return;
      mpKept++;
      const x = mpIdx[cat];
      x.n++;
      if (NEG.sellerClass(f[F.newegg_item_number] || f[F.sku]) === 'official') x.official++; else x.marketplace++;
      const it = nkey(f[F.newegg_item_number]); if (it) x.item.add(it);
      const u = normUPC(f[F.upc]); if (u) x.upc.add(u);
      const m = normMPN(f[F.mpn]); if (m) x.mpn.add(m);
    });
    feedStat.mp.inScope = mpKept;

    // ── PASS 2 — MKPL: what does it carry that mp does not? ─────────────────
    let mkplKept = 0;
    feedStat.mkpl = await streamFeed(sftp, mkplPath, 'MKPL', (f) => {
      const del = isDeleted(f[F.is_deleted]);

      // Q2 — catalog sighting (keep the record for pendings MKPL rescues)
      const hitRows = wanted.get(nkey(f[F.sku])) || wanted.get(nkey(f[F.newegg_item_number]));
      if (hitRows) {
        const s = classifySighting(del, f[F.availability]);
        for (const row of hitRows) {
          const improves = SIGHTING_RANK[s] > SIGHTING_RANK[row.mkpl];
          sight(row, 'mkpl', s);
          if (improves) row.mkplRec = {
            item: f[F.newegg_item_number] || null, url: f[F.product_url] || null,
            availability: (f[F.availability] || '').trim() || null,
            price: parseFloat(f[F.sale_price]) || parseFloat(f[F.retail_price]) || null,
          };
        }
      }

      // Q1 — redundancy, in-scope non-deleted rows only
      if (del) return;
      const cat = catOf((f[F.secondary_categories] || '').toLowerCase());
      if (!cat) return;
      mkplKept++;
      const x = mpIdx[cat], o = q1[cat];
      o.mkplRows++;
      const cls = NEG.sellerClass(f[F.newegg_item_number] || f[F.sku]);
      if (cls === 'official') o.official++; else o.marketplace++;

      const it = nkey(f[F.newegg_item_number]);
      const u = normUPC(f[F.upc]), m = normMPN(f[F.mpn]);
      if (it && x.item.has(it)) { o.dupItem++; return; }
      if (u && x.upc.has(u)) { o.dupUPC++; return; }
      if (m && x.mpn.has(m)) { o.dupMPN++; return; }

      o.unique++;
      if (cls === 'official') o.uniqueOfficial++;
      const avail = (f[F.availability] || '').trim();
      const inStock = /in-?stock/i.test(avail);
      if (inStock) o.uniqueInStock++;
      const price = parseFloat(f[F.sale_price]) || parseFloat(f[F.retail_price]) || null;
      const name = (f[F.product_name] || '').slice(0, 88);
      if (o.samples.length < 8) o.samples.push({ name, seller: cls, item: f[F.newegg_item_number], price, availability: avail, upc: f[F.upc], mpn: f[F.mpn] });

      // Q3 — liveness candidates. Prefer rows that claim to be buyable: a
      // 2023 snapshot insisting "in-stock" is the sharpest thing to falsify.
      if (candidates.length < CANDIDATE_TARGET && f[F.product_url] && it) {
        candidates.push({ cat, item: it, seller: cls, name, price, availability: avail || null, inStock, url: f[F.product_url] });
      }
    });
    feedStat.mkpl.inScope = mkplKept;
  } finally { try { await sftp.end(); } catch {} }

  // ── Q2 roll-up ────────────────────────────────────────────────────────────
  // "pending" here = the census's population: a Newegg deal absent from mp. The
  // live census also holds strikes for other reasons, so this is the feed-side
  // reconstruction of it, reported alongside its own count so the two can be
  // compared rather than assumed equal.
  const seenInMp = (r) => r.mp !== null && r.mp !== undefined;
  const pending = rows.filter((r) => !seenInMp(r));
  const rescued = pending.filter((r) => r.mkpl === 'alive' || r.mkpl === 'unbuyable');
  const mkplDeleted = pending.filter((r) => r.mkpl === 'deleted');
  const absentBoth = pending.filter((r) => r.mkpl === null || r.mkpl === undefined);
  const rescuedAlive = rescued.filter((r) => r.mkpl === 'alive');

  const byKey = (list) => list.reduce((a, r) => { a[r.dealKey] = (a[r.dealKey] || 0) + 1; return a; }, {});

  // MKPL-only catalog skus are the sharpest spot-check targets there are: they
  // are the rows the suppression is actually buying. Put them at the front.
  const catalogCandidates = rescued
    .filter((r) => r.mkplRec && r.mkplRec.url)
    .slice(0, 25)
    .map((r) => ({ cat: r.cat, item: r.mkplRec.item || r.itemNumber, seller: r.sellerClass, name: (r.name || '').slice(0, 88), price: r.mkplRec.price, storedPrice: r.stored, availability: r.mkplRec.availability, inStock: /in-?stock/i.test(r.mkplRec.availability || ''), url: r.mkplRec.url, productId: r.id, dealKey: r.dealKey, source: 'catalog-pending' }));

  const report = {
    generatedAt: new Date().toISOString(),
    readOnly: true, wroteCatalog: false,
    feeds: feedStat,
    q1_redundancy: { perCategory: {}, totals: null },
    q2_blastRadius: {
      catalogDeals: rows.length, distinctKeys: wanted.size,
      pendingReconstructed: pending.length,
      pendingByDealKey: byKey(pending),
      carriedByMkpl: rescued.length,
      carriedByMkplInStock: rescuedAlive.length,
      carriedByMkplByDealKey: byKey(rescued),
      mkplSaysDeleted: mkplDeleted.length,
      absentFromBothFeeds: absentBoth.length,
      rescuedSample: rescued.slice(0, 40).map((r) => ({ id: r.id, name: (r.name || '').slice(0, 70), cat: r.cat, dealKey: r.dealKey, sku: r.sku, item: r.itemNumber, mkpl: r.mkpl, availability: r.mkplRec && r.mkplRec.availability, stored: r.stored, mkplPrice: r.mkplRec && r.mkplRec.price })),
    },
    q3_spotcheck: { emitted: 0, note: 'Not fetched here — a runner IP gets bot-blocked and a 403 answers nothing. Fetch from a residential address.' },
  };

  let tU = 0, tM = 0;
  for (const c of CATS) { report.q1_redundancy.perCategory[c] = { mpRows: mpIdx[c].n, mpOfficial: mpIdx[c].official, mpMarketplace: mpIdx[c].marketplace, ...q1[c] }; tU += q1[c].unique; tM += q1[c].mkplRows; }
  report.q1_redundancy.totals = { inScopeMkplRows: tM, uniqueToMkpl: tU, uniquePct: tM ? +(tU / tM * 100).toFixed(2) : 0 };

  const spot = [...catalogCandidates, ...candidates.map((c) => ({ ...c, source: 'mkpl-only-inscope' }))];
  report.q3_spotcheck.emitted = spot.length;

  fs.mkdirSync(OUTDIR, { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  fs.writeFileSync(CANDIDATES, JSON.stringify({ generatedAt: report.generatedAt, howToUse: 'Fetch each url from a residential address. 404/redirect-to-search = dead listing; 200 with a live product page = MKPL carries real coverage.', catalogPendingCount: catalogCandidates.length, candidates: spot }, null, 2));

  // ── Console verdict ───────────────────────────────────────────────────────
  const pad = (s, n) => String(s).padStart(n);
  console.log('\n══ MKPL VERDICT — NOTHING WRITTEN ══\n');
  console.log(`feeds: mp ${feedStat.mp.total} records (${feedStat.mp.inScope} in-scope, mtime ${feedStat.mp.mtimeISO?.slice(0, 10)}, ${feedStat.mp.ageDays}d)`);
  console.log(`       MKPL ${feedStat.mkpl.total} records (${feedStat.mkpl.inScope} in-scope, mtime ${feedStat.mkpl.mtimeISO?.slice(0, 10)}, ${feedStat.mkpl.ageDays}d)\n`);

  console.log('── Q1 REDUNDANCY: what does MKPL carry that mp does not?');
  console.log(`${'category'.padEnd(12)} ${pad('mp', 7)} ${pad('MKPL', 7)} ${pad('dup:item', 9)} ${pad('dup:upc', 8)} ${pad('dup:mpn', 8)} ${pad('UNIQUE', 7)} ${pad('uniq 1P', 8)} ${pad('uniq inStk', 10)}`);
  for (const c of CATS) {
    const r = report.q1_redundancy.perCategory[c];
    console.log(`${c.padEnd(12)} ${pad(r.mpRows, 7)} ${pad(r.mkplRows, 7)} ${pad(r.dupItem, 9)} ${pad(r.dupUPC, 8)} ${pad(r.dupMPN, 8)} ${pad(r.unique, 7)} ${pad(r.uniqueOfficial, 8)} ${pad(r.uniqueInStock, 10)}`);
  }
  console.log(`\nTOTAL in-scope MKPL rows ${tM}; UNIQUE to MKPL ${tU} (${report.q1_redundancy.totals.uniquePct}%)`);
  console.log('  → ~0 unique: the nightly can DROP MKPL outright, suppression lifts, no email needed.');
  console.log('  → material: MKPL must be RESCHEDULED into its own workflow, not removed.\n');

  console.log('── Q2 BLAST RADIUS: which pendings does MKPL\'s exclusion actually protect?');
  console.log(`  catalog Newegg deals ............... ${rows.length}`);
  console.log(`  absent from mp (= pending) ......... ${pending.length}   ${JSON.stringify(byKey(pending))}`);
  console.log(`  ...of those, CARRIED BY MKPL ....... ${rescued.length}   ${JSON.stringify(byKey(rescued))}`);
  console.log(`       listed in-stock in MKPL ....... ${rescuedAlive.length}`);
  console.log(`  ...MKPL marks them deleted ......... ${mkplDeleted.length}`);
  console.log(`  ...absent from BOTH feeds .......... ${absentBoth.length}  <- MKPL's exclusion protects none of these`);
  console.log(`\n  The suppression is buying exactly ${rescued.length} deal(s). Everything else is held for nothing.\n`);

  console.log(`── Q3 SPOT-CHECK: ${spot.length} candidate url(s) emitted (${catalogCandidates.length} of them catalog pendings)`);
  for (const s of spot.slice(0, 10)) console.log(`   [${s.source}] ${s.item}  ${s.availability || '(no avail)'}  ${(s.name || '').slice(0, 56)}`);

  console.log(`\nReports: ${path.relative(ROOT, REPORT)} · ${path.relative(ROOT, CANDIDATES)}`);
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
