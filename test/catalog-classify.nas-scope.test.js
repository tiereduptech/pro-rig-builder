// Storage scope gate: a whole NAS APPLIANCE (a networked storage system with its
// own CPU / OS / enclosure) is not a drive and must be rejected from Storage, or it
// surfaces as a selectable build disk. The gate keys on a drive-BAY count on a NAS /
// NASync / DiskStation / Network-Attached-Storage unit — the signal a NAS-rated
// INTERNAL drive ("NAS Internal Hard Drive", "NAS SSD") never carries.
import test from 'node:test';
import assert from 'node:assert';
import { storageRejectReason } from '../catalog-classify.cjs';

test('storageRejectReason rejects whole NAS appliances (bay-count + NAS unit)', () => {
  const appliances = [
    'TS-464-8G-44WD-US 4 Bay High-Performance Desktop NAS with 12TB Storage Capacity, Preconfigured RAID 5 WD Red Plus HDD',
    'Synology DS223 Diskstation NAS (Realtek RTD1619B Quad-Core 2GB Ram 1xRJ-45 1GbE LAN-Port) 2-Bay with 2X 12TB Seagate IronWolf (Total 24TB)',
    'UGREEN NAS DXP4800 Pro 4-Bay Desktop Network Attached Storage, Intel Core i3-1315U 6-Core CPU, 8GB DDR5 RAM, Built-in 128GB SSD (Diskless)',
    'UGREEN NAS DXP8800 Plus 8-Bay Desktop NASync, Intel i5 1235u 10-Core CPU, 8GB DDR5 RAM, 8K HDMI, Network Attached Storage (Diskless)',
  ];
  for (const n of appliances) assert.strictEqual(storageRejectReason({ n }), 'nas_appliance', n);
});

test('storageRejectReason keeps NAS-rated internal drives in scope', () => {
  const drives = [
    'IronWolf 12TB NAS Internal Hard Drive HDD – CMR 3.5 Inch SATA 6Gb/s 7200 RPM 256MB Cache for RAID Network Attached Storage',
    'WD Red Plus 8TB NAS Internal Hard Drive HDD - 5400 RPM, SATA 6 Gb/s, CMR',
    '1TB WD Red SA500 NAS 3D NAND Internal SSD - SATA III 6 Gb/s, 2.5"/7mm',
    '2TB WD Red SN700 NVMe Internal Solid State Drive SSD for NAS Devices - Gen3 PCIe, M.2 2280',
    'Western Digital 24TB WD Red Pro NAS Internal Hard Drive HDD - 7200 RPM, SATA 6 Gb/s, CMR, 3.5"',
  ];
  for (const n of drives) assert.strictEqual(storageRejectReason({ n }), null, n);
});
