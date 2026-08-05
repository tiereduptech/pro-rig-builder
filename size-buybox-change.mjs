// size-buybox-change.mjs
//
// Sizes the blast radius of the Buy-Box-only price rule BEFORE it ships.
//
// `verify-catalog-asins.js --dry-run` cannot answer this: a dry run posts ZERO
// tasks and never calls the API, so it has no offer data to reason about. This
// script fetches DataForSEO sellers data ONCE for a sample and evaluates BOTH
// rules against identical bytes, so the comparison is not polluted by live
// price movement between two runs.
//
//   OLD: unlabeled Buy Box counted as New; if the Buy Box was not New it fell
//        back to the cheapest New SIDE offer (source 'lowest_new').
//   NEW: only a New, in-stock Buy Box is ever written. Everything else -> null
//        -> caller quarantines. 3P buyboxes additionally must clear the
//        cross-retailer sanity gate.
//
// Writes ONE report file. No catalog writes. No relinks.
//
//   railway run node size-buybox-change.mjs [--limit 250] [--tier 1]

import { readFileSync, writeFileSync } from 'node:fs';
import { selectNewOffer, amazonPriceSanity, classifyBuyBox, BUYBOX_STATE } from './amazon-price.js';
import { COST_PER_SELLERS_TASK } from './verify-spend-guard.js';

const BASE = 'https://api.dataforseo.com/v3';
const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) {
  console.error('DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD required. Use: railway run node size-buybox-change.mjs');
  process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');

const TIERS = {
  1: ['CPU', 'GPU', 'Motherboard', 'RAM', 'Storage', 'PSU', 'Case'],
  2: ['CPUCooler', 'CaseFan', 'Monitor'],
};
const arg = (name, dflt) => {
  const a = process.argv.find(x => x.startsWith(`--${name}=`));
  if (a) return a.split('=')[1];
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : dflt;
};
const LIMIT = Number(arg('limit', 250));
const TIER = String(arg('tier', '1'));
const OUT = 'buybox-change-sizing.json';

const BATCH_SIZE = 50, POST_DELAY_MS = 500;
const POLL_DELAY_MS = 30000, POLL_INTERVAL_MS = 10000, MAX_POLL_MS = 900000;
const GET_CONCURRENCY = 8;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function dfs(method, path, body = null) {
  for (let a = 0; a < 5; a++) {
    try {
      const res = await fetch(BASE + path, {
        method, headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429 || res.status === 503) { await sleep(3000 + a * 5000); continue; }
      return await res.json();
    } catch { await sleep(2000 * (a + 1)); }
  }
  throw new Error('dfs failed: ' + path);
}

// ── the OLD rule, reproduced verbatim from git history ──────────────────────
function selectNewOfferOLD(result0) {
  const offers = Array.isArray(result0 && result0.items) ? result0.items : [];
  const priceOf = o => Number(o && o.price && o.price.current);
  const isNew = o => /^new$/i.test(String(o && o.condition || '').trim());
  const main = offers.find(o => o && o.type === 'amazon_seller_main_item');
  if (main && priceOf(main) > 0) {
    const c = String(main.condition || '').trim();
    if (c === '' || /^new$/i.test(c)) {
      return { price: priceOf(main), seller: main.seller_name || main.ships_from || null,
               condition: main.condition || 'New (unlabeled buybox)',
               source: c === '' ? 'buybox_unlabeled' : 'buybox' };
    }
  }
  const news = offers.filter(o => isNew(o) && priceOf(o) > 0).sort((a, b) => priceOf(a) - priceOf(b));
  if (news.length) {
    const o = news[0];
    return { price: priceOf(o), seller: o.seller_name || o.ships_from || null,
             condition: o.condition, source: 'lowest_new' };
  }
  return null;
}

const extractASIN = url => { const m = String(url || '').match(/\/dp\/([A-Z0-9]{10})/i); return m ? m[1].toUpperCase() : null; };

(async () => {
  const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js?t=${Date.now()}`);
  const cats = TIERS[TIER] || TIERS[1];
  const all = mod.PARTS.filter(p => cats.includes(p.c) && extractASIN(p.deals?.amazon?.url));
  // Evenly spaced sample so one category cannot dominate.
  const step = Math.max(1, Math.floor(all.length / LIMIT));
  const sample = all.filter((_, i) => i % step === 0).slice(0, LIMIT);

  console.log(`Buy-Box rule sizing — tier ${TIER}`);
  console.log(`  tier population ....... ${all.length} rows with ASINs`);
  console.log(`  sampling .............. ${sample.length}`);
  console.log(`  est. cost ............. $${(sample.length * COST_PER_SELLERS_TASK).toFixed(2)}`);
  console.log(`  writes ................ NONE (sizing only)\n`);

  // post
  const tasks = [];
  for (let i = 0; i < sample.length; i += BATCH_SIZE) {
    const batch = sample.slice(i, i + BATCH_SIZE);
    const resp = await dfs('POST', '/merchant/amazon/sellers/task_post', batch.map(p => ({
      asin: extractASIN(p.deals.amazon.url), language_code: 'en_US', location_code: 2840, tag: `size-${p.id}`,
    })));
    for (const t of (resp.tasks || [])) {
      if (t.id) tasks.push({ taskId: t.id, productId: Number(t.data?.tag?.replace('size-', '')) });
    }
    process.stdout.write(`  posted ${Math.min(i + BATCH_SIZE, sample.length)}/${sample.length}\r`);
    await sleep(POST_DELAY_MS);
  }
  console.log(`\n  ${tasks.length} tasks posted`);

  // poll
  const results = new Map();
  const pending = new Map(tasks.map(t => [t.taskId, t]));
  await sleep(POLL_DELAY_MS);
  const t0 = Date.now();
  while (pending.size && Date.now() - t0 < MAX_POLL_MS) {
    const list = [...pending.keys()];
    for (let i = 0; i < list.length; i += GET_CONCURRENCY) {
      await Promise.all(list.slice(i, i + GET_CONCURRENCY).map(async id => {
        try {
          const resp = await dfs('GET', `/merchant/amazon/sellers/task_get/advanced/${id}`);
          const task = resp.tasks?.[0];
          if (!task) return;
          if (task.status_code === 20100 || task.status_code === 40602 || !task.result) return;
          results.set(id, { ...pending.get(id), data: task.result?.[0] ?? null });
          pending.delete(id);
        } catch {}
      }));
    }
    if (pending.size) { console.log(`  ${results.size} done / ${pending.size} pending`); await sleep(POLL_INTERVAL_MS); }
  }
  console.log(`  ${results.size} results retrieved\n`);

  // ── evaluate both rules on identical data ──────────────────────────────
  const byId = new Map(mod.PARTS.map(p => [p.id, p]));
  const written = [], flagged = [], quarantined = [];
  const flagReason = {}, quarReason = {};
  let priced3p = 0, sanityFail3p = 0;
  const unconfirmedRows = [];   // fed to the PA API follow-up question

  for (const r of results.values()) {
    if (!r.data) continue;
    const p = byId.get(r.productId);
    const v = classifyBuyBox(r.data);
    const asin = extractASIN(p?.deals?.amazon?.url);

    if (v.state === BUYBOX_STATE.BAD) {
      quarReason[v.reason] = (quarReason[v.reason] || 0) + 1;
      quarantined.push({ id: p?.id, cat: p?.c, name: p?.n, asin, cause: v.reason,
                         storedPrice: p?.deals?.amazon?.price ?? null });
      continue;
    }
    if (v.state === BUYBOX_STATE.UNCONFIRMED) {
      flagReason[v.reason] = (flagReason[v.reason] || 0) + 1;
      const row = { id: p?.id, cat: p?.c, name: p?.n, asin, reason: v.reason,
                    keptPrice: p?.deals?.amazon?.price ?? null };
      flagged.push(row);
      unconfirmedRows.push(row);
      continue;
    }
    // confirmed — the 3P sanity gate can still quarantine it
    if (v.offer.source === '3p') {
      priced3p++;
      if (!amazonPriceSanity(p, v.offer.price).pass) {
        sanityFail3p++;
        quarReason['3p_sanity_fail'] = (quarReason['3p_sanity_fail'] || 0) + 1;
        quarantined.push({ id: p?.id, cat: p?.c, name: p?.n, asin, cause: '3p_sanity_fail',
                           newPrice: v.offer.price, newSeller: v.offer.seller,
                           storedPrice: p?.deals?.amazon?.price ?? null });
        continue;
      }
    }
    written.push(p?.id);
  }

  const evaluated = written.length + flagged.length + quarantined.length;
  const rate = n => evaluated ? n / evaluated : 0;
  const proj = n => Math.round(rate(n) * all.length);

  console.log('='.repeat(70));
  console.log('RESULT — three-way verdict (ambiguous is not wrong)');
  console.log('='.repeat(70));
  console.log(`  rows evaluated ................... ${evaluated}`);
  console.log(`  PRICE WRITTEN (confirmed buybox) . ${written.length}  (${(rate(written.length) * 100).toFixed(1)}%)`);
  console.log(`  KEEP PRICE + FLAG (unconfirmed) .. ${flagged.length}  (${(rate(flagged.length) * 100).toFixed(1)}%)`);
  console.log(`  QUARANTINE (affirmatively bad) ... ${quarantined.length}  (${(rate(quarantined.length) * 100).toFixed(1)}%)`);
  console.log('  ' + '-'.repeat(60));
  console.log('  flag reasons:');
  for (const [k, n] of Object.entries(flagReason).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(38)} ${n}`);
  console.log('  quarantine reasons:');
  for (const [k, n] of Object.entries(quarReason).sort((a, b) => b[1] - a[1])) console.log(`    ${k.padEnd(38)} ${n}`);
  console.log(`    (3P-priced rows: ${priced3p}, failing sanity: ${sanityFail3p})`);
  console.log('  ' + '-'.repeat(60));
  console.log(`  PROJECTED over tier ${TIER} (${all.length} rows):`);
  console.log(`    price written ......... ~${proj(written.length)}`);
  console.log(`    kept + flagged ........ ~${proj(flagged.length)}`);
  console.log(`    QUARANTINED ........... ~${proj(quarantined.length)}`);

  const byCat = {};
  for (const f of flagged) byCat[f.cat] = (byCat[f.cat] || 0) + 1;
  console.log('\n  flagged by category:');
  for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) console.log(`    ${c.padEnd(14)} ${n}`);

  writeFileSync(OUT, JSON.stringify({
    meta: { generatedAt: new Date().toISOString(), tier: TIER, sampled: sample.length,
            evaluated, tierPopulation: all.length, costUsd: +(sample.length * COST_PER_SELLERS_TASK).toFixed(2),
            note: 'sizing only — no catalog writes' },
    totals: {
      priceWritten: written.length, keptAndFlagged: flagged.length, quarantined: quarantined.length,
      projectedWritten: proj(written.length), projectedFlagged: proj(flagged.length),
      projectedQuarantined: proj(quarantined.length),
      flagReason, quarReason, threePricedRows: priced3p, threeSanityFail: sanityFail3p,
    },
    quarantined, flagged,
  }, null, 2));
  console.log(`\nreport -> ${OUT}`);
})();
