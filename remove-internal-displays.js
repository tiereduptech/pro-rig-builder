#!/usr/bin/env node
/**
 * remove-internal-displays.js
 *
 * Undoes add-internal-displays.js:
 *   1. Removes all 31 products with c === 'InternalDisplay'
 *   2. Removes the InternalDisplay CAT entry from App.jsx
 */
import { writeFileSync, readFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = mod.PARTS;

// Remove products
const before = parts.length;
parts = parts.filter(p => p.c !== 'InternalDisplay');
const removed = before - parts.length;
console.log(`Removed ${removed} InternalDisplay products`);

// Remove from App.jsx
const appPath = './src/App.jsx';
let app = readFileSync(appPath, 'utf8');
const catRe = /\s*InternalDisplay\s*:\s*\{[^}]*filters:\{[^}]*\}\}\s*,?/;
if (catRe.test(app)) {
  app = app.replace(catRe, '');
  writeFileSync(appPath, app);
  console.log('Removed InternalDisplay CAT entry from App.jsx');
} else {
  console.log('InternalDisplay not found in App.jsx');
}

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
