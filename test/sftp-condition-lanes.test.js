// =============================================================================
//  test/sftp-condition-lanes.test.js
//
//  sftp-ingest.cjs is the ONLY writer for deals.newegg_openbox and its sibling
//  condition lanes. deals.newegg has refresh-newegg-prices.cjs to overwrite it
//  nightly; these have nothing else.
//
//  That mattered because the ingest applied a SELECTION rule ("of the listings
//  this feed carries for this product, which do we show?") across RUNS, to the
//  listing it had already stored. Yesterday's price competed with today's price
//  for the same listing and won whenever today's was higher, since
//  `newPrice < oldPrice` is the only path that displaces a same-rank in-stock
//  listing. A price RISE was never written.
//
//  Measured 2026-08-28: 180 open-box products tracked since 2026-05-30 took 10
//  price steps between them; deals.newegg took 2,095 over the same window. The
//  lane moved 5.1% where new-condition Newegg moved 27.1% — and open-box is
//  single-unit inventory that should move MORE, not less.
//
//  That is the #70 mechanism one layer down: a frozen low price is
//  disproportionately the cheapest, and the cheapest wins BEST.
// =============================================================================

import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { sellerRank, CAT_FILTER } from '../newegg-match.js';

const require = createRequire(import.meta.url);
const { chooseListing, detectCondition, CONDITION_LANES } = require('../sftp-ingest.cjs');

const OFFICIAL = 'N82E16819118507R';
const OFFICIAL2 = 'N82E16819118412R';
const MARKET = '9SIA12345678901';

const pick = (existing, incoming) => chooseListing(existing, incoming, sellerRank);

// ── the regression this file exists for ──────────────────────────────────────

test('THE BUG: the same listing at a HIGHER price is written', () => {
  const existing = { itemNumber: OFFICIAL, price: 265.99, inStock: true };
  const r = pick(existing, { itemNumber: OFFICIAL, sku: 'x', price: 299.99, inStock: true });
  assert.equal(r.sameListing, true);
  assert.equal(r.shouldReplace, true, 'a price rise on the listing we hold must be written');
});

test('the same listing at a LOWER price is also written', () => {
  const existing = { itemNumber: OFFICIAL, price: 299.99, inStock: true };
  const r = pick(existing, { itemNumber: OFFICIAL, sku: 'x', price: 265.99, inStock: true });
  assert.equal(r.shouldReplace, true);
});

test('the same listing at an UNCHANGED price still counts as a reprice', () => {
  // It must reach the write path so priceConfirmedAt advances. A row whose price
  // is genuinely stable is not the same thing as a row nobody has checked.
  const existing = { itemNumber: OFFICIAL, price: 265.99, inStock: true };
  const r = pick(existing, { itemNumber: OFFICIAL, sku: 'x', price: 265.99, inStock: true });
  assert.equal(r.shouldReplace, true);
});

test('identity falls back to sku when the stored row predates itemNumber', () => {
  // 46 of the 182 open-box rows were written before itemNumber was recorded and
  // carry sku only; matching on itemNumber alone would treat every one of them
  // as a competing listing forever.
  const existing = { sku: '445831605705533023021312', price: 100, inStock: true };
  const r = pick(existing, { itemNumber: OFFICIAL, sku: '445831605705533023021312', price: 140, inStock: true });
  assert.equal(r.sameListing, true);
  assert.equal(r.shouldReplace, true);
});

test('two unidentifiable listings are NOT the same listing', () => {
  // Empty === empty would let any anonymous record reprice any other.
  const r = pick({ price: 100, inStock: true }, { price: 140, inStock: true });
  assert.equal(r.sameListing, false);
  assert.equal(r.shouldReplace, false, 'dearer, same rank — selection rules still apply');
});

// ── selection between DIFFERENT listings is deliberately unchanged ───────────

test('first-party beats marketplace outright, price-independent', () => {
  const r = pick({ itemNumber: MARKET, price: 100, inStock: true },
                 { itemNumber: OFFICIAL, sku: 'a', price: 180, inStock: true });
  assert.equal(r.sameListing, false);
  assert.equal(r.shouldReplace, true);
});

test('marketplace does NOT displace first-party even when cheaper', () => {
  const r = pick({ itemNumber: OFFICIAL, price: 180, inStock: true },
                 { itemNumber: MARKET, sku: 'b', price: 100, inStock: true });
  assert.equal(r.shouldReplace, false);
});

test('within a tier, a cheaper competing listing wins', () => {
  const r = pick({ itemNumber: OFFICIAL, price: 180, inStock: true },
                 { itemNumber: OFFICIAL2, sku: 'c', price: 150, inStock: true });
  assert.equal(r.shouldReplace, true);
});

test('within a tier, a DEARER competing listing does not', () => {
  const r = pick({ itemNumber: OFFICIAL, price: 150, inStock: true },
                 { itemNumber: OFFICIAL2, sku: 'd', price: 180, inStock: true });
  assert.equal(r.shouldReplace, false);
});

test('an in-stock competitor displaces an out-of-stock incumbent', () => {
  const r = pick({ itemNumber: OFFICIAL, price: 100, inStock: false },
                 { itemNumber: OFFICIAL2, sku: 'e', price: 180, inStock: true });
  assert.equal(r.shouldReplace, true);
});

test('an out-of-stock competitor never displaces an in-stock incumbent', () => {
  const r = pick({ itemNumber: OFFICIAL, price: 180, inStock: true },
                 { itemNumber: OFFICIAL2, sku: 'f', price: 100, inStock: false });
  assert.equal(r.shouldReplace, false);
});

test('no existing listing means take it', () => {
  const r = pick(undefined, { itemNumber: OFFICIAL, sku: 'g', price: 100, inStock: true });
  assert.deepEqual(r, { shouldReplace: true, sameListing: false });
});

test('saleprice is what competes, not list price', () => {
  const r = pick({ itemNumber: OFFICIAL, price: 400, saleprice: 200, inStock: true },
                 { itemNumber: OFFICIAL2, sku: 'h', price: 300, saleprice: 150, inStock: true });
  assert.equal(r.shouldReplace, true);
});

// ── which lanes this job is allowed to certify ──────────────────────────────

test('deals.newegg is NOT a condition lane — one job must not certify another', () => {
  // sftp-ingest contacts the feed for deals.newegg too, so stamping it would be
  // defensible in isolation. It is excluded on purpose: refresh-newegg-prices.cjs
  // owns that lane, and a second stamper would let it die while the freshness
  // gate stayed green on this job's evidence.
  assert.ok(!CONDITION_LANES.includes('newegg'));
});

test('the lanes this job solely owns are the ones it may confirm', () => {
  assert.deepEqual(CONDITION_LANES, ['newegg_openbox', 'newegg_refurb', 'newegg_used']);
});

test('condition detection maps feed names onto those lane keys', () => {
  for (const [name, cond] of [
    ['ASUS PRIME B650 (Open Box)', 'openbox'],
    ['ASUS PRIME B650 OPEN-BOX', 'openbox'],
    ['Corsair RM850x Refurbished', 'refurb'],
    ['Corsair RM850x Renewed', 'refurb'],
    ['Seagate 2TB Used', 'used'],
    ['ASUS PRIME B650-PLUS', 'new'],
  ]) {
    assert.equal(detectCondition(name), cond, name);
    const lane = cond === 'new' ? 'newegg' : 'newegg_' + cond;
    if (cond !== 'new') assert.ok(CONDITION_LANES.includes(lane), lane);
  }
});

// =============================================================================
//  STAMP CARRY-OVER
//
//  applyMatchToPart() assigns a freshly-built object over part.deals[fieldKey],
//  so every field it does not name is erased. For the condition lanes that is
//  harmless — this job is their only writer. For deals.newegg it destroyed the
//  re-pricer's work nightly: 1,739 refreshedAt, 102 priceLastMovedAt, 27
//  migratedAt and 27 rematchedAt gone in the single 2026-09-02 ingest
//  (6147e809174 -> 14c2aae18ba).
//
//  The inversion is what made it invisible. matchedAt IS carried, deliberately,
//  so a row kept its 15-day-old binding stamp and lost the 0-day-old
//  confirmation refresh-newegg-prices had written hours earlier — and the
//  freshness gate read a 15d median over a catalog that had measured 0d and
//  PASSED six hours before.
// =============================================================================

const { applyMatchToPart, loadDeps } = require('../sftp-ingest.cjs');

const TODAY = new Date().toISOString().slice(0, 10);

test('load the ESM deps applyMatchToPart reaches through', async () => {
  await loadDeps();
});

const rec = (over = {}) => ({
  product_name: 'GIGABYTE GeForce RTX 5070 GAMING OC 12G',
  sku: 'RK-1', newegg_item_number: OFFICIAL,
  retail_price: '599.99', sale_price: '',
  product_url: 'https://newegg.com/p/1', image_url: 'https://img/1.jpg',
  availability: 'in-stock', ...over,
});

// A GPU: no `cap`, so the capacity guard passes, and peer-free so neweggSanity
// has nothing to contradict. Mirrors the 68 real GPU rows, all sftp-matched.
const part = (deal, over = {}) => ({
  id: 'p1', c: 'GPU', n: 'GIGABYTE GeForce RTX 5070 GAMING OC 12G',
  deals: { newegg: deal }, ...over,
});

const STAMPED = {
  itemNumber: OFFICIAL, sku: 'RK-1', price: 599.99, inStock: true,
  matchedAt: '2026-08-18T14:17:46.759Z',
  refreshedAt: '2026-09-02T09:20:00.000Z',
  priceLastMovedAt: '2026-08-30',
  migratedAt: '2026-08-29T00:00:00.000Z', migratedFrom: 'OLD-SKU',
};

test('THE BUG: repricing the listing we hold does not erase refreshedAt', () => {
  const p = part({ ...STAMPED });
  assert.equal(applyMatchToPart(p, rec({ retail_price: '649.99' }), { method: 'upc', confidence: 0.95 }), true);
  assert.equal(p.deals.newegg.price, 649.99, 'the reprice must still land');
  assert.equal(p.deals.newegg.refreshedAt, STAMPED.refreshedAt,
    'the re-pricer confirmed this row hours ago; this job must not delete that');
});

test('the movement history survives a reprice, and advances when the price moves', () => {
  const p = part({ ...STAMPED });
  applyMatchToPart(p, rec({ retail_price: '649.99' }), { method: 'upc', confidence: 0.95 });
  assert.equal(p.deals.newegg.priceLastMovedAt, TODAY,
    'a real price move must advance the stamp scripts/price-movement.cjs reads');
});

test('an unchanged price CARRIES priceLastMovedAt rather than advancing it', () => {
  // The distinction the whole freeze alarm rests on: re-reading the same number
  // is not the number moving.
  const p = part({ ...STAMPED });
  applyMatchToPart(p, rec(), { method: 'upc', confidence: 0.95 });
  assert.equal(p.deals.newegg.priceLastMovedAt, '2026-08-30');
});

test('deals.newegg movement is carried too — not just the condition lanes', () => {
  // The hoist. This lane is the largest, and the only one price-movement.cjs
  // actually reports on, yet it was the one lane excluded from the carry.
  const p = part({ ...STAMPED });
  applyMatchToPart(p, rec(), { method: 'upc', confidence: 0.95 });
  assert.ok(p.deals.newegg.priceLastMovedAt, 'the primary lane must keep its movement history');
});

test('re-pricer provenance survives', () => {
  const p = part({ ...STAMPED });
  applyMatchToPart(p, rec(), { method: 'upc', confidence: 0.95 });
  assert.equal(p.deals.newegg.migratedAt, STAMPED.migratedAt);
  assert.equal(p.deals.newegg.migratedFrom, 'OLD-SKU');
});

test('CARRIED, NEVER MINTED: this job never writes a refreshedAt of its own', () => {
  // THE property that keeps a dead re-pricer detectable, and the one the
  // row-granular ownership rule rests on. refreshedAt is how "has the re-pricer
  // ever reached this row" is stated, so if this job could MINT one it would be
  // manufacturing its own evidence of the other job's reach — and every row
  // would drift into the set this job is allowed to certify.
  //
  // Asserted on a MAPPED category with a live re-pricer stamp: the row this
  // property is about.
  const p = part({ ...STAMPED }, { c: 'CPU', n: 'AMD Ryzen 9 9950X' });
  applyMatchToPart(p, rec({ retail_price: '649.99' }), { method: 'upc', confidence: 0.95 });
  assert.equal(p.deals.newegg.refreshedAt, STAMPED.refreshedAt,
    'carried, unchanged — this job may preserve the re-pricer\'s stamp but never write one');
  assert.equal(p.deals.newegg.priceConfirmedAt, undefined,
    'a row the re-pricer DOES reach is not this job\'s to certify');
});

test('a DIFFERENT listing does not inherit the old one\'s confirmation', () => {
  // Carrying here would vouch for a price nothing has confirmed. Same gate, and
  // same reason, as matchedAt's.
  const p = part({ ...STAMPED });
  applyMatchToPart(p, rec({ newegg_item_number: OFFICIAL2, retail_price: '449.99' }),
    { method: 'upc', confidence: 0.95 });
  assert.equal(p.deals.newegg.itemNumber, OFFICIAL2, 'the replacement must land');
  assert.equal(p.deals.newegg.refreshedAt, undefined,
    'the old refreshedAt attests to a listing this row no longer holds');
  assert.equal(p.deals.newegg.migratedAt, undefined);
});

test('the condition lanes still get their own minted confirmation', () => {
  // The asymmetry is the design: this job solely owns these, so it may certify
  // them. Guarding it here so the hoist above cannot quietly level the two.
  const p = { id: 'p2', c: 'GPU', n: 'GIGABYTE GeForce RTX 5070 GAMING OC 12G', deals: {} };
  applyMatchToPart(p, rec({ product_name: 'GIGABYTE GeForce RTX 5070 GAMING OC 12G (Open Box)' }),
    { method: 'upc', confidence: 0.95 });
  assert.equal(p.deals.newegg_openbox.priceConfirmedAt, TODAY);
});

// =============================================================================
//  LANE OWNERSHIP IS PER ROW, NOT PER LANE
//
//  85 Newegg rows sit in categories with no CAT_FILTER entry — 68 GPU plus 17
//  peripherals. searchNewegg() returns 'no_cat_mapping' for them before issuing
//  a single request, so refresh-newegg-prices can never reach them: they were
//  0 of 85 confirmed on 2026-09-02 while the freshness gate counted all 85 in
//  Newegg's stale tail.
//
//  They were not unrefreshed. This feed carries them — 84 of 85 matched sftp:*,
//  79 first-party — and their prices move: 6 of the 68 GPUs repriced between the
//  09-01 and 09-02 ingests, one by $190. The data arrived nightly and was thrown
//  away unstamped.
//
//  So "the lanes this job solely owns" is decided per row. The rule did not
//  change; what changed is that for a row with no re-pricer the choice is not
//  between two certifiers but between one and none.
// =============================================================================

const { lanesSolelyOwned } = require('../sftp-ingest.cjs');

test('an unmappable row has no re-pricer, so this job owns its newegg lane', () => {
  // GPU is absent from CAT_FILTER: Rakuten Product Search does not carry GPUs.
  assert.ok(lanesSolelyOwned({ c: 'GPU' }).includes('newegg'));
  for (const c of ['ExternalStorage', 'Headset', 'Mouse', 'OS', 'Keyboard', 'Webcam']) {
    assert.ok(lanesSolelyOwned({ c }).includes('newegg'), c);
  }
});

test('a MAPPED row keeps its re-pricer, and this job still certifies nothing', () => {
  // The safety property. 3,104 of 3,189 rows are here, and for every one of them
  // a dead refresh-newegg-prices must still show up as a stale median.
  for (const c of ['CPU', 'Motherboard', 'RAM', 'Storage', 'PSU', 'Case', 'CPUCooler', 'CaseFan', 'Monitor']) {
    assert.ok(!lanesSolelyOwned({ c }).includes('newegg'), c);
  }
});

test('the condition lanes are owned regardless of category', () => {
  for (const c of ['GPU', 'CPU']) {
    for (const lane of CONDITION_LANES) assert.ok(lanesSolelyOwned({ c }).includes(lane), `${c}/${lane}`);
  }
});

test('ownership is DERIVED from CAT_FILTER, not a second category list', () => {
  // The property that keeps this from rotting. Adding GPU to CAT_FILTER must
  // hand the lane back to the re-pricer on the same commit — a hardcoded list
  // here would be a transcribed schedule by another name.
  const mapped = Object.keys(CAT_FILTER);
  for (const c of mapped) assert.ok(!lanesSolelyOwned({ c }).includes('newegg'), c);
  assert.equal(mapped.includes('GPU'), false,
    'GPU is deliberately unmapped; if this fails, the exception above is now dead code');
});

test('an unmappable row GETS a confirmation stamp from this job', () => {
  const p = { id: 'g1', c: 'GPU', n: 'GIGABYTE GeForce RTX 5070 GAMING OC 12G', deals: {} };
  applyMatchToPart(p, rec(), { method: 'upc', confidence: 0.95 });
  assert.equal(p.deals.newegg.priceConfirmedAt, TODAY,
    'nothing else will ever confirm this row');
});

test('a MAPPED row still gets none without a snapshot — the safe fallback', () => {
  // No snapshot has been taken in this process, so lanesSolelyOwned() falls back
  // to the category rule. That fallback certifies STRICTLY LESS, which is the
  // only direction a missing snapshot is allowed to err in.
  const p = { id: 'c1', c: 'CPU', n: 'AMD Ryzen 9 9950X', deals: {} };
  applyMatchToPart(p, { ...rec(), product_name: 'AMD Ryzen 9 9950X' },
    { method: 'upc', confidence: 0.95 });
  assert.equal(p.deals.newegg.priceConfirmedAt, undefined,
    'absent the snapshot the gate stays shut — a missing input must never mint a stamp');
});

// =============================================================================
//  AND OWNERSHIP IS PER ROW WITHIN A MAPPED CATEGORY TOO
//
//  CAT_FILTER answers "may the re-pricer issue a request for this row", and that
//  was read as "will it ever confirm this row". They are different questions and
//  the gap between them IS the Newegg stale tail: searchNewegg queries by name
//  and UPC while the feed is keyed by newegg_item_number, so a mapped row whose
//  name never matches is asked about every run and confirmed by nothing.
//
//  Measured on main 2026-09-08: of 3,198 deals.newegg rows, ALL 860 past the
//  gate's 12d tail budget carry no refreshedAt whatsoever. Not one is a row the
//  re-pricer reaches and is merely behind on. The re-pricer's logs agree from the
//  other side — 2,102 of 3,189 matched, and across consecutive runs zero rows
//  reached by the earlier were missed by the later. A fixed, nested set.
//
//  refreshedAt is what states the condition, and it can only do so because this
//  job carries that stamp and never mints one (asserted above).
// =============================================================================

const { repricerNeverReachedAtLoad } = require('../sftp-ingest.cjs');

const neverReached = (...parts) => repricerNeverReachedAtLoad(parts);

test('the snapshot names exactly the rows carrying no refreshedAt', () => {
  const reached  = { id: 'a', c: 'CPU', deals: { newegg: { refreshedAt: '2026-09-08T00:00:00Z' } } };
  const notYet   = { id: 'b', c: 'CPU', deals: { newegg: { matchedAt: '2026-09-08T00:00:00Z' } } };
  const noLane   = { id: 'c', c: 'CPU', deals: {} };
  const s = neverReached(reached, notYet, noLane);
  assert.equal(s.has('a'), false, 'the re-pricer has confirmed this row; it stays the re-pricer\'s');
  assert.equal(s.has('b'), true, 'matchedAt is not confirmation — see CONFIRMATION_STAMPS');
  assert.equal(s.has('c'), true, 'a row with no lane yet has no re-pricer history by construction');
});

test('a MAPPED row the re-pricer has NEVER reached is this job\'s to certify', () => {
  // The tail. Mapped, so the old category rule said "not yours"; unreached, so
  // nothing else was ever going to confirm it.
  const p = { id: 'c1', c: 'CPU', n: 'AMD Ryzen 9 9950X', deals: {} };
  assert.ok(lanesSolelyOwned(p, neverReached(p)).includes('newegg'));
});

test('THE SAFETY PROPERTY: a mapped row WITH refreshedAt is never this job\'s', () => {
  // The whole reason the old rule existed, and it has to survive intact: a job
  // certifying a lane that has its own re-pricer lets that re-pricer die
  // unnoticed. A row the re-pricer has confirmed even once can never enter the
  // set, so its liveness keeps driving the median.
  const p = { id: 'c2', c: 'CPU', n: 'AMD Ryzen 9 9950X',
              deals: { newegg: { refreshedAt: '2026-09-08T09:00:00Z' } } };
  assert.equal(lanesSolelyOwned(p, neverReached(p)).includes('newegg'), false);
});

test('a STALE refreshedAt is still refreshedAt — reach is not freshness', () => {
  // The tempting bug: "it has not been repriced in 90 days, so treat it as
  // unreached and stamp it". That would hand the ingest exactly the rows a
  // BROKEN re-pricer stops touching, which is the failure being guarded against.
  // Reachability is the question here; how stale is the gate's business, and a
  // budget transcribed into the ingest is a second copy of that policy.
  const p = { id: 'c3', c: 'CPU', n: 'AMD Ryzen 9 9950X',
              deals: { newegg: { refreshedAt: '2026-01-01T00:00:00Z' } } };
  assert.equal(lanesSolelyOwned(p, neverReached(p)).includes('newegg'), false,
    'an ancient stamp still proves the re-pricer reaches this row');
});

test('a mapped, never-reached row GETS the stamp through applyMatchToPart', () => {
  const p = { id: 'c4', c: 'CPU', n: 'AMD Ryzen 9 9950X', deals: {} };
  applyMatchToPart(p, { ...rec(), product_name: 'AMD Ryzen 9 9950X' },
    { method: 'upc', confidence: 0.95 }, neverReached(p));
  assert.equal(p.deals.newegg.priceConfirmedAt, TODAY,
    'nothing else will ever confirm this row — the tail, stamped');
});

// =============================================================================
//  THE SWEEP IS NARROWER THAN THE CERTIFICATION, ON PURPOSE
//
//  assert-retailer-freshness.cjs drops a row from `stamped` and `ages` when the
//  negative stamp is newer than every positive one:
//
//      if (failedAt && failedAt > best) continue;
//
//  A priceUnconfirmedAt therefore does not make a row read as STALE — it removes
//  the row from the distribution the gate measures. Simulated against the live
//  catalog at the census's measured 59% feed coverage:
//
//      sweep excludes newegg   3,186 stamped, p90 16d   RED
//      sweep includes newegg   2,793 stamped, p90  0d   GREEN, 405 rows dropped
//
//  So widening the sweep would green the gate by deleting the rows nothing
//  confirms out of its view, while the site kept quoting their prices. That is
//  the outcome this change was chosen INSTEAD of, and these tests are what stop
//  it being reintroduced as a tidy-looking symmetry fix.
// =============================================================================

const { lanesSweptForAbsence } = require('../sftp-ingest.cjs');

test('the sweep does NOT reach a mapped row the re-pricer never reached', () => {
  const p = { id: 's1', c: 'CPU', n: 'AMD Ryzen 9 9950X', deals: { newegg: {} } };
  const snap = neverReached(p);
  assert.ok(lanesSolelyOwned(p, snap).includes('newegg'),
    'this job may CERTIFY it — nothing else reaches it');
  assert.equal(lanesSweptForAbsence(p).includes('newegg'), false,
    'but it may not stamp it unconfirmed: that would hide it from the gate, not flag it');
});

test('the sweep still reaches the lanes it always did', () => {
  // The narrowing must not quietly drop the coverage the sweep already had.
  const gpu = { id: 's2', c: 'GPU', deals: { newegg: {} } };
  assert.ok(lanesSweptForAbsence(gpu).includes('newegg'),
    'an unmappable row has no re-pricer at all — the original case, unchanged');
  for (const lane of CONDITION_LANES) {
    assert.ok(lanesSweptForAbsence({ id: 's3', c: 'CPU' }).includes(lane), lane);
  }
});

test('the two rules differ ONLY on mapped, never-reached rows', () => {
  // Pins the exact size of the deliberate asymmetry, so widening either one
  // shows up here rather than in the gate's verdict six weeks later.
  const cases = [
    { c: 'GPU', refreshedAt: null,  certify: true,  sweep: true  },  // unmappable
    { c: 'GPU', refreshedAt: 'x',   certify: true,  sweep: true  },  // still unmappable
    { c: 'CPU', refreshedAt: null,  certify: true,  sweep: false },  // THE TAIL
    { c: 'CPU', refreshedAt: 'x',   certify: false, sweep: false },  // the re-pricer's
  ];
  for (const { c, refreshedAt, certify, sweep } of cases) {
    const p = { id: `k-${c}-${refreshedAt}`, c,
                deals: { newegg: refreshedAt ? { refreshedAt: '2026-09-08T00:00:00Z' } : {} } };
    assert.equal(lanesSolelyOwned(p, neverReached(p)).includes('newegg'), certify,
      `certify ${c}/${refreshedAt}`);
    assert.equal(lanesSweptForAbsence(p).includes('newegg'), sweep, `sweep ${c}/${refreshedAt}`);
  }
});

test('THE MID-RUN SWAP: ownership is read from the snapshot, not from live state', () => {
  // The bug this design exists to prevent. applyMatchToPart() consults ownership
  // BEFORE the wholesale assignment and the absence sweep consults it AFTER, and
  // a genuine listing swap drops refreshedAt in between. A live read would call
  // this row "re-priced" at the first site and "never re-priced" at the second,
  // and the sweep would stamp priceUnconfirmedAt over a price just confirmed.
  const p = part({ ...STAMPED }, { c: 'CPU', n: 'AMD Ryzen 9 9950X' });
  const snap = neverReached(p);
  assert.equal(snap.has(p.id), false, 'at load this row carried the re-pricer\'s stamp');

  // The swap: a different listing lands, and refreshedAt legitimately does not
  // carry across to it.
  applyMatchToPart(p, rec({ newegg_item_number: OFFICIAL2, retail_price: '449.99' }),
    { method: 'upc', confidence: 0.95 }, snap);
  assert.equal(p.deals.newegg.itemNumber, OFFICIAL2, 'the replacement must land');
  assert.equal(p.deals.newegg.refreshedAt, undefined, 'and it must not inherit the old stamp');

  // A live read here would now say "never reached". The snapshot does not.
  assert.equal(lanesSolelyOwned(p, snap).includes('newegg'), false,
    'the sweep must see the same answer applyMatchToPart saw, or it stamps over a fresh price');
  assert.equal(repricerNeverReachedAtLoad([p]).has(p.id), true,
    'and this is the live read that would have disagreed — the reason the snapshot exists');
});
