// Gate-fix regression tests — built against the ACTUAL titles the weekend ingest
// wrongly rejected (weekend-ingest-report.md, 2026-08-07). Each `recovers` case is a
// real product the old gates dropped; each `still rejects` case guards against the
// fix letting junk through.
import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCategory, stripCompatClauses, extractSpecs, prebuiltSystemReason, storageRejectReason, ramRejectReason, notBuildableReason } from '../catalog-classify.cjs';

const CC = { detectCategory, stripCompatClauses, extractSpecs, prebuiltSystemReason, storageRejectReason, ramRejectReason, notBuildableReason };
const cat = (t) => CC.detectCategory(CC.stripCompatClauses(t));
const wattsOf = (t) => CC.extractSpecs(t, 'PSU').watts;

test('BUG1 PSU watt parser — "850 Watt", "Gold 850", model-embedded RM850x/RM1000x recover', () => {
  // real specBar drops from the report
  assert.equal(wattsOf('Cooler Master MWE Gold 850 V2 Power Supply, Fully Modular'), 850);
  assert.equal(wattsOf('CORSAIR RMx Series, RM850x, 850 Watt, 80+ Gold Certified, Fully Modular Power Supply'), 850);
  assert.equal(wattsOf('CORSAIR RM1000x Fully Modular ATX Power Supply - 80 Plus Gold - Low-Noise Fan'), 1000);
  // and the format that already worked still works
  assert.equal(wattsOf('EVGA SuperNOVA 750 GT, 80 Plus Gold 750W, Fully Modular'), 750);
  // no false wattage from a non-PSU number
  assert.equal(CC.extractSpecs('Some 12VHPWR PCIe 5.1 Cable', 'PSU').watts, undefined);
});

test('BUG2a Storage — an SSD WITH a heatsink is Storage, not CPUCooler', () => {
  assert.equal(cat('Silicon Power 2TB US75 Nvme PCIe Gen4 M.2 2280 SSD Up to 7000 MB/s with Heatsink'), 'Storage');
  assert.equal(cat('WD_BLACK 2TB SN850P NVMe M.2 SSD Officially Licensed Storage Expansion for PS5 Consoles with Heatsink'), 'Storage');
  assert.equal(cat('Crucial P310 2280 2TB PCIe Gen4 NVMe Gaming PS5 SSD with Heatsink, Up to 7100MB/s'), 'Storage');
  assert.equal(cat('Samsung SSD 9100 PRO w/Heatsink 2TB, PCIe 5.0x4 M.2 2280, Up to 14700MB/s'), 'Storage');
  // a real CPU cooler is still a CPUCooler
  assert.equal(cat('Noctua NH-D15 chromax.black, Dual-Tower CPU Cooler'), 'CPUCooler');
});

test('BUG2b Storage — an INTERNAL SATA SSD that mentions USB is NOT external_usb', () => {
  assert.equal(CC.storageRejectReason('ORICO 1TB SATA SSD 2.5 Inch Internal Solid State Drive, Read up to 500MB/s, SATA III 6Gb/s, USB not required'), null);
  assert.equal(CC.storageRejectReason('ORICO 128GB SATA SSD 2.5 Inch Internal Solid State Drive'), null);
  // genuine external/portable drives are STILL rejected
  assert.equal(CC.storageRejectReason('MSI SPATIUM M470 PRO 2TB Portable SSD, 2TB External Solid State Drive'), 'external_usb');
  assert.equal(CC.storageRejectReason('SANDISK 4TB Extreme PRO Portable SSD - Up to 2000MB/s - USB-C, USB 3.2'), 'external_usb');
});

test('BUG3a RAM — a desktop DIMM whose title says "Desktop PC" is NOT a prebuilt', () => {
  const a = 'A-Tech 8GB DDR5 4800MHz PC5-38400 CL40 UDIMM 1.1V Non-ECC Unbuffered DIMM 288-Pin Desktop PC';
  const b = 'Samsung 16GB DDR5 5600MHz PC5-44800 CL46 UDIMM 1Rx8 1.1V Non-ECC DIMM 288-Pin Desktop PC';
  assert.equal(CC.prebuiltSystemReason(a), null);
  assert.equal(CC.prebuiltSystemReason(b), null);
  assert.equal(cat(a), 'RAM');
  assert.equal(cat(b), 'RAM');
});

test('BUG3b RAM — a memory kit that names a compatible CPU family is RAM, not CPU', () => {
  assert.equal(cat('Lexar 32GB (2x16GB) THOR DDR4 RAM 3200MT/s CL16 1.35V Desktop Memory with Heatsink, AMD Ryzen'), 'RAM');
  assert.equal(cat('Kingston FURY Beast 32GB (2x16GB) 3200MT/s DDR4 CL16 Desktop Memory Kit of 2, Intel XMP, AMD Ryzen'), 'RAM');
  // a real CPU still classifies as CPU
  assert.equal(cat('AMD Ryzen 7 7800X3D 8-Core 16-Thread Desktop Processor'), 'CPU');
});

test('BUG4 PSU — a real PSU that lists "Fan Hub"/bundled cables still classifies as PSU', () => {
  // category-first trusts these; the old gate rejected them via notBuildableReason
  assert.equal(cat('Lian Li RS1000G 1000W ATX Power Supply w/o USB Fan Hub - Black (RS1000G.B)'), 'PSU');
  assert.equal(cat('ASUS ROG Strix 1000W Platinum Fully Modular ATX Power Supply with Power Cable'), 'PSU');
  // a genuine standalone cable is NOT a PSU (so category-first still lets the accessory gate catch it)
  assert.equal(cat('SATA Power Cable for Seasonic Antec PSUs 6 Pin to 3X 15 Pin'), null);
  assert.ok(CC.notBuildableReason('SATA Power Cable for Seasonic Antec PSUs 6 Pin to 3X 15 Pin'));
});

test('REGRESSION — real prebuilts, laptop RAM, server RAM, enclosures still rejected', () => {
  assert.ok(CC.prebuiltSystemReason('Dell Pro Tower Plus Desktop, Intel 14-Core Ultra 5 235, 32GB DDR5 RAM, 1TB PCIe SSD, Windows 11 Pro'));
  assert.ok(CC.prebuiltSystemReason('GMKtec Gaming PC, K11 AMD Ryzen 9 8945HS, 32GB DDR5 RAM 1TB SSD Mini PC'));
  assert.equal(CC.ramRejectReason('Crucial 32GB DDR5 Kit (2x16GB) 5600MHz Laptop Memory 262-Pin SODIMM'), 'laptop_sodimm');
  assert.equal(CC.ramRejectReason('NEMIX RAM 64GB (2X32GB) DDR5 4800MHz PC5-38400 ECC RDIMM Registered Server'), 'server_registered_ram');
  assert.ok(CC.notBuildableReason('SABRENT USB-C NVMe Enclosure & Reader, M.2 PCIe SSD, 10Gbps (EC-PNVO)'));
});
