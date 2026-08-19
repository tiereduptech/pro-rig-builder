// Variant-collapse guard — the tests the ingest --dry-run CANNOT provide.
//
// fetch-newegg-via-rakuten.cjs --dry-run returns at the "not making API calls"
// branch, BEFORE getToken() and before any candidate is scored. It therefore
// never reaches scoreMatch() and cannot exercise this guard at all. Since
// ingest is how the bad matches got into the catalog in the first place, the
// guard needs coverage that does not depend on a live feed — this file.
//
//   node --test
//
// Every REJECT pair below is a real collapse observed in production or in a
// refresh dry-run artifact. Every ACCEPT pair is a real match we must not break.

import test from 'node:test';
import assert from 'node:assert/strict';

const NEG = await import('../newegg-match.js');
const { variantMismatch, scoreMatch } = NEG;

// scoreMatch() runs price/capacity/bundle gates before it reaches the variant
// guard. These helpers keep those gates out of the way so a failing assertion
// means the GUARD moved, not that some unrelated gate fired.
const ours = (n, extra = {}) => ({ n, c: 'Case', ...extra });
const theirs = (name, extra = {}) => ({ name, sku: 'N82E16811000001', price: null, upc: '', ...extra });

// ── Pairs that MUST be rejected ──────────────────────────────────────────────
// [label, our name, their name, expected reason]
const REJECT = [
  // The 0.59-score collapse from refresh dry-run 29757145308. Three independent
  // reasons to reject and the pre-fix guard caught none: both names share the
  // digit token "120", and "Open Box" / "Wireless" / "Reverse Blade" are all
  // alpha-only, which the digit-token check is structurally blind to.
  ['reverse-blade vs wireless open-box',
    'UNI Fan SL-Infinity 120 - Triple Pack (Reverse Blade) ARGB Fan-Daisy-Chain Design-Infinity Mirror',
    'Open Box - Lian Li UNI Fan SL-Infinity Wireless 120 - Triple Pack - 2.4 GHz Wireless Signal ARGB Fan Control - Double Infinity Mirror Design',
    'variant_marker'],
  ['open box alone',
    'Lian Li O11D MINI V2 Compact ATX Mid-Tower Airflow Case Panoramic View',
    'Open Box - Lian Li O11D MINI V2 Compact ATX Mid-Tower Airflow Case Panoramic View',
    'variant_marker'],
  ['refurbished',
    'Seagate IronWolf 12TB NAS Internal Hard Drive CMR 3.5 Inch SATA 7200 RPM',
    'Refurbished: Seagate IronWolf 12TB NAS Internal Hard Drive CMR 3.5 Inch SATA 7200 RPM',
    'variant_marker'],
  ['recertified folds to refurbished',
    'Seagate IronWolf 12TB NAS Internal Hard Drive CMR 3.5 Inch SATA 7200 RPM',
    'Manufacturer Recertified Seagate IronWolf 12TB NAS Internal Hard Drive CMR 3.5 Inch SATA 7200 RPM',
    'variant_marker'],
  ['renewed',
    'ASUS ROG Strix 32 inch 4K OLED Gaming Monitor TrueBlack Glossy Dual Mode',
    'Renewed ASUS ROG Strix 32 inch 4K OLED Gaming Monitor TrueBlack Glossy Dual Mode',
    'variant_marker'],
  ['wired vs wireless',
    'Lian Li UNI Fan TL 120 Triple Pack Wired ARGB Fan Daisy-Chain Design',
    'Lian Li UNI Fan TL 120 Triple Pack Wireless ARGB Fan Daisy-Chain Design',
    'variant_marker'],
  ['NH-D15 vs NH-D15 chromax.black',
    'Noctua NH-D15 Premium CPU Cooler with 2x NF-A15 PWM Fans',
    'Noctua NH-D15 chromax.black Premium CPU Cooler with 2x NF-A15 PWM Fans',
    'variant_marker'],
  ['North Black vs North White',
    'Fractal Design North Black Mid Tower ATX Case Walnut Front Mesh Side',
    'Fractal Design North White Mid Tower ATX Case Walnut Front Mesh Side',
    'variant_marker'],
  ['AIR 903 Series vs AIR 903 MAX',
    'Montech AIR 903 Series, E-ATX Mid Tower Case, High Airflow',
    'Montech AIR 903 MAX, E-ATX Mid Tower Case, High Airflow',
    'variant_marker'],
  // Digit-token cases — the original check, kept passing.
  ['5900X vs 5900XT',
    'AMD Ryzen 9 5900X 12-Core 24-Thread Socket AM4 Processor',
    'AMD Ryzen 9 5900XT 16-Core 32-Thread Socket AM4 Processor',
    'model_token'],
  ['990 PRO vs 990 EVO',
    'Samsung 990 PRO 2TB PCIe Gen4 x4 NVMe M.2 Internal SSD',
    'Samsung 990 EVO 2TB PCIe Gen4 x4 NVMe M.2 Internal SSD',
    'variant_marker'],
];

for (const [label, a, b, reason] of REJECT) {
  test(`rejects: ${label}`, () => {
    const vm = variantMismatch(a, b);
    assert.ok(vm, `variantMismatch returned false — the collapse would be accepted`);
    assert.equal(vm.reason, reason, `rejected for the wrong reason (${vm.detail})`);
    // The guard must also be reached through the real entry point.
    assert.equal(scoreMatch(ours(a), theirs(b)), null,
      'scoreMatch accepted a pair variantMismatch rejects');
  });

  test(`rejects (symmetric): ${label}`, () => {
    // Direction must not matter: ingest compares our-name-to-theirs, and a
    // marker present only on OUR side is just as disqualifying.
    assert.ok(variantMismatch(b, a), 'guard is direction-dependent');
  });
}

// ── Pairs that MUST still match ──────────────────────────────────────────────
// A guard biased toward rejection still has to let the real matches through,
// or every refresh becomes a lookup failure and the catalog freezes.
const ACCEPT = [
  ['identical name',
    'Lian Li O11D MINI V2 Compact ATX Mid-Tower Airflow Computer Case',
    'Lian Li O11D MINI V2 Compact ATX Mid-Tower Airflow Computer Case'],
  // The clean score-1.0 migration from the same dry run: brand prefix added,
  // punctuation dropped. Same product, tidier title.
  ['brand prefix + punctuation only',
    'O11D MINI V2 | Compact ATX Mid-Tower Airflow Computer Case | Panoramic View',
    'LIAN LI O11D MINI V2 Compact ATX Mid-Tower Airflow Computer Case Panoramic View'],
  ['"Series" is generic noise, not a variant',
    'Fractal Design Torrent Compact Black Solid ATX Mid Tower Case',
    'Fractal Design Torrent Compact Series Black Solid ATX Mid Tower Case'],
  ['80 PLUS Gold is an efficiency rating, not a Plus model',
    'Corsair RM850e 850W 80 PLUS Gold Fully Modular ATX Power Supply',
    'Corsair RM850e 850W 80+ Gold Fully Modular ATX Power Supply'],
];

for (const [label, a, b] of ACCEPT) {
  test(`accepts: ${label}`, () => {
    assert.equal(variantMismatch(a, b), false,
      `guard rejected a legitimate match: ${JSON.stringify(variantMismatch(a, b))}`);
  });
}

// ── The absence distinction ──────────────────────────────────────────────────
// A variant-guard rejection must never be reported as 'no_match', because
// callers read 'no_match' over a healthy candidate set as PROVEN ABSENCE and
// start the removal countdown on it.
test('scoreMatch reports variant rejection through the notes out-param', () => {
  const notes = {};
  const m = scoreMatch(
    ours('Lian Li UNI Fan SL-Infinity 120 Triple Pack Reverse Blade ARGB Daisy-Chain'),
    theirs('Open Box - Lian Li UNI Fan SL-Infinity Wireless 120 Triple Pack ARGB Daisy-Chain'),
    notes,
  );
  assert.equal(m, null);
  assert.match(notes.reject, /^variant_/);
});

test('a guard rejection is reported, but as a guard — never as a variant', () => {
  // Bundle/prebuilt rejection fires before the variant guard — it must not be
  // miscounted as a variant reject, or genuine absence would stop being provable.
  //
  // It used to be reported as NOTHING AT ALL, which was the other half of the
  // problem: a product whose every candidate died on the capacity gate came out
  // as no_match, so the gate's rejections were unattributable in aggregate.
  // Reported now, and classified apart from variant rejects.
  const notes = {};
  assert.equal(scoreMatch(ours('Fractal Design North Black'), theirs('Gaming PC Desktop Bundle North Black'), notes), null);
  assert.equal(notes.reject, 'guard_prebuilt_or_bundle');
  assert.equal(NEG.rejectKind(notes.reject), 'guard');
});

test('the capacity gate names itself', () => {
  // The specific gate item 3 was about: a 2TB drive must not silently lose to a
  // 4TB listing. It rejects, and the reject says which gate did it.
  const notes = {};
  const m = scoreMatch(
    { n: 'Samsung 990 Pro 2TB NVMe Gen4', c: 'Storage', cap: 2000, pr: 150 },
    { name: 'SAMSUNG 990 PRO 4TB M.2 2280 PCIe Gen4 NVMe Internal SSD', sku: 'N82E16820000001', price: 260 },
    notes,
  );
  assert.equal(m, null);
  assert.equal(notes.reject, 'guard_capacity_mismatch');
  assert.equal(NEG.rejectKind(notes.reject), 'guard');
});

test('searchNewegg separates guard rejects from variant rejects and from no_match', () => {
  // guardRejects must NOT inflate variantRejects (that gates the deletion
  // clock), and must NOT collapse into no_match (that IS the deletion clock).
  const xml = `<items>
    <item><productname>SAMSUNG 990 PRO 4TB M.2 2280 PCIe Gen4 NVMe Internal SSD</productname><sku>N82E16820000001</sku><price>260.00</price></item>
    <item><productname>SAMSUNG 990 PRO 1TB M.2 2280 PCIe Gen4 NVMe Internal SSD</productname><sku>N82E16820000002</sku><price>90.00</price></item>
  </items>`;
  const fetchImpl = async () => ({ ok: true, text: async () => xml });
  return NEG.searchNewegg(
    { n: 'Samsung 990 Pro 2TB NVMe Gen4', c: 'Storage', cap: 2000, pr: 150 },
    { token: 't', mid: '1', fetchImpl },
  ).then((res) => {
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'guard_rejected');
    assert.equal(res.guardRejects, 2);
    assert.equal(res.variantRejects, 0);
    assert.notEqual(res.reason, 'no_match',
      'a capacity reject is evidence the product EXISTS — it must not start the removal countdown');
  });
});

test('searchNewegg returns variant_rejected, not no_match, when the guard declined every candidate', async () => {
  const xml = `<items>
    <item><productname>Open Box - Lian Li UNI Fan SL-Infinity Wireless 120 - Triple Pack ARGB</productname><sku>9SIABC000001</sku><price>79.99</price></item>
    <item><productname>Lian Li UNI Fan SL-Infinity Wireless 120 - Triple Pack ARGB</productname><sku>N82E16835000002</sku><price>89.99</price></item>
    <item><productname>Refurbished: Lian Li UNI Fan SL-Infinity 120 - Triple Pack ARGB</productname><sku>N82E16835000003</sku><price>69.99</price></item>
  </items>`;
  const fetchImpl = async () => ({ ok: true, text: async () => xml });
  const res = await NEG.searchNewegg(
    { n: 'Lian Li UNI Fan SL-Infinity 120 - Triple Pack (Reverse Blade) ARGB', c: 'CaseFan' },
    { token: 't', mid: '1', fetchImpl },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'variant_rejected',
    'guard rejections reported as no_match would start the deletion clock on a live product');
  assert.equal(res.variantRejects, 3);
  assert.equal(res.rawCount, 3);
});

test('searchNewegg still reports no_match when nothing resembles our product', async () => {
  // Absence must stay provable, or the removal path can never fire at all.
  const xml = `<items>
    <item><productname>Corsair RM850e Power Supply</productname><sku>N82E16817000001</sku><price>99.99</price></item>
    <item><productname>Seagate Barracuda 2TB Hard Drive</productname><sku>N82E16822000002</sku><price>59.99</price></item>
    <item><productname>ASUS Prime B650 Motherboard</productname><sku>N82E16813000003</sku><price>149.99</price></item>
  </items>`;
  const fetchImpl = async () => ({ ok: true, text: async () => xml });
  const res = await NEG.searchNewegg(
    { n: 'Lian Li UNI Fan SL-Infinity 120 - Triple Pack (Reverse Blade) ARGB', c: 'CaseFan' },
    { token: 't', mid: '1', fetchImpl },
  );
  assert.equal(res.reason, 'no_match');
  assert.equal(res.variantRejects, 0);
});

// ── The migrate floor ────────────────────────────────────────────────────────
test('MIN_MIGRATE_SIM sits above the observed collapse and below the observed legit match', () => {
  // Guards the calibration itself: dry-run 29758284829 showed a 0.59 collapse
  // and a legitimate 0.765 brand-prefix match. Moving the floor outside that
  // band silently changes which real matches survive.
  assert.ok(NEG.MIN_MIGRATE_SIM > 0.59, 'floor must reject the observed collapse');
  assert.ok(NEG.MIN_MIGRATE_SIM < 0.765, 'floor must keep the observed brand-prefix match');
});

// ── The UPC bypass ───────────────────────────────────────────────────────────
test('exact UPC match bypasses the name guard', () => {
  // UPC is strong identity evidence; name similarity is weak. A UPC hit must
  // win even when the titles look like different variants, or legitimate
  // retitles would start failing.
  const m = scoreMatch(
    ours('Fractal Design North Black Mid Tower ATX Case', { upc: '0817301017893' }),
    theirs('Fractal Design North White Mid Tower ATX Case', { upc: '817301017893' }),
  );
  assert.deepEqual(m, { method: 'upc', score: 1.0 });
});

// ── Attach floor vs reprice floor ────────────────────────────────────────────
// These two floors MUST stay separate. scoreMatch() gates both ingest (first
// attach) and refresh (repricing); collapsing them to one number breaks one
// path or the other.
test('MIN_ATTACH_SIM is stricter than the reprice floor but matches MIN_MIGRATE_SIM', () => {
  assert.ok(NEG.MIN_ATTACH_SIM > 0.5, 'attach floor must be stricter than the reprice floor');
  assert.equal(NEG.MIN_ATTACH_SIM, NEG.MIN_MIGRATE_SIM,
    'first bind and re-bind should require the same confidence');
});

// Measured, not guessed — both land between the two floors (0.571 and 0.667).
// 0.571 is the same score the IronWolf repricing match scores in production,
// which is precisely why the reprice floor cannot be raised to 0.70.
const BETWEEN_FLOORS = [
  ['Seagate IronWolf 12TB NAS Hard Drive', 'Seagate IronWolf 12TB SATA Internal Enterprise Drive', 0.667],
  ['Lian Li Lancool II Mesh Performance Case', 'Lancool II Mesh Performance Mid Tower Chassis', 0.571],
];

for (const [a, b, expected] of BETWEEN_FLOORS) {
  test(`a ${expected}-scoring pair reprices but does NOT attach: ${a}`, () => {
    const o = ours(a), t = theirs(b);

    // Pin the score. If normalization drifts, this fixture stops sitting
    // between the floors and the asymmetry silently stops being tested.
    assert.equal(Number(NEG.nameSimilarity(o.n, t.name).toFixed(3)), expected,
      'fixture drifted out of the band between the two floors');

    const reprice = scoreMatch(o, t);                                     // default floor
    const attach  = scoreMatch(o, t, {}, { minSim: NEG.MIN_ATTACH_SIM }); // ingest floor

    assert.ok(reprice, 'reprice path must still accept a low-scoring truncated title');
    assert.equal(attach, null, 'attach path must reject the same pair');
  });
}

test('a pair above the attach floor still passes BOTH paths', () => {
  // Guards the other direction: the raised floor must not reject everything.
  const o = ours('be quiet Pure Base 500DX Airflow Case');
  const t = theirs('be quiet Pure Base 500DX Mid Tower Chassis Windowed');
  assert.ok(NEG.nameSimilarity(o.n, t.name) >= NEG.MIN_ATTACH_SIM);
  assert.ok(scoreMatch(o, t), 'reprice');
  assert.ok(scoreMatch(o, t, {}, { minSim: NEG.MIN_ATTACH_SIM }), 'attach');
});

test('below_attach_floor is reported distinctly from a variant rejection', () => {
  // The dry-run report separates these buckets; conflating them would make a
  // floor change look like the variant guard suddenly over-reaching.
  const notes = {};
  scoreMatch(ours(BETWEEN_FLOORS[0][0]), theirs(BETWEEN_FLOORS[0][1]),
    notes, { minSim: NEG.MIN_ATTACH_SIM });
  assert.equal(notes.reject, 'below_attach_floor');
});

// ── Seller-rank guard ────────────────────────────────────────────────────────
const cand = (sku, name, score) => ({ item: { sku, name }, match: { method: 'name', score } });

test('marketplace never wins when a first-party candidate matched', () => {
  const pick = NEG.selectWithFirstPartyPreference([
    cand('9SIA1234567', 'x', 0.99),          // marketplace, better score
    cand('N82E16811000001', 'x', 0.71),      // first-party, worse score
  ]);
  assert.ok(NEG.isFirstParty(pick.item.sku), 'first-party must win regardless of score');
});

test('unknown-prefix beats marketplace when no first-party exists', () => {
  // The gap the rank walk closes: these two used to compete on raw score, so a
  // marketplace listing could win by a hundredth of a point.
  const pick = NEG.selectWithFirstPartyPreference([
    cand('9SIA1234567', 'x', 0.99),          // marketplace (rank 2)
    cand('2AM-00CN-00061', 'x', 0.72),       // other/unknown (rank 1)
  ]);
  assert.ok(!NEG.isMarketplace(pick.item.sku), 'marketplace must lose to a higher-ranked seller');
});

test('marketplace is still selected when it is the only option', () => {
  // The 18/43 firstPartyAvailable:0 population — these must still attach, they
  // are just labelled sellerClass:'marketplace' so the site can badge them.
  const pick = NEG.selectWithFirstPartyPreference([cand('9SIA1234567', 'x', 0.85)]);
  assert.equal(NEG.sellerClass(pick.item.sku), 'marketplace');
});

// ── Form factor is spec text, not a variant marker ───────────────────────────
//
// The symmetric marker check was rejecting correct matches on nothing but the
// form factor Newegg spells out in every title and our catalog titles omit.
// Measured on the 2026-07-20 ingest dry run: [atx] alone drove 83 of 267
// theirs-only marker rejections, and 38 products had ZERO surviving candidates
// solely because of it.
test('a Newegg title that merely spells out the form factor still matches', () => {
  const cases = [
    ['MSI MAG X870 Tomahawk WiFi',
     'MSI MAG X870 TOMAHAWK WIFI Motherboard, ATX - Supports AMD Ryzen 9000 / 8000 / 7000 Processors, AM5'],
    ['ASUS TUF Gaming Z890-Plus WiFi',
     'ASUS TUF GAMING Z890-PLUS WIFI Z890 LGA 1851 ATX motherboard, Intel Core Ultra Series 2 Ready'],
    ['ASUS ROG Strix B650E-I Gaming WiFi',
     'ASUS ROG Strix B650E-I Gaming WiFi AMD B650 AM5 mini-ITX mITX motherboard, 10+2 power stages, DDR5'],
  ];
  for (const [our, their] of cases) {
    assert.equal(NEG.variantMismatch(our, their), false,
      `form factor alone must not reject: ${our}`);
  }
});

test('form factor folds to one token, so it cannot shed a bare mini/micro marker', () => {
  // "Mini-ITX" must not leave a loose "mini" behind — that word is a real
  // marker elsewhere, and letting the phrase drop it manufactured mismatches.
  assert.equal(NEG.variantMismatch('Jonsbo N3 Mini-ITX NAS Case', 'Jonsbo N3 ITX NAS Case'), false);
  assert.equal(NEG.variantMismatch('MSI B650 Gaming Plus', 'MSI B650 Gaming Plus micro ATX'), false);
});

test('real variant markers still reject, in BOTH directions', () => {
  // The fix narrows the marker set; it must not soften the guard itself.
  const mustReject = [
    ['Fractal Design AIR 903 Series', 'Fractal Design AIR 903 MAX'],           // tier
    ['MSI MEG X870E Ace', 'MSI MEG X870E ACE MAX Motherboard, ATX'],           // tier, ours-silent
    ['Fractal Design North', 'Fractal Design North XL ATX mATX Mid Tower'],     // size
    ['Fractal Design North Black', 'Fractal Design North ATX Chalk White'],     // colour
    ['ASUS ROG Strix B650E-I', 'Open Box - ASUS ROG Strix B650E-I ATX'],        // condition
  ];
  for (const [our, their] of mustReject) {
    assert.ok(NEG.variantMismatch(our, their), `must still reject: ${our} vs ${their}`);
  }
});

test('form factor in the MODEL NUMBER still rejects — that is the real discriminator', () => {
  // Dropping atx/matx/itx as markers is only safe because the model token
  // carries the distinction. Prove it does.
  assert.ok(NEG.variantMismatch('MSI B650 Gaming Plus WiFi ATX', 'MSI B650M GAMING PLUS WIFI micro ATX'));
  assert.ok(NEG.variantMismatch('ASRock H610M-HDV/M.2+ D5 Micro ATX', 'ASRock H610M-HDV/M.2 ATX'));
});

// ── Query construction ───────────────────────────────────────────────────────
test('the legacy queries come FIRST, so existing matches cannot be re-selected', () => {
  // The ordering is the safety property: broadening rungs are reachable only
  // after the legacy pair returns nothing, i.e. only for no_results products.
  // If this ever reorders, 606 working attachments are re-opened for
  // reselection against a wider candidate pool.
  const name = '27" Essential S3 (S36GD) Series FHD 1800R Curved Computer Monitor, 100Hz';
  const qs = NEG.buildQueries(name, 'Samsung');
  const legacy = NEG.extractKeywords(name, 'Samsung');
  assert.deepEqual(qs[0], { mode: 'exact', q: legacy });
  assert.deepEqual(qs[1], { mode: 'keyword', q: legacy });
});

test('a short, spec-stripped query exists further down the cascade', () => {
  const qs = NEG.buildQueries('27" Essential S3 (S36GD) Series FHD 1800R Curved Computer Monitor, 100Hz', 'Samsung');
  const short = qs.find((q) => q.q.split(/\s+/).length <= 4);
  assert.ok(short, 'no short rung was built');
  assert.ok(short.q.toLowerCase().startsWith('samsung'), `brand must lead: "${short.q}"`);
  // Live-measured: the spec-laden long form returns 0 hits for products Newegg
  // stocks. None of those tokens may appear in the broadening query.
  assert.doesNotMatch(short.q, /1800R|FHD|100Hz|Curved|Monitor|"/i);
});

test('no query is ever emitted with a stray quote mark', () => {
  // `27"` went to the API verbatim as an unmatchable term.
  for (const q of NEG.buildQueries('ARZOPA 16" 2.5K Portable Monitor 2560x1600 QHD IPS', 'ARZOPA')) {
    assert.doesNotMatch(q.q, /["“”'‘’]/, `stray quote in "${q.q}"`);
  }
});

test('buildQueries always retains the legacy exact= query', () => {
  // This change may only ADD reachable products. Anything matching today must
  // still be reachable by the exact query that reached it.
  const name = 'AMD Ryzen 9 9950X';
  const qs = NEG.buildQueries(name, 'AMD');
  const legacy = NEG.extractKeywords(name, 'AMD');
  assert.ok(qs.some((q) => q.q === legacy && q.mode === 'exact'),
    'legacy exact= query must remain in the cascade');
});

test('buildQueries never emits a single-term query', () => {
  // One term is a category scan: 20 rows of unrelated product for a wasted
  // request and a wasted rate-limit slot.
  for (const n of ['Corsair 4000D Airflow', 'AMD Ryzen 9 9950X', 'Monitor', '27" 1440p 165Hz']) {
    for (const q of NEG.buildQueries(n, 'X')) {
      assert.ok(q.q.split(/\s+/).length >= 2, `single-term query "${q.q}" from "${n}"`);
    }
  }
});

// ── A failed lookup is not an absence ────────────────────────────────────────
//
// The 2026-07-20 ingest dry run reported 166 products as having vanished from
// the feed. Every one came back on a throttled retry: the query cascade fired
// its rungs back-to-back, Rakuten rate-limited them, and `if (!res.ok) continue`
// turned the throttling into silence. Absence and failure MUST stay separable —
// this is the same inference that deleted 1,655 deals on 2026-07-06.
test('searchNewegg reports http_error, not no_results, when every query failed', async () => {
  const fetchImpl = async () => ({ ok: false, status: 429, text: async () => '' });
  const res = await NEG.searchNewegg(
    { n: 'AMD Ryzen 7 9800X3D', c: 'CPU', b: 'AMD' },
    { token: 't', mid: '1', fetchImpl },
  );
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'http_error',
    'a throttled lookup reported as no_results is indistinguishable from a delisted product');
  assert.ok(res.httpErrors > 0);
  assert.equal(res.httpErrors, res.queriesTried, 'every rung should be counted as tried');
});

test('a partial failure that still returns items is not an error outcome', async () => {
  // First rung 500s, a later rung succeeds. The product was found; the run is
  // not clean, but the outcome is a match.
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) return { ok: false, status: 500, text: async () => '' };
    return { ok: true, text: async () => `<items><item><productname>AMD Ryzen 7 9800X3D - Ryzen 7 9000 Series 8-Core Socket AM5</productname><sku>N82E16819113876</sku><price>479.00</price></item></items>` };
  };
  const res = await NEG.searchNewegg(
    { n: 'AMD Ryzen 7 9800X3D', c: 'CPU', b: 'AMD' },
    { token: 't', mid: '1', fetchImpl },
  );
  assert.equal(res.ok, true);
  assert.equal(res.httpErrors, 1, 'the failed rung must still be reported');
});

// ── Condition survives a UPC match ───────────────────────────────────────────
//
// The 2026-07-20 dry run accepted 20 Open Box SKUs, every one method='upc'.
// Nine were already in the pre-fix baseline, so this is not a regression — it
// is a hole the UPC shortcut has always had. An Open Box unit carries the
// manufacturer's UPC because it IS the same manufactured item; only the name
// says otherwise, and the UPC path returned before the name was ever consulted.
test('an Open Box listing is rejected even when the UPC matches exactly', () => {
  const notes = {};
  const m = scoreMatch(
    { n: 'ASUS B760M-AYW WiFi D4 II Intel B760 LGA 1700 microATX Motherboard', c: 'Motherboard', upc: '197105349827' },
    { name: 'Open Box - ASUS B760M-AYW WIFI D4 II Intel B760 (LGA 1700) microATX motherboard, PCIe',
      sku: 'N82E16813119744R', upc: '197105349827', price: 109.99 },
    notes,
  );
  assert.equal(m, null, 'a UPC match must not smuggle an Open Box unit past the guard');
  assert.equal(notes.reject, 'variant_condition');
});

test('refurbished and renewed are caught on the UPC path too', () => {
  const base = { n: 'Seagate IronWolf 12TB NAS Internal Hard Drive', c: 'Storage', upc: '763649114316', cap: 12000, pr: 250 };
  for (const label of ['Refurbished: Seagate IronWolf 12TB NAS Internal Hard Drive',
                       'Renewed Seagate IronWolf 12TB NAS Internal Hard Drive',
                       'Manufacturer Recertified Seagate IronWolf 12TB NAS Internal Hard Drive']) {
    const notes = {};
    assert.equal(scoreMatch(base, { name: label, sku: 'N82E1682200001R', upc: '763649114316', price: 240 }, notes), null, label);
    assert.equal(notes.reject, 'variant_condition', label);
  }
});

test('a genuine UPC match on a merely-truncated title still succeeds', () => {
  // The UPC shortcut exists for a reason: our titles are often truncated, and a
  // UPC match should not be thrown out over a missing word. Only CONDITION is
  // allowed to override it — narrowing this to model/tier words would break the
  // very case the shortcut was added for.
  const m = scoreMatch(
    { n: 'O11D MINI V2', c: 'Case', upc: '4718466012345' },
    { name: 'LIAN LI O11D MINI V2 Compact ATX Mid-Tower Airflow Computer Case Panoramic View',
      sku: 'N82E16811000001', upc: '4718466012345', price: 139.99 },
    {},
  );
  assert.ok(m, 'UPC shortcut must still work for truncated titles');
  assert.equal(m.method, 'upc');
});

test('both sides Open Box is a match, not a mismatch', () => {
  // Symmetric, like every other marker check: if we deliberately catalogue an
  // open-box product, the open-box listing is the RIGHT one.
  assert.equal(NEG.conditionMismatch(
    'Open Box - ASUS TUF Gaming B760-Plus WiFi',
    'Open Box - ASUS TUF GAMING B760-PLUS WIFI Intel B760 ATX motherboard'), false);
});

// ── Single-letter model suffixes ─────────────────────────────────────────────
//
// ASUS ships B650E-E, B650E-F and B650E-I as three different boards. The
// 2026-07-20 run attached our B650E-E to a B650E-I listing at score 0.895:
// prepare() splits "b650e-e" into "b650e e" and the lone letter, carrying no
// digit, is dropped before modelTokens() ever sees it.
test('a conflicting single-letter model suffix rejects', () => {
  const vm = variantMismatch(
    'ROG Strix B650E-E Gaming WiFi AMD B650 AM5 Ryzen Desktop 9000 8000 & 7000',
    'ASUS ROG Strix B650E-I Gaming WiFi AMD B650 AM5 Ryzen Desktop 9000 8000 & 7000');
  assert.ok(vm, 'B650E-E must not match B650E-I');
  assert.equal(vm.reason, 'model_suffix');
});

test('suffix conflict is judged per BASE model, and only on real disagreement', () => {
  assert.ok(NEG.modelSuffixConflict('ASUS ROG Strix Z890-A', 'ASUS ROG Strix Z890-H'));
  assert.ok(NEG.modelSuffixConflict('GIGABYTE B550M-K', 'GIGABYTE B550M-S'));
  // Same suffix — no conflict.
  assert.equal(NEG.modelSuffixConflict('ASUS ROG Strix B650E-E Gaming', 'ASUS ROG Strix B650E-E Gaming WiFi ATX'), false);
  // Different BASE models are the model-token check's business, not this one.
  assert.equal(NEG.modelSuffixConflict('ASUS Z890-A', 'ASUS B650E-A'), false);
});

test('a title that merely OMITS the suffix is not a conflict', () => {
  // Absence of evidence, not evidence of difference. Rejecting here would break
  // every legitimately-truncated Newegg title.
  assert.equal(NEG.modelSuffixConflict('ROG Strix B650E-E Gaming WiFi', 'ASUS ROG Strix B650E Gaming WiFi ATX motherboard'), false);
  assert.equal(NEG.modelSuffixConflict('ASUS Prime B840M-A-CSM', 'ASUS PRIME B840M-A-CSM Motherboard micro ATX'), false);
});

test('multi-letter suffixes are left to the existing checks', () => {
  // "-PLUS" is a marker, "-CSM" is a model line; neither is a single letter and
  // neither should be pulled into this check.
  assert.equal(NEG.modelSuffixConflict('ASUS TUF Gaming B650-PLUS WiFi', 'ASUS TUF GAMING B650-PLUS WIFI ATX'), false);
});

// ── Form factor: conflict-only ───────────────────────────────────────────────
//
// Demoting form factor to inert fixed the theirs-only false rejects and
// introduced a wrong-product bind. Product 20171 on the 2026-07-21 run: our
// "B650 … ATX" was attached to "B650M … micro ATX" at sim 1.000, because
// modelTokens is asymmetric (theirs holds both b650m and b650) and nothing else
// was left to object. Both behaviours are pinned here.
test('two DIFFERENT form factors reject', () => {
  const vm = variantMismatch(
    'B650 Gaming Plus WiFi Motherboard AMD B650 Socket AM5 ATX',
    'MSI B650M GAMING PLUS WIFI motherboard AMD B650 Socket AM5 micro ATX');
  assert.ok(vm, 'an mATX board must not bind to an ATX product');
  assert.equal(vm.reason, 'form_factor');
});

test('a form factor named on only ONE side still matches', () => {
  // The original defect. Newegg spells it out; our titles do not.
  assert.equal(variantMismatch(
    'MSI MAG X870 Tomahawk WiFi',
    'MSI MAG X870 TOMAHAWK WIFI Motherboard, ATX - Supports AMD Ryzen 9000 / 8000 / 7000'), false);
  assert.equal(variantMismatch(
    'ASUS ROG Strix B650E-I Gaming WiFi',
    'ASUS ROG Strix B650E-I Gaming WiFi AMD B650 AM5 mini-ITX mITX motherboard'), false);
});

test('a case listed for MULTIPLE form factors intersects, not conflicts', () => {
  // Newegg writes "ATX mATX" for chassis that accept both. Requiring equality
  // rather than overlap would reject every one of them.
  assert.equal(NEG.formFactorConflict(
    'Fractal Design North ATX Mid Tower Case',
    'Fractal Design North ATX mATX Mid Tower PC Case'), false);
  assert.equal(NEG.formFactorConflict(
    'Fractal Design North Micro ATX Case',
    'Fractal Design North ATX mATX Mid Tower PC Case'), false);
});

test('form-factor conflict is silent when either side omits it', () => {
  assert.equal(NEG.formFactorConflict('ASRock Z890 Taichi', 'ASRock Z890 Taichi OCF LGA 1851 ATX Motherboard'), false);
  assert.equal(NEG.formFactorConflict('Some ATX Board', 'Some Board'), false);
});

// ── Brand presence ───────────────────────────────────────────────────────────
//
// The 2026-07-22 live ingest bound commodity spec-defined products to the wrong
// manufacturer: a Micron ECC RDIMM to a NEMIX module, a Samsung SODIMM to an
// A-Tech, a Crucial P310 SSD to a Kingston KC600 — all at name-score 1.0,
// because nameSimilarity compares names only and our titles carried no brand.
test('a name match to a different manufacturer is rejected', () => {
  const drops = [
    [{ n: 'Micron DDR5 32GB ECC RDIMM 5600MHz', b: 'Micron' }, 'NEMIX RAM 32GB (1x32GB) DDR5 5600MHz ECC RDIMM'],
    [{ n: 'Samsung 32GB DDR5 4800MHz ECC RDIMM', b: 'Samsung' }, 'NEMIX RAM 32GB DDR5 4800MHz ECC RDIMM'],
    [{ n: 'SODIMM 16GB PC4 3200 DDR4 M471A2G43AB2-CWE', b: 'Samsung' }, 'A-Tech 16GB DDR4 3200 CL22 SODIMM Laptop Memory'],
    [{ n: 'P310 4TB SSD, PCIe Gen4 NVMe M.2 2280', b: 'Crucial', c: 'Storage' }, 'Kingston KC600 4TB SATA III 2.5 Internal SSD'],
  ];
  for (const [p, cand] of drops) {
    const bm = NEG.brandMismatch(p, cand);
    assert.ok(bm, `should reject: ${p.n} -> ${cand}`);
  }
  // And the rejection reaches scoreMatch on the name path (RAM case, plausible
  // price so the storage-price gate doesn't pre-empt it).
  const notes = {};
  assert.equal(scoreMatch(
    { n: 'Micron DDR5 32GB ECC RDIMM 5600MHz', b: 'Micron', pr: 300 },
    { name: 'NEMIX RAM 32GB (1x32GB) DDR5 5600MHz ECC RDIMM', sku: 'N82E1600', price: 300 }, notes), null);
  assert.equal(notes.reject, 'variant_brand');
});

test('brand gate keeps correct matches: naming-format, mislabeled b field, part-number slugs', () => {
  const keeps = [
    [{ n: '1TB WD Blue SA510 SATA SSD', b: 'WD', c: 'Storage' }, 'Western Digital 1TB Blue SA510 SATA III Internal SSD'],
    [{ n: 'WD_BLACK SN850X 2TB NVMe SSD', b: 'SanDisk', c: 'Storage' }, 'Western Digital 2TB Black SN850X NVMe Internal SSD'],
    [{ n: 'OWC 16GB Replacement for Crucial CT16G4SFRA266', b: 'Crucial' }, 'OWC 16GB DDR4 2666 PC4-21300 CL19 Notebook Memory'],
    [{ n: 'Western Digital 8TB WD Red Pro NAS HDD', b: 'Western Digital', c: 'Storage' }, 'WD Red Pro WD8005FFBX 8TB Enterprise NAS Hard Drive'],
    [{ n: 'Silicon Power 1TB SSD 3D NAND A55 SATA III', b: 'Silicon Power', c: 'Storage' }, 'Silicon Power 1TB Standard SATA III SSD'],
  ];
  for (const [p, cand] of keeps) {
    assert.equal(NEG.brandMismatch(p, cand), false, `should keep: ${p.n} -> ${cand}`);
  }
});

test('brand gate does not fire when we have no reliable brand token', () => {
  // No b field and a spec-leading name — we cannot judge, so we must not gate.
  assert.equal(NEG.brandMismatch({ n: '32GB DDR4 3200 CL22 SODIMM Kit' }, 'A-Tech 32GB DDR4 3200 CL22 SODIMM'), false);
});

test('brand gate never overrides a UPC match', () => {
  // UPC is authoritative; even a brand-absent candidate must attach on barcode.
  const m = scoreMatch(
    { n: 'Micron DDR5 32GB ECC RDIMM', b: 'Micron', upc: '649528937story' },
    { name: 'NEMIX RAM 32GB DDR5 ECC', sku: 'N82E1600', upc: '649528937story', price: 200 },
    {},
  );
  assert.ok(m);
  assert.equal(m.method, 'upc');
});

// ── Bundled-accessory variants ───────────────────────────────────────────────
//
// The bare-vs-heatsink collapse. Every pair below shares brand, model
// designation, capacity and condition, so every other gate passes them; only
// the accessory word separates the two SKUs. Both live cases come from the Best
// Buy mismatch queue: 50480 arrived there because a bare SN770 was pointing at
// an "SN850X with Heatsink", and relink dry run 32257835049 proposed writing
// the same shape into 50501 off the keyword-search tier with no UPC.
test('a bare storage part and its heatsink SKU are different products', () => {
  const drops = [
    ['50501 — the relink this gate exists to stop',
      'WD - BLACK SN850X 8TB Internal SSD PCIe Gen 4 x4 NVMe',
      'WD - BLACK SN850X 8TB Internal SSD PCIe Gen 4 x4 NVMe with Heatsink for PS5 and Desktops'],
    ['50480 — the mismap that put the row in the queue',
      'WD - BLACK SN770 1TB Internal SSD PCIe Gen 4 x4',
      'WD - BLACK SN850X 1TB Internal SSD PCIe Gen 4 x4 NVMe with Heatsink for PS5 and Desktops'],
    ['reverse direction — ours bundles, theirs is bare',
      'Samsung 990 PRO 2TB with Heatsink PCIe 4.0 NVMe',
      'Samsung 990 PRO 2TB PCIe 4.0 NVMe M.2 Internal SSD'],
    ['spelled as two words',
      'Crucial T700 4TB Gen5 NVMe M.2 SSD',
      'Crucial T700 4TB Gen5 NVMe M.2 SSD with Heat Sink'],
  ];
  for (const [label, ours, theirs] of drops) {
    const r = NEG.accessoryConflict(ours, theirs, 'Storage');
    assert.ok(r, `should reject: ${label}`);
    assert.equal(r.reason, 'accessory_heatsink');
  }
});

test('the accessory gate is silent when both sides agree', () => {
  assert.equal(NEG.accessoryConflict(
    'WD - BLACK SN850X 2TB Internal SSD with Heatsink',
    'WD - BLACK SN850X 2TB Internal SSD PCIe Gen 4 x4 with Heatsink for PS5', 'Storage'), false);
  // The three rows relinked on 2026-08-19 — this gate must not have touched them.
  assert.equal(NEG.accessoryConflict(
    'WD - BLACK SN770 1TB Internal SSD PCIe Gen 4 x4',
    'WD - BLACK SN770 1TB Internal SSD PCIe Gen 4 x4', 'Storage'), false);
  for (const cap of ['1TB', '2TB']) {
    const n = `Samsung - Geek Squad Certified Refurbished 970 EVO Plus ${cap} Internal SSD PCIe Gen 3 x4 NVMe`;
    assert.equal(NEG.accessoryConflict(n, n, 'Storage'), false);
  }
});

// Scope is the whole point: on a cooler the heatsink IS the product, and on a
// board it is a feature of the M.2 slot. Firing there would reject correct
// matches across two entire categories.
test('the accessory gate only applies where the accessory is an add-on', () => {
  const cooler = ['Noctua NH-D15 Premium CPU Cooler', 'Noctua NH-D15 Dual-Tower Heatsink CPU Cooler'];
  assert.equal(NEG.accessoryConflict(cooler[0], cooler[1], 'CPUCooler'), false);
  const board = ['ASUS ROG STRIX B650E-F Gaming WiFi', 'ASUS ROG STRIX B650E-F Gaming WiFi with M.2 Heatsink'];
  assert.equal(NEG.accessoryConflict(board[0], board[1], 'Motherboard'), false);
  // Same pair, storage category — proves the pass above is the scope and not a
  // regex that simply fails to match.
  assert.ok(NEG.accessoryConflict(board[0], board[1], 'Storage'));
});

test('the accessory conflict reaches scoreMatch as a variant reject', () => {
  const notes = {};
  assert.equal(scoreMatch(
    { n: 'WD - BLACK SN850X 8TB Internal SSD PCIe Gen 4 x4 NVMe', b: 'WD', c: 'Storage', cap: 8000, pr: 1299.99 },
    { name: 'WD - BLACK SN850X 8TB Internal SSD PCIe Gen 4 x4 NVMe with Heatsink for PS5 and Desktops',
      sku: 'N82E16820250001', price: 1699.99, upc: '' }, notes), null);
  assert.equal(notes.reject, 'variant_accessory');
  assert.equal(NEG.rejectKind(notes.reject), 'variant');
});
