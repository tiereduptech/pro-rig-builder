// auto-fix-quarantined-strict.cjs
// MUCH stricter matching:
// - Brand must match (first word of stored name in Amazon title)
// - Capacity (TB/GB/W) must match if present in stored name
// - Model number tokens must ALL match
// - Overall score >= 0.7

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
const KEY = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

// Strict match: brand + capacity + all model tokens
function strictMatch(stored, amazon, brand) {
  if (!stored || !amazon) return { match: false, reason: 'empty' };
  const a = normalize(stored);
  const b = normalize(amazon);

  // 1. Brand check - brand name should appear in Amazon title
  const brandLower = (brand || '').toLowerCase();
  if (brandLower) {
    const brandTokens = brandLower.split(/[\s\-]/).filter(t => t.length >= 3);
    let brandHits = 0;
    for (const bt of brandTokens) if (b.includes(bt)) brandHits++;
    if (brandTokens.length > 0 && brandHits === 0) {
      return { match: false, reason: 'brand-mismatch (' + brand + ' not in amazon title)' };
    }
  }

  // 2. Capacity check - if stored has capacity (TB, GB, W), it must match
  const capacityRe = /(\d+(?:\.\d+)?)\s*(tb|gb|w|gbps|mhz)\b/gi;
  const storedCaps = [];
  let m;
  while ((m = capacityRe.exec(a)) !== null) {
    storedCaps.push({ num: parseFloat(m[1]), unit: m[2] });
  }
  for (const cap of storedCaps) {
    // Allow approximate matches (1.92TB ≈ 1920GB; usually they're exact in titles though)
    const pattern = new RegExp('\\b' + cap.num + '\\s*' + cap.unit + '\\b', 'i');
    const altPattern = cap.unit === 'tb' && cap.num >= 1
      ? new RegExp('\\b' + (cap.num * 1000) + '\\s*gb\\b', 'i') // 2TB = 2000GB
      : null;
    if (!pattern.test(b) && !(altPattern && altPattern.test(b))) {
      return { match: false, reason: 'capacity-mismatch (' + cap.num + cap.unit.toUpperCase() + ')' };
    }
  }

  // 3. Model token check - ALL alphanumeric model tokens (≥4 chars with digit+letter) must match
  const tokensA = a.split(' ').filter(t => t.length >= 3);
  // Strict model tokens: have BOTH digit and letter, or are 4-char SKU-like
  const modelTokensA = tokensA.filter(t => {
    return (/\d/.test(t) && /[a-z]/.test(t)) ||
           (t.length >= 4 && /^[a-z]+\d+/i.test(t));
  });
  const tokensB = new Set(b.split(' ').filter(t => t.length >= 3));
  let modelMatches = 0;
  for (const t of modelTokensA) {
    if (tokensB.has(t)) modelMatches++;
  }
  if (modelTokensA.length > 0 && modelMatches < modelTokensA.length) {
    return { match: false, reason: 'model-mismatch (' + modelMatches + '/' + modelTokensA.length + ')' };
  }

  // 4. Overall token overlap >= 0.7
  let hits = 0;
  for (const t of tokensA) if (tokensB.has(t)) hits++;
  const score = hits / tokensA.length;
  if (score < 0.7) {
    return { match: false, reason: 'low-score (' + score.toFixed(2) + ')' };
  }

  return { match: true, score, reason: 'strict-match' };
}

function buildQuery(name) {
  let q = name.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  return q.split(' ').slice(0, 8).join(' ');
}

function setAsin(s, id, newAsin, newPrice) {
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

  entry = entry.replace(/"url":\s*"https:\/\/www\.amazon\.com\/dp\/[A-Z0-9]{10}[^"]*"/,
    '"url": "https://www.amazon.com/dp/' + newAsin + '?tag=tiereduptech-20"');
  entry = entry.replace(/"asin":\s*"[A-Z0-9]{10}"/, '"asin": "' + newAsin + '"');
  if (newPrice && newPrice > 0) {
    entry = entry.replace(/"amazon":\s*\{\s*"price":\s*\d+(?:\.\d+)?/,
      '"amazon": { "price": ' + Math.round(newPrice));
  }
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
  console.log('STRICT auto-fix for ' + quarantined.length + ' quarantined products');
  console.log('Match requires: brand match + ALL model tokens + capacity match + score >= 0.7\n');

  // Submit searches
  const tasks = [];
  const BATCH = 100;
  for (let i = 0; i < quarantined.length; i += BATCH) {
    const batch = quarantined.slice(i, i + BATCH);
    const body = batch.map(p => ({
      keyword: buildQuery(p.n),
      location_code: 2840,
      language_code: 'en_US',
      depth: 10,
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
        if (task.id) tasks.push({ id: task.id, product: batch[j] });
      }
    }
  }
  console.log('Submitted ' + tasks.length + ' tasks. Waiting 90s...');
  await new Promise(r => setTimeout(r, 90000));

  // Fetch
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
          if (d?.tasks?.[0]?.status_code === 20100) return { task: t, pending: true };
          return { task: t, items: [] };
        } catch (e) { return { task: t, pending: true }; }
      }));
      for (const f of fetched) {
        if (f.pending) stillPending.push(f.task);
        else if (f.items) {
          let best = null;
          for (const item of f.items) {
            if (!item.title || !item.data_asin) continue;
            const m = strictMatch(f.task.product.n, item.title, f.task.product.b);
            if (m.match && (!best || m.score > best.score)) {
              best = {
                asin: item.data_asin,
                title: item.title,
                price: item.price?.current || item.price_from || null,
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

  let s = fs.readFileSync(PARTS_PATH, 'utf8');
  let fixedCount = 0, noMatchCount = 0;

  console.log('\n═══ FIXES (strict matches only) ═══\n');
  for (const f of allFixes) {
    if (f.best) {
      const oldAsin = f.product.deals?.amazon?.url?.match(/\/dp\/([A-Z0-9]{10})/)?.[1] || '?';
      console.log('✓ id=' + f.product.id + ' ' + oldAsin + ' → ' + f.best.asin + ' (score ' + f.best.score.toFixed(2) + ')');
      console.log('    "' + f.product.n.substring(0, 55) + '"');
      console.log('    "' + f.best.title.substring(0, 60) + '"');
      s = setAsin(s, f.product.id, f.best.asin, f.best.price);
      fixedCount++;
    } else {
      noMatchCount++;
    }
  }

  fs.writeFileSync(PARTS_PATH, s);
  console.log('\n═══ SUMMARY ═══');
  console.log('Strict-fixed: ' + fixedCount);
  console.log('No strict match: ' + noMatchCount);
  console.log('\nProducts with no strict match remain quarantined.');
  console.log('Hidden from frontend until manually fixed or removed.');
})();
