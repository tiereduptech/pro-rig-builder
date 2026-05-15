/**
 * backfill-gpu-specs.cjs
 * 
 * Fetches Amazon ASIN detail pages for GPUs missing TDP/length/vram/memType.
 * 
 * USAGE:
 *   railway run node backfill-gpu-specs.cjs              # dry run
 *   railway run node backfill-gpu-specs.cjs --apply
 *   railway run node backfill-gpu-specs.cjs --limit=10
 * 
 * COST: ~$0.003 per ASIN × 137 = ~$0.41
 */
const fs = require('fs');
const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) { console.error('Missing creds. Use: railway run node backfill-gpu-specs.cjs'); process.exit(1); }
const AUTH = 'Basic ' + Buffer.from(LOGIN + ':' + PASSWORD).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';
const APPLY = process.argv.includes('--apply');
const LIMIT = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0') || null;

function flattenProductInfo(productInformation) {
  const flat = {};
  if (!productInformation) return flat;
  for (const section of Array.isArray(productInformation) ? productInformation : []) {
    if (section.type === 'product_information_details_item' && section.body && typeof section.body === 'object') {
      for (const [k, v] of Object.entries(section.body)) flat[k.toLowerCase()] = String(v).trim();
    }
    if (Array.isArray(section.contents)) {
      for (const c of section.contents) {
        if (c.body && typeof c.body === 'object' && !Array.isArray(c.body)) {
          for (const [k, v] of Object.entries(c.body)) flat[k.toLowerCase()] = String(v).trim();
        }
      }
    }
  }
  return flat;
}

function lookupField(flat, ...keys) {
  for (const k of keys) {
    const lk = k.toLowerCase();
    if (flat[lk]) return flat[lk];
    for (const fk of Object.keys(flat)) {
      if (fk.includes(lk)) return flat[fk];
    }
  }
  return null;
}

function parseInt2(s) {
  if (s == null) return null;
  const m = String(s).match(/\d+/);
  return m ? parseInt(m[0]) : null;
}

function extractGpuSpecs(product, flat) {
  const title = product.n || '';
  const specs = {};

  // TDP (power consumption)
  if (!product.tdp) {
    let v = lookupField(flat, 'tdp', 'power consumption', 'maximum power', 'graphics card power');
    if (v) {
      const n = parseInt2(v);
      if (n && n >= 30 && n <= 700) specs.tdp = n;
    }
    if (!specs.tdp) {
      const m = title.match(/(\d{2,3})\s*W\s*(?:TDP|TGP|power)/i);
      if (m) specs.tdp = parseInt(m[1]);
    }
  }

  // Length (mm)
  if (!product.length) {
    let v = lookupField(flat, 'card length', 'item length', 'length', 'product length');
    if (v) {
      const n = parseInt2(v);
      if (/inch/i.test(String(v))) {
        if (n) specs.length = Math.round(n * 25.4);
      } else if (n && n >= 100 && n <= 500) {
        specs.length = n;
      }
    }
    if (!specs.length) {
      const m = title.match(/(\d{3})\s*mm/i);
      if (m) {
        const n = parseInt(m[1]);
        if (n >= 100 && n <= 500) specs.length = n;
      }
    }
  }

  // VRAM (only if missing - normalized to number GB)
  if (!product.vram) {
    let v = lookupField(flat, 'graphics ram size', 'video memory', 'graphics memory size', 'memory size', 'vram');
    if (v) {
      const m = String(v).match(/(\d+)\s*(GB|G|MB|M)?/i);
      if (m) {
        const n = parseInt(m[1]);
        const unit = (m[2] || '').toUpperCase();
        if (unit === 'MB' || unit === 'M') specs.vram = Math.round(n / 1024);
        else if (n > 0 && n < 100) specs.vram = n;
      }
    }
    if (!specs.vram) {
      const m = title.match(/\b(\d{1,2})\s*GB\b/i);
      if (m) {
        const n = parseInt(m[1]);
        if (n > 0 && n <= 48) specs.vram = n;
      }
    }
  }

  // Memory type (GDDR6, GDDR6X, GDDR7)
  if (!product.memType) {
    let v = lookupField(flat, 'memory type', 'graphics ram type', 'ram type');
    if (v) {
      const m = String(v).match(/GDDR\s*(\d[XS]?)/i);
      if (m) specs.memType = 'GDDR' + m[1].toUpperCase();
    }
    if (!specs.memType) {
      const m = title.match(/\bGDDR\s*(\d[XS]?)\b/i);
      if (m) specs.memType = 'GDDR' + m[1].toUpperCase();
    }
  }

  // Recommended PSU
  if (!product.recPsu && !product.psuMin) {
    let v = lookupField(flat, 'recommended power supply', 'minimum power supply', 'power supply');
    if (v) {
      const n = parseInt2(v);
      if (n && n >= 200 && n <= 1500) specs.recPsu = n;
    }
  }

  // Slot width (1, 2, 3, 4 slot)
  if (!product.slots) {
    let v = lookupField(flat, 'slot width', 'slot', 'expansion slot');
    if (v) {
      const m = String(v).match(/(\d(?:\.\d)?)[\s\-]*slot/i);
      if (m) specs.slots = parseFloat(m[1]);
    }
    if (!specs.slots) {
      const m = title.match(/(\d(?:\.\d)?)[\s\-]*slot/i);
      if (m) specs.slots = parseFloat(m[1]);
    }
  }

  return specs;
}

async function postBatch(asins) {
  const body = asins.map(asin => ({
    asin,
    location_code: 2840,
    language_code: 'en_US',
    se_domain: 'amazon.com',
    priority: 1,
    tag: 'gpu-' + asin,
  }));
  const res = await fetch(BASE + '/merchant/amazon/asin/task_post', {
    method: 'POST',
    headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (data.status_code !== 20000) throw new Error('post failed: ' + JSON.stringify(data).slice(0,300));
  const map = {};
  for (const t of (data.tasks || [])) {
    const tag = t.data?.tag || '';
    const asin = tag.replace('gpu-', '');
    if (asin && t.id) map[asin] = t.id;
  }
  return map;
}

async function getResult(taskId) {
  const res = await fetch(BASE + '/merchant/amazon/asin/task_get/advanced/' + taskId, {
    headers: { 'Authorization': AUTH },
  });
  const data = await res.json();
  if (data.status_code !== 20000) return null;
  const task = data.tasks?.[0];
  if (!task || task.status_code !== 20000) return null;
  return task.result?.[0]?.items?.[0] || null;
}

async function waitForAll(asinToTaskId, timeoutMs = 600000) {
  const start = Date.now();
  const results = {};
  const remaining = new Set(Object.keys(asinToTaskId));
  while (remaining.size > 0 && (Date.now() - start) < timeoutMs) {
    for (const asin of [...remaining]) {
      try {
        const result = await getResult(asinToTaskId[asin]);
        if (result) { results[asin] = result; remaining.delete(asin); }
      } catch (e) {}
    }
    if (remaining.size > 0) {
      process.stdout.write(`. (${remaining.size} pending)\n`);
      await new Promise(r => setTimeout(r, 8000));
    }
  }
  return results;
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...m.PARTS];

  const targets = parts.filter(p => 
    p.c === 'GPU' && 
    !p.needsReview && 
    p.deals?.amazon?.asin && 
    (!p.tdp || !p.length || !p.vram)
  );

  console.log('GPUs needing backfill:', targets.length);
  const work = LIMIT ? targets.slice(0, LIMIT) : targets;
  console.log('Will process:', work.length);
  console.log('Mode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('Cost estimate: $' + (work.length * 0.003).toFixed(2));
  console.log('---');

  const CHUNK = 100;
  const allResults = {};
  for (let i = 0; i < work.length; i += CHUNK) {
    const batch = work.slice(i, i + CHUNK);
    const asins = batch.map(p => p.deals.amazon.asin);
    console.log(`Posting batch ${Math.floor(i/CHUNK)+1}: ${asins.length} ASINs...`);
    const taskMap = await postBatch(asins);
    console.log(`Got ${Object.keys(taskMap).length} task IDs, polling...`);
    const results = await waitForAll(taskMap);
    Object.assign(allResults, results);
    console.log(`Batch done: ${Object.keys(results).length}/${asins.length} returned data`);
  }

  console.log('\n--- Extracting specs ---');
  let hits = 0, fields = 0;
  for (const p of work) {
    const item = allResults[p.deals.amazon.asin];
    if (!item) continue;
    const flat = flattenProductInfo(item.product_information);
    const specs = extractGpuSpecs(p, flat);
    if (Object.keys(specs).length > 0) {
      hits++;
      fields += Object.keys(specs).length;
      if (hits <= 25) console.log(`[${p.id}] ${JSON.stringify(specs)} | ${p.n.slice(0,50)}`);
      if (APPLY) Object.assign(p, specs);
    }
  }

  console.log(`\nFetched data: ${Object.keys(allResults).length}/${work.length}`);
  console.log(`GPUs updated: ${hits}, field fills: ${fields}`);

  if (APPLY) {
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log('Wrote parts.js');
  }
})();
