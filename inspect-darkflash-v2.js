#!/usr/bin/env node
/**
 * inspect-darkflash-v2.js — finds actual product cards by searching for
 * specific product slugs.
 */
import { readFileSync } from 'node:fs';

const html = readFileSync('./catalog-build/manufacturer-cache/darkflash-list-1.html', 'utf8');

console.log('HTML size:', html.length);

// Search for specific slugs we know exist from the earlier markdown-converted fetch
const knownSlugs = ['ds950v', 'hm1', 'c365', 'b275', 'dy460', 'a305', 'floatron-f1'];

for (const slug of knownSlugs) {
  const idx = html.indexOf(slug);
  if (idx === -1) {
    console.log(`\n"${slug}" — NOT FOUND in HTML`);
    continue;
  }
  const start = Math.max(0, idx - 200);
  const end = Math.min(html.length, idx + 300);
  console.log(`\n━━━ "${slug}" at index ${idx} ━━━`);
  console.log(html.slice(start, end).replace(/\s+/g, ' '));
}

// Also check for JSON-LD or __NEXT_DATA__ style embedded data
console.log('\n━━━ Checking for embedded data patterns ━━━');
console.log('__NEXT_DATA__:', html.includes('__NEXT_DATA__'));
console.log('__INITIAL_STATE__:', html.includes('__INITIAL_STATE__'));
console.log('application/ld+json:', html.includes('application/ld+json'));
console.log('window.__data:', html.includes('window.__data'));
console.log('window.dataLayer:', html.includes('window.dataLayer'));
