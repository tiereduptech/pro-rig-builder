#!/usr/bin/env node
/**
 * inspect-enriched.js — show summary stats of enriched Best Buy data
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const dir = './catalog-build/bestbuy-enriched';
const files = readdirSync(dir).filter(f => f.endsWith('.json'));

console.log('Category       Count  SampleSpecs  Refurbs  NewItems  PriceRange');
console.log('-------------  -----  -----------  -------  --------  ----------');

let grandTotal = 0;
let grandRefurbs = 0;

for (const file of files) {
  const data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  const name = file.replace('.json', '');
  const sample = data[0];
  const specCount = sample?.specs ? Object.keys(sample.specs).length : 0;
  const refurbs = data.filter(p => p.condition === 'refurbished').length;
  const news = data.filter(p => p.condition === 'new').length;
  const prices = data.map(p => p.price).filter(p => typeof p === 'number' && p > 0);
  const priceRange = prices.length > 0
    ? `$${Math.min(...prices).toFixed(0)}-$${Math.max(...prices).toFixed(0)}`
    : 'n/a';

  console.log(
    `${name.padEnd(13)}  ${String(data.length).padStart(5)}  ${String(specCount).padStart(11)}  ${String(refurbs).padStart(7)}  ${String(news).padStart(8)}  ${priceRange}`
  );
  grandTotal += data.length;
  grandRefurbs += refurbs;
}

console.log('-------------  -----  -----------  -------  --------  ----------');
console.log(`TOTAL           ${String(grandTotal).padStart(5)}  ${''.padStart(11)}  ${String(grandRefurbs).padStart(7)}`);
