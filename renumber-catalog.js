#!/usr/bin/env node
/**
 * renumber-catalog.js
 *
 * Clean renumbers all products in parts.js into category-based ID ranges.
 * Preserves all product data except the id field.
 *
 * ID RANGES:
 *   CPU         10000-19999
 *   Motherboard 20000-29999
 *   GPU         30000-39999
 *   RAM         40000-49999
 *   Storage     50000-59999
 *   PSU         60000-69999
 *   Case        70000-79999
 *   CPUCooler   80000-84999
 *   CaseFan     85000-89999
 *   Monitor     90000-94999
 *   Peripherals 95000-98999 (Keyboard/Mouse/Headset/Mic/Webcam/MousePad/Chair/Desk)
 *   Accessories 99000-99999 (SoundCard/WiFi/Ethernet/Optical/UPS/OS/ThermalPaste/etc.)
 *
 * USAGE:
 *   node renumber-catalog.js            # Dry-run preview
 *   node renumber-catalog.js --apply    # Apply changes to parts.js
 */

import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const APPLY = process.argv.includes('--apply');

const ID_RANGES = {
  // Core components
  CPU:         { start: 10000, end: 19999 },
  Motherboard: { start: 20000, end: 29999 },
  GPU:         { start: 30000, end: 39999 },
  RAM:         { start: 40000, end: 49999 },
  Storage:     { start: 50000, end: 59999 },
  PSU:         { start: 60000, end: 69999 },
  Case:        { start: 70000, end: 79999 },
  // Cooling
  CPUCooler:   { start: 80000, end: 84999 },
  CaseFan:     { start: 85000, end: 89999 },
  // Display
  Monitor:     { start: 90000, end: 94999 },
  // Peripherals
  Keyboard:    { start: 95000, end: 95999 },
  Mouse:       { start: 96000, end: 96999 },
  Headset:     { start: 97000, end: 97499 },
  Microphone:  { start: 97500, end: 97999 },
  Webcam:      { start: 98000, end: 98499 },
  MousePad:    { start: 98500, end: 98749 },
  Chair:       { start: 98750, end: 98899 },
  Desk:        { start: 98900, end: 98999 },
  // Accessories & misc
  SoundCard:   { start: 99000, end: 99099 },
  EthernetCard:{ start: 99100, end: 99199 },
  WiFiCard:    { start: 99200, end: 99299 },
  OpticalDrive:{ start: 99300, end: 99399 },
  InternalLCD: { start: 99400, end: 99499 },
  InternalDisplay: { start: 99500, end: 99599 },
  ExtensionCables: { start: 99600, end: 99699 },
  ThermalPaste:{ start: 99700, end: 99799 },
  ExternalStorage: { start: 99800, end: 99849 },
  Antivirus:   { start: 99850, end: 99899 },
  ExternalOptical: { start: 99900, end: 99929 },
  UPS:         { start: 99930, end: 99969 },
  OS:          { start: 99970, end: 99999 },
};

// Load current catalog
console.log('Loading parts.js...');
const mod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
const parts = [...mod.PARTS];
console.log(`Loaded ${parts.length} products\n`);

// Group by category
const byCategory = {};
for (const p of parts) {
  const cat = p.c || 'UNKNOWN';
  if (!byCategory[cat]) byCategory[cat] = [];
  byCategory[cat].push(p);
}

// Assign new IDs
const renumbered = [];
const stats = {};
const overflow = [];

for (const [cat, list] of Object.entries(byCategory)) {
  const range = ID_RANGES[cat];
  if (!range) {
    console.warn(`! No ID range for category "${cat}" (${list.length} products) — using fallback 100000+`);
    stats[cat] = { count: list.length, range: 'FALLBACK', oldIds: list.map(p => p.id) };
    list.forEach((p, i) => renumbered.push({ ...p, id: 100000 + overflow.length + i, _oldId: p.id }));
    overflow.push(...list);
    continue;
  }

  const capacity = range.end - range.start + 1;
  if (list.length > capacity) {
    console.error(`! Category ${cat} has ${list.length} products but range only allows ${capacity}`);
    process.exit(1);
  }

  // Sort by existing ID to preserve some ordering sense
  list.sort((a, b) => (a.id || 0) - (b.id || 0));

  list.forEach((p, i) => {
    const newId = range.start + i;
    renumbered.push({ ...p, id: newId, _oldId: p.id });
  });

  stats[cat] = {
    count: list.length,
    range: `${range.start}-${range.start + list.length - 1}`,
    capacity: `${list.length}/${capacity} (${Math.round(list.length / capacity * 100)}% used)`,
    oldIds: list.slice(0, 3).map(p => p.id),
  };
}

// Print summary
console.log('─── Renumber Summary ───\n');
for (const [cat, info] of Object.entries(stats).sort((a, b) => b[1].count - a[1].count)) {
  console.log(`  ${cat.padEnd(20)} ${info.count.toString().padStart(4)} products  ${info.range.padEnd(15)}  ${info.capacity || ''}`);
}
console.log();

// Sample some before/after pairs for verification
console.log('─── Sample Renumbering ───');
const samples = renumbered.filter(p => p.c).slice(0, 10);
for (const p of samples) {
  console.log(`  ${p.c.padEnd(12)} old=${p._oldId?.toString().padStart(5)} new=${p.id.toString().padStart(5)}  ${p.n.slice(0, 55)}`);
}

// Remove the _oldId temp field before writing
for (const p of renumbered) delete p._oldId;

// Sort by new ID for a clean file
renumbered.sort((a, b) => a.id - b.id);

if (APPLY) {
  // Backup first
  const backup = './src/data/parts.js.pre-renumber-backup';
  copyFileSync('./src/data/parts.js', backup);
  console.log(`\n✓ Backup saved: ${backup}`);

  // Write new parts.js
  const header = '// Auto-merged catalog. Edit with care.\n';
  const content = header + 'export const PARTS = ' + JSON.stringify(renumbered, null, 2) + ';\n\nexport default PARTS;\n';
  writeFileSync('./src/data/parts.js', content);
  console.log(`✓ Renumbered ${renumbered.length} products`);
  console.log(`✓ Wrote src/data/parts.js`);
} else {
  console.log('\n(Dry run — no changes written. Use --apply to commit the renumber.)');
}
