// bundleReason() — multi-component combo detector.
//
// A "Ryzen 9 7900X + B650 Motherboard" combo left in the CPU (or Motherboard)
// category misprices the builder: it shows as a bare CPU at the combined price.
// This gate rejects such combos on ingest (wired into apply-newegg-discoveries,
// apply-amazon-discoveries, discover-newegg-dry) — the Newegg path previously had
// only a word-based PREBUILT_RE that missed a "+ Motherboard" combo with no
// "bundle"/"combo" word.
//
// The five names in FALSE_POSITIVES are real live-catalog rows the detector MUST
// leave as single products (fan multipacks, an SSD+cable kit, an SSD+warranty
// bundle, and a plain board whose "12 + 2 power stages" must not read as a combo).
//
//   node --test

import test from 'node:test';
import assert from 'node:assert/strict';
import cc from '../catalog-classify.cjs';
const { bundleReason } = cc;

// The 3 confirmed combos (ids 10141, 20065, 20492) — all CPU + motherboard.
const REAL_BUNDLES = [
  'Ryzen 9 7900X + GIGABYTE B650 AORUS ELITE AX Motherboard',
  'Ryzen 5 7600X + GIGABYTE B650 AORUS ELITE AX Motherboard',
  'AMD Ryzen 7 9700X CPU Processor with MSI B850 Gaming Plus WiFi Motherboard',
];

// Live-catalog rows that are SINGLE products — must return null.
const FALSE_POSITIVES = [
  'iCUE Link QX120 RGB 120mm Magnetic Dome RGB Fans - Triple Fan Starter Kit with iCUE Link System Hub - Black', // 85045 fan kit
  'iCUE SP140 RGB Elite Performance 140mm White PWM Dual Fan Kit with Lighting Node CORE',                        // 85181 fan kit
  'ROG Strix B650-A Gaming WiFi AMD B650 AM5 Ryzen™ Desktop 9000 8000 & 7000 ATX motherboard, 12 + 2 power stages, DDR5', // 20052 plain board
  'CS900 2TB 2.5” SATA III Internal SSD - Complete Upgrade Kit with Transfer Cable and Software - Up to 550/530 MB/s', // 50180 SSD+cable
  'MZ-V9P4T0B/AM 990 PRO PCIe 4.0 NVMe M.2 SSD 4TB Bundle with 2 YR CPS Enhanced Protection Pack',                // 50461 SSD+warranty
];

// Plain components + compatibility text that must NOT be flagged.
const SINGLES = [
  'AMD Ryzen 9 7900X',
  'GIGABYTE B650 AORUS ELITE AX (Socket AM5) AMD B650 ATX DDR5 Motherboard',
  'ASUS TUF Gaming B650-Plus WiFi AMD B650 ATX Motherboard, supports Ryzen 9 7950X, 12+2 power stages, DDR5, PCIe 5.0',
  'NVIDIA GeForce RTX 4090',
  'CORSAIR Vengeance 32GB (2x16GB) DDR5 6000 Kit',
  'Corsair CX750M 750W 80+ Bronze Semi-Modular ATX Power Supply',
];

test('flags the 3 confirmed CPU+motherboard combos', () => {
  for (const n of REAL_BUNDLES) {
    const r = bundleReason(n);
    assert.ok(r, `expected a bundle reason for: ${n}`);
    assert.equal(r, 'cpu+mobo', `expected cpu+mobo for: ${n} (got ${r})`);
  }
});

test('leaves the 5 false-positive candidates as single products', () => {
  for (const n of FALSE_POSITIVES) {
    assert.equal(bundleReason(n), null, `must NOT be flagged as a bundle: ${n}`);
  }
});

test('does not flag plain components or compatibility text', () => {
  for (const n of SINGLES) {
    assert.equal(bundleReason(n), null, `must NOT be flagged: ${n}`);
  }
});

test('flags a non-CPU multi-component combo (GPU + PSU)', () => {
  assert.ok(bundleReason('ASUS RTX 4070 Graphics Card + Corsair RM750 Power Supply Bundle'));
});

test('null-safe on empty/undefined', () => {
  assert.equal(bundleReason(''), null);
  assert.equal(bundleReason(undefined), null);
  assert.equal(bundleReason(null), null);
});
