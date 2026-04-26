// recheck-quarantined.cjs
// Fetches Amazon titles for all quarantined products
// Smart-matches: if stored model+brand appears in Amazon title, unquarantine

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';

const KEY = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// More forgiving title match
function isMatch(stored, amazon) {
  if (!stored || !amazon) return { match: false, reason: 'empty', score: 0 };
  const a = normalize(stored);
  const b = normalize(amazon);

  // Extract model-like tokens (have digits AND letters)
  const tokensA = a.split(' ').filter(t => t.length >= 3);
  const modelTokensA = tokensA.filter(t => /\d/.test(t) && /[a-z]/.test(t));
  const numTokensA = tokensA.filter(t => /^\d+$/.test(t) && t.length >= 3); // pure numbers like "6000"

  // Calculate token overlap
  const tokensB = new Set(b.split(' ').filter(t => t.length >= 3));
  let hits = 0;
  for (const t of tokensA) if (tokensB.has(t)) hits++;
  const score = hits / tokensA.length;

  // Check ALL model tokens (not just one)
  let modelMatches = 0;
  for (const t of modelTokensA) if (tokensB.has(t)) modelMatches++;

  // Strict: ALL model tokens (or all but 1) must match
  // Lenient: brand + most tokens
  const requiredModelMatches = Math.max(1, modelTokensA.length - 1);
  const modelMatchOK = modelTokensA.length === 0 || modelMatches >= requiredModelMatches;

  // For products with no model tokens (rare), require >= 0.7 overlap
  if (modelTokensA.length === 0) {
    return { match: score >= 0.7, score, reason: score >= 0.7 ? 'token-only' : 'low-overlap' };
  }

  // For products WITH model tokens, accept if model matches AND overall >= 0.5
  if (modelMatchOK && score >= 0.5) {
    return { match: true, score, reason: 'model+overlap' };
  }

  return { match: false, score, reason: 'model-mismatch (' + modelMatches + '/' + modelTokensA.length + ')' };
}

function unquarantine(s, id) {
  const idMarker = '"id": ' + id + ',';
  const idIdx = s.indexOf(idMarker);
  if (idIdx < 0) return s;
  // Find the entry
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

  // Remove needsReview and quarantinedAt fields (with possible trailing/leading commas)
  entry = entry.replace(/,?\s*"needsReview":\s*true/g, '');
  entry = entry.replace(/,?\s*"quarantinedAt":\s*"[^"]*"/g, '');
  // Cleanup any double commas
  entry = entry.replace(/,(\s*),/g, ',$1');
  entry = entry.replace(/{(\s*),/g, '{$1');

  return s.substring(0, startBrace) + entry + s.substring(endBrace + 1);
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  const quarantined = parts.filter(p => p.needsReview && p.deals?.amazon?.url);

  console.log('Checking ' + quarantined.length + ' quarantined products...\n');

  // Submit all tasks in batches of 100
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
      for (let j = 0; j < d.tasks.length; j++) {
        const task = d.tasks[j];
        if (task.id && task.data?.asin) {
          const product = batch.find(p => p.deals.amazon.url.includes(task.data.asin));
          if (product) tasks.push({ id: task.id, asin: task.data.asin, product });
        }
      }
    }
  }
  console.log('Submitted ' + tasks.length + ' tasks');

  // Poll tasks_ready until tasks are done
  console.log('\nPolling tasks_ready...');
  const ready = new Map();
  const startTime = Date.now();
  const TIMEOUT = 12 * 60 * 1000;

  while (ready.size < tasks.length && Date.now() - startTime < TIMEOUT) {
    await new Promise(r => setTimeout(r, 10000));
    const res = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/tasks_ready', {
      headers: { 'Authorization': KEY }
    });
    const d = await res.json();
    for (const t of (d?.tasks?.[0]?.result || [])) {
      if (tasks.find(x => x.id === t.id) && !ready.has(t.id)) {
        ready.set(t.id, t.endpoint_advanced);
      }
    }
    console.log('  ready: ' + ready.size + '/' + tasks.length + ' (' + Math.round((Date.now() - startTime) / 1000) + 's)');
  }

  // Fetch results in parallel
  console.log('\nFetching ' + ready.size + ' results...');
  const results = [];
  const taskList = [...ready.entries()];
  const CONCURRENCY = 5;
  for (let i = 0; i < taskList.length; i += CONCURRENCY) {
    const chunk = taskList.slice(i, i + CONCURRENCY);
    const fetched = await Promise.all(chunk.map(async ([id, endpoint]) => {
      try {
        const res = await fetch('https://api.dataforseo.com' + endpoint, {
          headers: { 'Authorization': KEY }
        });
        const d = await res.json();
        return { id, item: d?.tasks?.[0]?.result?.[0]?.items?.[0] };
      } catch (e) { return null; }
    }));
    fetched.forEach(r => r && results.push(r));
  }

  console.log('\n═══ ANALYSIS ═══\n');
  let unquarantineCount = 0;
  let realMismatch = [];
  let s = fs.readFileSync(PARTS_PATH, 'utf8');

  for (const r of results) {
    if (!r.item) continue;
    const task = tasks.find(t => t.id === r.id);
    if (!task) continue;
    const stored = task.product.n;
    const amazon = r.item.title || '';
    const m = isMatch(stored, amazon);

    if (m.match) {
      console.log('✓ UNQUARANTINE id=' + task.product.id + ' (score=' + m.score.toFixed(2) + ')');
      console.log('    Stored: ' + stored.substring(0, 65));
      console.log('    Amazon: ' + amazon.substring(0, 65));
      s = unquarantine(s, task.product.id);
      unquarantineCount++;
    } else {
      realMismatch.push({ id: task.product.id, stored: stored.substring(0,50), amazon: amazon.substring(0,50), reason: m.reason, asin: task.asin });
    }
  }

  console.log('\n═══ REAL MISMATCHES (' + realMismatch.length + ') ═══\n');
  realMismatch.slice(0, 20).forEach(rm => {
    console.log('id=' + rm.id + ' [' + rm.reason + ']');
    console.log('  Stored: ' + rm.stored);
    console.log('  Amazon: ' + rm.amazon);
  });

  if (unquarantineCount > 0) {
    fs.writeFileSync(PARTS_PATH, s);
    console.log('\n✓ Unquarantined ' + unquarantineCount + ' products');
  }
  console.log('Real mismatches needing ASIN repair: ' + realMismatch.length);

  // Save mismatch list for repair
  fs.writeFileSync('quarantine-mismatches.json', JSON.stringify(realMismatch, null, 2));
  console.log('\nSaved mismatch list to quarantine-mismatches.json');
})();
