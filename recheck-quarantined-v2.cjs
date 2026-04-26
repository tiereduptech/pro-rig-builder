// recheck-quarantined-v2.cjs
// Fetches tasks by ID directly - no tasks_ready dependency

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

const KEY = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isMatch(stored, amazon) {
  if (!stored || !amazon) return { match: false, reason: 'empty', score: 0 };
  const a = normalize(stored);
  const b = normalize(amazon);
  const tokensA = a.split(' ').filter(t => t.length >= 3);
  const modelTokensA = tokensA.filter(t => /\d/.test(t) && /[a-z]/.test(t));
  const tokensB = new Set(b.split(' ').filter(t => t.length >= 3));
  let hits = 0;
  for (const t of tokensA) if (tokensB.has(t)) hits++;
  const score = hits / tokensA.length;
  let modelMatches = 0;
  for (const t of modelTokensA) if (tokensB.has(t)) modelMatches++;
  const requiredModelMatches = Math.max(1, modelTokensA.length - 1);
  const modelMatchOK = modelTokensA.length === 0 || modelMatches >= requiredModelMatches;

  if (modelTokensA.length === 0) {
    return { match: score >= 0.7, score, reason: score >= 0.7 ? 'token-only' : 'low-overlap' };
  }
  if (modelMatchOK && score >= 0.5) {
    return { match: true, score, reason: 'model+overlap' };
  }
  return { match: false, score, reason: 'model-mismatch (' + modelMatches + '/' + modelTokensA.length + ')' };
}

function unquarantine(s, id) {
  const idMarker = '"id": ' + id + ',';
  const idIdx = s.indexOf(idMarker);
  if (idIdx < 0) return s;
  let pos = idIdx;
  while (pos > 0 && s[pos] !== '{') pos--;
  const startBrace = pos;
  let depth = 1;
  pos = startBrace + 1;
  while (pos < s.length && depth > 0) {
    if (s[pos] === '{') depth++;
    else if (s[pos] === '}') depth--;
    if (depth === 0) break;
    pos++;
  }
  const endBrace = pos;
  let entry = s.substring(startBrace, endBrace + 1);
  entry = entry.replace(/,?\s*"needsReview":\s*true/g, '');
  entry = entry.replace(/,?\s*"quarantinedAt":\s*"[^"]*"/g, '');
  entry = entry.replace(/,(\s*),/g, ',$1');
  entry = entry.replace(/{(\s*),/g, '{$1');
  return s.substring(0, startBrace) + entry + s.substring(endBrace + 1);
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  const quarantined = parts.filter(p => p.needsReview && p.deals?.amazon?.url);

  console.log('Checking ' + quarantined.length + ' quarantined products...\n');

  // Submit all tasks
  const tasks = [];
  const BATCH = 100;
  for (let i = 0; i < quarantined.length; i += BATCH) {
    const batch = quarantined.slice(i, i + BATCH);
    const body = batch.map(p => {
      const asin = p.deals.amazon.url.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
      return asin ? { asin, location_code: 2840, language_code: 'en_US' } : null;
    }).filter(Boolean);

    if (body.length === 0) continue;

    const post = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/task_post', {
      method: 'POST',
      headers: { 'Authorization': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await post.json();
    if (d.tasks) {
      for (const task of d.tasks) {
        if (task.id && task.data?.asin) {
          const product = batch.find(p => p.deals.amazon.url.includes(task.data.asin));
          if (product) tasks.push({ id: task.id, asin: task.data.asin, product });
        }
      }
    }
  }
  console.log('Submitted ' + tasks.length + ' tasks');

  // Wait 60s for tasks to start processing
  console.log('\nWaiting 60s for tasks to process...');
  await new Promise(r => setTimeout(r, 60000));

  // Fetch each task directly by ID, with retries
  console.log('\nFetching tasks by ID directly...');
  const results = [];
  const pendingTasks = [...tasks];
  let attempt = 0;
  const MAX_ATTEMPTS = 20; // 20 attempts × 30s = 10 min max

  while (pendingTasks.length > 0 && attempt < MAX_ATTEMPTS) {
    attempt++;
    const stillPending = [];

    // Process in chunks of 10 in parallel
    const CONCURRENCY = 10;
    for (let i = 0; i < pendingTasks.length; i += CONCURRENCY) {
      const chunk = pendingTasks.slice(i, i + CONCURRENCY);
      const fetched = await Promise.all(chunk.map(async (task) => {
        try {
          const res = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/task_get/advanced/' + task.id, {
            headers: { 'Authorization': KEY }
          });
          const d = await res.json();
          const t = d?.tasks?.[0];
          if (t?.status_code === 20000 && t.result) {
            return { task, result: t.result[0] };
          }
          // Status 40601 = task in progress, 40602 = task is queued
          return { task, pending: true };
        } catch (e) { return { task, pending: true }; }
      }));

      for (const f of fetched) {
        if (f.result) {
          results.push({ task: f.task, item: f.result.items?.[0] });
        } else if (f.pending) {
          stillPending.push(f.task);
        }
      }
    }

    console.log('  attempt ' + attempt + ': fetched=' + results.length + ' pending=' + stillPending.length);
    pendingTasks.length = 0;
    pendingTasks.push(...stillPending);

    if (pendingTasks.length > 0) {
      await new Promise(r => setTimeout(r, 30000));
    }
  }

  console.log('\n═══ ANALYSIS ═══\n');
  let unquarantineCount = 0;
  let realMismatch = [];
  let s = fs.readFileSync(PARTS_PATH, 'utf8');

  for (const r of results) {
    if (!r.item) continue;
    const stored = r.task.product.n;
    const amazon = r.item.title || '';
    const m = isMatch(stored, amazon);

    if (m.match) {
      console.log('✓ UNQUARANTINE id=' + r.task.product.id + ' (score=' + m.score.toFixed(2) + ')');
      console.log('    Stored: ' + stored.substring(0, 65));
      console.log('    Amazon: ' + amazon.substring(0, 65));
      s = unquarantine(s, r.task.product.id);
      unquarantineCount++;
    } else {
      realMismatch.push({ id: r.task.product.id, stored, amazon, reason: m.reason, asin: r.task.asin });
    }
  }

  console.log('\n═══ REAL MISMATCHES (' + realMismatch.length + ') ═══\n');
  realMismatch.forEach(rm => {
    console.log('id=' + rm.id + ' [' + rm.reason + '] asin=' + rm.asin);
    console.log('  Stored: ' + rm.stored.substring(0, 70));
    console.log('  Amazon: ' + rm.amazon.substring(0, 70));
  });

  if (unquarantineCount > 0) {
    fs.writeFileSync(PARTS_PATH, s);
    console.log('\n✓ Unquarantined ' + unquarantineCount + ' products');
  }
  console.log('Real mismatches needing ASIN repair: ' + realMismatch.length);

  fs.writeFileSync('quarantine-mismatches.json', JSON.stringify(realMismatch, null, 2));
})();
