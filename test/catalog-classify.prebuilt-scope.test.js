// Prebuilt whole-system scope gate: a complete PC / laptop / AIO is not a component
// and must be rejected from CPU (and detectable in any component category). The gate
// keys on a spec-BUNDLE (CPU + OS, or CPU + RAM + storage) because keyword tests on
// "desktop"/"laptop" alone hit pervasive compat text ("Desktop Computer Memory",
// "for Pc or Laptop", "Low Profile Card for Slim Desktop PC").
import test from 'node:test';
import assert from 'node:assert';
import cc from '../catalog-classify.cjs';
const { prebuiltSystemReason, cpuRejectReason } = cc;

test('flags real prebuilt systems (spec-bundle / brand line)', () => {
  const systems = [
    'ProDesk 400 G9 Business Desktop Computer, SFF, 12th Gen Intel i7-12700 Processor, 32GB DDR4 RAM, 1TB PCIe NVMe M.2 SSD, Windows 11, Black',
    'HP 15.6" HD Display, Intel Processor N200 (Pentium), 4GB RAM, 128GB UFS, Windows 11 Home, 15-fd0079wm (Renewed)',
    'Dell Slim Desktop ECS1250 - Intel Core i3 14100 Processor, 8GB DDR5 RAM, 512GB SSD, Windows 11 Home',
    'acer Aspire XC-1780-UA91 Desktop | Intel Core i5-13400 Processor | 8GB DDR4 RAM | 512GB PCIe Gen 4 SSD | Windows 11 Home',
  ];
  for (const n of systems) {
    assert.ok(prebuiltSystemReason(n), `should flag: ${n}`);
    assert.ok(cpuRejectReason({ n }), `cpuRejectReason should reject: ${n}`);
  }
});

test('does NOT flag components whose titles carry compat/marketing text', () => {
  const components = [
    'VENGEANCE RGB DDR5 RAM 32GB (2x16GB) 6000MHz CL36 Intel XMP 3.0 Desktop Computer Memory - White',
    'RipjawsV Series DDR4 RAM 32GB (2x16GB) 3200MT/s Intel AMD Desktop Computer Memory U-DIMM',
    'SSD 1TB 2.5 Inch Internal Hard Drive for Pc or Laptop, SATA III 6Gb/s',
    'MOUGOL AMD Radeon R7 350 4GB Low Profile Graphics Card, SFF Half-Height Video Card for Slim Desktop PC',
    'Micro ATX Case PC Case: MATX Case Mini PC ITX Desktop Computer Case',
    'ARCTIC Liquid Freezer III 360 A-RGB - All-in-One CPU AIO Liquid Cooler',
    'IronWolf 12TB NAS Internal Hard Drive HDD - CMR 3.5 Inch SATA, for RAID Network Attached Storage',
    'AMD Ryzen 7 9700X 8-Core Processor, Socket AM5, DDR5 support',
  ];
  for (const n of components) assert.strictEqual(prebuiltSystemReason(n), null, `should NOT flag: ${n}`);
});
