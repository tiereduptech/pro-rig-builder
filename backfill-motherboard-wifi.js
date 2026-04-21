#!/usr/bin/env node
/**
 * backfill-motherboard-wifi.js — infer wifi standard from product name
 * for Motherboard products missing the field.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

function inferWifi(name) {
  const s = String(name || '');
  if (/Wi-?Fi\s*7|WIFI7|\b802\.11be\b/i.test(s)) return 'WiFi 7';
  if (/Wi-?Fi\s*6E|WIFI6E/i.test(s)) return 'WiFi 6E';
  if (/Wi-?Fi\s*6|WIFI6|\b802\.11ax\b|\bAX\d{3,4}\b/i.test(s)) return 'WiFi 6';
  if (/Wi-?Fi\s*5|WIFI5|\b802\.11ac\b/i.test(s)) return 'WiFi 5';
  // General WIFI without version
  if (/\bWIFI\b|\bWi-?Fi\b/i.test(s)) return 'WiFi';
  return 'None';
}

let added = 0;
let wifiCount = 0;
let noneCount = 0;

for (const p of parts) {
  if (p.c !== 'Motherboard') continue;
  if (p.wifi) continue; // already populated
  const inferred = inferWifi(p.n);
  p.wifi = inferred;
  added++;
  if (inferred === 'None') noneCount++;
  else wifiCount++;
}

console.log('Backfilled', added, 'motherboard wifi values');
console.log('  WiFi (any version):', wifiCount);
console.log('  None:              ', noneCount);

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote', parts.length, 'products');
