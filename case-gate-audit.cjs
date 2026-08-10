#!/usr/bin/env node
/**
 * case-gate-audit.cjs — CASES ONLY. Phase-2 read-only gate attribution.
 *
 * WRITES NOTHING (report JSON + stdout table only). Reads the Phase-1 sweep dumps,
 * dedupes each row against the live catalog, and attributes every SURVIVING row that
 * we do NOT already own to the FIRST gate that rejects it.
 *
 * ORDER MATTERS AND IS DELIBERATE: dedupe runs BEFORE the gate ladder. The existing
 * discovery scripts gate first and dedupe last, which charges rows we already own to a
 * gate and makes the reject table overstate every gate. Here "rejected" always means
 * "a case we do not have and did not admit".
 *
 * Ranking: reject reasons are ranked by how many MAINSTREAM-brand rows each kills, not
 * by raw count — a gate dropping 200 no-name chassis matters less than one dropping a
 * single Fractal/NZXT/Lian Li/Corsair/Cooler Master.
 *
 * Usage: node case-gate-audit.cjs [--full] [--gate=<reason>]
 *   --full          print every rejected title for every gate (not just 5)
 *   --gate=<reason> print every rejected title for ONE gate
 */

const fs = require('fs');
const path = require('path');
const CC = require('./catalog-classify.cjs');
const { isRenewedTitle } = require('./condition.cjs');

const ROOT = __dirname;
const argv = process.argv.slice(2);
const FULL = argv.includes('--full');
const ONLY_GATE = (argv.find((a) => a.startsWith('--gate=')) || '').split('=')[1] || null;
const OUT = path.join(ROOT, 'catalog-build', 'case-gate-audit.json');

// ── Mainstream chassis makers — the brands whose loss actually costs the catalog.
// Tier 1 = the names a builder shops by. Tier 2 = real, widely-stocked value makers.
const TIER1 = new Set(['fractal design', 'nzxt', 'lian li', 'corsair', 'cooler master',
  'be quiet!', 'phanteks', 'thermaltake', 'asus', 'msi', 'gigabyte', 'hyte', 'silverstone',
  'antec', 'in win', 'inwin', 'deepcool', 'montech', 'fractal']);
const TIER2 = new Set(['jonsbo', 'zalman', 'cougar', 'sama', 'darkflash', 'thermalright',
  'segotep', 'apevia', 'rosewill', 'gamdias', 'sharkoon', 'aerocool', 'xigmatek', 'okinos',
  'vetroo', 'kediers', 'musetex', 'raidmax', 'ssupd', 'geometric future', 'havn', 'gamemax',
  'pccooler', 'diypc', 'asrock', 'azza', 'bitfenix', 'chieftec', 'enermax', 'fsp', 'lianli']);
const brandTier = (b) => {
  const k = String(b || '').toLowerCase().trim();
  if (!k) return 0;
  if (TIER1.has(k)) return 1;
  if (TIER2.has(k)) return 2;
  for (const t of TIER1) if (k.includes(t)) return 1;
  for (const t of TIER2) if (k.includes(t)) return 2;
  return 3;
};

// ── Case price band (TOTAL, like CPU: $/unit is meaningless for a chassis).
// Calibrated 2026-08-10 against the live catalog's 364 priced cases: min $30.32,
// p50 $110, p95 $288, p99 $499, max $984 (Cooler Master HAF 700 EVO). Floor $20 sits
// below the cheapest real budget chassis (~$30 Apevia/Raidmax) so a $9 "case" — always
// an accessory or a mis-attached link — is caught. Ceiling $1200 clears the observed
// max with headroom, per the RAM lesson that a TIGHT ceiling is the disaster mode.
const CASE_PRICE = { floor: 20, ceiling: 1200 };

// ── name normalisation / token overlap (dedupe) ──────────────────────────────
const STOP = new Set(['case', 'cases', 'pc', 'computer', 'gaming', 'tower', 'mid', 'full',
  'mini', 'micro', 'atx', 'matx', 'itx', 'eatx', 'chassis', 'desktop', 'with', 'and', 'for',
  'the', 'usb', 'type', 'tempered', 'glass', 'side', 'panel', 'mesh', 'airflow', 'fans',
  'fan', 'argb', 'rgb', 'black', 'white', 'support', 'supports', 'front', 'new', 'inch',
  'mm', 'edition', 'series', 'high', 'water', 'cooling', 'gpu', 'atx3']);
const tokens = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ')
  .split(/\s+/).filter((t) => t.length >= 2 && !STOP.has(t) && !/^\d{1,2}$/.test(t)));
// Model tokens: an alnum blob carrying a digit ("h6", "4000d", "o11", "gr701", "1100").
const modelToks = (s) => new Set([...tokens(s)].filter((t) => /\d/.test(t) && /^[a-z]*\d+[a-z0-9]*$/.test(t)));
// SYMMETRIC (Jaccard), not containment. Containment over min(|A|,|B|) scores 1.00 for
// any long title that happens to contain a terse catalog name's two tokens: "Corsair
// FRAME 4000D WOOD RS" vs catalog "Corsair 4000D Airflow" ({corsair,4000d}) read as a
// perfect dupe and a genuinely new chassis got swallowed. Jaccard charges the extra
// tokens, so a longer name has to actually AGREE, not merely contain.
const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let hit = 0; for (const t of a) if (b.has(t)) hit++;
  return hit / (a.size + b.size - hit);
};
// Model-LINE qualifiers: words that separate two products inside one family
// (H6 vs H6 Flow, View 380 vs View 380 XL, 4000D vs 4000D FRAME/WOOD, H7 vs H7 Elite).
// Present on exactly one side => different product, regardless of name similarity.
const QUALIFIER = new Set(['xl', 'xxl', 'sl', 'compact', 'max', 'plus', 'pro', 'evo', 'elite',
  'flow', 'air', 'wood', 'frame', 'vision', 'dynamic', 'ii', 'iii', 'v2', 'v3', 'snow',
  'shift', 'crux', 'base', 'pop', 'north', 'torrent', 'define', 'meshify', 'ridge', 'terra',
  'era', 'pure', 'silent', 'shadow', 'lite', 'nano', 'slim', 'razer', 'core', 'zone',
  'panorama', 'infinity', 'reverse', 'inverse', 'open', 'showcase', 'wide', 'cube']);
const qualifierConflict = (a, b) => {
  for (const q of QUALIFIER) { const ia = a.has(q), ib = b.has(q); if (ia !== ib) return q; }
  return null;
};
const normUPC = (u) => String(u || '').replace(/\D/g, '').replace(/^0+/, '');
const normMPN = (m) => { const c = String(m || '').toUpperCase().replace(/[\s\-_/]/g, ''); return (c.length < 5 || /^\d+$/.test(c)) ? '' : c; };

// ── the gate ladder — first reason wins ─────────────────────────────────────
// Mirrors what the Phase-4 writer will enforce, in the same order, so this table
// predicts the write exactly.
function gateLadder(row) {
  const title = row.name;
  // 1. condition
  if (isRenewedTitle(title)) return 'condition:renewed';
  if (/\bopen[\s-]?box\b/i.test(title)) return 'condition:openbox';
  if (/\bused\b|\bpre[\s-]?owned\b/i.test(title)) return 'condition:used';
  // 2. whole-machine / multi-component
  const pre = CC.prebuiltSystemReason(title); if (pre) return `prebuilt:${pre}`;
  const bun = CC.bundleReason(title); if (bun) return `bundle:${bun}`;
  // 3. category classification (category-first: a positive Case signal is trusted
  //    over the feature-word accessory rules)
  const signal = CC.detectCategory(CC.stripCompatClauses(title));
  if (signal && signal !== 'Case') return `miscategorized:${signal}`;
  if (!signal) {
    const acc = CC.notBuildableReason(title);
    return acc ? `accessory:${acc}` : 'not_a_case';
  }
  // 4. brand
  const brand = CC.resolveDiscoveryBrand(title, row.mfr, 'Case');
  if (!brand) return 'no_brand';
  // 5. price band
  const p = row.price;
  if (p == null || !(p > 0)) return 'no_price';
  if (p > CASE_PRICE.ceiling) return 'price:above_ceiling';
  if (p < CASE_PRICE.floor) return 'price:below_floor';
  return null;   // ACCEPT
}

// Legacy gates the CURRENT Newegg discovery path applies, measured separately so
// their over-fire is visible instead of hiding inside "prebuilt".
const LEGACY_PREBUILT_RE = /\b(Custom|Workstation|Desktop PC|Pre.?built|Gaming PC|Gaming Desktop|Barebone|Bundle|Combo)\b/i;

(async () => {
  const partsMod = await import('file://' + ROOT.replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = partsMod.PARTS || partsMod.default || [];
  const ourCases = parts.filter((p) => p.c === 'Case');

  // catalog dedupe indexes
  const asins = new Set(), upcs = new Set(), mpns = new Set(), bbSkus = new Set(), neItems = new Set();
  // key -> is the row we matched HIDDEN (quarantined)? A dedupe hit against a
  // quarantined row means we "have" the case but nobody can see it — a different
  // problem from a coverage gap, and one worth counting separately.
  const hiddenKey = new Map();
  const markHidden = (k, p) => { if (k) hiddenKey.set(String(k), !!p.needsReview); };
  const reAsin = /\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i;
  for (const p of parts) {
    if (p.asin) { asins.add(String(p.asin).toUpperCase()); markHidden(String(p.asin).toUpperCase(), p); }
    if (p.deals?.amazon?.asin) { asins.add(String(p.deals.amazon.asin).toUpperCase()); markHidden(String(p.deals.amazon.asin).toUpperCase(), p); }
    const mm = p.deals?.amazon?.url && String(p.deals.amazon.url).match(reAsin);
    if (mm) { asins.add(mm[1].toUpperCase()); markHidden(mm[1].toUpperCase(), p); }
    const u = normUPC(p.upc); if (u) { upcs.add(u); markHidden(u, p); }
    const m = normMPN(p.mpn); if (m) { mpns.add(m); markHidden(m, p); }
    // Best Buy rows carry NO sku field — the SKU lives in the affiliate URL's
    // prodsku= param (…7tiv.net/c/…?prodsku=6560305&u=…). Reading only deals.bestbuy.sku
    // matched 0 of 106 swept rows and pushed every dedupe decision onto UPC/MPN/name.
    if (p.deals?.bestbuy?.sku) { bbSkus.add(String(p.deals.bestbuy.sku)); markHidden(String(p.deals.bestbuy.sku), p); }
    const bbu = p.deals?.bestbuy?.url || '';
    const ps = String(bbu).match(/[?&]prodsku=(\d+)/i); if (ps) { bbSkus.add(ps[1]); markHidden(ps[1], p); }
    const sp = String(bbu).match(/skuId=(\d+)/i); if (sp) { bbSkus.add(sp[1]); markHidden(sp[1], p); }
    for (const k of ['newegg', 'newegg_openbox']) {
      const it = p.deals?.[k]?.itemNumber || p.deals?.[k]?.sku;
      if (it) { neItems.add(String(it).toUpperCase()); markHidden(String(it).toUpperCase(), p); }
    }
  }
  // name index over OUR cases only (token overlap needs same-category scope)
  const ourIdx = ourCases.map((p) => ({ p, t: tokens(p.n), m: modelToks(p.n), b: String(p.b || '').toLowerCase() }));

  function dupeReason(row) {
    const hit = (verdict, key) => { row._dupeHidden = hiddenKey.get(String(key)) === true; return verdict; };
    if (row.asin && asins.has(row.asin.toUpperCase())) return hit('have:asin', row.asin.toUpperCase());
    if (row.bbSku && bbSkus.has(row.bbSku)) return hit('have:bestbuy_sku', row.bbSku);
    if (row.itemNumber && neItems.has(String(row.itemNumber).toUpperCase())) return hit('have:newegg_item', String(row.itemNumber).toUpperCase());
    const u = normUPC(row.upc); if (u && upcs.has(u)) return hit('have:upc', u);
    const m = normMPN(row.mpn); if (m && mpns.has(m)) return hit('have:mpn', m);
    const t = tokens(row.name), mt = modelToks(row.name);
    const rb = String(CC.resolveDiscoveryBrand(row.name, row.mfr, 'Case') || row.mfr || '').toLowerCase();
    if (t.size < 2) return null;                 // too little signal to judge on name
    for (const o of ourIdx) {
      // brand must agree (or one side is unbranded) before a name match counts
      if (rb && o.b && !(rb.includes(o.b) || o.b.includes(rb))) continue;
      if (o.t.size < 2) continue;
      const c = jaccard(t, o.t);
      if (c < 0.62) continue;
      // model tokens present on BOTH sides and disjoint => different model, not a dupe
      if (mt.size && o.m.size) { let shared = 0; for (const x of mt) if (o.m.has(x)) shared++; if (!shared) continue; }
      if (qualifierConflict(t, o.t)) continue;   // H6 vs H6 Flow, View 380 vs View 380 XL
      row._dupeAgainst = `#${o.p.id} ${o.p.n}`;
      row._dupeScore = c.toFixed(2);
      row._dupeHidden = !!o.p.needsReview;
      return 'have:name_overlap';
    }
    return null;
  }

  // ── load sweeps ───────────────────────────────────────────────────────────
  const sources = [];
  const load = (file, mapper, label) => {
    const f = path.join(ROOT, 'catalog-build', file);
    if (!fs.existsSync(f)) { console.log(`  (skip ${label}: ${file} absent)`); return; }
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    sources.push({ label, meta: d, rows: (d.rows || []).map(mapper) });
  };
  load('case-sweep-amazon.json', (r) => ({
    source: 'amazon', asin: r.asin, name: r.title, mfr: r.mfr || r.brandField, price: r.price,
    upc: null, mpn: null, url: `https://www.amazon.com/dp/${r.asin}`, availability: r.availability,
  }), 'Amazon');
  load('case-sweep-newegg.json', (r) => ({
    source: 'newegg', itemNumber: r.itemNumber, name: r.name, mfr: r.brand,
    price: r.sale != null && r.sale > 0 ? r.sale : r.retail,
    upc: r.upc, mpn: r.mpn, url: r.url, sellerClass: r.sellerClass, availability: r.availability,
  }), 'Newegg');
  load('case-sweep-bestbuy.json', (r) => ({
    source: 'bestbuy', bbSku: r.sku, name: r.name, mfr: r.mfr, price: r.price,
    upc: r.upc, mpn: r.mpn, url: r.url, availability: `${r.onlineAvailability}`,
  }), 'Best Buy');

  // ── run ───────────────────────────────────────────────────────────────────
  const all = [];
  const perSource = {};
  for (const s of sources) {
    const st = { found: s.rows.length, marketplace: 0, deduped: 0, dedupedHidden: 0, accepted: 0, rejected: 0 };
    for (const row of s.rows) {
      // Newegg policy gate: first-party only (a 3P Newegg link is not one we publish)
      if (row.source === 'newegg' && row.sellerClass !== 'official') {
        st.marketplace++;
        all.push({ ...row, verdict: 'policy:newegg_marketplace', tier: brandTier(CC.resolveDiscoveryBrand(row.name, row.mfr, 'Case') || row.mfr) });
        continue;
      }
      const dupe = dupeReason(row);
      const brand = CC.resolveDiscoveryBrand(row.name, row.mfr, 'Case');
      const tier = brandTier(brand || row.mfr);
      if (dupe) {
        st.deduped++;
        if (row._dupeHidden) st.dedupedHidden = (st.dedupedHidden || 0) + 1;
        all.push({ ...row, brand, tier, verdict: dupe, dupeAgainst: row._dupeAgainst, dupeScore: row._dupeScore, dupeHidden: !!row._dupeHidden });
        continue;
      }
      const gate = gateLadder(row);
      if (gate) { st.rejected++; all.push({ ...row, brand, tier, verdict: gate, legacyPrebuilt: LEGACY_PREBUILT_RE.test(row.name) }); }
      else { st.accepted++; all.push({ ...row, brand, tier, verdict: 'ACCEPT', legacyPrebuilt: LEGACY_PREBUILT_RE.test(row.name) }); }
    }
    perSource[s.label] = st;
  }

  // ── report ────────────────────────────────────────────────────────────────
  const bar = '─'.repeat(96);
  const notOurs = all.filter((r) => !String(r.verdict).startsWith('have:'));
  const rejected = notOurs.filter((r) => r.verdict !== 'ACCEPT');
  const accepted = notOurs.filter((r) => r.verdict === 'ACCEPT');

  console.log('='.repeat(96));
  console.log('CASE GATE AUDIT — READ-ONLY. Nothing written.');
  console.log('='.repeat(96));
  console.log(`catalog: ${parts.length} products, ${ourCases.length} Case rows (${ourCases.filter((p) => !p.needsReview).length} live)\n`);
  console.log('PER SOURCE');
  console.log(bar);
  console.log(`  ${'source'.padEnd(10)} ${'found'.padStart(7)} ${'3P drop'.padStart(8)} ${'already have'.padStart(13)} ${'(of those, hidden)'.padStart(19)} ${'gate-rejected'.padStart(14)} ${'ACCEPT'.padStart(7)}`);
  for (const [k, s] of Object.entries(perSource)) {
    console.log(`  ${k.padEnd(10)} ${String(s.found).padStart(7)} ${String(s.marketplace).padStart(8)} ${String(s.deduped).padStart(13)} ${String(s.dedupedHidden || 0).padStart(19)} ${String(s.rejected).padStart(14)} ${String(s.accepted).padStart(7)}`);
  }
  const tot = Object.values(perSource).reduce((a, s) => ({
    found: a.found + s.found, marketplace: a.marketplace + s.marketplace,
    deduped: a.deduped + s.deduped, dedupedHidden: a.dedupedHidden + (s.dedupedHidden || 0),
    rejected: a.rejected + s.rejected, accepted: a.accepted + s.accepted,
  }), { found: 0, marketplace: 0, deduped: 0, dedupedHidden: 0, rejected: 0, accepted: 0 });
  console.log(bar);
  console.log(`  ${'TOTAL'.padEnd(10)} ${String(tot.found).padStart(7)} ${String(tot.marketplace).padStart(8)} ${String(tot.deduped).padStart(13)} ${String(tot.dedupedHidden).padStart(19)} ${String(tot.rejected).padStart(14)} ${String(tot.accepted).padStart(7)}`);

  // gate table, ranked by mainstream kills
  const gates = new Map();
  for (const r of rejected) {
    let e = gates.get(r.verdict);
    if (!e) { e = { n: 0, t1: 0, t2: 0, t3: 0, examples: [], t1examples: [] }; gates.set(r.verdict, e); }
    e.n++;
    if (r.tier === 1) { e.t1++; if (e.t1examples.length < 8) e.t1examples.push(r); }
    else if (r.tier === 2) e.t2++; else e.t3++;
    if (e.examples.length < (FULL || ONLY_GATE === r.verdict ? 100000 : 5)) e.examples.push(r);
  }
  const ranked = [...gates.entries()].sort((a, b) => (b[1].t1 - a[1].t1) || (b[1].t2 - a[1].t2) || (b[1].n - a[1].n));

  console.log('\n' + '='.repeat(96));
  console.log('REJECT TABLE — ranked by MAINSTREAM (tier-1) kills, then tier-2, then raw count');
  console.log('  tier1 = Fractal/NZXT/Lian Li/Corsair/Cooler Master/be quiet!/Phanteks/Thermaltake/ASUS/MSI/HYTE/…');
  console.log('  tier2 = real value makers (Jonsbo/Zalman/Apevia/Montech/Rosewill/…)   tier3 = no-name/unbranded');
  console.log('='.repeat(96));
  for (const [reason, e] of ranked) {
    console.log(`\n▸ ${reason}   — ${e.n} rows   (tier1 ${e.t1} · tier2 ${e.t2} · tier3 ${e.t3})`);
    const show = ONLY_GATE && ONLY_GATE !== reason ? [] : e.examples.slice(0, FULL || ONLY_GATE === reason ? 100000 : 5);
    for (const r of show) {
      console.log(`    [${r.source.padEnd(7)}|t${r.tier}] $${String(r.price ?? '—').padStart(7)}  ${String(r.name).slice(0, 76)}`);
    }
    if (e.t1 && !FULL && ONLY_GATE !== reason) {
      const extra = e.t1examples.filter((x) => !show.includes(x)).slice(0, 4);
      if (extra.length) { console.log(`    ── tier-1 kills:`); for (const r of extra) console.log(`    [${r.source.padEnd(7)}|t1] $${String(r.price ?? '—').padStart(7)}  ${String(r.name).slice(0, 76)}`); }
    }
  }

  // legacy-gate diagnostic
  const legacyKills = notOurs.filter((r) => r.legacyPrebuilt);
  const legacyWouldAccept = legacyKills.filter((r) => r.verdict === 'ACCEPT');
  console.log('\n' + '='.repeat(96));
  console.log('LEGACY GATE DIAGNOSTIC — discover-newegg-dry.cjs / newegg-match.js PREBUILT_RE');
  console.log('='.repeat(96));
  console.log(`  rows whose title trips the legacy regex: ${legacyKills.length}`);
  console.log(`  ...of which this ladder ACCEPTS as real cases: ${legacyWouldAccept.length}  (tier1 ${legacyWouldAccept.filter((r) => r.tier === 1).length} · tier2 ${legacyWouldAccept.filter((r) => r.tier === 2).length})`);
  for (const r of legacyWouldAccept.slice(0, 8)) console.log(`    [${r.source.padEnd(7)}|t${r.tier}] ${String(r.name).slice(0, 82)}`);

  console.log('\n' + '='.repeat(96));
  console.log(`WOULD ACCEPT: ${accepted.length}   (tier1 ${accepted.filter((r) => r.tier === 1).length} · tier2 ${accepted.filter((r) => r.tier === 2).length} · tier3 ${accepted.filter((r) => r.tier === 3).length})`);
  console.log('='.repeat(96));
  const byBrand = {};
  for (const r of accepted) { const k = r.brand || '(none)'; byBrand[k] = (byBrand[k] || 0) + 1; }
  console.log('  ' + Object.entries(byBrand).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}:${v}`).join(', '));

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(), dryRun: true, wrote: false,
    casePriceBand: CASE_PRICE, perSource, totals: tot,
    gateTable: Object.fromEntries(ranked.map(([k, e]) => [k, {
      n: e.n, tier1: e.t1, tier2: e.t2, tier3: e.t3,
      examples: e.examples.slice(0, 40).map((r) => ({ source: r.source, tier: r.tier, price: r.price, name: r.name })),
    }])),
    legacy: { trips: legacyKills.length, wouldAcceptAnyway: legacyWouldAccept.length },
    dedupe: (() => {
      const byMethod = {};
      for (const r of all.filter((x) => String(x.verdict).startsWith('have:'))) {
        const k = r.verdict; byMethod[k] = byMethod[k] || { n: 0, samples: [] };
        byMethod[k].n++;
        if (byMethod[k].samples.length < 25) byMethod[k].samples.push({ source: r.source, name: r.name, against: r.dupeAgainst || null, score: r.dupeScore || null });
      }
      return byMethod;
    })(),
    accepted: accepted.map((r) => ({ source: r.source, brand: r.brand, tier: r.tier, price: r.price, name: r.name, asin: r.asin, bbSku: r.bbSku, itemNumber: r.itemNumber, upc: r.upc, mpn: r.mpn, url: r.url })),
    rejected: rejected.map((r) => ({ source: r.source, brand: r.brand, tier: r.tier, price: r.price, name: r.name, verdict: r.verdict })),
  }, null, 2));
  console.log(`\nReport: ${path.relative(ROOT, OUT)}`);
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
