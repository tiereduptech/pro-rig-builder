#!/usr/bin/env node
/**
 * relink-bestbuy-mismatches.mjs — find the RIGHT Best Buy sku for the rows whose
 * sku names a different product, and relink only the ones that are certain.
 *
 * DRY RUN BY DEFAULT. `--apply` is the only thing that writes.
 *
 *   node relink-bestbuy-mismatches.mjs                          # report only
 *   node relink-bestbuy-mismatches.mjs --apply                  # relink what is certain
 *   node relink-bestbuy-mismatches.mjs --ids=50485,50501        # a scoped pass
 *   node relink-bestbuy-mismatches.mjs --expect-count=6         # refuse to widen
 *
 * ── WHY THIS IS A SEPARATE PASS ──────────────────────────────────────────────
 * refresh-bestbuy-prices.mjs holds the price on a row whose sku names another
 * product, and stops there on purpose. A mismap is the one error class a daily
 * job cannot recover from by waiting — tomorrow's run reads the same wrong sku
 * and agrees with itself — so it needs a decision, and a decision about which
 * product a row IS does not belong in a job that runs unattended every night.
 *
 * ── AND WHY IT IS NOT A REVIEW QUEUE EITHER ──────────────────────────────────
 * build-relink-review-queue.mjs says it plainly for Amazon: "a wrong ASIN
 * replaced by a guessed ASIN is the same bug in a new coat". That is right
 * about guesses, and it is why every candidate here has to clear the gates the
 * ingest path clears before it can be written:
 *
 *   identity   the model designations must AGREE — namesAgreeOnModel() === 'match',
 *              the same function refresh-bestbuy-prices.mjs uses to flag the row
 *   capacity   capacityCompatible(), a hard gate, never a signal
 *   price      isPricePlausibleForCapacity() on storage, as bestbuy-merge does
 *   condition  a refurbished row may only be relinked to a refurbished listing
 *              and vice versa (condition.cjs's isRenewedTitle)
 *   brand      the row's brand must appear in the candidate's name
 *
 * A row with exactly ONE candidate through all of that is not a guess: it is a
 * UPC or a model number resolving to a listing that names the same model, of
 * the same capacity, in the same condition. A row with none, or with two, is
 * left exactly as it is and reported. No forced matches, ever.
 *
 * ── HOW IT LOOKS FOR THE RIGHT SKU ───────────────────────────────────────────
 * Tiered, the same order the ingest matcher uses, because it is the order of
 * decreasing certainty:
 *
 *   1. upc=          the row's own GTIN. An exact identifier, both directions.
 *   2. modelNumber=  the manufacturer part number.
 *   3. search=       brand + model designation + capacity, as a last resort.
 *
 * Every tier feeds the same gates. The tier only decides what gets LOOKED at.
 *
 * ── WHAT IT WRITES ───────────────────────────────────────────────────────────
 * The sku, the url (prodsku and the destination both, so the affiliate link
 * stops sending buyers to the wrong product page), the price and the stock.
 *
 * The price is written but NOT stamped confirmed: it is marked
 * priceConfidence:'unconfirmed' with reason 'bestbuy:relinked-<date>'. This
 * pass establishes identity, not price truth — the sanity ladder that decides
 * whether a Best Buy price may be published lives in refresh-bestbuy-prices.mjs
 * and runs over the row the next night. Two places allowed to certify a price
 * is how they end up disagreeing.
 *
 * ── SCOPE ────────────────────────────────────────────────────────────────────
 * Never the whole catalog. The ids come from the refresh summary's
 * heldNameMismatch list, from rows already stamped 'bestbuy:name-mismatch', or
 * from --ids. --expect-count asserts the count before anything is fetched, so
 * a pass cannot silently widen the day the upstream list grows.
 *
 * Every id is re-checked against the live API before it is acted on: if the
 * mismatch is gone (Best Buy corrected the listing, or someone relinked it
 * already) the row is reported as resolved and left alone. A stale report must
 * not be able to move a row that is no longer broken.
 *
 * ── WHEN THE DISAGREEMENT IS ON OUR SIDE ─────────────────────────────────────
 * A row lands in this queue because two NAMES disagreed, and a name has two
 * sides. Usually the link is the wrong one. Sometimes it is our title.
 *
 * The tell is the row's own sku coming back from an IDENTIFIER tier: Best Buy's
 * record for this row's upc or model number resolving to the sku the row
 * already carries. The barcode and the link then corroborate each other and the
 * stored name is the outlier. Those rows are reported as `name-suspect` rather
 * than folded in with `none`, because the remedy is the opposite one — check
 * the product title, do not go hunting for a different sku. Row 90365 on
 * 2026-08-19 is the case: upc 199271246627 returned sku 6673532, the sku on the
 * row, and nothing else.
 *
 * Nothing is written for them either way. The distinction is about pointing the
 * reviewer at the half of the row that is actually in doubt.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

import {
  namesAgreeOnModel, modelDesignations, parseCapacityGB, capacityCompatible,
  isHardDrive, isPricePlausibleForCapacity,
} from './normalize-product-name.js';

const require = createRequire(import.meta.url);
const { writeCatalog } = require('./scripts/write-catalog.cjs');
const { isRenewedTitle } = require('./condition.cjs');

// ── CLI ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const argOf = (f, d = null) => {
  const eq = argv.find((a) => a.startsWith(`--${f}=`));
  if (eq) return eq.slice(f.length + 3);
  const i = argv.indexOf(`--${f}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const APPLY = has('apply');
const IDS_ARG = argOf('ids');
const EXPECT = argOf('expect-count') ? Number(argOf('expect-count')) : null;
const SUMMARY_IN = argOf('from-summary', path.join(process.cwd(), 'catalog-build', 'bestbuy-refresh-summary.json'));
const MAX_CANDIDATES = 50;

const ROOT = process.cwd();
const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) {
  console.error('ERROR: BESTBUY_API_KEY required.');
  process.exit(1);
}

const PACE_MS = 340;
const TRIES = 3;
const DETERMINISTIC = new Set([400, 401, 404, 414, 422]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bar = '='.repeat(96);
const today = new Date().toISOString().slice(0, 10);
const API = 'https://api.bestbuy.com/v1';
const SHOW = ['sku', 'name', 'salePrice', 'regularPrice', 'onSale', 'active', 'orderable',
  'onlineAvailability', 'priceUpdateDate', 'upc', 'modelNumber', 'manufacturer', 'url'].join(',');

// Same form and the same error handling as refresh-bestbuy-prices.mjs — filter
// in the path, format as a parameter, and keep the body when the API objects.
function errDetail(status, body) {
  let msg = null;
  if (body) {
    try { msg = JSON.parse(body).errorMessage || null; } catch {
      const m = body.match(/<(?:errorMessage|message)>([^<]+)</i);
      msg = m ? m[1] : body.replace(/\s+/g, ' ').trim().slice(0, 200) || null;
    }
  }
  return `HTTP ${status}${msg ? ` — ${msg}` : ''}`;
}
async function get(url) {
  let last = null;
  for (let attempt = 1; attempt <= TRIES; attempt++) {
    try {
      const res = await fetch(url);
      if (res.ok) return { ok: true, json: await res.json(), status: res.status };
      last = errDetail(res.status, await res.text().catch(() => ''));
      if (res.status === 404) return { ok: false, status: 404, err: 'HTTP 404' };
      if (DETERMINISTIC.has(res.status)) return { ok: false, status: res.status, err: last };
    } catch (e) { last = e.message; }
    if (attempt < TRIES) await sleep(1200 * attempt);
  }
  return { ok: false, status: null, err: last };
}
const q = (s) => encodeURIComponent(String(s));
const query = (filter) => `${API}/products(${filter})?apiKey=${KEY}&show=${SHOW}&pageSize=${MAX_CANDIDATES}&format=json`;

const buyableOf = (v) => v.active !== false && v.onlineAvailability !== false &&
  (v.orderable == null || /^(available|preorder|backorder)$/i.test(String(v.orderable)));

// ── Catalog ──────────────────────────────────────────────────────────────────
const skuOf = (deal) => {
  if (deal.sku) return String(deal.sku);
  const m = String(deal.url || '').match(/[?&]prodsku=(\d+)/);
  return m ? m[1] : null;
};

const parts = (await import(`file://${path.join(ROOT, 'src/data/parts.js')}?t=${Date.now()}`)).PARTS;
if (!Array.isArray(parts)) { console.error('parts.js did not export PARTS'); process.exit(1); }
const loadedCount = parts.length;
const byId = new Map(parts.map((p) => [p.id, p]));

// ── Scope ────────────────────────────────────────────────────────────────────
let ids = [];
let idSource = '';
if (IDS_ARG) {
  ids = IDS_ARG.split(',').map((s) => Number(s.trim())).filter(Boolean);
  idSource = '--ids';
} else if (existsSync(SUMMARY_IN)) {
  const s = JSON.parse(readFileSync(SUMMARY_IN, 'utf8'));
  ids = (s.heldNameMismatch || []).map((r) => r.id);
  idSource = `${path.relative(ROOT, SUMMARY_IN)} (run ${s.ranAt || '?'})`;
}
if (!ids.length) {
  ids = parts.filter((p) => p.deals?.bestbuy?.priceUnconfirmedReason === 'bestbuy:name-mismatch').map((p) => p.id);
  idSource = 'catalog rows stamped bestbuy:name-mismatch';
}
if (!ids.length) {
  console.log('No rows to relink: no --ids, no heldNameMismatch in the summary, no stamped rows.');
  process.exit(0);
}
if (EXPECT != null && ids.length !== EXPECT) {
  console.error(`ERROR: --expect-count=${EXPECT} but the scope is ${ids.length} rows (${idSource}). Refusing to widen.`);
  process.exit(1);
}

console.log(bar);
console.log(`BEST BUY RELINK — ${APPLY ? 'APPLY' : 'DRY RUN (nothing written)'}`);
console.log(`scope: ${ids.length} row(s) from ${idSource}`);
console.log(bar);

// ── Gates ────────────────────────────────────────────────────────────────────
const STORAGE_CATS = new Set(['Storage', 'ExternalStorage']);

// Tiers that look a row up by an EXACT identifier rather than by words. Which
// tier found a candidate is normally just provenance; for the row's own sku it
// is the whole signal — see the self-drop note in the candidate loop.
const IDENTIFIER_TIERS = new Set(['upc', 'modelNumber']);

/** Why a candidate was rejected, or null if it survives every gate. */
function reject(row, cand) {
  const id = namesAgreeOnModel(row.n, cand.name || '');
  if (id.verdict !== 'match') {
    return `${id.verdict}: row names [${id.a.join(' ') || '—'}], candidate names [${id.b.join(' ') || '—'}]`;
  }
  const ourCap = row.cap != null ? row.cap : parseCapacityGB(row.n);
  const theirCap = parseCapacityGB(cand.name || '');
  if (!capacityCompatible(ourCap, theirCap)) return `capacity ${ourCap ?? '—'} vs ${theirCap ?? '—'}`;
  if (STORAGE_CATS.has(row.c) && cand.salePrice != null &&
      !isPricePlausibleForCapacity(cand.salePrice, ourCap, { isHDD: isHardDrive(row) })) {
    return `price $${cand.salePrice} implausible for ${ourCap}GB`;
  }
  // Condition is identity too: the Geek Squad refurbished 970 EVO Plus and the
  // new one are two skus at two prices, and swapping one for the other is the
  // same class of error this pass exists to undo.
  const ourRefurb = row.condition && row.condition !== 'new' ? true : isRenewedTitle(row.n);
  const theirRefurb = isRenewedTitle(cand.name || '');
  if (ourRefurb !== theirRefurb) return `condition: row ${ourRefurb ? 'refurbished' : 'new'}, candidate ${theirRefurb ? 'refurbished' : 'new'}`;
  const brand = String(row.b || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const candName = String(cand.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (brand && brand.length >= 2 && !candName.includes(brand)) return `brand "${row.b}" absent from the candidate`;
  if (cand.active === false) return 'listing is inactive';
  return null;
}

/** The affiliate wrapper, repointed. Returns null if the url is not one we can rewrite. */
function repoint(url, sku, destination) {
  const u = String(url || '');
  if (!/[?&]prodsku=\d+/.test(u)) return null;
  let out = u.replace(/([?&]prodsku=)\d+/, `$1${sku}`);
  if (destination && /[?&]u=/.test(out)) out = out.replace(/([?&]u=)[^&]*/, `$1${encodeURIComponent(destination)}`);
  return out;
}

// ── Work ─────────────────────────────────────────────────────────────────────
const results = [];
for (const id of ids) {
  const p = byId.get(id);
  if (!p) { results.push({ id, outcome: 'gone', why: 'no such row in the catalog' }); continue; }
  const deal = p.deals?.bestbuy;
  const sku = deal ? skuOf(deal) : null;
  if (!deal || !sku) { results.push({ id, name: p?.n, outcome: 'gone', why: 'row has no Best Buy sku' }); continue; }

  const row = { id, name: p.n, cat: p.c, sku, storedPrice: deal.price ?? null };

  // 1. Is it still wrong? A report is evidence about the moment it was written.
  const cur = await get(`${API}/products/${sku}.json?apiKey=${KEY}&show=all&format=json`);
  await sleep(PACE_MS);
  if (!cur.ok && cur.status !== 404) { results.push({ ...row, outcome: 'unknown', why: cur.err }); continue; }
  const curName = cur.ok ? (cur.json?.name || '') : null;
  if (cur.ok) {
    const v = namesAgreeOnModel(p.n, curName);
    if (v.verdict !== 'mismatch') {
      results.push({ ...row, outcome: 'resolved', why: `sku ${sku} now reads "${curName}" — ${v.verdict}`, apiName: curName });
      continue;
    }
  }
  row.currentSkuName = cur.ok ? curName : '404 — sku is dead';

  // 2. Tiered search for the product the row actually names.
  const tiers = [];
  if (p.upc) tiers.push({ tier: 'upc', url: query(`upc=${q(String(p.upc).replace(/\D/g, ''))}`) });
  if (p.mpn) tiers.push({ tier: 'modelNumber', url: query(`modelNumber=${q(p.mpn)}`) });
  const terms = [String(p.b || ''), ...modelDesignations(p.n)]
    .concat(p.cap ? [p.cap >= 1000 ? `${p.cap / 1000}tb` : `${p.cap}gb`] : [])
    .map((t) => String(t).trim()).filter(Boolean);
  if (terms.length >= 2) {
    tiers.push({ tier: 'search', url: query(`(${terms.map((t) => `search=${q(t)}`).join('&')})`) });
  }

  const seen = new Map();      // sku -> candidate
  const rejected = [];
  const survivors = [];
  const selfSkuBy = [];   // identifier tiers that returned the row's OWN sku
  let usedTier = null;
  for (const t of tiers) {
    const res = await get(t.url);
    await sleep(PACE_MS);
    if (!res.ok) { rejected.push({ tier: t.tier, why: res.err }); continue; }
    const found = res.json?.products || [];
    for (const cand of found) {
      if (seen.has(String(cand.sku))) continue;
      seen.set(String(cand.sku), cand);
      // The row's own sku can come back as a candidate. It cannot be the
      // ANSWER — relinking a row to the sku it already has is a no-op — so it
      // is dropped here either way.
      //
      // But WHY it came back is not a detail. This comment used to say the sku
      // "is the wrong product — that is why the row is here", and that asserts
      // the very thing in question. The row is here because a NAME comparison
      // disagreed, and a name has two sides. When an IDENTIFIER tier is what
      // returned it — Best Buy's own record for this row's upc or model number
      // resolving to the sku already on the row — the barcode and the link
      // agree with each other and our stored NAME is the odd one out. Row 90365
      // on 2026-08-19: upc 199271246627 returned sku 6673532, the sku on the
      // row, and nothing else. Calling that "no candidate" points the reviewer
      // at picking a sku when the thing to check is the product title.
      if (String(cand.sku) === sku) {
        if (IDENTIFIER_TIERS.has(t.tier)) selfSkuBy.push(t.tier);
        rejected.push({ tier: t.tier, sku, name: cand.name, why: `the sku already on the row, returned by the ${t.tier} tier` });
        continue;
      }
      const why = reject(p, cand);
      if (why) rejected.push({ tier: t.tier, sku: String(cand.sku), name: cand.name, why });
      else survivors.push({ tier: t.tier, cand });
    }
    // Stop at the first tier that survives anything. A UPC hit is not improved
    // by also running a keyword search; running one anyway only creates ways to
    // turn a certainty into an ambiguity.
    if (survivors.length) { usedTier = t.tier; break; }
  }

  if (survivors.length === 1) {
    const c = survivors[0].cand;
    const url = repoint(deal.url, String(c.sku), c.url || null);
    if (!url) {
      results.push({ ...row, outcome: 'unwritable', why: 'the deal url has no prodsku= to repoint', newSku: String(c.sku), newName: c.name });
      continue;
    }
    results.push({
      ...row, outcome: 'relink', tier: usedTier,
      newSku: String(c.sku), newName: c.name, newUrl: url,
      newPrice: c.salePrice ?? null, newInStock: buyableOf(c),
      upcMatch: !!(p.upc && c.upc && String(p.upc).replace(/\D/g, '') === String(c.upc).replace(/\D/g, '')),
      considered: seen.size, rejected,
    });
  } else if (survivors.length > 1) {
    results.push({ ...row, outcome: 'ambiguous', considered: seen.size,
      why: `${survivors.length} candidates cleared every gate`,
      candidates: survivors.map((s) => ({ sku: String(s.cand.sku), name: s.cand.name, price: s.cand.salePrice ?? null, tier: s.tier })) });
  } else if (selfSkuBy.length) {
    // Not "no candidate". The identifier resolved, and it resolved to the sku
    // this row already carries. That is a different finding with a different
    // remedy, and it is reported as one rather than being folded into the pile
    // of rows whose sku is unknown.
    results.push({ ...row, outcome: 'name-suspect', considered: seen.size,
      identifierAgreesOn: selfSkuBy,
      why: `Best Buy resolves this row's ${selfSkuBy.join(' and ')} to sku ${sku} — the sku already on the row. ` +
        'The identifier and the link agree; only our stored name disagrees, so the name is the more likely error.',
      rejected: rejected.slice(0, 12) });
  } else {
    results.push({ ...row, outcome: 'none', considered: seen.size,
      why: seen.size ? 'every candidate failed a gate' : 'no candidate returned by any tier',
      rejected: rejected.slice(0, 12) });
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
const of = (o) => results.filter((r) => r.outcome === o);
const n = (o) => of(o).length;

console.log('');
console.log(`  rows in scope ....................... ${results.length}`);
console.log(`  -> relinkable (one clean candidate) . ${n('relink')}`);
console.log(`  -> ambiguous (more than one) ........ ${n('ambiguous')}  <- left alone`);
console.log(`  -> no candidate ..................... ${n('none')}  <- left alone`);
console.log(`  -> our name is the suspect .......... ${n('name-suspect')}  <- left alone`);
console.log(`  -> already resolved upstream ........ ${n('resolved')}`);
console.log(`  -> url could not be repointed ....... ${n('unwritable')}`);
console.log(`  -> row gone / no sku ................ ${n('gone')}`);
console.log(`  -> API gave no answer ............... ${n('unknown')}`);

for (const r of of('relink')) {
  console.log('');
  console.log(`RELINK ${r.id}  ${r.name.slice(0, 70)}`);
  console.log(`   was  sku ${r.sku}  "${(r.currentSkuName || '').slice(0, 66)}"  $${r.storedPrice ?? '—'}`);
  console.log(`   now  sku ${r.newSku}  "${(r.newName || '').slice(0, 66)}"  $${r.newPrice ?? '—'}` +
    `  [${r.tier}${r.upcMatch ? ', upc confirmed' : ''}]`);
}
for (const r of of('ambiguous')) {
  console.log('');
  console.log(`AMBIGUOUS ${r.id}  ${r.name.slice(0, 70)} — ${r.why}`);
  r.candidates.forEach((c) => console.log(`   sku ${c.sku}  $${c.price ?? '—'}  ${String(c.name).slice(0, 70)}`));
}
for (const r of of('none')) {
  console.log('');
  console.log(`NO CANDIDATE ${r.id}  ${r.name.slice(0, 70)} — ${r.why} (${r.considered} looked at)`);
  (r.rejected || []).slice(0, 5).forEach((x) => console.log(`   ${x.sku ? `sku ${x.sku}` : x.tier}: ${x.why}`));
}
for (const r of of('name-suspect')) {
  console.log('');
  console.log(`NAME SUSPECT ${r.id}  ${r.name.slice(0, 70)}`);
  console.log(`   sku ${r.sku} is what Best Buy returns for this row's ${r.identifierAgreesOn.join(' and ')}.`);
  console.log(`   ours   "${String(r.name).slice(0, 74)}"`);
  console.log(`   theirs "${String(r.currentSkuName || '').slice(0, 74)}"`);
  console.log('   The link is corroborated by the identifier; the stored name is not.');
  console.log('   Check the product title before touching the sku.');
}

// ── Write ────────────────────────────────────────────────────────────────────
let written = 0;
if (APPLY) {
  for (const r of of('relink')) {
    const d = byId.get(r.id).deals.bestbuy;
    d.sku = r.newSku;
    d.url = r.newUrl;
    if (r.newPrice != null) { d.price = r.newPrice; d.priceSource = '1p'; }
    d.inStock = r.newInStock;
    // Identity is settled here; price truth is not. The next refresh run puts
    // this price through the sanity ladder and stamps it, or holds it.
    d.priceConfidence = 'unconfirmed';
    d.priceUnconfirmedReason = `bestbuy:relinked-${today}`;
    d.relinkedAt = today;
    written++;
  }
}

const report = {
  ranAt: new Date().toISOString(),
  apply: APPLY,
  scope: { ids, source: idSource, expectCount: EXPECT },
  totals: {
    considered: results.length, relinkable: n('relink'), relinked: written,
    ambiguous: n('ambiguous'), noCandidate: n('none'), nameSuspect: n('name-suspect'), resolved: n('resolved'),
    unwritable: n('unwritable'), gone: n('gone'), unknown: n('unknown'),
  },
  results,
};
mkdirSync(path.join(ROOT, 'verify-reports'), { recursive: true });
const out = path.join(ROOT, 'verify-reports', `bestbuy-relink-${today}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nReport: ${path.relative(ROOT, out)}`);

if (process.env.GITHUB_STEP_SUMMARY) {
  const md = [`## Best Buy relink — ${APPLY ? 'applied' : 'dry run'}`, ''];
  md.push('| outcome | rows |', '|---|---:|');
  md.push(`| relinked | ${APPLY ? written : `${n('relink')} (dry)`} |`);
  md.push(`| ambiguous — left alone | ${n('ambiguous')} |`);
  md.push(`| no candidate — left alone | ${n('none')} |`);
  md.push(`| our name is the suspect — left alone | ${n('name-suspect')} |`);
  md.push(`| already resolved upstream | ${n('resolved')} |`);
  md.push(`| API gave no answer | ${n('unknown')} |`, '');
  if (n('name-suspect')) {
    md.push('', '### Rows whose stored NAME is the likely error', '',
      'Best Buy resolves these rows\' own identifier to the sku already on the row. The link is',
      'corroborated; the name is not. Check the product title before changing the sku.', '');
    md.push('| id | identifier agrees on | our name | the sku\'s name |', '|---|---|---|---|');
    of('name-suspect').forEach((r) => md.push(
      `| ${r.id} | ${r.identifierAgreesOn.join(', ')} | ${String(r.name).slice(0, 60)} | ${String(r.currentSkuName || '').slice(0, 60)} |`));
    md.push('');
  }
  if (n('relink')) {
    md.push('| id | from | to | tier |', '|---|---|---|---|');
    of('relink').forEach((r) => md.push(`| ${r.id} | ${r.sku} ${String(r.currentSkuName).slice(0, 40)} | ${r.newSku} ${String(r.newName).slice(0, 40)} | ${r.tier} |`));
    md.push('');
  }
  writeFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n', { flag: 'a' });
}

const CI = !!process.env.GITHUB_ACTIONS;
if (n('ambiguous') || n('none')) {
  const left = [...of('ambiguous'), ...of('none')].map((r) => r.id).join(', ');
  const msg = `${n('ambiguous') + n('none')} rows could not be relinked automatically and are untouched: ${left}. ` +
    'They still point at the wrong product and their prices stay held. Each needs a person to pick the sku.';
  console.log(CI ? `::warning::${msg}` : `NOTE: ${msg}`);
}
// Separate from the warning above on purpose. Those rows need a sku chosen;
// these need a name checked, and telling a reviewer to go sku-hunting on a row
// whose sku is corroborated by its own barcode is how the wrong half gets
// edited. Same silence either way would hide that difference.
if (n('name-suspect')) {
  const rows = of('name-suspect').map((r) => `${r.id} (${r.identifierAgreesOn.join('+')})`).join(', ');
  const msg = `${n('name-suspect')} row(s) are flagged as name-suspect and untouched: ${rows}. ` +
    "Best Buy resolves the row's own identifier to the sku it already carries, so the link is corroborated " +
    'and our stored name is the more likely error. Check the product title before changing the sku.';
  console.log(CI ? `::warning::${msg}` : `NOTE: ${msg}`);
}

// A pass that could not read the API has not measured anything, and on a scope
// this small a couple of silent failures is most of it. Say so and exit red
// rather than reporting "0 relinked" as if that were an answer.
if (n('unknown') && n('unknown') / results.length > 0.5) {
  const msg = `${n('unknown')} of ${results.length} rows got no answer from the API — this pass did not read Best Buy.`;
  console.log(CI ? `::error::${msg}` : `ERROR: ${msg}`);
  process.exit(1);
}

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to relink the rows listed above.');
  process.exit(0);
}
if (!written) {
  console.log('\nNothing to write.');
  process.exit(0);
}
await writeCatalog(parts, { loadedCount, reason: `bestbuy relink — ${written} row(s) repointed at the sku that names them` });
console.log('Done.');
