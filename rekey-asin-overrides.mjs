#!/usr/bin/env node
/**
 * rekey-asin-overrides.mjs — bind every known-good ASIN to the ONE product it
 * was verified for, and quarantine the entries that cannot name one.
 *
 * DRY RUN BY DEFAULT. `--apply` is the only thing that writes.
 *
 *   node rekey-asin-overrides.mjs
 *   node rekey-asin-overrides.mjs --apply
 *
 * ── WHAT IS WRONG WITH THE TABLE ─────────────────────────────────────────────
 * It is keyed by canonicalizeProductName(), which is a CLASS for GPUs, cases
 * and boards: "NVIDIA|RTX|5080" is 31 distinct cards, "AMD|RX|9070 XT" is 25,
 * "CORSAIR|CASE|ICUE" is 5. Every one of those entries is marked source
 * 'verified' and answers at score 1.0, and verify-catalog-asins.js consults the
 * table FIRST when repairing a mismatched ASIN — on a cron that runs every two
 * days with --fix-asins.
 *
 * It has already landed. B0BNLSDRKB is on the RX 7900 XTX, the 7900 XT and the
 * 7900 GRE at once, and the table claims it under all three keys. B0DF2DC3R4 is
 * on both a Samsung 870 EVO and a Crucial MX500, claimed under SAMSUNG|1TB|SATA
 * and CRUCIAL|1TB|SATA. Click any two of those rows and you land on one product.
 *
 * ── WHAT THIS DOES ABOUT IT ──────────────────────────────────────────────────
 * Three outcomes per entry, decided by how many distinct products its key
 * answers for in the live catalog:
 *
 *   1  ->  BIND. The entry gains `verifiedName`, the exact name of that product,
 *          and `productId` is refreshed to its current id. (Every productId in
 *          the file is stale — the catalog was renumbered underneath it, so all
 *          201 point at ids that no longer exist.) The lookup then requires the
 *          name to match, so the entry answers for that product and nothing else.
 *
 *   >1 ->  QUARANTINE. The ASIN is right for one of them and wrong for the rest,
 *          and nothing in the file records which. Re-verifying that is a job
 *          with an Amazon lookup in it, not a rename.
 *
 *   0  ->  QUARANTINE. The key matches no product in the catalog. It cannot be
 *          consulted, so it is not a known-good override, it is a dead entry
 *          that reads as verified.
 *
 * Then one more rule, which the per-key counting cannot see: AN ASIN MAY BE
 * CLAIMED BY ONE ENTRY. Eleven ASINs are claimed by two or three keys each —
 * B0BBJ59WJ4 under both AMD|Ryzen 9|7900X and AMD|Ryzen 9|7900, B0DF2DC3R4
 * under SAMSUNG|1TB|SATA and CRUCIAL|1TB|SATA. Each key there is unique and
 * each entry names its product, so both guards pass and one Amazon listing
 * still stands for two products. Every entry sharing an ASIN is quarantined,
 * both sides: the table records no way to tell which one was verified.
 *
 * Nothing is deleted. The quarantined entries move to
 * src/data/asin-overrides.quarantined.json with the products their key answers
 * for and which rows currently carry the ASIN, which is what a person needs to
 * bind them one at a time.
 *
 * ── WHAT IT DOES NOT DO ──────────────────────────────────────────────────────
 * It does not touch the catalog. An ASIN already written onto a row stays
 * there; this only stops the table handing it to more rows. The rows that
 * already share an ASIN are audit-duplicate-asins.js's report, and fixing them
 * needs Amazon, not this pass.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalizeProductName } from './normalize-product-name.js';
import { normalizeForBinding, OVERRIDES_PATH } from './asin-override-table.js';

const APPLY = process.argv.includes('--apply');
const ROOT = process.cwd();
const QUARANTINE_PATH = './src/data/asin-overrides.quarantined.json';
const bar = '='.repeat(96);

const parts = (await import(`file://${path.join(ROOT, 'src/data/parts.js')}?t=${Date.now()}`)).PARTS;
const overrides = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));

const asinOf = (p) => {
  if (p.asin) return String(p.asin).toUpperCase();
  const m = String(p.deals?.amazon?.url || '').match(/\/dp\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
};

const byKey = new Map();
for (const p of parts) {
  let k = null;
  try { k = canonicalizeProductName(p.n, p.c); } catch { k = null; }
  if (!k) continue;
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(p);
}
const carriersOf = (asin) => parts.filter((p) => asinOf(p) === asin);

const bound = {};
const quarantined = [];

for (const [key, entry] of Object.entries(overrides)) {
  const answers = byKey.get(key) || [];
  const distinct = [...new Map(answers.map((p) => [normalizeForBinding(p.n), p])).values()];

  if (distinct.length === 1) {
    const p = distinct[0];
    const carried = asinOf(p);
    // Evidence for the binding, recorded rather than assumed. The key being
    // unique is what makes the binding safe; the row already carrying the ASIN
    // is what makes it certain. They are not the same claim.
    const evidence = carried === entry.asin ? 'row-carries-asin' : (carried ? 'row-carries-a-different-asin' : 'key-unique-only');
    bound[key] = { ...entry, productId: p.id, verifiedName: p.n, binding: evidence };
    continue;
  }

  quarantined.push({
    key, ...entry,
    reason: distinct.length === 0
      ? 'key matches no product in the catalog — it can never be consulted'
      : `key answers for ${distinct.length} distinct products — the ASIN is right for at most one`,
    answersFor: distinct.map((p) => ({ id: p.id, name: p.n })),
    asinCurrentlyOn: carriersOf(entry.asin).map((p) => ({ id: p.id, name: p.n })),
  });
}

// ── An ASIN may be claimed by one entry ──────────────────────────────────────
// Bound and unique per key, and still wrong: the Ryzen 9 7900X and the 7900
// each key uniquely, each names its own product, and both claim B0BBJ59WJ4.
// One listing cannot be two products, and nothing in the file says which entry
// was the verified one — so both go, rather than a coin flip.
const entriesPerAsin = new Map();
for (const [key, e] of Object.entries(bound)) {
  if (!entriesPerAsin.has(e.asin)) entriesPerAsin.set(e.asin, []);
  entriesPerAsin.get(e.asin).push(key);
}
let contested = 0;
for (const [asin, keys] of entriesPerAsin) {
  if (keys.length < 2) continue;
  contested++;
  for (const k of keys) {
    const e = bound[k];
    delete bound[k];
    quarantined.push({
      key: k, ...overrides[k],
      reason: `ASIN ${asin} is claimed by ${keys.length} entries (${keys.join(', ')}) — one listing, more than one product`,
      answersFor: [{ id: e.productId, name: e.verifiedName }],
      asinCurrentlyOn: carriersOf(asin).map((p) => ({ id: p.id, name: p.n })),
    });
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
console.log(bar);
console.log(`ASIN OVERRIDE RE-KEY — ${APPLY ? 'APPLY' : 'DRY RUN (nothing written)'}`);
console.log(bar);
console.log(`  entries in the table ................ ${Object.keys(overrides).length}`);
const boundBy = (ev) => Object.values(bound).filter((e) => e.binding === ev).length;
console.log(`  -> bound to one product ............. ${Object.keys(bound).length}`);
console.log(`       the row already carries the ASIN  ${boundBy('row-carries-asin')}`);
console.log(`       the row carries a DIFFERENT ASIN  ${boundBy('row-carries-a-different-asin')}  <- the table's job; kept, listed below`);
console.log(`       the row carries no ASIN yet ..... ${boundBy('key-unique-only')}`);
console.log(`  -> quarantined ...................... ${quarantined.length}`);
console.log(`       key answers for >1 product ...... ${quarantined.filter((q) => /answers for \d+ distinct/.test(q.reason)).length}`);
console.log(`       key answers for no product ...... ${quarantined.filter((q) => q.reason.startsWith('key matches no product')).length}`);
console.log(`       ASIN claimed by another entry ... ${quarantined.filter((q) => q.reason.startsWith('ASIN ')).length}  (${contested} contested ASINs)`);

const worst = quarantined.filter((q) => q.answersFor.length > 1 && !q.reason.startsWith('ASIN '))
  .sort((a, b) => b.answersFor.length - a.answersFor.length);
console.log(`\nWIDEST CLASS KEYS — one ASIN, marked ${'verified'}, offered to every product below:`);
for (const q of worst.slice(0, 8)) {
  console.log(`  ${q.key.padEnd(24)} ${q.asin} -> ${q.answersFor.length} products` +
    (q.asinCurrentlyOn.length > 1 ? `  (ALREADY on ${q.asinCurrentlyOn.length} rows)` : ''));
  q.answersFor.slice(0, 3).forEach((a) => console.log(`      ${String(a.id).padEnd(7)} ${a.name.slice(0, 66)}`));
  if (q.answersFor.length > 3) console.log(`      … and ${q.answersFor.length - 3} more`);
}

const disagreeing = Object.entries(bound).filter(([, e]) => e.binding === 'row-carries-a-different-asin');
if (disagreeing.length) {
  console.log('\nBOUND, BUT THE TABLE AND THE ROW DISAGREE (the table is meant to win — check these first):');
  for (const [k, e] of disagreeing.slice(0, 15)) {
    const p = parts.find((x) => x.id === e.productId);
    console.log(`  ${k.padEnd(24)} table ${e.asin}  row ${asinOf(p)}  ${e.verifiedName.slice(0, 50)}`);
  }
}

// ── Write ────────────────────────────────────────────────────────────────────
const quarantineDoc = {
  meta: {
    generatedAt: new Date().toISOString(),
    from: OVERRIDES_PATH,
    policy: 'NOT deleted, and NOT usable. Each entry needs an Amazon lookup to bind it to one product; ' +
      'move it back into asin-overrides.json with a verifiedName once it has one.',
  },
  totals: {
    quarantined: quarantined.length,
    classKeys: quarantined.filter((q) => /answers for \d+ distinct/.test(q.reason)).length,
    unreachable: quarantined.filter((q) => q.reason.startsWith('key matches no product')).length,
    contestedAsin: quarantined.filter((q) => q.reason.startsWith('ASIN ')).length,
  },
  entries: quarantined,
};

if (!APPLY) {
  console.log('\nDRY RUN — nothing written. Re-run with --apply to rewrite the table.');
  process.exit(0);
}
writeFileSync(OVERRIDES_PATH, JSON.stringify(bound, null, 2) + '\n');
writeFileSync(QUARANTINE_PATH, JSON.stringify(quarantineDoc, null, 2) + '\n');
console.log(`\nWrote ${OVERRIDES_PATH} (${Object.keys(bound).length}) and ${QUARANTINE_PATH} (${quarantined.length}).`);
