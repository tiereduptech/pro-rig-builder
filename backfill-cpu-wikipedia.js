#!/usr/bin/env node
/**
 * backfill-cpu-wikipedia.js — fill CPU tdp and cores from Wikipedia articles
 *
 * Approach:
 *   1. Extract CPU model name from product title (Ryzen 7 7800X3D, Core i9-13900K, etc.)
 *   2. Query Wikipedia MediaWiki API for the article's wikitext
 *   3. Parse infobox fields: TDP, base clock, boost clock, cores, threads, L3
 *
 * Wikipedia API: https://en.wikipedia.org/w/api.php
 * Rate limit: ~1 req/sec (self-imposed to be polite)
 *
 * Usage:
 *   node backfill-cpu-wikipedia.js
 *   node backfill-cpu-wikipedia.js --dry-run     (don't save, just show what we'd do)
 *   node backfill-cpu-wikipedia.js --limit=5     (test with small sample)
 */
import { writeFileSync } from 'node:fs';

const DRY_RUN = process.argv.includes('--dry-run');
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0');
const RATE_MS = 1000;

const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js`);
const parts = mod.PARTS;

// ─────────────────────────────────────────────────────────────────────────────
// Extract CPU model from product name
// ─────────────────────────────────────────────────────────────────────────────

function extractModel(name) {
  const s = String(name || '').replace(/[™®©]/g, '');

  // AMD Ryzen — "Ryzen 7 7800X3D", "Ryzen 9 9950X", "Ryzen 5 5600X"
  let m = s.match(/\bRyzen\s+(\d)\s+(\d{4}[A-Z0-9]*)/i);
  if (m) return { vendor: 'AMD', family: 'Ryzen', tier: m[1], model: m[2], full: `Ryzen ${m[1]} ${m[2]}` };

  // AMD Threadripper — "Threadripper PRO 7995WX"
  m = s.match(/\bThreadripper(?:\s+PRO)?\s+(\d{4}[A-Z0-9]*)/i);
  if (m) return { vendor: 'AMD', family: 'Threadripper', model: m[1], full: `Threadripper ${m[1]}` };

  // AMD EPYC
  m = s.match(/\bEPYC\s+(\d{4}[A-Z0-9]*)/i);
  if (m) return { vendor: 'AMD', family: 'EPYC', model: m[1], full: `EPYC ${m[1]}` };

  // Intel Core — "Core i9-13900K", "Core i5-12600KF", "Core i7 14700K"
  m = s.match(/\bCore\s+(i[3579])[-\s](\d{4,5}[A-Z]{0,3})\b/i);
  if (m) return { vendor: 'Intel', family: 'Core', tier: m[1].toLowerCase(), model: m[2], full: `Core ${m[1].toLowerCase()}-${m[2]}` };

  // Intel Core Ultra — "Core Ultra 7 265K", "Core Ultra 9 285K"
  m = s.match(/\bCore\s+Ultra\s+(\d)\s+(\d{3}[A-Z]{0,3})/i);
  if (m) return { vendor: 'Intel', family: 'Core Ultra', tier: m[1], model: m[2], full: `Core Ultra ${m[1]} ${m[2]}` };

  // Intel Xeon
  m = s.match(/\bXeon\s+([A-Z0-9-]+)/i);
  if (m) return { vendor: 'Intel', family: 'Xeon', model: m[1], full: `Xeon ${m[1]}` };

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Wikipedia API query
// ─────────────────────────────────────────────────────────────────────────────

async function fetchArticle(title) {
  const url = `https://en.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(title)}&prop=wikitext&format=json&redirects=true`;
  const resp = await fetch(url, {
    headers: { 'User-Agent': 'ProRigBuilder/1.0 (https://prorigbuilder.com; coby@prorigbuilder.com) catalog-backfill' },
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  if (data.error) return null;
  return data.parse?.wikitext?.['*'] || null;
}

// Try multiple article title candidates in order of specificity
function candidateTitles(model) {
  const titles = [];
  if (model.vendor === 'AMD') {
    if (model.family === 'Ryzen') {
      // Try specific article first, fall back to list article
      titles.push(`${model.family}_${model.tier}_${model.model}`);
      titles.push(`AMD_${model.family}_${model.tier}_${model.model}`);
      titles.push(`List_of_AMD_Ryzen_processors`);
    } else if (model.family === 'Threadripper') {
      titles.push(`List_of_AMD_Threadripper_processors`);
    }
  } else if (model.vendor === 'Intel') {
    if (model.family === 'Core') {
      // Intel per-SKU articles are rare; the generation list is more reliable
      const gen = parseInt(model.model.slice(0, 2));
      titles.push(`${gen}th_Gen_Intel_Core`);
      titles.push(`List_of_Intel_Core_processors`);
    } else if (model.family === 'Core Ultra') {
      titles.push(`Intel_Core_Ultra`);
    }
  }
  return titles;
}

// ─────────────────────────────────────────────────────────────────────────────
// Parse wikitext infobox / tables for a specific model
// ─────────────────────────────────────────────────────────────────────────────

function parseSpecs(wikitext, modelInfo) {
  if (!wikitext) return null;
  const specs = {};

  // For list articles, find the row containing our model SKU
  const needle = modelInfo.model; // e.g. "7800X3D", "13900K"
  const idx = wikitext.indexOf(needle);
  if (idx === -1) return null;

  // Grab ~3000 chars around this occurrence — usually contains the row + neighbors
  const chunk = wikitext.slice(Math.max(0, idx - 200), idx + 3000);

  // TDP — "125 W", "65W", "TDP: 105 W"
  const tdpM = chunk.match(/\b(?:TDP|PBP|Base Power)[^\n|]{0,20}?(\d{2,3})\s*W\b/i) || chunk.match(/\|\s*tdp[_ ]?w?\s*=\s*(\d{2,3})/i);
  if (tdpM) specs.tdp = parseInt(tdpM[1]);

  // Cores — "16 cores", "cores=8"
  const coresM = chunk.match(/(\d{1,2})\s*(?:cores|×)/i) || chunk.match(/\|\s*cores\s*=\s*(\d{1,2})/i);
  if (coresM) specs.cores = parseInt(coresM[1]);

  // Threads
  const threadsM = chunk.match(/(\d{1,2})\s*threads/i) || chunk.match(/\|\s*threads\s*=\s*(\d{1,2})/i);
  if (threadsM) specs.threads = parseInt(threadsM[1]);

  return Object.keys(specs).length > 0 ? specs : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const cpus = parts.filter(p => p.c === 'CPU' && (!p.tdp || !p.cores));
const target = LIMIT ? cpus.slice(0, LIMIT) : cpus;

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Backfilling CPU specs from Wikipedia');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Missing-field CPUs:', cpus.length);
console.log('Processing:', target.length);
console.log('Rate:', RATE_MS + 'ms per request');
console.log('Dry run:', DRY_RUN);
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');

let matched = 0;
let filled = 0;
const tried = new Map(); // cache by article title so we don't re-fetch

for (let i = 0; i < target.length; i++) {
  const p = target[i];
  const model = extractModel(p.n);
  if (!model) {
    console.log(`[${i+1}/${target.length}] ❌ Can't extract model: ${p.n.slice(0, 70)}`);
    continue;
  }
  process.stdout.write(`[${i+1}/${target.length}] ${model.full} ... `);

  let found = false;
  for (const title of candidateTitles(model)) {
    let wikitext = tried.get(title);
    if (wikitext === undefined) {
      wikitext = await fetchArticle(title);
      tried.set(title, wikitext);
      await sleep(RATE_MS);
    }

    const specs = parseSpecs(wikitext, model);
    if (specs) {
      matched++;
      found = true;
      const before = JSON.stringify({ tdp: p.tdp, cores: p.cores, threads: p.threads });
      if (!p.tdp && specs.tdp) { p.tdp = specs.tdp; filled++; }
      if (!p.cores && specs.cores) { p.cores = specs.cores; filled++; }
      if (!p.threads && specs.threads) { p.threads = specs.threads; filled++; }
      console.log(`✓ ${JSON.stringify(specs)}`);
      break;
    }
  }

  if (!found) console.log('✗ not found');
}

console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('Matched:', matched, '/', target.length);
console.log('Fields filled:', filled);
console.log('Cached articles:', tried.size);

if (!DRY_RUN) {
  const source = `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`;
  writeFileSync('./src/data/parts.js', source);
  console.log('Wrote', parts.length, 'products to ./src/data/parts.js');
} else {
  console.log('\nDRY RUN — parts.js not modified');
}
