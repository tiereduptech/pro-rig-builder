#!/usr/bin/env node
/**
 * find-bestbuy-categories.js — dump Best Buy's category tree under "Computers & Tablets"
 *
 * Fetches the top-level "Computers & Tablets" category (id=abcat0500000) with
 * its full subCategories tree, then prints all descendants so we can
 * identify the right category IDs for PC components.
 */

const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) {
  console.error('ERROR: BESTBUY_API_KEY env var required.');
  process.exit(1);
}

async function fetchCat(id) {
  const url = `https://api.bestbuy.com/v1/categories/${id}.json?apiKey=${KEY}&show=id,name,subCategories`;
  const resp = await fetch(url);
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  return resp.json();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Recursive walk — depth-first, with rate limit respect
async function walk(id, depth = 0, pathNames = []) {
  await sleep(500); // 2/sec max — conservative given earlier 403s
  let cat;
  try {
    cat = await fetchCat(id);
  } catch (err) {
    console.error(`  ERROR at ${id}: ${err.message}`);
    return;
  }

  const indent = '  '.repeat(depth);
  const pathStr = [...pathNames, cat.name].join(' > ');
  console.log(`${indent}${cat.id.padEnd(16)} | ${cat.name.padEnd(45).slice(0, 45)} | ${pathStr}`);

  const subs = cat.subCategories || [];
  for (const sub of subs) {
    await walk(sub.id, depth + 1, [...pathNames, cat.name]);
  }
}

(async () => {
  console.log('Walking Best Buy category tree under "Computers & Tablets"\n');
  console.log('id               | name                                          | path');
  console.log('-----------------|-----------------------------------------------|------');
  await walk('abcat0500000');
  console.log('\nDone.');
})();
