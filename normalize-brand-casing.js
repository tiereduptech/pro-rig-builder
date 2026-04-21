#!/usr/bin/env node
/**
 * normalize-brand-casing.js
 *
 * Catalog has duplicate brand entries due to inconsistent casing:
 *   - "Corsair" (20 cases) + "CORSAIR" (14 cases) — should all be "Corsair"
 *   - "Gamdias" (6 cases) + "GAMDIAS" (1 case) — should all be "GAMDIAS"
 *     (since the brand actually styles itself uppercase)
 *
 * Pick the casing the BRAND prefers and merge.
 */
import { writeFileSync } from 'node:fs';

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
let parts = [...mod.PARTS];

// Casing the brand actually uses
const NORMAL_CASING = {
  'CORSAIR': 'Corsair',  // they're called "Corsair" in marketing
  'GAMDIAS': 'GAMDIAS',  // they style as all caps
  'Gamdias': 'GAMDIAS',
  'corsair': 'Corsair',
  'INWIN': 'In Win',
  'In-Win': 'In Win',
};

let changes = 0;
const stats = {};
for (const p of parts) {
  if (NORMAL_CASING[p.b]) {
    const oldB = p.b;
    p.b = NORMAL_CASING[p.b];
    if (oldB !== p.b) {
      changes++;
      const k = `${oldB} → ${p.b}`;
      stats[k] = (stats[k] || 0) + 1;
    }
  }
}

console.log(`━━━ NORMALIZED ${changes} BRAND VALUES ━━━`);
for (const [k, v] of Object.entries(stats)) console.log(`  ${k}: ${v} products`);

const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
writeFileSync('./src/data/parts.js', source);
console.log('\nWrote parts.js');
