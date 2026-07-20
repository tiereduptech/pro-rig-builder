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
