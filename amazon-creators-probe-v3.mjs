// amazon-creators-probe-v3.mjs
//
// READ-ONLY. Writes nothing. Does NOT call DataForSEO.
//
// PART 1 — OFFER DEPTH
//   Is offersV2.listings capped by design (buybox + ~1 alternate), or can a
//   request parameter widen it? Probes:
//     a) max listings ever returned across a wide ASIN sweep
//     b) does the legacy `offers.*` namespace exist at all
//     c) do condition / merchant / offerCount / itemCount params expand it
//        (bogus values are sent deliberately — the API's 400 leaks the enum)
//
// PART 2 — ASIN IDENTITY AUDIT
//   GetItems across a stratified sample of catalog rows; compare the returned
//   Amazon title to the stored catalog name using the EXISTING gate
//   (titleMatches from drift-gate.js: token overlap + model-token + capacity)
//   plus the model-suffix check from audit-deal-links-v2.cjs.
//
// Run: node amazon-creators-probe-v3.mjs [sampleSize]

import { readFileSync } from 'node:fs';
import { titleMatches } from './drift-gate.js';

const CREDS_PATH  = process.env.PRORIG_AMAZON_CREDS || 'C:\\rigfinder\\PRB-credentials.csv';
const PARTNER_TAG = 'tiereduptech-20';
const MARKETPLACE = 'www.amazon.com';
const TOKEN_URL   = 'https://api.amazon.com/auth/o2/token';
const SCOPE       = 'creatorsapi::default';
const BASE        = 'https://creatorsapi.amazon/catalog/v1';
const GETITEMS    = `${BASE}/getItems`;

const SAMPLE_SIZE = Number(process.argv[2]) || 200;
const PAUSE_MS = 1100;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- creds --------------------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') {}
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}
function loadCreds(p) {
  const rows = parseCsv(readFileSync(p, 'utf8'));
  const h = rows[0].map(x => x.trim().toLowerCase()), d = rows[1];
  const g = n => { const i = h.indexOf(n); return i === -1 ? '' : (d[i] || '').trim(); };
  return { id: g('credential id'), secret: g('secret'), version: g('version') };
}
async function getToken(id, secret) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: SCOPE }).toString(),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('token failed: ' + JSON.stringify(j).slice(0, 300));
  return j.access_token;
}

let TOKEN = null;
async function call(url, body, tries = 3) {
  for (let a = 0; a < tries; a++) {
    let res, text;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json',
                   Accept: 'application/json', 'x-marketplace': MARKETPLACE },
        body: JSON.stringify(body),
      });
      text = await res.text();
    } catch (e) { await sleep(1500); continue; }
    if (res.status === 429 && a < tries - 1) { await sleep(2500 * (a + 1)); continue; }
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, ok: res.ok, json, raw: text };
  }
  return { status: 0, ok: false, json: null, raw: 'exhausted retries' };
}

const base = (x = {}) => ({ marketplace: MARKETPLACE, partnerTag: PARTNER_TAG, partnerType: 'Associates', ...x });
const itemsOf = j => j?.itemsResult?.items || j?.items || [];
const listingsOf = it => it?.offersV2?.listings || it?.offers?.listings || [];
function hr(t) { console.log('\n' + '='.repeat(74)); console.log(t); console.log('='.repeat(74)); }
function sub(t) { console.log('\n' + '-'.repeat(74)); console.log(t); console.log('-'.repeat(74)); }

// model-suffix check, lifted verbatim from audit-deal-links-v2.cjs
function extractSuffix(name) {
  if (!name) return '';
  const m = String(name).toUpperCase().match(/[A-Z]\d{3,4}-([A-Z0-9]+)\b/);
  return m ? m[1] : '';
}

// ---- fixtures -----------------------------------------------------------
async function loadCatalog() {
  const mod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js');
  const re = /(?:\/dp\/|\/gp\/product\/|ASIN=)([A-Z0-9]{10})/;
  const rows = [];
  for (const p of mod.default) {
    const url = p?.deals?.amazon?.url;
    if (!url) continue;
    const m = String(url).match(re);
    if (!m) continue;
    rows.push({ id: p.id, cat: p.c || '?', name: p.n, cap: p.cap ?? null, asin: m[1] });
  }
  return rows;
}

// stratified round-robin so every category is represented
function stratify(rows, n) {
  const byCat = {};
  for (const r of rows) (byCat[r.cat] ||= []).push(r);
  const cats = Object.keys(byCat).sort();
  const out = [], seen = new Set();
  let i = 0;
  while (out.length < n) {
    let added = false;
    for (const c of cats) {
      const list = byCat[c];
      if (i < list.length) {
        const r = list[i];
        if (!seen.has(r.asin)) { seen.add(r.asin); out.push(r); added = true; }
        if (out.length >= n) break;
      }
    }
    if (!added) break;
    i++;
  }
  return out;
}

(async () => {
  hr('Amazon Creators API — PROBE v3 (read-only; NO DataForSEO calls)');

  const rows = await loadCatalog();
  console.log(`catalog: ${rows.length} Amazon-linked rows`);

  const creds = loadCreds(CREDS_PATH);
  TOKEN = await getToken(creds.id, creds.secret);
  console.log('token: acquired\n');

  const OFFER_RES = ['itemInfo.title', 'offersV2.listings.price', 'offersV2.listings.condition',
                     'offersV2.listings.merchantInfo', 'offersV2.listings.isBuyBoxWinner',
                     'offersV2.listings.availability', 'offersV2.listings.type'];

  // ======================================================================
  // PART 1 — OFFER DEPTH
  // ======================================================================
  hr('PART 1 — OFFER DEPTH: is offersV2.listings capped by design?');

  // 1a. Sweep a broad set of ASINs, record how many listings each returns.
  sub('1a. Max listings observed across a 120-ASIN sweep');
  const sweep = stratify(rows, 120);
  const dist = {};                 // listingCount -> n
  let best = { count: -1 };
  for (let i = 0; i < sweep.length; i += 10) {
    const chunk = sweep.slice(i, i + 10);
    const r = await call(GETITEMS, base({ itemIds: chunk.map(x => x.asin), itemIdType: 'ASIN', resources: OFFER_RES }));
    for (const it of itemsOf(r.json)) {
      const n = listingsOf(it).length;
      dist[n] = (dist[n] || 0) + 1;
      if (n > best.count) {
        const row = chunk.find(x => x.asin === it.asin);
        best = { count: n, asin: it.asin, name: row?.name || it?.itemInfo?.title?.displayValue };
      }
    }
    await sleep(PAUSE_MS);
  }
  console.log('listings-per-item distribution (items sampled):');
  for (const k of Object.keys(dist).map(Number).sort((a, b) => a - b)) {
    console.log(`  ${k} listing(s): ${dist[k]} items`);
  }
  console.log(`\nMAX listings returned for any single ASIN: ${best.count}`);
  console.log(`  worst-case ASIN: ${best.asin} — ${best.name}`);

  const TARGET = best.asin;

  // 1b. Does the legacy offers.* namespace exist?
  sub('1b. Legacy `offers.*` namespace vs `offersV2.*`');
  const legacy = await call(GETITEMS, base({ itemIds: [TARGET], itemIdType: 'ASIN',
    resources: ['itemInfo.title', 'offers.listings.price'] }));
  console.log(`offers.listings.price  -> HTTP ${legacy.status}`);
  console.log('  ' + (legacy.raw || '').slice(0, 260));
  await sleep(PAUSE_MS);

  // 1c. Do request parameters widen the listing set?
  //     Bogus values are intentional: the 400 body leaks the valid enum.
  sub('1c. Can any request parameter expand the listings? (bogus values leak enums)');
  const paramTests = [
    { label: 'baseline (no extra params)', extra: {} },
    { label: 'condition: "Any"',           extra: { condition: 'Any' } },
    { label: 'condition: "Used"',          extra: { condition: 'Used' } },
    { label: 'condition: "__BOGUS__"',     extra: { condition: '__BOGUS__' } },
    { label: 'merchant: "All"',            extra: { merchant: 'All' } },
    { label: 'merchant: "__BOGUS__"',      extra: { merchant: '__BOGUS__' } },
    { label: 'offerCount: 10',             extra: { offerCount: 10 } },
    { label: 'itemCount: 10',              extra: { itemCount: 10 } },
    { label: 'maxOffers: 20',              extra: { maxOffers: 20 } },
    { label: 'offerPage: 2',               extra: { offerPage: 2 } },
  ];
  console.log('param'.padEnd(32) + 'HTTP'.padEnd(6) + 'listings'.padEnd(10) + 'note');
  console.log('-'.repeat(74));
  const paramResults = {};
  for (const t of paramTests) {
    const r = await call(GETITEMS, base({ itemIds: [TARGET], itemIdType: 'ASIN', resources: OFFER_RES, ...t.extra }));
    const it = itemsOf(r.json)[0];
    const n = it ? listingsOf(it).length : 0;
    let note = '';
    if (!r.ok) {
      const msg = r.json?.message || r.raw || '';
      note = msg.slice(0, 150).replace(/\s+/g, ' ');
    }
    paramResults[t.label] = { status: r.status, listings: n, note };
    console.log(t.label.padEnd(32) + String(r.status).padEnd(6) + String(n).padEnd(10) + note.slice(0, 60));
    if (note.length > 60) console.log('   └─ ' + note);
    await sleep(PAUSE_MS);
  }

  // Full offer dump for the deepest ASIN, so the shape is on record.
  sub(`1d. Full listing dump for deepest ASIN ${TARGET}`);
  const deep = await call(GETITEMS, base({ itemIds: [TARGET], itemIdType: 'ASIN', resources: OFFER_RES }));
  const deepItem = itemsOf(deep.json)[0];
  console.log(JSON.stringify(deepItem?.offersV2 ?? deep.json, null, 2).slice(0, 3000));

  // ======================================================================
  // PART 2 — ASIN IDENTITY AUDIT
  // ======================================================================
  hr(`PART 2 — ASIN IDENTITY AUDIT (${SAMPLE_SIZE} rows, stratified by category)`);
  console.log('Gate: titleMatches() from drift-gate.js (token overlap >=0.5 + model-token');
  console.log('      + capacity) — the SAME check the verifier uses — plus the');
  console.log('      model-suffix check from audit-deal-links-v2.cjs.\n');

  const sample = stratify(rows, SAMPLE_SIZE);
  const catCount = {};
  for (const r of sample) catCount[r.cat] = (catCount[r.cat] || 0) + 1;
  console.log(`sample: ${sample.length} rows across ${Object.keys(catCount).length} categories`);
  console.log(JSON.stringify(catCount) + '\n');

  const mismatches = [], suffixHits = [], notReturned = [], okRows = [];
  let checked = 0;

  for (let i = 0; i < sample.length; i += 10) {
    const chunk = sample.slice(i, i + 10);
    const r = await call(GETITEMS, base({
      itemIds: chunk.map(x => x.asin), itemIdType: 'ASIN',
      resources: ['itemInfo.title', 'offersV2.listings.price', 'offersV2.listings.condition'],
    }));
    const got = new Map(itemsOf(r.json).map(it => [it.asin, it]));

    for (const row of chunk) {
      const it = got.get(row.asin);
      if (!it) { notReturned.push(row); continue; }
      checked++;
      const azTitle = it?.itemInfo?.title?.displayValue || '';
      const tm = titleMatches(row.name, azTitle, row.cap);

      const sA = extractSuffix(row.name), sB = extractSuffix(azTitle);
      const suffixConflict = !!(sA && sB && sA !== sB);

      if (!tm.match || suffixConflict) {
        const rec = { ...row, azTitle, score: tm.score, capConflict: !!tm.capConflict,
                      suffixConflict, storedSuffix: sA, azSuffix: sB };
        mismatches.push(rec);
        if (suffixConflict) suffixHits.push(rec);
      } else okRows.push(row);
    }
    process.stdout.write(`\r  checked ${checked}/${sample.length}…`);
    await sleep(PAUSE_MS);
  }
  console.log('\n');

  const rate = checked ? (mismatches.length / checked * 100) : 0;
  console.log('RESULTS');
  console.log('-'.repeat(74));
  console.log(`  rows sampled ..................... ${sample.length}`);
  console.log(`  returned by PA API ............... ${checked}`);
  console.log(`  ASINs NOT returned (dead/invalid)  ${notReturned.length}`);
  console.log(`  clean (title matches) ............ ${okRows.length}`);
  console.log(`  MISMATCHES ....................... ${mismatches.length}`);
  console.log(`  mismatch rate .................... ${rate.toFixed(1)}%`);
  console.log(`    of which capacity conflicts .... ${mismatches.filter(m => m.capConflict).length}`);
  console.log(`    of which model-suffix conflicts  ${suffixHits.length}`);

  const byCat = {};
  for (const m of mismatches) byCat[m.cat] = (byCat[m.cat] || 0) + 1;
  console.log('\n  mismatches by category:');
  for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${c.padEnd(18)} ${n}/${catCount[c]}`);
  }

  sub('MISMATCH DETAIL (stored name  vs  Amazon title)');
  for (const m of mismatches) {
    console.log(`\n[${m.cat}] id=${m.id}  asin=${m.asin}  score=${m.score}` +
      (m.capConflict ? '  CAPACITY-CONFLICT' : '') +
      (m.suffixConflict ? `  SUFFIX ${m.storedSuffix}≠${m.azSuffix}` : ''));
    console.log(`  stored: ${m.name}`);
    console.log(`  amazon: ${m.azTitle}`);
  }

  if (notReturned.length) {
    sub('ASINs NOT RETURNED BY PA API (dead / invalid / region-gated)');
    for (const r of notReturned) console.log(`  [${r.cat}] id=${r.id} asin=${r.asin} — ${r.name}`);
  }

  hr('SUMMARY');
  console.log(JSON.stringify({
    offerDepth: { maxListings: best.count, deepestAsin: best.asin, distribution: dist, params: paramResults },
    identityAudit: {
      sampled: sample.length, returned: checked, notReturned: notReturned.length,
      clean: okRows.length, mismatches: mismatches.length,
      mismatchRatePct: Number(rate.toFixed(1)),
      capacityConflicts: mismatches.filter(m => m.capConflict).length,
      suffixConflicts: suffixHits.length,
    },
  }, null, 2));
  console.log('\nNo writes. No migration. DataForSEO not called.');
})();
