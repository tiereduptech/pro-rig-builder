// Case discovery classifier + brand-from-search.
//
// The old detectCategory Case branch keyed ONLY on the tower nouns
// (pc/computer case, mid/full/mini-tower, chassis). Budget SFF brands (Apevia,
// Jonsbo, MUSETEX, …) title their cases "Micro-ATX Gaming Case" / "Mini-ITX Cube
// Case" / "SFF Case" — none of which carry those nouns — so 0 of them classified
// and every one fell through to a null category or a null brand and got dropped.
// That is a DISCOVERY hole, not a quality one: PCPartPicker lists all of them.
//
// This locks in: (a) SFF/gaming-case phrasing now classifies Case, (b) real case
// FEATURE text (AIO/GPU/mobo/PSU/radiator/tempered-glass support) does NOT knock a
// case out, (c) genuine non-cases (case fans, coolers, accessories, PSU-only) do
// NOT classify Case, and (d) budget brands resolve, with a brand-from-search
// fallback for the truly no-name row.
//
//   node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCategory, categorize, detectBrand, resolveDiscoveryBrand, notBuildableReason, stripCompatClauses, BRANDS } from '../catalog-classify.cjs';

const cat = (title) => detectCategory(stripCompatClauses(title));

test('SFF / gaming-case phrasing the tower-noun rule missed now classifies Case', () => {
  const cases = [
    'Apevia X-QT Micro-ATX Gaming Case with Tempered Glass',
    'Apevia Aura-S Mini-ITX Case, Tempered Glass Side Panel',
    'Apevia Predator Mini Tower Computer Case',
    'Apevia Genesis Pro ATX Mid Tower Gaming Case',
    'Apevia Crusader Micro-ATX Computer Case',
    'Apevia Trooper-G ATX Case',
    'MUSETEX ATX Mid Tower Gaming PC Case, 6 ARGB Fans Pre-Installed',
    'Zalman P10 ATX Mid Tower Computer Case',
    'Cougar MX330-G Mid Tower Case',
    'KEDIERS SFF Case Mini-ITX Small Form Factor Chassis',
  ];
  for (const n of cases) assert.equal(cat(n), 'Case', n);
});

test('standard tower cases still classify (no regression)', () => {
  for (const n of [
    'NZXT H7 Flow Mid Tower ATX PC Case',
    'Fractal Design Meshify 2 Full Tower Computer Case',
    'Corsair 4000D Airflow Mid-Tower ATX PC Case',
    'Lian Li O11 Dynamic EVO Full Tower Chassis',
  ]) assert.equal(cat(n), 'Case', n);
});

test('a real case is NOT knocked out by its own AIO/GPU/mobo/PSU/glass feature text', () => {
  // The live JONSBO D31 row — mentions GPU, mainboard, AIO, and ATX/SFX power. Those
  // are the case's SPECS; an over-eager cooler/GPU/PSU negative would wrongly drop it.
  assert.equal(cat('JONSBO D31 MESH Black Micro ATX Computer Case, MATX/ITX Mainboard/Support RTX 4090(335-400mm) GPU 360/280AIO, Power ATX/SFX: 100mm-220mm'), 'Case');
  assert.equal(cat('Apevia X-Pioneer ATX Mid Tower Gaming Case, Supports 360mm AIO Radiator & Full ATX Motherboard'), 'Case');
  assert.equal(cat('MUSETEX ATX Case with Tempered Glass Panel, GPU up to 400mm, SFX/ATX PSU Support'), 'Case');
});

test('genuine non-cases under a case query do NOT classify Case', () => {
  // case fan — a fan, belongs in CaseFan not Case
  assert.notEqual(cat('Apevia Twin Turbo 120mm ARGB Case Fan, 3-Pack'), 'Case');
  // "PC Case Fan" trips the "pc case" alternate but is still a FAN, not a case
  // (real live Apevia rows the pilot caught leaking into ACCEPTED before this guard)
  assert.notEqual(cat('APEVIA AF58S-BK 80mm Black PC Case Fan, 2000 RPM, Silent, 5-Pack'), 'Case');
  assert.notEqual(cat('Apevia AF312S-BK 120mm Ultra Silent Black PC Case Fan 3-Pack'), 'Case');
  // …but a real case that merely SHIPS WITH fans is NOT knocked out by the fan guard
  assert.equal(cat('Apevia Phenom-BK Micro-ATX Gaming PC Case with 3X 120mm ARGB Fans'), 'Case');
  assert.equal(cat('MUSETEX ATX PC Case Pre-Install 6 PWM ARGB Fans, Mid Tower Computer Case'), 'Case');
  // cooler — the CPUCooler branch owns it
  assert.equal(cat('Thermalright Peerless Assassin 120 SE Dual Tower CPU Air Cooler'), 'CPUCooler');
  // PSU-only listing (a "power supply" wins the PSU branch first)
  assert.equal(cat('Apevia ATX-PRO700W ATX Gaming Power Supply, 700W'), 'PSU');
  // accessory
  assert.notEqual(cat('PC Case Vertical GPU Mount Bracket Kit'), 'Case');
  assert.notEqual(cat('Computer Case Replacement Feet, Set of 4'), 'Case');
});

test('categorize keeps the Case prior only when there is no other positive signal', () => {
  // positive Case signal wins
  assert.equal(categorize('Apevia X-QT Micro-ATX Gaming Case', 'Case'), 'Case');
  // a PSU title under a (mistaken) Case source query is corrected to PSU, not left Case
  assert.equal(categorize('Apevia ATX-PRO700W 700W Gaming Power Supply', 'Case'), 'PSU');
});

test('budget case brands are in BRANDS and detect from the title', () => {
  for (const b of ['Apevia', 'Jonsbo', 'MUSETEX', 'Zalman', 'Cougar', 'Vetroo', 'KEDIERS']) {
    assert.ok(BRANDS.includes(b), `${b} missing from BRANDS`);
  }
  assert.equal(detectBrand('Apevia X-QT Micro-ATX Gaming Case', ''), 'Apevia');
  assert.equal(detectBrand('JONSBO D31 MESH Micro ATX Computer Case', ''), 'Jonsbo');
});

test('a carrying / travel / tote bag for a PC is NOT a case and IS non-buildable', () => {
  // the 4 real live rows the pilot leaked into ACCEPTED before this exclusion
  const bags = [
    'MRINCA Computer Desktop Tower Large Carrying Case for ATX Mid-Tower Desktop',
    'Wigojoy Computer Desktop Mid Tower Large Carrying Case, PC Travel Case',
    'BUBM Desktop Computer Carrying Case, Padded Nylon Carry Tote Bag for Transporting Computer',
    'CURMIO PC Carrying Case, Desktop Travel Bag for Full Computer Tower, Black',
  ];
  for (const n of bags) {
    assert.notEqual(cat(n), 'Case', n);                          // not classified a case
    assert.equal(notBuildableReason(n), 'carrying/travel bag', n); // and rejected as non-buildable
  }
  // a real case with a carry HANDLE must not be caught by the bag rule
  assert.equal(notBuildableReason('NZXT H9 Flow Mid Tower ATX Case with Carrying Handle'), null);
  assert.equal(cat('NZXT H9 Flow Mid Tower ATX Case with Carrying Handle'), 'Case');
});

test('category-first premise: real cases classify Case even with dust-filter/cable feature text', () => {
  // These two REAL cases were over-fire-rejected by notBuildableReason's dust-filter /
  // cable rules; the pilot now runs category-first and trusts this positive Case signal.
  assert.equal(cat('MSI MPG GUNGNIR 111R Mid Tower Gaming PC Case - Black, 4 x 120mm ARGB Fans, USB 3.2 Gen2x2 Type-C, Tempered Glass, Dust Filter'), 'Case');
  assert.equal(cat('VEVOR PC Gaming Case, Mid-Tower, Computer Case with High-Airflow Tempered Glass Panel, Dust Filter, Cable Management'), 'Case');
});

test('brand-from-search fills a no-name row without overriding a real title brand', () => {
  // title has the brand → search hint is not needed and does not override it
  assert.equal(resolveDiscoveryBrand('Apevia X-QT Micro-ATX Gaming Case', '', 'Case', 'Apevia'), 'Apevia');
  // no title brand, no manufacturer → the brand the search was scoped to fills the gap
  assert.equal(resolveDiscoveryBrand('X-QT Micro-ATX Gaming Case Tempered Glass', '', 'Case', 'Apevia'), 'Apevia');
  // manufacturer field still beats the search hint (authoritative)
  assert.equal(resolveDiscoveryBrand('Some Generic Mid Tower Case', 'Cooler Master Technology', 'Case', 'Apevia'), 'Cooler Master');
  // no hint, no brand anywhere → null (unchanged 3-arg behavior)
  assert.equal(resolveDiscoveryBrand('Some Generic Mid Tower Case', '', 'Case'), null);
});
