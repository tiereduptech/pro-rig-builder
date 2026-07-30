// Storage discovery scope gate — enterprise + external drives are out of scope for
// a consumer/gaming DESKTOP build and must be rejected at discovery. The feed
// carries no structured interface field, so storageRejectReason computes
// interface/formFactor from the TITLE (storageAttributes) and gates on the
// COMPUTED value, name regex as backstop only. Titles below are REAL Newegg feed
// rows pulled from the Storage discovery dry run (2026-07-30), not synthetic.
//
//   node --test
import test from 'node:test';
import assert from 'node:assert';
import { storageRejectReason, storageAttributes } from '../catalog-classify.cjs';

test('storageAttributes reads interface + form factor from real titles', () => {
  assert.equal(storageAttributes('SanDisk Pro-Blade 1TB PCIe NVMe 3.0 Portable External SSD').interface, 'USB'); // external wins over NVMe
  assert.equal(storageAttributes('WD 2TB Elements Portable Hard Drive USB 3.0').interface, 'USB');
  assert.equal(storageAttributes('HGST Ultrastar DC HC320 8 TB 3.5\' Internal Hard Drive - SAS').interface, 'SAS');
  assert.equal(storageAttributes('WD_BLACK SN7100 M.2 2280 4TB PCI-Express 4.0 x4 Internal SSD').interface, 'NVMe');
  assert.equal(storageAttributes('Kingston A400 960GB SATA 3 2.5\' Internal SSD').interface, 'SATA');
  assert.equal(storageAttributes('Intel Optane DC P4800X 750GB U.2 PCIe 3.0 x4').formFactor, 'U.2');
  assert.equal(storageAttributes('WD_BLACK SN7100 M.2 2280 4TB Internal SSD').formFactor, 'M.2');
  assert.equal(storageAttributes('Lenovo ThinkSystem 2.4 TB hot-swap 2.5\' SAS 12Gb/s').hotSwap, true);
});

test('rejects external / USB drives (belong in ExternalStorage, not internal)', () => {
  const external = [
    'APRICORN Aegis Padlock DT 6TB USB 3.0 FIPS 140-2 Encrypted Desktop Hard Drive',
    'SanDisk Pro-Blade 1TB PCIe NVMe 3.0 Portable External SSD SDPM1NS001TGBAND',
    'Kingston IronKey Vault Privacy 80 3840GB External SSD IKVP80ES/3840G',
    'Seagate Portable 4TB External Hard Drive HDD Slim - USB 3.0 for PC Laptop',
    'WD 2TB Elements Portable Hard Drive USB 3.0 Model WDBU6Y0020BBK-WESN',
    'SanDisk Professional 6TB G-Drive Enterprise-Class External Desktop Hard Drive',
  ];
  for (const n of external) assert.equal(storageRejectReason(n), 'external_usb', n);
});

test('rejects enterprise SAS / U.2-U.3-EDSFF / hot-swap drives', () => {
  assert.equal(storageRejectReason('HGST Ultrastar DC HC320 HUS728T8TAL5204 8 TB 3.5\' Internal Hard Drive - SAS'), 'enterprise_sas');
  assert.equal(storageRejectReason('Western Digital Ultrastar 7K6 HUS726T4TALS204 4 TB Hard Drive - 3.5\' Internal - SAS'), 'enterprise_sas');
  assert.equal(storageRejectReason('Western Digital Ultrastar DC SN861 1.60 TB Solid State Drive U.2'), 'enterprise_form');
  assert.equal(storageRejectReason('Samsung PM9A3 3.84TB PCIe Gen4 x4 NVMe U.2 Enterprise SSD'), 'enterprise_form');
  assert.equal(storageRejectReason('Lenovo ThinkSystem - Hard drive - 2.4 TB - hot-swap - 2.5\' - SAS 12Gb/s'), 'enterprise_sas'); // SAS wins first
  assert.equal(storageRejectReason('HPE 800GB hot-swap SFF Mixed Use SSD'), 'enterprise_hotswap');
});

test('keeps legitimate internal SATA / NVMe desktop drives (real feed rows)', () => {
  const internal = [
    'KingSpec XG 7000 1TB M.2 2280 PCIe Gen 4.0x4 NVME Internal Solid State Drive',
    'Crucial E100 480GB PCIe 4.0 Gen4 2280 NVMe M.2 Internal SSD CT480E100SSD8',
    'Kingston A400 960GB SATA 3 2.5\' Internal SSD SA400S37/960G',
    'WD_BLACK SN7100 M.2 2280 4TB PCI-Express 4.0 x4 TLC 3D NAND Internal Solid State Drive',
    'WD Purple Pro 8TB 7200 RPM 256MB Cache SATA 6.0Gb/s 3.5\' Hard Drives Bare Drive',
    'Seagate IronWolf 12TB NAS Hard Drive 7200 RPM 256MB Cache SATA 6.0Gb/s CMR 3.5\' Internal',
    'Synology 8TB HAT3320 Plus Series SATA III 3.5\' Internal NAS HDD',
  ];
  for (const n of internal) assert.equal(storageRejectReason(n), null, n);
});

test('accepts a bare string OR a catalog product object (structured field wins)', () => {
  assert.equal(storageRejectReason('WD Red 4TB 3.5" SATA Internal Hard Drive'), null);
  assert.equal(storageRejectReason({ n: 'Some Drive', interface: 'SAS' }), 'enterprise_sas');
  assert.equal(storageRejectReason({ n: 'Some Drive', formFactor: 'U.3' }), 'enterprise_form');
});
