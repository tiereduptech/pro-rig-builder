// auto-fix-quarantined.cjs
// For each quarantined product, search Amazon for its name and find the best matching ASIN

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
const KEY = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function isMatch(stored, amazon) {
  if (!stored || !amazon) return { match: false, score: 0 };
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
    return { match: score >= 0.7, score };
  }
  if (modelMatchOK && score >= 0.5) {
    return { match: true, score };
  }
  return { match: false, score };
}

// Generate a search query from a product name, removing extras
function buildQuery(name) {
  // Strip parenthesized groups and capacity descriptions
  let q = name.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  // Limit to first 8 words for cleaner search
  const words = q.split(' ').slice(0, 8);
  return words.join(' ');
}

function setAsin(s, id, newAsin, newPrice, newTitle) {
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

  // Update Amazon URL
  entry = entry.replace(/"url":\s*"https:\/\/www\.amazon\.com\/dp\/[A-Z0-9]{10}[^"]*"/,
    '"url": "https://www.amazon.com/dp/' + newAsin + '?tag=tiereduptech-20"');
  // Update ASIN field (top-level)
  entry = entry.replace(/"asin":\s*"[A-Z0-9]{10}"/, '"asin": "' + newAsin + '"');
  // Update Amazon price
  if (newPrice && newPrice > 0) {
    entry = entry.replace(/"amazon":\s*\{\s*"price":\s*\d+(?:\.\d+)?/,
      '"amazon": { "price": ' + Math.round(newPrice));
  }
  // Remove quarantine flags
  entry = entry.replace(/,?\s*"needsReview":\s*true/g, '');
  entry = entry.replace(/,?\s*"quarantinedAt":\s*"[^"]*"/g, '');
  entry = entry.replace(/,(\s*),/g, ',$1');
  entry = entry.replace(/{(\s*),/g, '{$1');

  return s.substring(0, startBrace) + entry + s.substring(endBrace + 1);
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  const quarantined = parts.filter(p => p.needsReview);
  console.log('Searching Amazon for ' + quarantined.length + ' quarantined products...\n');

  // Submit searches in batches
  const tasks = [];
  const BATCH = 100;
  for (let i = 0; i < quarantined.length; i += BATCH) {
    const batch = quarantined.slice(i, i + BATCH);
    const body = batch.map(p => ({
      keyword: buildQuery(p.n),
      location_code: 2840,
      language_code: 'en_US',
      depth: 10,
      tag: 'fix-quar-' + p.id
    }));
    const post = await fetch('https://api.dataforseo.com/v3/merchant/amazon/products/task_post', {
      method: 'POST',
      headers: { 'Authorization': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const d = await post.json();
    if (d.tasks) {
      for (let j = 0; j < d.tasks.length; j++) {
        const task = d.tasks[j];
        if (task.id) {
          tasks.push({ id: task.id, product: batch[j] });
        }
      }
    }
  }
  console.log('Submitted ' + tasks.length + ' search tasks');

  console.log('\nWaiting 90s for search results...');
  await new Promise(r => setTimeout(r, 90000));

  // Fetch results
  const pendingTasks = [...tasks];
  const allFixes = [];
  let attempt = 0;
  while (pendingTasks.length > 0 && attempt < 25) {
    attempt++;
    const stillPending = [];
    const CONCURRENCY = 5;
    for (let i = 0; i < pendingTasks.length; i += CONCURRENCY) {
      const chunk = pendingTasks.slice(i, i + CONCURRENCY);
      const fetched = await Promise.all(chunk.map(async (t) => {
        try {
          const res = await fetch('https://api.dataforseo.com/v3/merchant/amazon/products/task_get/advanced/' + t.id, {
            headers: { 'Authorization': KEY }
          });
          const d = await res.json();
          const result = d?.tasks?.[0]?.result?.[0];
          if (result?.items) return { task: t, items: result.items };
          if (d?.tasks?.[0]?.status_code === 20100) return { task: t, pending: true }; // task in queue
          return { task: t, items: [] };
        } catch (e) { return { task: t, pending: true }; }
      }));
      for (const f of fetched) {
        if (f.pending) stillPending.push(f.task);
        else if (f.items) {
          // Find best match
          let best = null;
          for (const item of f.items) {
            if (!item.title || !item.data_asin) continue;
            const m = isMatch(f.task.product.n, item.title);
            if (m.match && (!best || m.score > best.score)) {
              best = {
                asin: item.data_asin,
                title: item.title,
                price: item.price?.current || item.price_from || null,
                rating: item.rating?.value || null,
                score: m.score
              };
            }
          }
          allFixes.push({ product: f.task.product, best });
        }
      }
    }
    console.log('  attempt ' + attempt + ': fixes=' + allFixes.length + ' pending=' + stillPending.length);
    pendingTasks.length = 0;
    pendingTasks.push(...stillPending);
    if (pendingTasks.length > 0) await new Promise(r => setTimeout(r, 30000));
  }

  // Apply fixes
  let s = fs.readFileSync(PARTS_PATH, 'utf8');
  let fixedCount = 0;
  let noMatchCount = 0;

  console.log('\n═══ FIXES ═══\n');
  for (const f of allFixes) {
    if (f.best) {
      const oldAsin = f.product.deals?.amazon?.url?.match(/\/dp\/([A-Z0-9]{10})/)?.[1] || '?';
      console.log('✓ id=' + f.product.id + ' ' + oldAsin + ' → ' + f.best.asin + ' (score ' + f.best.score.toFixed(2) + ')');
      console.log('    "' + f.product.n.substring(0, 50) + '" → "' + f.best.title.substring(0, 60) + '"');
      s = setAsin(s, f.product.id, f.best.asin, f.best.price);
      fixedCount++;
    } else {
      console.log('✗ id=' + f.product.id + ' NO MATCH found for "' + f.product.n.substring(0, 50) + '"');
      noMatchCount++;
    }
  }

  fs.writeFileSync(PARTS_PATH, s);
  console.log('\n═══ SUMMARY ═══');
  console.log('Fixed: ' + fixedCount);
  console.log('No match found: ' + noMatchCount);
  console.log('\nProducts with no match remain quarantined - may need to be removed from catalog');
})();
