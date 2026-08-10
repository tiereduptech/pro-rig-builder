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

// Chassis makers trusted on the Newegg 3P path: every brand already present on a Case row
// in the live catalog, plus the tier lists. Data-driven so it stays current, and populated
// from the catalog at startup (see below). Deliberately conservative — a genuinely NEW case
// brand only enters via first-party or Best Buy, never via a marketplace seller's filing.
const CASE_BRANDS = new Set([...TIER1, ...TIER2]);

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
  // 3. Case SCOPE, before classification. A rackmount / server chassis is out of scope no
  //    matter which category its title reads as, and putting scope first stops those rows
  //    being charged to "miscategorized:Storage" (which is what happens when a 4U chassis
  //    lists HDD bays) — the reject table should name the real reason.
  const scope = CC.caseRejectReason(title);
  if (scope) return `caseReject:${scope}`;
  // 4. category classification (category-first: a positive Case signal is trusted
  //    over the feature-word accessory rules)
  const signal = CC.detectCategory(CC.stripCompatClauses(title));
  if (signal && signal !== 'Case') return `miscategorized:${signal}`;
  if (!signal) {
    // SOURCE PRIOR — but ONLY from a source whose categorisation is trustworthy.
    //
    // Newegg FIRST-PARTY and Best Buy file their own catalogue, so their case category is
    // strong evidence and beats the title: plenty of real chassis never say "case" at all
    // ("Antec P10 FLUX, F-LUX Platform, 5 x 120mm Fans…"), and rejecting those was the
    // single largest gate loss in the audit.
    //
    // Newegg MARKETPLACE is the opposite. Third-party sellers file anything under any
    // leaf: the same case category served Siemens contact blocks, Baldor electric motors,
    // Bryant locking plugs, Eaton neutral kits, a 3Dconnexion SpaceMouse and an HPE riser
    // kit — 72 of 817 3P rows carry no case noun whatsoever. So for 3P the prior is not
    // evidence, and a POSITIVE Case classification is required instead.
    if (!row.trustPrior) {
      // For 3P the prior is not evidence, but requiring a positive Case classification
      // outright threw away 63 tier-1 chassis whose titles are pure feature lists (Antec
      // C5 ARGB, HYTE Y70 TOUCH, be quiet! PURE BASE 600, Thermaltake View 380 XL, MSI MPG
      // GUNGNIR 300R). So the 3P fallback needs a discriminator, and the one that actually
      // separates the two populations is BRAND plus a clean product name:
      //   • a maker we already carry in Cases (or a known chassis brand) — kills the
      //     Siemens / Eaton / HPE / 3Dconnexion / Supermicro-blade / AAAwave rows outright
      //   • no accessory noun in the product-name segment — kills the case-BRAND accessories
      //     (Lian Li UNI Fan Controller, NZXT Control Hub, Thermaltake TT Sync Controller)
      const bk = String(CC.resolveDiscoveryBrand(title, row.mfr, 'Case') || '').toLowerCase().trim();
      if (!bk || !CASE_BRANDS.has(bk)) return 'not_a_case:3p_unknown_brand';
      const head = title.split(/[,;]/)[0];
      if (/\b(accessory|controller|hub|kit|bracket|adapter|riser|reader|deck|dock|enclosure|benchtable|cover|panel)\b/i.test(head)) {
        return 'not_a_case:3p_accessory_name';
      }
    }
    // The accessory rules still run FIRST, so the prior cannot launder a fan controller or
    // a rail kit into Case.
    // Product-name segment only — a case's "…Riser Cable Included" / "…Fan Controller" /
    // "…cable management" feature clauses are not accessory products. See
    // accessoryProductReason for the position-not-vocabulary rationale.
    const acc = CC.accessoryProductReason(title);
    if (acc) return `accessory:${acc}`;
    // fall through on the prior — treated as Case
  }
  // 5. brand
  const brand = CC.resolveDiscoveryBrand(title, row.mfr, 'Case');
  if (!brand) return 'no_brand';
  // 6. price band — QUARANTINE, NOT DROP. A bounds miss is stamped on the row and the row
  //    is still admitted (needsReview), because a stale ceiling must never silently delete
  //    good data: that is the DDR5 lesson, where $10/GB rejected 95% of real DDR5 and only
  //    quarantining made the mistake recoverable. Three of the 13 over-ceiling rows here are
  //    genuine halo chassis (SilverStone ALTA F2, Lian Li Odyssey X, GIGABYTE AORUS C700).
  const p = row.price;
  if (p == null || !(p > 0)) return 'no_price';
  if (p > CASE_PRICE.ceiling) { row._priceFlag = { reason: 'above_ceiling', price: p, ceiling: CASE_PRICE.ceiling }; return null; }
  if (p < CASE_PRICE.floor) { row._priceFlag = { reason: 'below_floor', price: p, floor: CASE_PRICE.floor }; return null; }
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
  // every brand already on a Case row joins the 3P-trusted set
  for (const p of ourCases) { const b = String(p.b || '').toLowerCase().trim(); if (b) CASE_BRANDS.add(b); }

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
    // keyword search, not a curated leaf — the title must carry the signal
    trustPrior: false,
    upc: null, mpn: null, url: `https://www.amazon.com/dp/${r.asin}`, availability: r.availability,
  }), 'Amazon');
  load('case-sweep-newegg.json', (r) => ({
    source: 'newegg', itemNumber: r.itemNumber, name: r.name, mfr: r.brand,
    // first-party files its own catalogue; a marketplace seller's leaf choice is not evidence
    trustPrior: r.sellerClass === 'official',
    price: r.sale != null && r.sale > 0 ? r.sale : r.retail,
    upc: r.upc, mpn: r.mpn, url: r.url, sellerClass: r.sellerClass, availability: r.availability,
  }), 'Newegg');
  load('case-sweep-bestbuy.json', (r) => ({
    source: 'bestbuy', bbSku: r.sku, name: r.name, mfr: r.mfr, price: r.price, trustPrior: true,
    upc: r.upc, mpn: r.mpn, url: r.url, availability: `${r.onlineAvailability}`,
  }), 'Best Buy');

  // ── 3P MARKUP CORROBORATION ───────────────────────────────────────────────
  // An absolute per-category ceiling cannot catch a marketplace markup: "MSI MPG VELOX
  // 300R AIRFLOW PZ WHITE" (real ~$120) is listed 3P at $809.99, comfortably under the
  // $1200 halo-chassis ceiling. The corroboration available is the sweep itself — the same
  // chassis is usually also listed first-party or by a saner 3P seller — plus the price we
  // already carry for that product. A 3P row priced far above the cheapest sighting of the
  // SAME brand+model is an outlier, and outliers are quarantined, never dropped (the
  // standing price-gate rule) so a genuine price rise is reviewable rather than lost.
  const MARKUP_MULT = 1.6;
  const groupKey = (brand, name) => {
    const mt = [...modelToks(name)].sort().join('-');
    return `${String(brand || '').toLowerCase()}|${mt}`;
  };
  const groupMin = new Map();
  const noteMin = (brand, name, price) => {
    if (!(price > 0)) return;
    const mt = modelToks(name);
    if (!mt.size) return;                       // no model token → nothing to corroborate against
    const k = groupKey(brand, name);
    if (!groupMin.has(k) || price < groupMin.get(k)) groupMin.set(k, price);
  };
  for (const s of sources) {
    for (const row of s.rows) noteMin(CC.resolveDiscoveryBrand(row.name, row.mfr, 'Case'), row.name, row.price);
  }
  for (const p of ourCases) noteMin(p.b, p.n, p.pr);   // the price we already publish counts too
  const markupVerdict = (row) => {
    if (!(row.price > 0)) return null;
    const mt = modelToks(row.name);
    if (!mt.size) return null;
    const lo = groupMin.get(groupKey(CC.resolveDiscoveryBrand(row.name, row.mfr, 'Case'), row.name));
    if (lo == null || !(lo > 0)) return null;
    const mult = row.price / lo;
    return mult > MARKUP_MULT ? { lo, mult: Number(mult.toFixed(2)) } : null;
  };

  // ── run ───────────────────────────────────────────────────────────────────
  const all = [];
  const perSource = {};
  for (const s of sources) {
    const st = { found: s.rows.length, marketplace: 0, deduped: 0, dedupedHidden: 0, accepted: 0, rejected: 0 };
    for (const row of s.rows) {
      // Newegg 3P is ADMITTED (decision 2026-08-10), tagged priceSource:'3p' + seller so
      // the disclosure badge renders — mirroring the Amazon 3P policy shipped 2026-08-05.
      // It runs the IDENTICAL gate ladder as first-party; seller class is a label on the
      // row, not a gate. Counted separately so the split stays visible.
      if (row.source === 'newegg' && row.sellerClass !== 'official') st.marketplace++;
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
      else {
        st.accepted++;
        // ACCEPTED, but a marketplace markup is held for review rather than published.
        const mk = (row.sellerClass && row.sellerClass !== 'official') ? markupVerdict(row) : null;
        if (mk) st.markupHeld = (st.markupHeld || 0) + 1;
        if (row._priceFlag) st.priceHeld = (st.priceHeld || 0) + 1;
        all.push({ ...row, brand, tier, verdict: 'ACCEPT', markup: mk, priceFlag: row._priceFlag || null, legacyPrebuilt: LEGACY_PREBUILT_RE.test(row.name) });
      }
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
  console.log(`  ${'source'.padEnd(10)} ${'found'.padStart(7)} ${'3P (kept)'.padStart(9)} ${'already have'.padStart(13)} ${'(of those, hidden)'.padStart(19)} ${'gate-rejected'.padStart(14)} ${'ACCEPT'.padStart(7)}`);
  for (const [k, s] of Object.entries(perSource)) {
    console.log(`  ${k.padEnd(10)} ${String(s.found).padStart(7)} ${String(s.marketplace).padStart(9)} ${String(s.deduped).padStart(13)} ${String(s.dedupedHidden || 0).padStart(19)} ${String(s.rejected).padStart(14)} ${String(s.accepted).padStart(7)}`);
  }
  const tot = Object.values(perSource).reduce((a, s) => ({
    found: a.found + s.found, marketplace: a.marketplace + s.marketplace,
    deduped: a.deduped + s.deduped, dedupedHidden: a.dedupedHidden + (s.dedupedHidden || 0),
    rejected: a.rejected + s.rejected, accepted: a.accepted + s.accepted,
  }), { found: 0, marketplace: 0, deduped: 0, dedupedHidden: 0, rejected: 0, accepted: 0 });
  console.log(bar);
  console.log(`  ${'TOTAL'.padEnd(10)} ${String(tot.found).padStart(7)} ${String(tot.marketplace).padStart(9)} ${String(tot.deduped).padStart(13)} ${String(tot.dedupedHidden).padStart(19)} ${String(tot.rejected).padStart(14)} ${String(tot.accepted).padStart(7)}`);
  const accepts = all.filter((r) => r.verdict === 'ACCEPT');
  const acc3p = accepts.filter((r) => r.sellerClass && r.sellerClass !== 'official').length;
  const held = accepts.filter((r) => r.markup);
  console.log(`\n  of the ${tot.accepted} accepted: ${tot.accepted - acc3p} first-party · ${acc3p} Newegg 3P (tagged priceSource:'3p' + seller, disclosure badge required)`);
  const priceHeld = accepts.filter((r) => r.priceFlag);
  const anyHeld = accepts.filter((r) => r.markup || r.priceFlag);
  console.log(`  3P markup corroboration: ${held.length} priced >${MARKUP_MULT}x the cheapest sighting of the same brand+model → QUARANTINE`);
  console.log(`  price band (floor $${CASE_PRICE.floor} / ceiling $${CASE_PRICE.ceiling}): ${priceHeld.length} out of band → QUARANTINE (never dropped)`);
  console.log(`  => ${anyHeld.length} of ${tot.accepted} admitted-but-held on price; ${tot.accepted - anyHeld.length} price-clean`);
  for (const r of held.slice(0, 6)) console.log(`      ${(r.brand || '?').padEnd(14)} $${String(r.price).padStart(8)} vs $${r.markup.lo} (${r.markup.mult}x)  ${r.name.slice(0, 52)}`);

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
