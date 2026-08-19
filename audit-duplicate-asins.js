#!/usr/bin/env node
/**
 * audit-duplicate-asins.js — every ASIN that sits on more than one catalog
 * product, and which of them can be right.
 *
 * REPORT ONLY. It never writes to the catalog, and it never picks a winner.
 *
 *   node audit-duplicate-asins.js
 *   node audit-duplicate-asins.js --json-only
 *
 * An Amazon /dp/ ASIN is one listing. Two products carrying the same one is
 * therefore one of two things, and they need opposite fixes:
 *
 *   the catalog holds the same product twice  -> a dedupe problem. The link is
 *                                                fine; the second row is not.
 *   the products are different                -> a wrong link. At most one of
 *                                                them can be right, and every
 *                                                other row sends buyers to a
 *                                                product they did not click on.
 *
 * The verdicts below are evidence, not adjudication. `wrong` means these two
 * rows cannot both be correct and says why; it does not say which one to keep,
 * because that needs the Amazon listing and this pass has no network. Anything
 * it cannot decide is `needs-check` rather than a guess.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { canonicalizeProductName, namesAgreeOnModel, parseCapacityGB } from './normalize-product-name.js';
import { normalizeForBinding } from './asin-override-table.js';

const JSON_ONLY = process.argv.includes('--json-only');
const ROOT = process.cwd();
const today = new Date().toISOString().slice(0, 10);
const bar = '='.repeat(96);

const parts = (await import(`file://${path.join(ROOT, 'src/data/parts.js')}?t=${Date.now()}`)).PARTS;
const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null);
const overrides = readJson('./src/data/asin-overrides.json') || {};
const quarantine = readJson('./src/data/asin-overrides.quarantined.json');

const asinOf = (p) => {
  if (p.asin) return String(p.asin).toUpperCase();
  const m = String(p.deals?.amazon?.url || '').match(/\/dp\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
};
const key = (p) => { try { return canonicalizeProductName(p.n, p.c); } catch { return null; } };
const brandOf = (p) => String(p.b || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// A row that sells a machine or a kit is not the part it contains, whatever it
// shares with it. The catalog already flags some with `bundle`; these are the
// title shapes that give away the rest.
const BUNDLE_RE = /\b(gaming pc|desktop pc|prebuilt|pre-built|barebones|with\s+(?:msi|asus|gigabyte|asrock)\b|cpu processor with|bundle)\b/i;
const isBundle = (p) => p.bundle === true || BUNDLE_RE.test(p.n || '');

const byAsin = new Map();
for (const p of parts) {
  const a = asinOf(p);
  if (!a) continue;
  if (!byAsin.has(a)) byAsin.set(a, []);
  byAsin.get(a).push(p);
}
const groups = [...byAsin.entries()].filter(([, ps]) => ps.length > 1);

const overrideAsins = new Set(Object.values(overrides).map((e) => e.asin));
const quarantinedAsins = new Set((quarantine?.entries || []).map((e) => e.asin));

/** One verdict per group, with the reason it rests on. */
function classify(rows) {
  const names = new Set(rows.map((p) => normalizeForBinding(p.n)));
  if (names.size === 1) {
    return { verdict: 'same-product-twice', reason: 'identical names — one product, two rows (a dedupe problem, not a wrong link)' };
  }
  const brands = new Set(rows.map(brandOf).filter(Boolean));
  if (brands.size > 1) {
    return { verdict: 'wrong', reason: `${brands.size} brands share one listing: ${[...brands].join(' vs ')}` };
  }
  const bundles = rows.filter(isBundle);
  if (bundles.length && bundles.length < rows.length) {
    return { verdict: 'wrong', reason: `a bundle or prebuilt shares the bare part's listing (${bundles.map((p) => p.id).join(', ')})` };
  }
  const keys = new Set(rows.map(key).filter(Boolean));
  if (keys.size > 1) {
    return { verdict: 'wrong', reason: `different models: ${[...keys].join(' vs ')}` };
  }
  const caps = new Set(rows.map((p) => (p.cap != null ? p.cap : parseCapacityGB(p.n))).filter((c) => c != null));
  if (caps.size > 1) {
    return { verdict: 'wrong', reason: `different capacities: ${[...caps].join('GB vs ')}GB` };
  }
  // Same class key, same brand field, different names. For GPUs that is the AIB
  // case — one chip, many cards, one listing — and they are different products
  // sold at different prices.
  const pair = rows.slice(0, 2);
  const v = namesAgreeOnModel(pair[0].n, pair[1].n);
  if (rows[0].c === 'GPU' || rows[0].c === 'Case' || rows[0].c === 'Motherboard') {
    return { verdict: 'wrong', reason: `one ${rows[0].c} listing on ${rows.length} differently-named products — same class key, different products` };
  }
  if (v.verdict === 'mismatch') return { verdict: 'wrong', reason: `model designations disagree: [${v.a.join(' ')}] vs [${v.b.join(' ')}]` };
  return { verdict: 'needs-check', reason: 'same brand and class, names differ — could be one product named twice' };
}

const findings = groups.map(([asin, rows]) => {
  const c = classify(rows);
  return {
    asin, rows: rows.length, ...c,
    inOverrideTable: overrideAsins.has(asin),
    inQuarantine: quarantinedAsins.has(asin),
    categories: [...new Set(rows.map((p) => p.c))],
    products: rows.map((p) => ({ id: p.id, cat: p.c, name: p.n, brand: p.b ?? null, price: p.pr ?? null, bundle: isBundle(p) || undefined })),
  };
}).sort((a, b) => (a.verdict === b.verdict ? b.rows - a.rows : (a.verdict === 'wrong' ? -1 : b.verdict === 'wrong' ? 1 : 0)));

const n = (v) => findings.filter((f) => f.verdict === v).length;
const rowsIn = (v) => findings.filter((f) => f.verdict === v).reduce((s, f) => s + f.rows, 0);

if (!JSON_ONLY) {
  console.log(bar);
  console.log('DUPLICATE ASINS — one Amazon listing, more than one catalog product');
  console.log(bar);
  console.log(`  products carrying an ASIN ........... ${[...byAsin.values()].reduce((s, r) => s + r.length, 0)}`);
  console.log(`  distinct ASINs ...................... ${byAsin.size}`);
  console.log(`  ASINs on more than one product ...... ${groups.length}  (covering ${groups.reduce((s, [, r]) => s + r.length, 0)} rows)`);
  console.log('');
  console.log(`  -> WRONG — the rows are different products  ${n('wrong')}  (${rowsIn('wrong')} rows)`);
  console.log(`  -> same product, listed twice ............. ${n('same-product-twice')}  (${rowsIn('same-product-twice')} rows)`);
  console.log(`  -> needs a check ......................... ${n('needs-check')}  (${rowsIn('needs-check')} rows)`);
  console.log(`  of all of them, still in the override table ${findings.filter((f) => f.inOverrideTable).length}`);
  console.log(`  quarantined by rekey-asin-overrides.mjs ... ${findings.filter((f) => f.inQuarantine).length}`);

  for (const f of findings.filter((x) => x.verdict === 'wrong')) {
    console.log('');
    console.log(`${f.asin}  ${f.rows} rows — ${f.reason}` +
      (f.inOverrideTable ? '  [STILL IN THE OVERRIDE TABLE]' : f.inQuarantine ? '  [override quarantined]' : ''));
    f.products.forEach((p) => console.log(`   ${String(p.id).padEnd(7)} ${String(p.cat).padEnd(12)} $${String(p.price ?? '—').padEnd(9)} ${p.name.slice(0, 62)}`));
  }
  const nc = findings.filter((x) => x.verdict === 'needs-check');
  if (nc.length) {
    console.log(`\nNEEDS A CHECK (${nc.length}):`);
    nc.forEach((f) => { console.log(`  ${f.asin}  ${f.reason}`); f.products.forEach((p) => console.log(`     ${String(p.id).padEnd(7)} ${p.name.slice(0, 70)}`)); });
  }
}

const report = {
  ranAt: new Date().toISOString(),
  policy: 'REPORT ONLY — never writes the catalog, never picks a winner',
  totals: {
    productsWithAsin: [...byAsin.values()].reduce((s, r) => s + r.length, 0),
    distinctAsins: byAsin.size,
    sharedAsins: groups.length,
    rowsAffected: groups.reduce((s, [, r]) => s + r.length, 0),
    wrong: n('wrong'), wrongRows: rowsIn('wrong'),
    sameProductTwice: n('same-product-twice'), needsCheck: n('needs-check'),
    stillInOverrideTable: findings.filter((f) => f.inOverrideTable).length,
  },
  findings,
};
mkdirSync(path.join(ROOT, 'verify-reports'), { recursive: true });
const out = path.join(ROOT, 'verify-reports', `duplicate-asins-${today}.json`);
writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\nReport: ${path.relative(ROOT, out)}`);

const CI = !!process.env.GITHUB_ACTIONS;
if (n('wrong')) {
  const msg = `${n('wrong')} Amazon listings are shared by ${rowsIn('wrong')} catalog rows that are NOT the same product. ` +
    'At most one row per listing can be right; the rest send buyers to a product they did not click on.';
  console.log(CI ? `::warning::${msg}` : `NOTE: ${msg}`);
}
