// Contract for src/search-match.js — the one matcher behind every search box.
//
// ── Why the pinned numbers live on a FIXTURE and not on the live catalog ─────
// The interesting numbers from the rewrite are live-catalog counts: "8gb" went
// from 1,095 matches to 135, "2tb" from 460 to 148, "144hz" from 122 to 33. The
// drop IS the fix — the old matcher let a query like "8gb" through on any row
// containing "128GB" — and a future change that quietly re-broadens matching
// would push those counts back up.
//
// Asserting those exact numbers against src/data/parts.js would go red on the
// next ingest, and the catalog is written several times a day (21 of the last
// 60 catalog commits are distinct days; 19 Aug alone has four). A test that
// fails every night is a test that gets deleted, so this file pins the numbers
// in the two places that hold still:
//
//   1. FIXTURE — real rows copied out of the catalog, frozen here. Exact match
//      sets, deterministic forever. This is where the SEMANTICS are pinned.
//   2. LIVE — invariants and ceilings over the real catalog. "Every row that
//      matches 8gb is actually an 8GB thing" stays true as the catalog grows,
//      and trips the moment matching widens again. The ceilings carry today's
//      counts so the numbers are on the record where they can be read.

import test from 'node:test';
import assert from 'node:assert/strict';
import RAW_PARTS from '../src/data/parts.js';
import { smartMatch, matchesText, normalizeText, buildProductBlob } from '../src/search-match.js';

// ── Fixture: real rows, lifted verbatim from the catalog on 2026-08-19 ───────
const GPU_5060TI = { n: 'Dual GeForce RTX™ 5060 Ti 8GB GDDR7 OC Edition Graphics Card, NVIDIA, Desktop (PCIe 5.0', b: 'ASUS', mpn: 'DUAL-RTX5060TI-O8G', asin: 'B0F7W1KVT3', memType: 'GDDR7', interface: 'PCI-Express x16', vram: 8, c: 'GPU' };
const MOBO_128GB = { n: 'PRO B760-P WiFi DDR4 ATX Motherboard, 4X DDR4~128GB, 5X PCI-E x16', b: 'MSI', mpn: '7D98-001R', asin: 'B0BJW1G7VN', socket: 'LGA1700', memType: 'DDR4', chipset: 'B760', ff: 'ATX', c: 'Motherboard' };
const MOBO_B650 = { n: 'Gigabyte B650 AORUS Elite AX', b: 'Gigabyte', mpn: 'B650M AORUS ELITE AX', socket: 'AM5', memType: 'DDR5', chipset: 'B650', ff: 'ATX', c: 'Motherboard' };
const SSD_1TB = { n: 'Crucial T700 1TB NVMe Gen5', b: 'Crucial', mpn: 'CT1000T700SSD3', interface: 'NVMe', ff: 'M.2 2280', storageType: 'NVMe', cap: 1000, c: 'Storage' };
const SSD_2TB = { n: 'Crucial T700 2TB NVMe Gen5', b: 'Crucial', mpn: 'CT2000T700SSD3', interface: 'NVMe', ff: 'M.2 2280', storageType: 'NVMe', cap: 2000, c: 'Storage' };
const MON_240HZ = { n: 'LG 27GR95QE 27in 1440p 240Hz OLED', b: 'LG', res: '2560x1440', resolution: '1440p', refresh: 240, c: 'Monitor' };
const MON_144HZ = { n: 'Samsung Odyssey G7 28in 4K 144Hz', b: 'Samsung', res: '3840x2160', resolution: '4K', refresh: 144, c: 'Monitor' };
const RAM_GSKILL = { n: 'RipjawsV Series DDR4 RAM (XMP) 32GB (2x16GB) 3200MT/s CL16-18-18-38 1.35V Intel AMD Desktop Computer Memory U-DIMM', b: 'G.Skill', mpn: 'RipJaws V', asin: 'B0171GQR0C', memType: 'DDR4', cap: 32, speed: 3200, cl: 16, c: 'RAM' };
const RAM_CORSAIR = { n: 'Corsair Vengeance RGB DDR5 32GB (2x16GB) 6400MHz CL32', b: 'Corsair', memType: 'DDR5', cap: 32, speed: 6400, cl: 32, c: 'RAM' };
const CPU_12700K = { n: 'Intel Core i7-12700K', b: 'Intel', mpn: 'BX8071512700K-0', socket: 'LGA1700', memType: 'DDR5', cores: 12, threads: 20, c: 'CPU' };
// Carries the string "CM8071504650608" in its own name — the row that made the
// old substring matcher answer "650" with an Intel i5.
const CPU_12400 = { n: 'Intel CORE I5-12400 Desktop Processor LGA 1700 10 (6P+0E) Cores (18M Cache UP to 4.40 GHZ) with Intel Laminar RM1 Air Cooler. OEMTray (CM8071504650608) (Bulk Packaging)', b: 'Intel', socket: 'LGA1700', cores: 6, c: 'CPU' };

const FIXTURE = [GPU_5060TI, MOBO_128GB, MOBO_B650, SSD_1TB, SSD_2TB, MON_240HZ, MON_144HZ, RAM_GSKILL, RAM_CORSAIR, CPU_12700K, CPU_12400];
const NAMES = new Map(FIXTURE.map(p => [p, Object.entries({ GPU_5060TI, MOBO_128GB, MOBO_B650, SSD_1TB, SSD_2TB, MON_240HZ, MON_144HZ, RAM_GSKILL, RAM_CORSAIR, CPU_12700K, CPU_12400 }).find(([, v]) => v === p)[0]]));
const hits = (q) => FIXTURE.filter(p => smartMatch(p, q)).map(p => NAMES.get(p)).sort();
/** Exact match set over the fixture — not a count, so a failure names the row. */
const expect = (q, ...expected) => assert.deepEqual(hits(q), expected.sort(), `query ${JSON.stringify(q)}`);

// ── The reported bug ─────────────────────────────────────────────────────────

test('a prefix of any word matches — this is the reported bug', () => {
  // "rtx 5060 t" returned nothing site-wide: the old matcher forced any 1-3
  // character token containing a letter to match a whole word, so the half-typed
  // "t" could never reach "Ti".
  expect('rtx 5060 t', 'GPU_5060TI');
  expect('rtx 5060 ti', 'GPU_5060TI');
  expect('corsai', 'RAM_CORSAIR');
  expect('gigab', 'MOBO_B650');
});

test('word order does not matter', () => {
  expect('ti 5060 rtx', 'GPU_5060TI');
  expect('5060 ti rtx', 'GPU_5060TI');
  expect('ddr5 corsair', 'RAM_CORSAIR');
});

test('spacing, case and punctuation in the query do not matter', () => {
  for (const q of ['i7-12700', 'i7 12700', 'I7   12700', ' i7-12700 ', 'i7/12700']) {
    expect(q, 'CPU_12700K');
  }
});

test('punctuation in the DATA does not matter — "gskill" reaches "G.Skill"', () => {
  expect('gskill', 'RAM_GSKILL');
  expect('g.skill', 'RAM_GSKILL');
  expect('g skill', 'RAM_GSKILL');
});

test('a glued query token finds text that spells it apart', () => {
  expect('5060ti', 'GPU_5060TI');   // vs "5060 Ti"
  expect('b650', 'MOBO_B650');
  expect('650', 'MOBO_B650');       // and the pieces are addressable
});

test('brand and specs are searchable, not just the name', () => {
  expect('asus', 'GPU_5060TI');                    // b field
  expect('am5', 'MOBO_B650');                      // socket
  expect('cl32', 'RAM_CORSAIR');                   // cl
  expect('6400mhz', 'RAM_CORSAIR');                // speed + unit
  expect('6400', 'RAM_CORSAIR');                   // and bare
  expect('lga1700', 'CPU_12700K', 'CPU_12400', 'MOBO_128GB');
  expect('12core', 'CPU_12700K');                  // cores
  expect('b0f7w1kvt3', 'GPU_5060TI');              // asin
});

// ── The false positives the rewrite removed. These ARE the pinned counts. ────

test('PINNED: "8gb" does not match a 128GB motherboard (live: 1095 -> 135)', () => {
  // The old glued fallback accepted "the digits appear ANYWHERE and the letters
  // match a word", so "128GB" satisfied "8gb" and 960 of the 1,095 live matches
  // were rows like this one. Re-broadening matching brings them straight back.
  expect('8gb', 'GPU_5060TI');
  assert.equal(smartMatch(MOBO_128GB, '8gb'), false, 'a 128GB board is not an 8GB part');
});

test('PINNED: "2tb" does not match a 1TB M.2 2280 drive (live: 460 -> 148)', () => {
  // "M.2 2280" supplied the "2" and "1TB" supplied the "tb", so every 1TB NVMe
  // drive in the catalog answered a search for 2TB.
  expect('2tb', 'SSD_2TB');
  assert.equal(smartMatch(SSD_1TB, '2tb'), false, 'a 1TB drive is not a 2TB drive');
  expect('1tb', 'SSD_1TB');
});

test('PINNED: "144hz" does not match a 240Hz monitor (live: 122 -> 33)', () => {
  expect('144hz', 'MON_144HZ');
  assert.equal(smartMatch(MON_240HZ, '144hz'), false, 'a 240Hz panel is not 144Hz');
});

test('PINNED: matching is prefix-of-a-word, never substring-anywhere', () => {
  // The single most likely regression is someone replacing the word-prefix test
  // with String.includes on the blob. Each of these passes under substring
  // matching and must not pass here.
  assert.equal(smartMatch(CPU_12400, '650'), false, 'an ASIN fragment is not a model number');
  assert.equal(smartMatch(RAM_CORSAIR, 'orsair'), false, 'mid-word is not a prefix');
  assert.equal(smartMatch(MON_240HZ, '40hz'), false, 'mid-word is not a prefix');
  assert.equal(smartMatch(SSD_1TB, '000'), false, 'mid-number is not a prefix');
});

test('every query token must match — they narrow, never widen', () => {
  expect('corsair ddr5', 'RAM_CORSAIR');   // one row is both
  expect('corsair ddr4');                  // no row is both, though the fixture has each
  expect('asus 5060 ti', 'GPU_5060TI');
  expect('asus corsair');
});

// ── Normalizer ───────────────────────────────────────────────────────────────

test('normalizeText fences the split pieces so unrelated pairs cannot join', () => {
  // b650 and x670 both split; without the fence the string reads "b 650 x 670"
  // and "650x" would match the seam between two different model numbers.
  const blob = normalizeText('B650 X670');
  assert.equal(blob.includes(' 650 x'), false, 'the seam must not be matchable');
  assert.ok(blob.includes(' b 650'), 'the real pair must still be matchable');
});

test('an empty query matches everything; a punctuation-only query does too', () => {
  for (const q of ['', null, undefined, '   ', '---']) {
    assert.equal(smartMatch(MOBO_128GB, q), true, `query ${JSON.stringify(q)}`);
  }
});

test('matchesText — the SearchSelect path — uses the same rules', () => {
  assert.equal(matchesText('GeForce RTX 5060 Ti · 8GB · ASUS', 'rtx 5060 t'), true);
  assert.equal(matchesText('GeForce RTX 5060 Ti · 8GB · ASUS', 'ti 5060'), true);
  assert.equal(matchesText('Optimized Cooling Kit', 'ti'), false, 'not the "ti" inside "Optimized"');
  assert.equal(matchesText('Radeon RX 7900 XTX', 'rtx'), false);
});

test('a product with no searchable text at all does not crash or match', () => {
  const empty = { c: 'GPU' };
  assert.equal(smartMatch(empty, ''), true);
  assert.equal(smartMatch(empty, 'rtx'), false);
  assert.equal(buildProductBlob(empty), ' ');
});

// ── Live catalog: the invariants that must hold as the catalog grows ─────────
//
// These read src/data/parts.js, which changes several times a day, so they
// assert shape rather than exact counts. Together with the fixture above they
// are what catches a quiet re-broadening.

// Mirrors what App.jsx actually searches: needsReview rows are dropped and
// everything out of stock at every retailer is hidden.
const isAvailable = (p) => {
  if (!p.deals || typeof p.deals !== 'object') return true;
  const keys = Object.keys(p.deals).filter(k => p.deals[k] && typeof p.deals[k] === 'object' && p.deals[k].price);
  return keys.length ? keys.some(k => p.deals[k].inStock !== false) : true;
};
const LIVE = RAW_PARTS.filter(p => !p.needsReview).filter(isAvailable);
const liveHits = (q) => LIVE.filter(p => smartMatch(p, q));
const text = (p) => `${p.n || ''} ${p.fullTitle || ''}`;

test('LIVE: the catalog is big enough for these assertions to mean something', () => {
  assert.ok(LIVE.length > 3000, `only ${LIVE.length} searchable rows — the filters or the data moved`);
});

test('LIVE: every "8gb" match is genuinely an 8GB part', () => {
  const wrong = liveHits('8gb').filter(p => !(p.vram === 8 || p.cap === 8 || /(?<![0-9])8\s*gb/i.test(text(p))));
  assert.deepEqual(wrong.map(p => p.n).slice(0, 5), [], `${wrong.length} rows match "8gb" without being 8GB`);
});

test('LIVE: every "2tb" match is genuinely a 2TB part', () => {
  const wrong = liveHits('2tb').filter(p => !(p.cap === 2000 || p.cap === 2 || /(?<![0-9])2\s*tb/i.test(text(p))));
  assert.deepEqual(wrong.map(p => p.n).slice(0, 5), [], `${wrong.length} rows match "2tb" without being 2TB`);
});

test('LIVE: every "144hz" match is genuinely a 144Hz part', () => {
  const wrong = liveHits('144hz').filter(p => !(p.refresh === 144 || /(?<![0-9])144\s*hz/i.test(text(p))));
  assert.deepEqual(wrong.map(p => p.n).slice(0, 5), [], `${wrong.length} rows match "144hz" without being 144Hz`);
});

test('LIVE: spec queries stay inside their ceiling', () => {
  // Counts as measured on 2026-08-19, old matcher -> new matcher. The ceiling
  // sits well above today's number so catalog growth does not trip it, and well
  // below the old one so a return to loose matching does.
  const CEILINGS = [
    { q: '8gb', was: 1095, now: 135, ceiling: 400 },
    { q: '2tb', was: 460, now: 148, ceiling: 320 },
    { q: 'nvme 2tb', was: 252, now: 93, ceiling: 200 },
    { q: '144hz', was: 122, now: 33, ceiling: 90 },
  ];
  for (const { q, was, now, ceiling } of CEILINGS) {
    const n = liveHits(q).length;
    assert.ok(n <= ceiling, `"${q}" matches ${n} rows, over the ${ceiling} ceiling (was ${was} before the rewrite, ${now} after) — matching has re-broadened`);
    assert.ok(n > 0, `"${q}" matches nothing — matching has over-narrowed (${now} at the time of writing)`);
  }
});

test('LIVE: no recall lost on the sets that must be complete', () => {
  // The counts came down by removing false positives, not by dropping real
  // rows. Every part that IS the thing must still be findable by typing it.
  const gpu8 = LIVE.filter(p => p.c === 'GPU' && p.vram === 8);
  assert.ok(gpu8.length > 20, `only ${gpu8.length} 8GB GPUs — check the fixture assumptions`);
  assert.deepEqual(gpu8.filter(p => !smartMatch(p, '8gb')).map(p => p.n), [], '8GB GPUs missing from "8gb"');

  const tb2 = LIVE.filter(p => p.c === 'Storage' && p.cap === 2000);
  assert.ok(tb2.length > 20, `only ${tb2.length} 2TB drives — check the fixture assumptions`);
  assert.deepEqual(tb2.filter(p => !smartMatch(p, '2tb')).map(p => p.n), [], '2TB drives missing from "2tb"');

  const hz144 = LIVE.filter(p => p.c === 'Monitor' && p.refresh === 144);
  assert.deepEqual(hz144.filter(p => !smartMatch(p, '144hz')).map(p => p.n), [], '144Hz monitors missing from "144hz"');
});

test('LIVE: a half-typed model still finds the finished one', () => {
  const full = liveHits('rtx 5060 ti');
  const partial = liveHits('rtx 5060 t');
  assert.ok(full.length > 0, 'no RTX 5060 Ti in the catalog — the assertion below is vacuous');
  const missing = full.filter(p => !partial.includes(p));
  assert.deepEqual(missing.map(p => p.n), [], 'typing one character less lost results');
});
