#!/usr/bin/env node
/**
 * inspect-darkflash.js — shows the structure of cached DarkFlash HTML
 * so we can write a correct parser.
 */
import { readFileSync } from 'node:fs';

const html = readFileSync('./catalog-build/manufacturer-cache/darkflash-list-1.html', 'utf8');

console.log('Total HTML size:', html.length);
console.log('\n━━━ Looking for product links ━━━');

// Find all occurrences of /product/ and show context
const productRefs = [...html.matchAll(/\/product\/[\w-]+/g)];
console.log('Total /product/ references:', productRefs.length);
if (productRefs.length === 0) {
  console.log('\n━━━ Raw HTML sample (first 2000 chars after <body>) ━━━');
  const bodyIdx = html.indexOf('<body');
  console.log(html.slice(bodyIdx, bodyIdx + 2000));
} else {
  console.log('\n━━━ First 3 product contexts ━━━');
  for (const m of productRefs.slice(0, 3)) {
    const start = Math.max(0, m.index - 150);
    const end = Math.min(html.length, m.index + 250);
    console.log('─'.repeat(50));
    console.log(html.slice(start, end).replace(/\s+/g, ' '));
  }
}
