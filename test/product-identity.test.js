// The canonical key must name a PRODUCT, not a class of products.
//
// Every pair below is a real collision from this catalog. The five storage
// rows named here are the five whose Best Buy sku resolves to a different
// drive — 50465, 50466, 50480, 50485, 50501 — and every one of them was linked
// by the name tier, which asked for a canonical key and got a bucket:
//
//   "Samsung 970 EVO Plus 1TB Internal SSD"      -> SAMSUNG|1TB|SSD
//   "Samsung T7 1TB External Portable SSD"       -> SAMSUNG|1TB|SSD
//
// Same key, so the T7's listing was attached to the 970 EVO Plus row, and no
// price check downstream could object: the price was the T7's real price.
//
//   node --test test/product-identity.test.js

import test from 'node:test';
import assert from 'node:assert/strict';

const {
  canonicalizeProductName, extractModelToken, modelDesignations, namesAgreeOnModel,
} = await import('../normalize-product-name.js');

// The five mismapped rows, catalog name vs the name Best Buy returns for the
// sku the row points at (from the 2026-08-17 dead-sku audit's bySku map).
const MISMAPPED = [
  [50465, 'Samsung - Geek Squad Certified Refurbished 970 EVO Plus 1TB Internal SSD PCIe Gen 3 x4 NVMe',
          'Samsung - T7 1TB External USB 3.2 Gen 2 Portable SSD with Hardware Encryption - Titan Gray'],
  [50466, 'Samsung - Geek Squad Certified Refurbished 970 EVO Plus 2TB Internal SSD PCIe Gen 3 x4 NVMe',
          'Samsung - T7 2TB External USB 3.2 Gen 2 Portable SSD with Hardware Encryption - Titan Gray'],
  [50480, 'WD - BLACK SN770 1TB Internal SSD PCIe Gen 4 x4',
          'WD - BLACK SN850X 1TB Internal SSD PCIe Gen 4 x4 NVMe with Heatsink for PS5 and Desktops'],
  [50485, 'WD - Blue SA510 2TB Internal SSD SATA',
          'WD - BLACK SN850P 2TB Internal SSD PCIe Gen 4 x4 with Heatsink for PS5'],
  [50501, 'WD - BLACK SN850X 8TB Internal SSD PCIe Gen 4 x4 NVMe',
          'WD - BLACK SN850P 8TB Internal SSD PCIe Gen 4 x4 with Heatsink for PS5'],
];

test('the mismapped rows do not share a canonical key with the sku they got', () => {
  for (const [id, ours, theirs] of MISMAPPED) {
    const a = canonicalizeProductName(ours, 'Storage');
    const b = canonicalizeProductName(theirs, 'Storage');
    assert.ok(a, `${id}: catalog name does not canonicalize`);
    assert.ok(b, `${id}: Best Buy name does not canonicalize`);
    assert.notEqual(a, b, `${id}: "${a}" keys both products — that is how it was mismapped`);
  }
});

test('the mismapped rows are a MISMATCH, not a doubt', () => {
  for (const [id, ours, theirs] of MISMAPPED) {
    assert.equal(namesAgreeOnModel(ours, theirs).verdict, 'mismatch', `${id}`);
  }
});

test('prose drift on the same product is not a mismatch', () => {
  // Catalog names come from manufacturers, Best Buy's from Best Buy. Words
  // differ constantly on rows that are the same product; designations do not.
  const same = [
    ['WD - BLACK SN850X 1TB Internal SSD PCIe Gen 4 x4 NVMe',
     'WD Black SN850X 1TB NVMe Gen4'],
    ['MSI MPG271QRXQDOLED',
     'MSI - MPG 271QRX QD-OLED 27" 360Hz Gaming Monitor'],
    ['Samsung - Geek Squad Certified Refurbished 980 PRO 1TB Internal SSD PCIe Gen 4 x4',
     'Samsung 980 Pro 1TB NVMe Gen4'],
  ];
  for (const [a, b] of same) assert.equal(namesAgreeOnModel(a, b).verdict, 'match', `${a} / ${b}`);
});

test('a name with no model designation is unverifiable, never a mismatch', () => {
  // Neither name carries one, so there is nothing to compare and the answer is
  // "cannot tell" — the daily refresh counts these and leaves them alone.
  assert.equal(namesAgreeOnModel('Fractal Design - North Charcoal Black',
    'North - Genuine Walnut Wood Front').verdict, 'unverifiable');
  assert.equal(namesAgreeOnModel('Corsair iCUE Link Titan RX LCD', 'Corsair - iCUE LINK TITAN RX LCD Liquid CPU Cooler').verdict, 'unverifiable');
});

test('90365 is a mismatch — but on the resolution, not the model', () => {
  // Worth pinning because it is not what the hold reason implies. Lenovo's
  // catalog name designates P24q-40; Best Buy's drops the model and the only
  // digits left that are not units are the resolution, 2560x1440. The verdict
  // is right — a 48-120Hz QHD panel is not a 60Hz P24q-40 — but the evidence it
  // rests on is "p24q != 2560x1440", so do not read this row as proof that the
  // check caught a model conflict.
  const v = namesAgreeOnModel(
    'Lenovo - ThinkVision P24Q-40 24" Class WQHD LED Monitor - 16:9 - Raven',
    'Lenovo - ThinkVision 23.8" IPS LED QHD (2560x1440) 48Hz - 120Hz Monitor (HDMI, DP - Black');
  assert.equal(v.verdict, 'mismatch');
  assert.deepEqual(v.a, ['p24q']);
  assert.deepEqual(v.b, ['2560x1440']);
});

test('units are not model designations', () => {
  assert.deepEqual(modelDesignations('WD - Blue SA510 2TB Internal SSD SATA 6 Gb/s'), ['sa510']);
  assert.deepEqual(modelDesignations('Samsung - 970 EVO Plus 1TB PCIe Gen 3 x4'), ['970']);
  // Capacity, speed and count-of-sticks drop out; DDR5 and CL30 stay, which is
  // right for RAM — they are part of what identifies the kit.
  assert.deepEqual(modelDesignations('Corsair Vengeance 32GB DDR5 6000MHz CL30 2x16GB Kit'),
    ['ddr5', 'cl30', '2x16gb']);
});

test('two PSUs of the same wattage and rating are two products', () => {
  const rm = canonicalizeProductName('Corsair - RM850x 850W 80+ Gold Fully Modular', 'PSU');
  const hx = canonicalizeProductName('Corsair - HX850 850W 80 Plus Gold Fully Modular', 'PSU');
  assert.equal(rm, 'CORSAIR|850W|RM850X');
  assert.notEqual(rm, hx);
});

test('the last segment of a key is the model, for every category it keys', () => {
  // It was the interface word for Storage ("SSD") and the 80 PLUS rating for
  // PSUs ("GOLD"), which made verify-catalog-asins.js's strict model-token
  // gate ask whether an Amazon title contains the word SSD.
  assert.equal(extractModelToken('WD - Blue SA510 2TB Internal SSD SATA', 'Storage'), 'SA510');
  assert.equal(extractModelToken('Corsair - RM850x 850W 80+ Gold', 'PSU'), 'RM850X');
  assert.equal(extractModelToken('AMD Ryzen 9 5900X 12-Core 3.7 GHz Socket AM4', 'CPU'), '5900X');
});

test('a transfer rate is not a capacity', () => {
  // "2TB WD Red Plus NAS … SATA 6 Gb/s" keyed as a 6GB drive, because the old
  // pattern started looking for a size AFTER the brand and 6 Gb/s was next.
  const k = canonicalizeProductName('2TB WD Red Plus NAS Internal Hard Drive HDD - 5400 RPM, SATA 6 Gb/s, CMR', 'Storage');
  assert.ok(k.startsWith('WD|2TB|'), `keyed as ${k}`);
});

test('a name with no designation at all does not canonicalize', () => {
  // Better a missed match than a key that stands for every drive in its class.
  assert.equal(canonicalizeProductName('Seagate Barracuda 4TB HDD SATA', 'Storage'), null);
});

test('CPU and GPU keys are unchanged — src/data/asin-overrides.json is keyed by them', () => {
  assert.equal(canonicalizeProductName('AMD Ryzen 9 9950X3D 16-Core', 'CPU'), 'AMD|Ryzen 9|9950X3D');
  assert.equal(canonicalizeProductName('Intel Core Ultra 7 265KF 20-Core', 'CPU'), 'INTEL|Core Ultra 7|265KF');
  assert.equal(canonicalizeProductName('ASUS TUF Gaming GeForce RTX 5080 16GB', 'GPU'), 'NVIDIA|RTX|5080');
});
