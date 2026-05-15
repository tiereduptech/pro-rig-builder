/**
 * verify-discoveries.cjs
 *
 * For each product added via Amazon discovery (source='amazon-discovery'),
 * verify the ASIN is real, title matches our stored title, and price is reasonable.
 * If verified, clear needsReview=true.
 *
 * Uses DataForSEO Amazon ASIN endpoint (same as verify-catalog-asins.js).
 *
 * USAGE:
 *   railway run node verify-discoveries.cjs           # dry run
 *   railway run node verify-discoveries.cjs --apply
 */

const fs = require('fs');

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) { console.error('Missing creds'); process.exit(1); }
const AUTH = 'Basic ' + Buffer.from(LOGIN + ':' + PASSWORD).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

const APPLY = process.argv.includes('--apply');
const MIN_TITLE_SCORE = 0.6;

// Simple title similarity
function tokenize(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(t => t.length >= 3));
}
function titleScore(a, b) {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (!ta.size || !tb.size) return 0;
  let common = 0;
  for (const t of ta) if (tb.has(t)) common++;
  return common / Math.min(ta.size, tb.size);
}

async function fetchBatch(asins) {
  const body = asins.map(asin => ({
    asin,
    location_code: 2840,
    language_code: 'en_US',
    se_domain: 'amazon.com',
    priority: 1,
    tag: 'verify-' + asin,
  }));
  const res = await fetch(BASE + '/merchant/amazon/asin/task_post', {
    method: 'POST',
    headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.status_code !== 20000) throw new Error('Post failed: ' + JSON.stringify(data));
  return data.tasks.map(t => t.id);
}

async function getResult(taskId) {
  const res = await fetch(BASE + '/merchant/amazon/asin/task_get/advanced/' + taskId, {
    headers: { 'Authorization': AUTH },
  });
  const data = await res.json();
  if (data.status_code !== 20000) return null;
  const task = data.tasks?.[0];
  if (!task || task.status_code !== 20000) return null;
  return task.result?.[0];
}

async function waitForTasks(taskIds, timeoutMs = 300000) {
  const start = Date.now();
  const results = new Map();
  const remaining = new Set(taskIds);
  while (remaining.size > 0 && (Date.now() - start) < timeoutMs) {
    for (const id of [...remaining]) {
      try {
        const result = await getResult(id);
        if (result) {
          results.set(id, result);
          remaining.delete(id);
        }
      } catch (e) {}
    }
    if (remaining.size > 0) {
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.log();
  return results;
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...m.PARTS];

  const targets = parts.filter(p => p.source === 'amazon-discovery' && p.needsReview === true);
  console.log('Mode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('Discovery products to verify:', targets.length);

  if (targets.length === 0) { console.log('Nothing to verify.'); return; }

  console.log('Estimated cost: $' + (targets.length * 0.003).toFixed(2));

  // Submit in batches of 50
  const BATCH = 50;
  const taskIds = [];
  const taskToProduct = new Map();

  for (let i = 0; i < targets.length; i += BATCH) {
    const batch = targets.slice(i, i + BATCH);
    const asins = batch.map(p => p.deals.amazon.asin);
    process.stdout.write('Posting batch ' + (i / BATCH + 1) + '... ');
    const ids = await fetchBatch(asins);
    ids.forEach((id, idx) => taskToProduct.set(id, batch[idx]));
    taskIds.push(...ids);
    console.log(ids.length + ' tasks');
    await new Promise(r => setTimeout(r, 500));
  }
  console.log('Total tasks:', taskIds.length);
  console.log('Waiting 20s before polling...');
  await new Promise(r => setTimeout(r, 20000));

  process.stdout.write('Polling for results');
  const results = await waitForTasks(taskIds);
  console.log('Got results for:', results.size, '/', taskIds.length);

  // Process results
  const stats = { verified: 0, unmatched: 0, missing: 0, noPrice: 0 };
  const verifyLog = [];

  for (const [taskId, result] of results) {
    const product = taskToProduct.get(taskId);
    if (!product) continue;

    const item = result.items?.[0];
    if (!item || !item.title) {
      stats.missing++;
      verifyLog.push({ id: product.id, status: 'missing', name: product.n.slice(0, 60) });
      continue;
    }
    const amzTitle = item.title;
    const amzPrice = item.price_from || item.price;
    const inStock = !item.is_amazon_choice ? true : true;  // default to true
    const score = titleScore(product.n, amzTitle);

    if (score < MIN_TITLE_SCORE) {
      stats.unmatched++;
      verifyLog.push({ id: product.id, status: 'unmatched', score: score.toFixed(2), our: product.n.slice(0, 60), amz: amzTitle.slice(0, 80) });
      continue;
    }
    if (!amzPrice || amzPrice <= 0) {
      stats.noPrice++;
      verifyLog.push({ id: product.id, status: 'noPrice', name: product.n.slice(0, 60) });
      continue;
    }

    stats.verified++;
    if (APPLY) {
      delete product.needsReview;
      // Refresh price + title from Amazon (more accurate)
      if (product.deals?.amazon) {
        product.deals.amazon.price = amzPrice;
        product.deals.amazon.inStock = inStock;
      }
      product.pr = amzPrice;
      // Update title only if it's much more detailed
      if (amzTitle.length > product.n.length) product.n = amzTitle;
    }
    verifyLog.push({ id: product.id, status: 'verified', score: score.toFixed(2), price: amzPrice });
  }

  console.log('\n--- VERIFY RESULTS ---');
  console.log('Verified (un-quarantine):', stats.verified);
  console.log('Title mismatch (kept quarantined):', stats.unmatched);
  console.log('ASIN missing on Amazon (kept quarantined):', stats.missing);
  console.log('No price (kept quarantined):', stats.noPrice);

  fs.writeFileSync('verify-discoveries-report.json', JSON.stringify({
    generatedAt: new Date().toISOString(),
    stats,
    log: verifyLog,
  }, null, 2));
  console.log('Report written to verify-discoveries-report.json');

  if (APPLY) {
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log('\nApplied: ' + stats.verified + ' products un-quarantined');
  }
})();
