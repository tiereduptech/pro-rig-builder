// titleMatches() directional-recall rescue for verbose stored names.
//
// score = |A∩B| / |A| (stored-token recall) alone sinks a correct match when the
// STORED name is long marketing text against a clean Amazon title. The nightly
// ASIN-identity audit measured 335 such rows — 60% of ALL title-flags — as false
// mismatches. The rescue adds the reverse direction (Amazon-in-stored containment)
// under a hard capacity gate + a brand check on the weaker arm, so a same-brand
// different-model "close-but-wrong" is NOT rescued.
//
//   node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { titleMatches } from '../drift-gate.js';

test('verbose stored name vs clean Amazon title now matches (the 335 class)', () => {
  const stored = 'Intel - Core i9-14900K 14th Gen 24-Core 32-Thread - 4.4GHz (6.0GHz Turbo) Socket LGA 1700 Unlocked Desktop Processor - M';
  const amazon = 'Intel Core i9-14900K Desktop Processor';
  const r = titleMatches(stored, amazon);
  assert.equal(r.match, true);            // rescued: every Amazon token is in the stored name
  assert.ok(r.score < 0.5);               // forward recall alone would have failed it
});

test('an Amazon title that is a near-subset of the stored name matches (bInA arm)', () => {
  const stored = 'Samsung 990 PRO 2TB PCIe 4.0 NVMe M.2 Internal Solid State Drive SSD with Heatsink MZ-V9P2T0CW';
  const amazon = 'Samsung 990 PRO 2TB NVMe SSD';
  assert.equal(titleMatches(stored, amazon).match, true);
});

test('same brand, DIFFERENT model line still fires (real close-but-wrong)', () => {
  // From the audit's labelled close-but-wrong set (id 60009): same brand, a
  // different product line AND wattage. Distinguishing spec tokens keep both
  // containment arms below threshold, so the rescue does NOT swallow it.
  const stored = 'be quiet! Straight Power 12 850W';
  const amazon = 'be quiet! Pure Power 13 M 1000W, ATX 3.1, Fully Modular PSU, 80+ Gold';
  assert.equal(titleMatches(stored, amazon).match, false);
});

test('KNOWN BOUNDARY: a same-brand diff-model pair whose non-model tokens overlap ' +
     '>=75% can be rescued — accepted to match the audit classifier exactly. The ' +
     'price-divergence flag is the backstop for this narrow case.', () => {
  const stored = 'LG 27GP850-B UltraGear 27 inch QHD Nano IPS 165Hz Gaming Monitor';
  const amazon = 'LG 27GS75Q-B UltraGear 27 inch QHD IPS 200Hz Gaming Monitor';
  // Documented, not asserted-against: the weak arm (max>=.75 && brand) rescues it.
  // Zero such pairs occur in the 3682-row catalog; recorded so the trade-off is
  // visible and a future tightening has a regression anchor.
  assert.equal(titleMatches(stored, amazon).match, true);
});

test('capacity conflict is still a HARD veto, even with high containment', () => {
  // Identical family, wrong capacity — vendors reuse one title across sizes.
  const stored = 'Samsung 990 PRO 1TB NVMe SSD';
  const amazon = 'Samsung 990 PRO 4TB PCIe 4.0 NVMe M.2 Internal Solid State Drive SSD';
  const r = titleMatches(stored, amazon);
  assert.equal(r.capConflict, true);
  assert.equal(r.match, false);
});

test('genuinely different product (no shared brand) still fails', () => {
  const stored = 'Corsair Vengeance RGB DDR5 32GB 6400MHz CL32';
  const amazon = 'G.SKILL Trident Z5 DDR5 64GB 6000MHz CL30';
  assert.equal(titleMatches(stored, amazon).match, false);
});
