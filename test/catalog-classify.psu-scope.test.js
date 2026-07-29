// PSU scope gate: a UPS / battery backup is not a power supply and must be
// rejected on ingest, or it re-enters the PSU category and breaks builds.
import test from 'node:test';
import assert from 'node:assert';
import { psuRejectReason } from '../catalog-classify.cjs';

test('psuRejectReason rejects UPS / battery-backup (name or product)', () => {
  const ups = [
    'CyberPower CP1500AVRLCD3 Intelligent LCD UPS Battery Backup and Surge Protector',
    'APC Back-UPS 600VA',
    'Tripp Lite 1500VA Uninterruptible Power Supply',
    'CyberPower CP1500PFCLCD 1500VA UPS',
  ];
  for (const n of ups) {
    assert.strictEqual(psuRejectReason(n), 'ups_not_psu', `name: ${n}`);
    assert.strictEqual(psuRejectReason({ n }), 'ups_not_psu', `product: ${n}`);
  }
});

test('psuRejectReason rejects redundant / hot-swap server supplies', () => {
  const server = [
    'FSP Twins Pro PC PSU PS2 1+1 Dual Module 500W ATX Redundant Power Supply with Guardian Monitor Software (Twins Pro 500)',
    'FSP Twins Pro PC PSU PS2 1+1 Dual Module 700W ATX Redundant Power Supply with Guardian Monitor Software (Twins Pro 700)',
    'Supermicro 1200W 1U CRPS Redundant Power Supply Module PWS-1K23A-1R',
    'Dell 750W Hot-Swap Redundant Power Supply for PowerEdge Server',
  ];
  for (const n of server) {
    assert.strictEqual(psuRejectReason(n), 'server_redundant', `name: ${n}`);
    assert.strictEqual(psuRejectReason({ n }), 'server_redundant', `product: ${n}`);
  }
});

test('psuRejectReason keeps real ATX power supplies', () => {
  for (const n of [
    'Corsair RM850e 850W 80 Plus Gold Fully Modular ATX Power Supply',
    'be quiet! Pure Power 12 750W 80 PLUS Gold',
    'Apevia ITX-PFC500W Mini ITX/Flex ATX 500W Fully Modular Power Supply',
    'EVGA SuperNOVA 1000 G7 1000W',
    'Seasonic FOCUS GX-750 750W',
    // "1U" / "NAS" in compat text on a legit Flex-ATX SFF PSU — must NOT trip the
    // redundant/hot-swap server gate (no "redundant" / "hot-swap" / CRPS token).
    'Apevia ITX-PFC500W Mini ITX/Flex ATX / 1U 500W Fully Modular Power Supply, AC for POS AIO System Desktop Gaming Server Small Form Factor (Flex ITX) Computer PSU',
    'FSP FlexGURU Pro Power Supply, Flex ATX 500W, 80 Plus Gold, Non-Modular, Perfect for SFF PC, 1U IPC, and NAS Systems (FSP500-50FDP)',
  ]) assert.strictEqual(psuRejectReason(n), null, n);
});
