#!/usr/bin/env node
/**
 * patch-ram-filters.js
 *
 * App.jsx currently has:
 *   RAM:{..., filters:{ramType:{...}, cap:{...}, sticks:{...}, speed:{...}, cl:{...}, ecc:{...}, rgb:{...}}}
 *
 * But products use `memType` field (DDR4/DDR5), not `ramType`. So the
 * "Type" filter is showing empty options. We need to:
 *
 *   1. Rename the filter key from `ramType` to `memType` so it hits real data
 *   2. Add a `formFactor` filter (UDIMM / SODIMM) for desktop vs laptop
 */
import { readFileSync, writeFileSync } from 'node:fs';

const appPath = './src/App.jsx';
let app = readFileSync(appPath, 'utf8');

// Step 1: replace the RAM filters block
const oldFilters = 'filters:{ramType:{label:"Type",type:"check"},cap:{label:"Total Capacity",type:"check"},sticks:{label:"Kit (Sticks)",type:"check"},speed:{label:"Speed (MHz)",type:"check"},cl:{label:"CAS Latency",type:"check"},ecc:{label:"ECC",type:"bool"},rgb:{label:"RGB",type:"bool"}}';
const newFilters = 'filters:{memType:{label:"Type",type:"check"},formFactor:{label:"Form Factor",type:"check"},cap:{label:"Total Capacity",type:"check"},sticks:{label:"Kit (Sticks)",type:"check"},speed:{label:"Speed (MHz)",type:"check"},cl:{label:"CAS Latency",type:"check"},ecc:{label:"ECC",type:"bool"},rgb:{label:"RGB",type:"bool"}}';

if (app.includes(oldFilters)) {
  app = app.replace(oldFilters, newFilters);
  console.log('✓ Replaced RAM filters: ramType → memType, added formFactor');
} else {
  console.error('✗ RAM filters string not found — aborting');
  console.error('Expected:', oldFilters.slice(0, 60));
  process.exit(1);
}

// Step 2: fix cols too (if ramType is referenced there)
const oldCols = 'cols:["ramType","cap","sticks","speed","cl"]';
const newCols = 'cols:["memType","cap","sticks","speed","cl"]';
if (app.includes(oldCols)) {
  app = app.replace(oldCols, newCols);
  console.log('✓ Replaced RAM cols: ramType → memType');
}

writeFileSync(appPath, app);
console.log('\nWrote App.jsx');
