// case-ingest.mjs — CASES ONLY. Phase-4 write: Newegg + Best Buy case ingest.
//
// THE ONLY WRITE PATH IS writeCatalog(). No fs.writeFileSync over parts.js, ever.
// Runs in the FOREGROUND — a backgrounded catalog write corrupted the catalog once, so
// "foreground" here means the process, not merely the liveness check.
//
// WHAT IT DOES, in order:
//   1. Restore tag (annotated) BEFORE touching anything, so the whole run reverts exactly.
//   2. RECOVERY pass — rows we already own that are QUARANTINED while the retailer stocks
//      them first-party and in stock right now. Attach the deal, clear needsReview.
//   3. INSERT pass — the gate-audit survivors, each with provenance and a per-row in-stock
//      confirmation. Confirmed + price-clean → LIVE. Anything unconfirmed or price-flagged
//      → QUARANTINED (needsReview + quarantinedAt + a reason), never silently dropped.
//   4. writeCatalog with a DELIBERATE maxGrowth override (logged, this run only) — a full
//      category ingest is exactly what the brake's escape hatch exists for. The brake is
//      not removed or weakened; the default is asserted to be back at 15% afterwards.
//   5. wrong-ASIN detector re-run (read-only) on the freshly re-split chunks.
//
// 3P DISCLOSURE: Newegg marketplace rows are written priceSource:'3p' + priceSeller so the
// retailer-aware ThirdPartyBadge discloses them. --quarantine-3p writes them held instead,
// which is the fallback if the badge is not verified in PRERENDERED HTML.
//
// Usage:
//   node case-ingest.mjs                 # DRY RUN — full report, writes nothing
//   node case-ingest.mjs --apply         # writes (foreground) + re-split + detector
//   node case-ingest.mjs --apply --quarantine-3p   # 3P rows held pending badge verification

import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const require = createRequire(import.meta.url);
const CC = require('./catalog-classify.cjs');
const { isRenewedTitle } = require('./condition.cjs');
const { writeCatalog, MAX_GROWTH } = require('./scripts/write-catalog.cjs');

const ROOT = process.cwd();
const argv = process.argv.slice(2);
const APPLY = argv.includes('--apply');
const QUARANTINE_3P = argv.includes('--quarantine-3p');
const TODAY = new Date().toISOString().slice(0, 10);
const NOW = new Date().toISOString();
const BATCH = `case-ingest-${TODAY}`;
const REPORT = path.join(ROOT, 'catalog-build', `case-ingest-${APPLY ? 'live' : 'dry'}.json`);
const RESTORE_TAG = `cases-ingest-restore-${TODAY}`;

// Newegg affiliate link. The feed's product_url already carries the linksynergy wrapper
// with our SID; a bare newegg.com link earns nothing, so the feed URL is used verbatim.
//
// Best Buy is the opposite: the Developer API's `url` field is a RAW click-tracking URL
// (https://api.bestbuy.com/click/-/<sku>/pdp) that carries no affiliate attribution, so a
// click on it earns nothing. Every other Best Buy row in the catalog uses the 7tiv wrapper.
// Construct it the same way bestbuy-discover-v2.js does rather than trusting the API field.
const BB_AFFILIATE = { host: 'bestbuycreators.7tiv.net', partner: '7109270', offer: '3337161', campaign: '28102' };
const bestBuyProductUrl = (sku) => `https://www.bestbuy.com/site/-/${sku}.p?skuId=${sku}`;
const bestBuyAffiliateUrl = (sku) => `https://${BB_AFFILIATE.host}/c/${BB_AFFILIATE.partner}/${BB_AFFILIATE.offer}/${BB_AFFILIATE.campaign}?prodsku=${sku}&u=${encodeURIComponent(bestBuyProductUrl(sku))}`;
const bar = '─'.repeat(96);
const log = (m) => console.log(m);

(async () => {
  log('='.repeat(96));
  log(`CASE INGEST — ${APPLY ? 'APPLY (foreground write)' : 'DRY RUN (nothing written)'} — batch ${BATCH}`);
  if (QUARANTINE_3P) log('  --quarantine-3p: every Newegg marketplace row is written HELD (badge unverified)');
  log('='.repeat(96));

  // ── inputs: the read-only audit's verdicts, so the write cannot disagree with the table
  const audit = require('./catalog-build/case-gate-audit.json');
  const neSweep = require('./catalog-build/case-sweep-newegg.json');
  const bbSweep = require('./catalog-build/case-sweep-bestbuy.json');
  const neByName = new Map(neSweep.rows.map((r) => [r.name, r]));
  const bbBySku = new Map(bbSweep.rows.map((r) => [String(r.sku), r]));

  const mod = await import('file://' + ROOT.replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...(mod.PARTS || mod.default || [])];
  const loadedCount = parts.length;
  const existingIds = new Set(parts.map((p) => p.id));
  let nextId = Math.max(...parts.map((p) => p.id || 0)) + 1;
  const allocId = () => { while (existingIds.has(nextId)) nextId++; existingIds.add(nextId); return nextId++; };
  log(`catalog: ${loadedCount} products, ${parts.filter((p) => p.c === 'Case').length} Case rows ` +
      `(${parts.filter((p) => p.c === 'Case' && !p.needsReview).length} live)\n`);

  // ── 1. RESTORE TAG (before any mutation) ──────────────────────────────────
  if (APPLY) {
    try {
      execFileSync('git', ['tag', '-a', RESTORE_TAG, '-m',
        `restore point before case ingest ${BATCH} (${loadedCount} products)`], { cwd: ROOT });
      log(`restore tag: ${RESTORE_TAG}  (git reset --hard ${RESTORE_TAG} to revert)\n`);
    } catch (e) {
      const msg = String(e.message || '');
      if (/already exists/i.test(msg)) log(`restore tag ${RESTORE_TAG} already exists — reusing\n`);
      else throw new Error(`refusing to write without a restore tag: ${msg}`);
    }
  } else {
    log(`restore tag: would create ${RESTORE_TAG}\n`);
  }

  // ── 2. RECOVERY — owned but hidden, while the retailer stocks it 1P in stock ──
  // These are products we ALREADY had and were hiding for no reason. A quarantined row is
  // invisible in browse and excluded from the builder, so a live first-party in-stock
  // listing is exactly the evidence needed to clear it.
  const caseRows = parts.filter((p) => p.c === 'Case');
  const recovered = [];
  const recoverySkipped = [];
  {
    const normUPC = (u) => String(u || '').replace(/\D/g, '').replace(/^0+/, '');
    const normMPN = (m) => { const c = String(m || '').toUpperCase().replace(/[\s\-_/]/g, ''); return (c.length < 5 || /^\d+$/.test(c)) ? '' : c; };
    const byUPC = new Map(), byMPN = new Map(), byBBSku = new Map(), byNeItem = new Map();
    for (const p of caseRows) {
      const u = normUPC(p.upc); if (u) byUPC.set(u, p);
      const m = normMPN(p.mpn); if (m) byMPN.set(m, p);
      const bbu = p.deals?.bestbuy?.url || '';
      const ps = String(bbu).match(/[?&]prodsku=(\d+)/i); if (ps) byBBSku.set(ps[1], p);
      const it = p.deals?.newegg?.sku || p.deals?.newegg?.itemNumber;
      if (it) byNeItem.set(String(it).toUpperCase(), p);
    }
    // candidate listings: FIRST-PARTY and IN STOCK only
    const candidates = [];
    for (const r of neSweep.rows) {
      if (r.sellerClass !== 'official') continue;
      if (!/in-stock/i.test(r.availability || '')) continue;
      candidates.push({ retailer: 'newegg', name: r.name, price: (r.sale > 0 ? r.sale : r.retail) || null,
        url: r.url, image: r.image, upc: r.upc, mpn: r.mpn, key: String(r.itemNumber || '').toUpperCase(), raw: r });
    }
    for (const r of bbSweep.rows) {
      if (r.onlineAvailability !== true) continue;          // in stock online, first-party by construction
      candidates.push({ retailer: 'bestbuy', name: r.name, price: r.price, url: r.url, image: r.image,
        upc: r.upc, mpn: r.mpn, key: String(r.sku), raw: r });
    }
    const claimed = new Set();
    for (const c of candidates) {
      const hit = (c.retailer === 'bestbuy' ? byBBSku.get(c.key) : byNeItem.get(c.key))
        || byUPC.get(normUPC(c.upc)) || byMPN.get(normMPN(c.mpn));
      if (!hit || !hit.needsReview) continue;               // only interested in HIDDEN rows
      if (claimed.has(hit.id)) continue;
      if (!(c.price > 0)) { recoverySkipped.push({ id: hit.id, why: 'no price on the listing', name: hit.n }); continue; }
      // the gate ladder still applies to a recovery — a row we own does not get a free pass
      const scope = CC.caseRejectReason(hit.n) || CC.caseRejectReason(c.name);
      if (scope) { recoverySkipped.push({ id: hit.id, why: `caseReject:${scope}`, name: hit.n }); continue; }
      if (isRenewedTitle(c.name)) { recoverySkipped.push({ id: hit.id, why: 'listing is not New', name: hit.n }); continue; }
      claimed.add(hit.id);
      recovered.push({ row: hit, listing: c,
        before: { needsReview: hit.needsReview, quarantinedAt: hit.quarantinedAt || null, pr: hit.pr } });
    }
  }

  log(bar);
  log(`RECOVERY — owned rows that are HIDDEN while a first-party listing is in stock: ${recovered.length}`);
  log(bar);
  for (const r of recovered) {
    log(`  #${String(r.row.id).padEnd(7)} ${(r.row.b || '?').padEnd(14)} held:${String(r.before.quarantinedAt || '?').padEnd(11)} ` +
        `$${String(r.before.pr ?? '—').padStart(8)} → $${String(r.listing.price).padStart(8)} ${r.listing.retailer}`);
    log(`            ${r.row.n.slice(0, 88)}`);
  }
  if (recoverySkipped.length) {
    log(`\n  skipped (${recoverySkipped.length}):`);
    for (const s of recoverySkipped.slice(0, 12)) log(`    #${s.id} — ${s.why} — ${String(s.name).slice(0, 66)}`);
  }

  // apply the recovery in memory
  for (const r of recovered) {
    const p = r.row, c = r.listing;
    p.deals = p.deals || {};
    if (c.retailer === 'newegg') {
      p.deals.newegg = { ...(p.deals.newegg || {}), sku: c.key, price: c.price, saleprice: c.raw.sale || null,
        linkurl: c.url, imageurl: c.image || p.deals.newegg?.imageurl || null, sellerClass: 'official',
        inStock: true, priceSource: '1p', priceConfidence: 'confirmed', priceConfirmedAt: TODAY,
        matchedAt: TODAY, matchMethod: 'case-ingest-recovery' };
    } else {
      p.deals.bestbuy = { ...(p.deals.bestbuy || {}), price: c.price, url: bestBuyAffiliateUrl(c.key), sku: String(c.key), inStock: true,
        priceSource: '1p', priceConfidence: 'confirmed', priceConfirmedAt: TODAY };
    }
    if (!(p.pr > 0) || p.pr !== c.price) { p.msrp = p.msrp ?? p.pr ?? c.price; p.pr = c.price; }
    // Backfill the identifiers this row was missing (never overwrite) — #70153 carried no
    // UPC at all, which is why it could only be matched by item number.
    if (!p.upc && c.upc) p.upc = String(c.upc).replace(/^0+/, '');
    if (!p.mpn && c.mpn) p.mpn = c.mpn;
    delete p.needsReview;
    delete p.quarantinedAt;
    p.linkVerifiedAt = TODAY;
    p.linkVerifiedSource = c.retailer;
    p.linkVerifiedBy = 'case-ingest';
    p.recoveredBy = BATCH;
  }

  // ── 3. INSERT — the audit's survivors ─────────────────────────────────────
  const rows = [];
  const summary = { live: 0, held: 0, live1p: 0, live3p: 0 };
  const heldReasons = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  // canonical brand casing: match what the catalog already publishes for the same brand,
  // so "Be Quiet"/"be quiet!" and "Silverstone"/"SilverStone" do not both appear in filters
  const canonBrand = new Map();
  for (const p of caseRows) {
    const b = String(p.b || '').trim(); if (!b) continue;
    const k = b.toLowerCase().replace(/[^a-z0-9]/g, '');
    const e = canonBrand.get(k);
    if (!e) canonBrand.set(k, { spelling: b, n: 1 });
    else { e.n++; if (b === e.spelling) e.spelling = b; }
  }
  const canon = (b) => {
    const k = String(b || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    return canonBrand.get(k)?.spelling || b;
  };

  for (const a of audit.accepted) {
    const attrs = CC.caseAttributes(a.name);
    const brand = canon(a.brand);
    const is3p = a.sellerClass === 'marketplace';
    const src = a.source === 'bestbuy' ? bbBySku.get(String(a.bbSku)) : neByName.get(a.name);

    // PER-ROW IN-STOCK CONFIRMATION. Newegg: the feed row's own availability field, from a
    // snapshot taken minutes ago; Best Buy: the API's onlineAvailability. A row we cannot
    // positively confirm as in stock is HELD, never published on an assumption.
    const inStock = a.source === 'bestbuy'
      ? src?.onlineAvailability === true
      : /in-stock/i.test(src?.availability || '');

    const priceHeld = !!a.priceFlag;
    const markupHeld = !!a.markup;
    const badgeHeld = is3p && QUARANTINE_3P;
    const held = !inStock || priceHeld || markupHeld || badgeHeld;

    const row = {
      id: allocId(), c: 'Case', n: a.name, b: brand,
      pr: a.price ?? null, msrp: a.price ?? null, r: null, img: a.image || null,
      ff: attrs.ff, tower: attrs.tower, tg: attrs.tg, rgb: attrs.rgb, usb_c: attrs.usb_c,
      upc: a.upc || undefined, mpn: a.mpn || undefined,
      deals: {},
      source: `${a.source}-case-discovery`, batchId: BATCH, discoveredAt: TODAY, addedAt: NOW,
    };
    if (a.source === 'newegg') {
      row.deals.newegg = {
        sku: a.itemNumber, price: a.price ?? null, saleprice: src?.sale || null,
        linkurl: a.url, imageurl: a.image || null,
        sellerClass: is3p ? 'marketplace' : 'official',
        inStock, matchedAt: TODAY, matchMethod: 'case-discovery',
        priceSource: is3p ? '3p' : '1p',
        // priceSeller stays NULL for Newegg 3P. The Rakuten feed carries no seller-name
        // field — its `manufacturer` is the BRAND, so populating priceSeller from it would
        // render "Sold by In Win via Newegg", attributing the sale to the maker rather than
        // disclosing an unknown marketplace seller. The badge's generic fallback ("Sold by a
        // third-party seller via Newegg") is the accurate statement, and the 9SIA… item-number
        // prefix that identifies the seller carries no human-readable name to use instead.
        priceSeller: null,
        ...(held ? {} : { priceConfidence: 'confirmed', priceConfirmedAt: TODAY }),
      };
    } else {
      row.deals.bestbuy = {
        price: a.price ?? null, url: bestBuyAffiliateUrl(a.bbSku), sku: String(a.bbSku), inStock, priceSource: '1p',
        ...(held ? {} : { priceConfidence: 'confirmed', priceConfirmedAt: TODAY }),
      };
    }
    if (held) {
      row.needsReview = true;
      row.quarantinedAt = TODAY;
      const why = !inStock ? 'not_confirmed_in_stock'
        : priceHeld ? `price_${a.priceFlag.reason}`
          : markupHeld ? 'price_3p_markup'
            : 'badge_unverified_3p';
      row.heldReason = why;
      if (markupHeld) row.priceQuarantine = { reason: '3p_markup', mult: a.markup.mult, cheapestSeen: a.markup.lo };
      if (priceHeld) row.priceQuarantine = { reason: a.priceFlag.reason, price: a.priceFlag.price, ceiling: a.priceFlag.ceiling ?? null, floor: a.priceFlag.floor ?? null };
      bump(heldReasons, why);
      summary.held++;
    } else {
      summary.live++;
      if (is3p) summary.live3p++; else summary.live1p++;
    }
    rows.push(row);
  }

  log('\n' + bar);
  log(`INSERT — ${rows.length} new Case rows`);
  log(bar);
  log(`  LIVE .......... ${summary.live}   (first-party ${summary.live1p} · Newegg 3P ${summary.live3p})`);
  log(`  HELD .......... ${summary.held}`);
  for (const [k, n] of [...heldReasons.entries()].sort((a, b) => b[1] - a[1])) log(`       · ${k}: ${n}`);

  const brandTally = {};
  for (const r of rows) brandTally[r.b || '(none)'] = (brandTally[r.b || '(none)'] || 0) + 1;
  log('\n  brands: ' + Object.entries(brandTally).sort((a, b) => b[1] - a[1]).slice(0, 24).map(([k, v]) => `${k}:${v}`).join(', '));

  const ffTally = {}, towerTally = {};
  for (const r of rows) { ffTally[r.ff] = (ffTally[r.ff] || 0) + 1; towerTally[r.tower] = (towerTally[r.tower] || 0) + 1; }
  log(`  form factor: ${JSON.stringify(ffTally)}   tower: ${JSON.stringify(towerTally)}`);

  // ── growth brake maths, stated before the write ────────────────────────────
  const nextLen = loadedCount + rows.length;
  const growth = (nextLen / loadedCount) - 1;
  const OVERRIDE = 0.25;
  log('\n' + bar);
  log('GROWTH BRAKE');
  log(bar);
  log(`  ${loadedCount} → ${nextLen} products (+${rows.length}, +${(growth * 100).toFixed(1)}%)`);
  log(`  default ceiling ${(MAX_GROWTH * 100).toFixed(0)}% → DELIBERATE OVERRIDE ${(OVERRIDE * 100).toFixed(0)}% for THIS RUN ONLY`);
  log('  reason: a full single-category ingest (Case, 1,824 Newegg + 106 Best Buy candidates');
  log('          swept) legitimately exceeds the per-run default. The brake is passed a');
  log('          higher ceiling, not bypassed: writeCatalog still refuses anything above it.');
  if (growth > OVERRIDE) {
    log(`\n  ✗ ABORT — +${(growth * 100).toFixed(1)}% exceeds even the deliberate override.`);
    process.exit(2);
  }

  const report = {
    generatedAt: NOW, batchId: BATCH, apply: APPLY, quarantine3p: QUARANTINE_3P,
    restoreTag: RESTORE_TAG,
    catalogBefore: loadedCount, catalogAfter: nextLen,
    growth: { pct: Number((growth * 100).toFixed(2)), defaultCeiling: MAX_GROWTH, overrideUsed: OVERRIDE },
    recovered: recovered.map((r) => ({ id: r.row.id, name: r.row.n, brand: r.row.b, before: r.before,
      retailer: r.listing.retailer, price: r.listing.price, url: r.listing.url })),
    recoverySkipped,
    insert: { total: rows.length, ...summary, heldReasons: Object.fromEntries(heldReasons) },
    brandTally, ffTally, towerTally,
    rows,
  };
  mkdirSync(path.dirname(REPORT), { recursive: true });
  writeFileSync(REPORT, JSON.stringify(report, null, 2));
  log(`\nReport: ${path.relative(ROOT, REPORT)}`);

  if (!APPLY) {
    log('\nDRY RUN — nothing written. Re-run with --apply.');
    return;
  }

  // ── 4. WRITE (foreground, writeCatalog only) ──────────────────────────────
  parts.push(...rows);
  await writeCatalog(parts, {
    loadedCount,
    maxGrowth: OVERRIDE,
    reason: `case ingest ${BATCH}: +${rows.length} (${summary.live} live, ${summary.held} held), ${recovered.length} recovered`,
  });
  log(`\nWROTE. Catalog ${loadedCount} → ${parts.length}. Recovered ${recovered.length}, inserted ${rows.length}.`);

  // the override is per-call, never a module mutation — assert the default is untouched
  const { MAX_GROWTH: after } = require('./scripts/write-catalog.cjs');
  if (after !== MAX_GROWTH || after !== 0.15) throw new Error(`growth brake default changed (${after}) — it must stay 15%`);
  log(`growth brake default after the run: ${(after * 100).toFixed(0)}% (unchanged, override was per-call only)`);

  // ── 5. detector re-run (read-only) ────────────────────────────────────────
  log('\n' + bar);
  log('DETECTOR RE-RUN — detect-wrong-asin.cjs (read-only)');
  log(bar);
  try { execFileSync(process.execPath, ['detect-wrong-asin.cjs'], { cwd: ROOT, stdio: 'inherit' }); }
  catch (e) { log(`  (detector exited non-zero: ${String(e.message).slice(0, 160)})`); }

  log(`\nDONE. Rollback: git reset --hard ${RESTORE_TAG}  (or drop rows where batchId==='${BATCH}' and re-split)`);
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
