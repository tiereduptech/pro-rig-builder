// =============================================================================
//  scripts/report-stale-badges.mjs
//
//  What the price-freshness gate changes, BEFORE it ships.
//
//  De-badging a row is visible to every reader, so the size and shape of that
//  change is a decision, not a detail. This reports it by retailer and by
//  category, and sweeps the threshold so 14 days can be checked against the
//  alternatives rather than assumed.
//
//  It imports the gate from src/price-freshness.js rather than reimplementing
//  it. A report that reimplements the predicate it measures can only tell you
//  about itself.
//
//    node scripts/report-stale-badges.mjs
//    node scripts/report-stale-badges.mjs --days=30
//    node scripts/report-stale-badges.mjs --json
// =============================================================================

import { PARTS } from '../src/data/parts.js';
import { PRICE_STALE_AFTER_DAYS, priceAgeDays, priceStampOf } from '../src/price-freshness.js';

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.split('=')[1] : d;
};
const CUT = Number(arg('days', PRICE_STALE_AFTER_DAYS));
const JSON_OUT = process.argv.includes('--json');
const NOW = Date.now();

// Mirrors dealPrice() in App.jsx: the lower of price and saleprice, because 19
// rows carry a saleprice ABOVE price and preferring it would overstate.
const dealPrice = (d) => {
  if (!d || typeof d !== 'object') return null;
  const list = Number(d.price), sale = Number(d.saleprice);
  const hl = Number.isFinite(list) && list > 0, hs = Number.isFinite(sale) && sale > 0;
  if (hl && hs) return Math.min(list, sale);
  if (hs) return sale;
  return hl ? list : null;
};

const freshAt = (d, cut) => {
  const a = priceAgeDays(d, NOW);
  return a != null && a <= cut;
};

// The row that WOULD wear BEST, under a given cut. Mirrors retailers(): sink
// out-of-stock, then sink stale, then cheapest — and index 0 wears the badge
// only if it passes both tests.
function badgeRow(p, cut) {
  const rows = Object.entries(p.deals || {})
    .filter(([, d]) => d && typeof d === 'object' && dealPrice(d) != null && (d.url || d.linkurl))
    .map(([name, d]) => ({ name, price: dealPrice(d), inStock: d.inStock !== false, fresh: freshAt(d, cut), age: priceAgeDays(d, NOW), stamp: priceStampOf(d) }));
  if (!rows.length) return null;
  rows.sort((a, b) => (b.inStock - a.inStock) || (b.fresh - a.fresh) || (a.price - b.price));
  return rows[0];
}

function analyse(cut) {
  const byRetailer = {};
  let badgedBefore = 0, badgedAfter = 0, moved = 0, lostEntirely = 0;
  const examples = [];

  for (const p of PARTS) {
    // Before: stock, then price. Freshness ignored — the shipping behaviour.
    const rows = Object.entries(p.deals || {})
      .filter(([, d]) => d && typeof d === 'object' && dealPrice(d) != null && (d.url || d.linkurl))
      .map(([name, d]) => ({ name, price: dealPrice(d), inStock: d.inStock !== false, fresh: freshAt(d, cut), age: priceAgeDays(d, NOW) }));
    if (!rows.length) continue;
    const before = [...rows].sort((a, b) => (b.inStock - a.inStock) || (a.price - b.price))[0];
    const after = badgeRow(p, cut);
    if (before.inStock) badgedBefore++;
    if (after && after.inStock && after.fresh) badgedAfter++;

    if (!before.inStock) continue;              // wore no badge before either
    if (after && after.name === before.name && after.fresh) continue;  // unchanged

    const r = byRetailer[before.name] || (byRetailer[before.name] = { deBadged: 0, movedTo: 0, ages: [], neverStamped: 0, priceDelta: [] });
    r.deBadged++;
    if (before.age == null) r.neverStamped++; else r.ages.push(before.age);

    if (after && after.inStock && after.fresh) {
      moved++;
      r.priceDelta.push(after.price - before.price);
      (byRetailer[after.name] || (byRetailer[after.name] = { deBadged: 0, movedTo: 0, ages: [], neverStamped: 0, priceDelta: [] })).movedTo++;
      if (examples.length < 10) examples.push({ n: p.n.slice(0, 44), from: before.name, fromAge: before.age, fromPrice: before.price, to: after.name, toPrice: after.price });
    } else {
      lostEntirely++;   // nothing fresh and in stock — the card shows no BEST
    }
  }
  return { byRetailer, badgedBefore, badgedAfter, moved, lostEntirely, examples };
}

const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] : null);
const sum = (a) => a.reduce((x, y) => x + y, 0);

const r = analyse(CUT);

if (JSON_OUT) { console.log(JSON.stringify({ cut: CUT, ...r }, null, 2)); process.exit(0); }

console.log(`\nPrice freshness gate — impact at PRICE_STALE_AFTER_DAYS = ${CUT}\n`);
console.log(`  products with a BEST badge today .......... ${r.badgedBefore}`);
console.log(`  products with a BEST badge after .......... ${r.badgedAfter}`);
console.log(`  badge MOVES to a fresher retailer ......... ${r.moved}`);
console.log(`  badge DISAPPEARS (nothing fresh in stock) . ${r.lostEntirely}`);

console.log(`\n  de-badged, by retailer that currently holds the badge:\n`);
console.log('    retailer'.padEnd(24) + 'de-badged'.padStart(10) + 'never stamped'.padStart(15) + 'median age'.padStart(12) + 'gains badge'.padStart(13) + 'median $ change'.padStart(17));
const rows = Object.entries(r.byRetailer).sort((a, b) => b[1].deBadged - a[1].deBadged);
for (const [name, v] of rows) {
  const m = med(v.ages), d = med(v.priceDelta);
  console.log('    ' + name.padEnd(22)
    + String(v.deBadged || '').padStart(10)
    + String(v.neverStamped || '').padStart(15)
    + (m == null ? '-' : m + 'd').padStart(12)
    + String(v.movedTo || '').padStart(13)
    + (d == null ? '-' : (d >= 0 ? '+$' : '-$') + Math.abs(Math.round(d))).padStart(17));
}
console.log('    ' + 'TOTAL'.padEnd(22) + String(sum(rows.map(([, v]) => v.deBadged))).padStart(10)
  + String(sum(rows.map(([, v]) => v.neverStamped))).padStart(15) + ''.padStart(12)
  + String(sum(rows.map(([, v]) => v.movedTo))).padStart(13));

console.log(`\n  "median $ change" is what the reader now sees instead. A POSITIVE`);
console.log(`  number means the honest price is higher than the frozen one we were`);
console.log(`  endorsing — which is the whole point, and the cost of being right.\n`);

if (r.examples.length) {
  console.log('  examples of the badge moving:\n');
  for (const e of r.examples) {
    console.log(`    ${e.n.padEnd(46)} ${e.from} $${e.fromPrice} (${e.fromAge == null ? 'never confirmed' : e.fromAge + 'd'})  ->  ${e.to} $${e.toPrice}`);
  }
}

console.log(`\n  threshold sweep — is 14 the right cut?\n`);
console.log('    days'.padEnd(10) + 'badges lost'.padStart(14) + 'badge moves'.padStart(14) + 'badge gone'.padStart(13) + '% of today'.padStart(13));
for (const cut of [7, 14, 21, 30, 45, 60, 90]) {
  const a = analyse(cut);
  const lost = a.badgedBefore - a.badgedAfter;
  console.log('    ' + String(cut).padEnd(8) + String(lost).padStart(14) + String(a.moved).padStart(14)
    + String(a.lostEntirely).padStart(13) + ((lost / (a.badgedBefore || 1)) * 100).toFixed(1).padStart(12) + '%');
}
console.log('');
