// Case gate fixes — 2026-08-10 Newegg/Best Buy case sweep.
//
// Every title below is a REAL row from the sweep of 1,824 Newegg case-leaf products and
// 106 Best Buy first-party cases, and every one was being rejected or mis-filed by a gate.
// The sweep measured ~48 real chassis killed, 38 of them tier-1 brands, plus 56 rackmount
// server chassis wrongly ADMITTED (Case was the one core category with no scope gate).
//
// The five over-fires, each locked in below:
//   1. plural "Cases"          — Newegg's own suffix is "(Computer Cases - ATX Form)"
//   2. "desktop case"          — missing head noun; PSU branch then claimed the row
//   3. bare riser/vertical-gpu — a case that SHIPS a riser was called an accessory
//   4. motherboard support text— "Back Connect Motherboard Support" read as a Motherboard
//   5. PSU support text        — "Front PSU Chamber" read as a PSU
// Plus the new caseRejectReason() scope gate and the Case price band.
//
//   node --test
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectCategory, stripCompatClauses, notBuildableReason, accessoryProductReason, detectBrand,
  caseRejectReason, caseAttributes, cleanManufacturer, bundleReason,
} from '../catalog-classify.cjs';
import { priceValidate, PRICE_TABLE } from '../normalize-product-name.js';

const cat = (title) => detectCategory(stripCompatClauses(title));

test('plural "Cases" classifies — Newegg titles carry the retailer category suffix', () => {
  // Real sweep rows. Every one of these classified as NOTHING before the fix because the
  // patterns only matched a singular \bcase\b.
  for (const n of [
    'Fractal Design North XL RC FD-C-NOR1X-05 Charcoal Black Cases (Computer Cases - ATX Form)',
    'be quiet! PURE Base 501 DX BGW76 Black Cases (Computer Cases - ATX Form)',
    'DIYPC ARGB-N3-BK Black Cases (Computer Cases - ATX Form)',
    'DIYPC DIY-S05-BK Black Cases (Computer Cases - ATX Form)',
    'Montech XRWood Black Black Computer Cases - ATX Form',
    'Bgears Black Micro ATX Cases, b-Pellucid Mini - Black, Micro-ATX / ITX BG30132',
    'NZXT CC-H31FB-01 Black tinted tempered glass Micro ATX Cases Case (Computer Cases)',
  ]) assert.equal(cat(n), 'Case', n);
});

test('"desktop case" is a case, not a power supply', () => {
  // The 300W TFX PSU is BUNDLED WITH the chassis. Before the fix "desktop" was not a head
  // noun, isCase was false, and the (!isCase) PSU branch claimed it off "300W … Bronze".
  assert.equal(cat('InWin BL631 mATX Desktop case with 300W TFX PSU/Black/IEEE 1394 - BL631.FF300TB3F'), 'Case');
  assert.equal(cat('inwin bl040 matx desktop case with 300w tfx psu/black/ieee 1394 - bl040.ff300tb3f'), 'Case');
});

test('a case that SHIPS WITH a riser is a case, not a riser accessory', () => {
  assert.equal(cat('Fractal Design Ridge White Mini-ITX Slim Small Form Factor Console PC Case with PCIe 4.0 Riser'), 'Case');
  assert.equal(cat('Cooler Master NCORE 100 MAX ITX SFF Tower Case, Custom 120mm AIO, 850W SFX Gold ATX3.0 PSU, 4 Slot GPU, Vertical Mount GPU, PCIe 4.0 Riser'), 'Case');
  assert.equal(cat('HYTE Y40 Mainstream Vertical GPU Case ATX Mid Tower Gaming Case with PCI Express 4.0 x 16 Riser Cable'), 'Case');
});

test('...but a standalone riser / vertical-GPU bracket is still NOT a case', () => {
  // Names a KIT, carries no case head noun → classifies as nothing, and the accessory
  // rule attributes it in the null-signal branch.
  const kit = 'Lian Li 4 Slots Vertical GPU Kit (VG4v4) - Premium Gen 5 Riser Cable PCI-E 5.0 x16';
  assert.notEqual(cat(kit), 'Case');
  assert.equal(notBuildableReason(kit), 'riser cable');
  // The pre-existing invariant: a bracket kit that DOES say "PC Case" must still be vetoed.
  assert.notEqual(cat('PC Case Vertical GPU Mount Bracket Kit'), 'Case');
});

test('motherboard SUPPORT text does not make a chassis a motherboard', () => {
  // Antec FLUX Wood / FLUX Rear name no case noun at all, so the bare "motherboard" was
  // the entire basis for filing them as Motherboard.
  assert.notEqual(cat('Antec FLUX Wood, 5 x PWM Fans Included, High-Airflow Front Panel With Walnut Wood, Type-C, 420mm Radiator & Back Connect Motherboard Support, Up to 10 Fans'), 'Motherboard');
  assert.notEqual(cat('Antec C8 Curve Wood, Fans not Included, Wooden Front Panel, Supports E-ATX Motherboard'), 'Motherboard');
  // REGRESSION: a real motherboard must still classify as one, by name and by chipset+socket.
  assert.equal(cat('ASUS ROG STRIX B650E-F GAMING WIFI AM5 ATX Motherboard'), 'Motherboard');
  assert.equal(cat('MSI PRO Z790-A WIFI LGA 1700 DDR5 ATX Motherboard'), 'Motherboard');
  assert.equal(cat('GIGABYTE B850 AORUS ELITE WIFI7 AM5 DDR5'), 'Motherboard');
});

test('PSU SUPPORT text does not make a chassis a power supply', () => {
  assert.notEqual(cat('Antec FLUX Rear, 5 PWM Fans Included, F-LUX Platform, Front PSU Chamber, Back Connect Motherboard'), 'PSU');
  assert.notEqual(cat('JONSBO D31 MESH Micro ATX Computer Case, Power ATX/SFX: 100mm-220mm'), 'PSU');
  // REGRESSION: real PSUs still classify as PSU.
  assert.equal(cat('Corsair RM850x 850W 80+ Gold Fully Modular ATX Power Supply'), 'PSU');
  assert.equal(cat('EVGA SuperNOVA 1000 G6 1000W 80 Plus Gold Fully Modular'), 'PSU');
  assert.equal(cat('Apevia ATX-PRO700W ATX Gaming Power Supply, 700W'), 'PSU');
});

test('cooler CLEARANCE text does not make a chassis a CPU cooler', () => {
  for (const n of [
    'COUGAR MG140 AIR RGB Case, Max. 350mm GPU Length, Max. 280mm Liquid Cooling & Max.160mm CPU Cooler',
    'COUGAR MG140 AIR Case, Max. 350mm GPU Length, Max.160mm CPU Cooler',
    'Apevia X-Pioneer ATX Mid Tower Gaming Case, supports CPU cooler up to 160mm',
  ]) assert.notEqual(cat(n), 'CPUCooler', n);
  // REGRESSION: real coolers still classify as coolers.
  assert.equal(cat('Thermalright Peerless Assassin 120 SE Dual Tower CPU Air Cooler'), 'CPUCooler');
  assert.equal(cat('ARCTIC Liquid Freezer III 360 A-RGB AIO CPU Cooler'), 'CPUCooler');
  assert.equal(cat('DeepCool AK620 Digital Air Cooler, 160mm Height'), 'CPUCooler');
});

test('a vertical-GPU MOUNT is a case feature, not an accessory', () => {
  // Cooler Master NR200: the vertical-mount veto knocked it out of Case, and the PSU
  // branch then claimed it off the "SFX PSU" clearance note.
  assert.equal(cat('Cooler Master NR200 Mini-ITX PC Case - 280mm Radiator Support, Fits up to 6 x 120mm Fans, Vertical GPU Mount with 330mm GPU Clearance, SFX PSU'), 'Case');
});

test('accessoryProductReason: an INCLUDED part is not an accessory product', () => {
  // Real cases the plain accessory gate rejected on a feature clause.
  for (const n of [
    'Thermaltake TR100 Koralie Edition; mITX Support; 18.9 Liters; PCIe 4.0 Riser Cable Included; 360mm GPU Clearance',
    'Antec AX1000 ARGB, 4 x 140mm ARGB PWM Fans Included, ARGB PWM Fan Controller, Up to 9 Fans Simultaneously',
    'ASUS Prime AP303 - Mesh Panel Case, supports ATX, M-ATX, and MINI-ITX motherboards, 34mm cable management',
  ]) assert.equal(accessoryProductReason(n), null, n);
  // ...while an accessory that names ITSELF in its product name still rejects.
  assert.equal(accessoryProductReason('Lian Li 4 Slots Vertical GPU Kit (VG4v4) - Premium Gen 5 Riser Cable PCI-E 5.0, PCIe 3.0'), 'riser cable');
  assert.equal(accessoryProductReason('NZXT Control Hub - Digital RGB Lighting and PWM Fan Speed Controller - Control Up to 5 Fans'), 'RGB/fan control hub (accessory)');
  assert.equal(accessoryProductReason('EN-Labs 4pin Fan PWM Fan Hub 10 Ports 4 Pin TX4 Hub Splitter'), 'fan hub/splitter');
  assert.equal(accessoryProductReason('1U rail kit for RMC-1E'), 'rack rail kit (accessory)');
});

test('caseRejectReason rejects rackmount / server / rack-enclosure chassis', () => {
  const out = {
    'Supermicro CS CSE-813MFTQC-350CB2 1U SuperChassis 813MFTQC-350CB2': 'server_rackmount',
    'Silverstone RM44 4U rackmount server chassis with enhanced liquid cooling': 'server_rackmount',
    'Rosewill 4U Server Chassis Rackmount Case 8 x 3.5" HDD Bays + 3 x 5.25" Devices': 'server_rackmount',
    'CHENBRO RM24100-L2 2U Rackmount Advanced Industrial Server Case': 'server_rackmount',
    'iStarUSA D-400-6-ND Black 4U Rackmount Compact Stylish Chassis': 'server_rackmount',
    '1U rail kit for RMC-1E': 'rack_rail_kit',
    'Rosewill HEARTH NAS Server Chassis Supports up to 6 x 3.5" Hot Swap HDD': 'server_chassis',
    'APC NetShelter SX 750mm Wide x 1200mm Deep Networking Roof Server - Chassis': 'server_chassis',
    'SilverStone Technology CS351 5-Bay SAS-12G / SATA-6G hot-swappable NAS Chassis': 'enterprise_sas',
  };
  for (const [n, reason] of Object.entries(out)) assert.equal(caseRejectReason(n), reason, n);
});

test('caseRejectReason keeps real DESKTOP chassis, including tower NAS cases', () => {
  // hot-swap ALONE must not reject: JONSBO N-series is a consumer Micro-ATX NAS cube and
  // is already live in the catalog (#100883). Gating on hot-swap would have deleted it.
  for (const n of [
    'Rosewill Helium NAS ATX Mid Tower Computer Case Mesh Panel 4 x 140mm PWM Fans Supports up to 13 Hard Drives',
    'JONSBO N6 NAS Case, Micro ATX Pc Case, 9HDD/SSD Drive Bay (hot-swap)',
    'NZXT H7 Flow Mid Tower ATX PC Case',
    'Fractal Design Meshify 2 Full Tower Computer Case',
    'Cooler Master NCORE 100 MAX ITX SFF Tower Case',
    // A test bench whose title states what it SUPPORTS, not what it is (live row #70198).
    'DIY Aluminium Pc Open Case Computer Chassis Test Bench Support Water Cooling Support Server Chassis Support Itx Matx',
  ]) assert.equal(caseRejectReason(n), null, n);
});

test('the new accessory rules catch what the case leaf carries but a build cannot use', () => {
  assert.equal(notBuildableReason('CORSAIR Commander Duo Lighting and Fan Controller ARGB and iCUE LINK Hybrid'), 'fan/lighting controller (accessory)');
  assert.equal(notBuildableReason('1U rail kit for RMC-1E'), 'rack rail kit (accessory)');
  assert.equal(notBuildableReason('5.25" Dual Bay Mobile Rack for both 2.5" and 3.25" SATA HDD, Plus 2 USB 3.0 Ports'), 'drive bay mobile rack (accessory)');
  // A real case that merely INCLUDES a fan hub is not a hub product. The bare
  // /\b(fan|pwm) (hub|splitter)\b/ rule rejected this real SAMA case on any path that runs
  // the accessory gate before classification — discover-newegg-dry.cjs did exactly that.
  assert.equal(notBuildableReason('SAMA V43 ATX Gaming PC Case, 6 x ARGB Infinity Mirror Fans + PWM Hub Included'), null);
  assert.equal(notBuildableReason('MONTECH KING 95 PRO ATX Mid-Tower Case with PWM Hub'), null);
  // REGRESSION: a standalone hub product is still rejected.
  assert.equal(notBuildableReason('EZDIY-FAB 10 Port PWM Fan Hub Splitter for 12V 4-Pin Fans'), 'fan hub/splitter');
  assert.equal(notBuildableReason('ARGB Fan Splitter Cable 1 to 5 Way'), 'fan hub/splitter');
});

test('caseAttributes derives form factor and tower class from the title', () => {
  assert.deepEqual({ ...caseAttributes('Fractal Design Meshify 2 XL E-ATX Full Tower Case') }, { ff: 'E-ATX', tower: 'Full', tg: false, rgb: false, usb_c: false });
  assert.equal(caseAttributes('NZXT H7 Flow Mid Tower ATX PC Case').ff, 'ATX');
  assert.equal(caseAttributes('NZXT H7 Flow Mid Tower ATX PC Case').tower, 'Mid');
  assert.equal(caseAttributes('Apevia X-QT Micro-ATX Gaming Case').ff, 'mATX');
  assert.equal(caseAttributes('KEDIERS SFF Case Mini-ITX Small Form Factor Chassis').ff, 'Mini-ITX');
  assert.equal(caseAttributes('KEDIERS SFF Case Mini-ITX Small Form Factor Chassis').tower, 'Mini');
  // "Micro-ATX" must not be read as a bare ATX.
  assert.equal(caseAttributes('JONSBO D31 MESH Black Micro ATX Computer Case').ff, 'mATX');
  const a = caseAttributes('Corsair 4000D Airflow ATX Mid-Tower Case, Tempered Glass, ARGB, USB-C');
  assert.equal(a.tg, true); assert.equal(a.rgb, true); assert.equal(a.usb_c, true);
});

test('Case has an absolute price band and it brackets the real market', () => {
  assert.ok(PRICE_TABLE.Case, 'Case band missing from PRICE_TABLE');
  const band = PRICE_TABLE.Case.TOTAL;
  assert.equal(band.floor, 20);
  assert.equal(band.ceiling, 1200);
  // Real prices from the live catalog pass.
  for (const p of [30.32, 49.99, 109.99, 288.46, 499, 984.41]) {
    assert.equal(priceValidate('Case', {}, p).status, 'ok', `$${p} should pass`);
  }
  // A $9 "case" is an accessory or a mis-attached link; a $3,500 one is a prebuilt PC.
  assert.equal(priceValidate('Case', {}, 9).reason, 'below_floor');
  assert.equal(priceValidate('Case', {}, 3500).reason, 'above_ceiling');
  // Missing price is never a block (fail-open, same as every other category).
  assert.equal(priceValidate('Case', {}, null).status, 'skip');
});

test('a case+PSU / case+cooler combo is a bundle, not a case', () => {
  // Case was missing from the bundle component map, so these registered one type and would
  // have gone live as a plain case priced at the combined total.
  assert.equal(bundleReason('PC Builder Bundle - Zalman PC Case with PSU Combo - Zalman S2 TG + 600W PSU'), 'case+psu');
  assert.equal(bundleReason('Zalman Case Cooler PSU Combo - Zalman P30 White MATX Mini-Tower PC Case + CNPS20X'), 'case+psu');
  assert.equal(bundleReason('Cooler Master HAF 500 High-Airflow Mid-Tower ATX Gaming Case + Hyper 212 Halo CPU Cooler 140W TDP + 650W Gold PSU - 3x ARGB Fans'), 'case+cooler+psu');
  // A combo whose second component is spelled out only as wattage ("+ 700W 80 plus Bronze
  // 700BX power supply") is caught by the classifier instead — it reads as PSU, not Case —
  // so it is still never admitted as a plain case. Documented, not silently assumed.
  assert.notEqual(cat('Iceberg Gaming combo Case Titan M16 plus (7) Seven aRGB Fans + 700W 80 plus Bronze 700BX power supply'), 'Case');
  // REGRESSION: a plain case stating its own clearances is NOT a bundle (no joining token).
  assert.equal(bundleReason('JONSBO D31 MESH Micro ATX Computer Case, Support 360 AIO Cooler, Power ATX/SFX 100-220mm'), null);
  assert.equal(bundleReason('Corsair 4000D Airflow ATX Mid-Tower PC Case, 2 x 120mm Fans Included'), null);
  assert.equal(bundleReason('NZXT H7 Flow Mid Tower ATX PC Case with Tempered Glass Panel'), null);
});

test('brand detection: earliest brand in the TITLE wins, not earliest in BRANDS', () => {
  // "WD" (a Wood colour code) sits ahead of 'Lian Li'/'Jonsbo' in the BRANDS array, so the
  // old first-in-array scan branded these wood-finish cases Western Digital.
  assert.equal(detectBrand('Lian Li A3-mATX PC Case - Wood Edition - Micro ATX Case - A3-mATX WD', ''), 'Lian Li');
  assert.equal(detectBrand('JONSBO TK-4 WD/BK Wood ATX PC Case, Mid Tower Computer Case', ''), 'Jonsbo');
  // REGRESSION: chip giants stay last — a maker always beats a bare chip mention.
  assert.equal(detectBrand('ASUS ROG Strix B650E-F Gaming WiFi for AMD Ryzen 7000', ''), 'ASUS');
  assert.equal(detectBrand('MSI MAG B650 Tomahawk WiFi AMD AM5 Motherboard', ''), 'MSI');
  // ...but a real chip-giant product still resolves.
  assert.equal(detectBrand('AMD Ryzen 7 9800X3D 8-Core Processor', ''), 'AMD');
  assert.equal(detectBrand('Intel Core i7-14700K 20-Core Processor', ''), 'Intel');
  // A real WD drive is still WD.
  assert.equal(detectBrand('WD Blue SN580 1TB NVMe SSD', ''), 'WD');
});

test('a case ACCESSORY that says "for Computer Case" is not a case', () => {
  const panel = '5.25 Inch Usb 3.0 Front Panel Pc Usb 3.0/2.0 Hub E-Sata Sata Audio Multi Card Reader for Computer Case Optical Drives Bay';
  assert.notEqual(cat(panel), 'Case');
  assert.equal(notBuildableReason(panel), 'front-panel card reader (accessory)');
});

test('a PCIe expansion chassis is not a PC case', () => {
  assert.equal(caseRejectReason('4 SLOT PCIE EXPANSION CHASSIS -'), 'expansion_chassis');
  assert.equal(caseRejectReason('Sonnet Echo III Thunderbolt PCIe Expansion Chassis'), 'expansion_chassis');
});

test('cleanManufacturer strips the feed\'s trailing punctuation artifacts', () => {
  // The Newegg feed ships these verbatim; they reached the catalog as the brand.
  assert.equal(cleanManufacturer('iStarUSA .'), 'iStarUSA');
  assert.equal(cleanManufacturer('AIC .'), 'AIC');
  assert.equal(cleanManufacturer('Cooler Master Technology'), 'Cooler Master');
});
