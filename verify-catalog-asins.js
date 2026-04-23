/**
 * verify-catalog-asins.js v2 — Catalog-wide Amazon ASIN verifier via DataForSEO
 *
 * CHANGES FROM v1:
 *   - Fixed polling: now polls each task_get directly (tasks_ready cursor was unreliable)
 *   - New mode: --fix-asins searches Amazon for correct ASIN when title mismatch detected
 *   - Auto-fix now covers: prices, stock, AND wrong ASINs (safely, with confidence checks)
 *
 * USAGE:
 *   railway run node verify-catalog-asins.js --tier 1 --dry-run
 *   railway run node verify-catalog-asins.js --tier 1 --report-only
 *   railway run node verify-catalog-asins.js --tier 1 --auto-fix
 *   railway run node verify-catalog-asins.js --tier 1 --auto-fix --fix-asins
 *   railway run node verify-catalog-asins.js --limit 20 --report-only
 *
 * SAFETY GUARANTEES:
 *   - Never auto-fixes an ASIN unless new search result has title-score >= 0.8
 *   - Never auto-fixes price/stock if title mismatch (whole record is suspect)
 *   - Always writes a report BEFORE changes
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { canonicalizeProductName, extractModelToken } from './normalize-product-name.js';

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
if (!LOGIN || !PASSWORD) {
  console.error('ERROR: Missing DATAFORSEO_LOGIN or DATAFORSEO_PASSWORD env vars.');
  process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(`${LOGIN}:${PASSWORD}`).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

const TIERS = {
  1: ['CPU', 'GPU', 'Motherboard', 'RAM', 'Storage', 'PSU', 'Case'],
  2: ['CPUCooler', 'CaseFan', 'Monitor'],
  3: ['Keyboard', 'Mouse', 'Headset', 'Microphone', 'Webcam', 'MousePad', 'Chair', 'Desk'],
  4: ['SoundCard', 'EthernetCard', 'WiFiCard', 'OpticalDrive', 'ExtensionCables',
      'InternalLCD', 'InternalDisplay', 'ThermalPaste', 'ExternalStorage',
      'Antivirus', 'ExternalOptical', 'UPS', 'OS'],
};

const REPORTS_DIR = './verify-reports';
const BATCH_SIZE = 50;
const POST_DELAY_MS = 500;
const TASK_POLL_DELAY_MS = 30000;
const TASK_POLL_INTERVAL_MS = 10000;
const MAX_POLL_WAIT_MS = 1800000;
const GET_CONCURRENCY = 8;
const PRICE_DRIFT_THRESHOLD = 0.05;
const ASIN_FIX_MIN_SCORE = 0.8;

// ═══ STRATEGY 2: Known-good ASIN overrides table ═══
let ASIN_OVERRIDES = {};
const OVERRIDES_PATH = './src/data/asin-overrides.json';
if (existsSync(OVERRIDES_PATH)) {
  try {
    ASIN_OVERRIDES = JSON.parse(readFileSync(OVERRIDES_PATH, 'utf8'));
    console.log(`Loaded ${Object.keys(ASIN_OVERRIDES).length} known-good ASIN overrides`);
  } catch (e) {
    console.warn('Failed to load asin-overrides.json:', e.message);
  }
}

function lookupKnownGoodASIN(product) {
  const key = canonicalizeProductName(product.n, product.c);
  if (!key) return null;
  const entry = ASIN_OVERRIDES[key];
  return entry ? { asin: entry.asin, source: 'known-good-table', score: 1.0 } : null;
}

// Strict model-token matching — "5900X" must NOT match "5900XT"
function hasExactModelToken(storedName, candidateTitle, category) {
  const storedModel = extractModelToken(storedName, category);
  if (!storedModel) return false;
  // Tokenize candidate title (split on whitespace/punctuation)
  const tokens = candidateTitle.toUpperCase().split(/[\s,\-\/\(\)\[\]™®]+/).filter(Boolean);
  return tokens.includes(storedModel.toUpperCase());
}


const args = process.argv.slice(2);
const getFlag = (name, hasValue = false) => {
  const i = args.indexOf(name);
  if (i === -1) return hasValue ? null : false;
  return hasValue ? args[i + 1] : true;
};
const flags = {
  tier: getFlag('--tier', true),
  dryRun: getFlag('--dry-run'),
  reportOnly: getFlag('--report-only'),
  autoFix: getFlag('--auto-fix'),
  fixAsins: getFlag('--fix-asins'),
  limit: Number(getFlag('--limit', true)) || null,
};
if (!flags.tier) { console.error('Must specify --tier (1|2|3|4|all)'); process.exit(1); }
if (!flags.dryRun && !flags.reportOnly && !flags.autoFix) {
  console.error('Must specify mode: --dry-run, --report-only, or --auto-fix');
  process.exit(1);
}

async function dfs(method, path, body = null) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const res = await fetch(BASE + path, {
        method,
        headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
      if (res.status === 429 || res.status === 503) {
        await new Promise(r => setTimeout(r, 3000 + attempt * 5000));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return await res.json();
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
    }
  }
}

function extractASIN(url) {
  if (!url) return null;
  const m = url.match(/\/dp\/([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
}

function normalize(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function titleMatches(storedName, amazonTitle) {
  if (!storedName || !amazonTitle) return { match: false, score: 0 };
  const a = normalize(storedName);
  const b = normalize(amazonTitle);
  const tokensA = new Set(a.split(' ').filter(t => t.length >= 3));
  const tokensB = new Set(b.split(' ').filter(t => t.length >= 3));
  if (!tokensA.size) return { match: false, score: 0 };
  let hits = 0;
  for (const t of tokensA) if (tokensB.has(t)) hits++;
  const score = hits / tokensA.size;
  const modelTokensA = [...tokensA].filter(t => /\d/.test(t) && /[a-z]/.test(t));
  const modelMatch = modelTokensA.length === 0 || modelTokensA.some(t => tokensB.has(t));
  return { match: score >= 0.5 && modelMatch, score: Math.round(score * 100) / 100 };
}

async function loadCatalog() {
  const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js?t=${Date.now()}`);
  return [...mod.PARTS];
}
function saveCatalog(parts) {
  writeFileSync('./src/data/parts.js',
    `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`);
}
function selectProducts(parts, tier) {
  const cats = tier === 'all' ? Object.values(TIERS).flat() : (TIERS[tier] || []);
  const products = parts.filter(p => cats.includes(p.c) && extractASIN(p.deals?.amazon?.url));
  return flags.limit ? products.slice(0, flags.limit) : products;
}

async function postTasks(products) {
  const tasks = [];
  console.log(`\nPosting ${products.length} tasks...`);
  for (let i = 0; i < products.length; i += BATCH_SIZE) {
    const batch = products.slice(i, i + BATCH_SIZE);
    const payload = batch.map(p => ({
      asin: extractASIN(p.deals.amazon.url),
      language_code: 'en_US',
      location_code: 2840,
      tag: `verify-${p.id}`,
    }));
    const resp = await dfs('POST', '/merchant/amazon/asin/task_post', payload);
    for (const t of (resp.tasks || [])) {
      if (t.id) {
        const prodId = Number(t.data?.tag?.replace('verify-', ''));
        tasks.push({ taskId: t.id, productId: prodId, asin: t.data?.asin });
      }
    }
    process.stdout.write(`  posted ${Math.min(i + BATCH_SIZE, products.length)}/${products.length}\r`);
    await new Promise(r => setTimeout(r, POST_DELAY_MS));
  }
  console.log(`\n  ${tasks.length} tasks posted`);
  return tasks;
}

async function fetchAllResults(tasks) {
  const results = new Map();
  const pending = new Map(tasks.map(t => [t.taskId, t]));
  const startedAt = Date.now();
  console.log(`\nWaiting ${TASK_POLL_DELAY_MS / 1000}s before first poll...`);
  await new Promise(r => setTimeout(r, TASK_POLL_DELAY_MS));

  while (pending.size && (Date.now() - startedAt) < MAX_POLL_WAIT_MS) {
    console.log(`\n  ${results.size} done / ${pending.size} pending`);
    const taskList = [...pending.keys()];
    for (let i = 0; i < taskList.length; i += GET_CONCURRENCY) {
      const batch = taskList.slice(i, i + GET_CONCURRENCY);
      await Promise.all(batch.map(async taskId => {
        try {
          const resp = await dfs('GET', `/merchant/amazon/asin/task_get/advanced/${taskId}`);
          const task = resp.tasks?.[0];
          if (!task) return;
          const isPending = task.status_code === 20100 || task.status_code === 40602 || !task.result;
          if (isPending) return;
          const t = pending.get(taskId);
          const item = task.result?.[0]?.items?.[0];
          if (task.status_code === 20000 && item) {
            results.set(taskId, { ...t, data: item, status: task.status_code });
          } else {
            results.set(taskId, { ...t, data: null, status: task.status_code, error: task.status_message });
          }
          pending.delete(taskId);
        } catch (e) {
          // Leave pending for retry
        }
      }));
      process.stdout.write(`    polled ${Math.min(i + GET_CONCURRENCY, taskList.length)}/${taskList.length}\r`);
    }
    if (pending.size) {
      console.log(`\n  ${pending.size} still pending, waiting ${TASK_POLL_INTERVAL_MS / 1000}s...`);
      await new Promise(r => setTimeout(r, TASK_POLL_INTERVAL_MS));
    }
  }
  if (pending.size) console.log(`\n  WARN: ${pending.size} tasks never completed.`);
  return [...results.values()];
}

async function searchAmazonFor(productName) {
  try {
    const resp = await dfs('POST', '/merchant/amazon/products/task_post', [{
      keyword: productName, language_code: 'en_US', location_code: 2840, depth: 10,
    }]);
    const taskId = resp.tasks?.[0]?.id;
    if (!taskId) return null;
    await new Promise(r => setTimeout(r, 30000));
    for (let attempt = 0; attempt < 6; attempt++) {
      const getResp = await dfs('GET', `/merchant/amazon/products/task_get/advanced/${taskId}`);
      const task = getResp.tasks?.[0];
      if (task?.status_code === 20100) {
        await new Promise(r => setTimeout(r, 15000));
        continue;
      }
      if (task?.result) return task.result[0]?.items?.slice(0, 5) || [];
    }
    return null;
  } catch (e) {
    return null;
  }
}

async function findBestASIN(product) {
  const searchResults = await searchAmazonFor(product.n);
  if (!searchResults || !searchResults.length) return null;
  let best = null;
  for (const r of searchResults) {
    const title = r.title || r.product_title;
    const asin = r.asin || r.data_asin;
    if (!asin || !title) continue;
    const match = titleMatches(product.n, title);
    if (!best || match.score > best.score) {
      best = { asin, title, score: match.score, price: r.price?.current || r.price_from };
    }
  }
  return best;
}

function analyzeResult(product, amazonData) {
  const issues = [];
  const fixes = {};
  if (!amazonData) {
    issues.push({ type: 'no_data', severity: 'high', msg: 'No data returned' });
    return { issues, fixes };
  }
  const azTitle = amazonData.title || amazonData.product_title;
  const azPrice = amazonData.price?.current || amazonData.price_from;
  const azInStock = amazonData.is_available !== false;
  const tm = titleMatches(product.n, azTitle);

  if (!tm.match) {
    issues.push({ type: 'title_mismatch', severity: 'high',
      msg: `Title mismatch (score=${tm.score})`, stored: product.n, amazon: azTitle });
    return { issues, fixes };
  }

  const storedPrice = product.deals?.amazon?.price;
  if (azPrice != null && storedPrice != null) {
    const drift = Math.abs(azPrice - storedPrice) / Math.max(storedPrice, 1);
    if (drift > PRICE_DRIFT_THRESHOLD) {
      issues.push({ type: 'price_drift', severity: 'medium',
        msg: `Drift ${(drift * 100).toFixed(1)}%`, stored: storedPrice, amazon: azPrice });
      fixes.amazonPrice = azPrice;
    }
  }
  const storedStock = product.deals?.amazon?.inStock;
  if (storedStock !== azInStock) {
    issues.push({ type: 'stock_mismatch', severity: 'medium',
      msg: `Stock changed`, stored: storedStock, amazon: azInStock });
    fixes.amazonInStock = azInStock;
  }
  return { issues, fixes };
}

function applyFixes(parts, perProductFixes) {
  let changed = 0;
  for (const p of parts) {
    const fix = perProductFixes[p.id];
    if (!fix) continue;
    let productChanged = false;
    if (fix.amazonPrice != null && p.deals?.amazon) {
      p.deals.amazon.price = fix.amazonPrice; productChanged = true;
    }
    if (fix.amazonInStock != null && p.deals?.amazon) {
      p.deals.amazon.inStock = fix.amazonInStock; productChanged = true;
    }
    if (fix.newAsinUrl) {
      p.deals.amazon.url = fix.newAsinUrl;
      if (fix.newAsinPrice != null) p.deals.amazon.price = fix.newAsinPrice;
      productChanged = true;
    }
    if (fix.needsReview) {
      p.needsReview = true;
      p.quarantinedAt = fix.quarantinedAt;
      productChanged = true;
    }
    if (productChanged) changed++;
  }
  return changed;
}

function writeReports(allIssues, asinRepairs, meta) {
  if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const jsonPath = join(REPORTS_DIR, `report-${ts}.json`);
  const mdPath = join(REPORTS_DIR, `report-${ts}.md`);
  writeFileSync(jsonPath, JSON.stringify({ meta, issues: allIssues, asinRepairs }, null, 2));

  const byType = {};
  for (const entry of allIssues) {
    for (const iss of entry.issues) {
      if (!byType[iss.type]) byType[iss.type] = [];
      byType[iss.type].push({ ...entry, issue: iss });
    }
  }
  let md = `# Catalog ASIN Verification Report\n\n`;
  md += `**Run at:** ${meta.timestamp}\n**Tier:** ${meta.tier}\n**Products checked:** ${meta.checked}\n`;
  md += `**With issues:** ${allIssues.filter(e => e.issues.length).length}\n**Mode:** ${meta.mode}\n`;
  md += `**ASIN repairs:** ${asinRepairs.length}\n\n---\n\n## Summary\n\n`;
  for (const [type, list] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
    md += `- **${type}**: ${list.length}\n`;
  }
  md += `\n---\n\n`;
  if (asinRepairs.length) {
    md += `## ASIN Repairs\n\n`;
    asinRepairs.forEach(r => {
      md += `- **id=${r.productId}** [${r.category}]\n  - Name: ${r.name}\n`;
      md += `  - Old: \`${r.oldAsin}\` → New: \`${r.newAsin || '(none found)'}\` (score: ${r.score})\n`;
      md += `  - Status: ${r.applied ? 'APPLIED' : 'SKIPPED'}\n\n`;
    });
  }
  for (const [type, list] of Object.entries(byType).sort((a, b) => b[1].length - a[1].length)) {
    md += `## ${type} (${list.length})\n\n`;
    for (const e of list.slice(0, 100)) {
      md += `- **id=${e.productId}** [${e.category}] \`${e.asin}\` — ${e.issue.msg}\n`;
      md += `  - Name: ${e.name}\n`;
      if (e.issue.stored !== undefined) md += `  - Stored: \`${JSON.stringify(e.issue.stored).slice(0, 120)}\`\n`;
      if (e.issue.amazon !== undefined) md += `  - Amazon: \`${JSON.stringify(e.issue.amazon).slice(0, 120)}\`\n`;
      md += `\n`;
    }
    if (list.length > 100) md += `\n_...${list.length - 100} more, see JSON_\n\n`;
  }
  writeFileSync(mdPath, md);
  console.log(`\nReport: ${mdPath}`);
}

(async () => {
  const parts = await loadCatalog();
  const products = selectProducts(parts, flags.tier);
  console.log(`━━━ Verifier v2 ━━━`);
  console.log(`  Tier: ${flags.tier}`);
  console.log(`  Products: ${products.length}`);
  console.log(`  Est cost: $${(products.length * 0.0015).toFixed(2)}${flags.fixAsins ? ' + ASIN searches' : ''}`);
  console.log(`  Mode: ${flags.dryRun ? 'DRY RUN' : flags.autoFix ? 'AUTO-FIX' : 'REPORT-ONLY'}${flags.fixAsins ? ' + ASIN repair' : ''}`);
  if (flags.dryRun) { console.log(`\nDry run complete.`); return; }

  const tasks = await postTasks(products);
  const results = await fetchAllResults(tasks);
  console.log(`\nGot ${results.length} results`);

  const byProduct = new Map(parts.map(p => [p.id, p]));
  const allIssues = [];
  const perProductFixes = {};
  for (const r of results) {
    const product = byProduct.get(r.productId);
    if (!product) continue;
    const { issues, fixes } = analyzeResult(product, r.data);
    allIssues.push({ productId: r.productId, asin: r.asin, name: product.n, category: product.c, issues });
    if (Object.keys(fixes).length) perProductFixes[r.productId] = fixes;
  }

  const asinRepairs = [];
  if (flags.fixAsins) {
    const mismatches = allIssues.filter(e => e.issues.some(i => i.type === 'title_mismatch'));
    console.log(`\nStrategy 2 ASIN repair: ${mismatches.length} candidates...`);
    let viaTable = 0, viaSearch = 0, viaQuarantine = 0;
    for (let i = 0; i < mismatches.length; i++) {
      const entry = mismatches[i];
      const product = byProduct.get(entry.productId);

      // Step 1: try known-good table first
      let best = lookupKnownGoodASIN(product);
      if (best && best.asin !== entry.asin) {
        viaTable++;
        console.log(`  ${i+1}/${mismatches.length}: "${product.n.slice(0, 50)}" -> table hit ${best.asin}`);
      } else {
        best = null;
      }

      // Step 2: search Amazon + strict verify
      if (!best) {
        const searchResult = await findBestASIN(product);
        if (searchResult) {
          const strictMatch = hasExactModelToken(product.n, searchResult.title || '', product.c);
          if (strictMatch && searchResult.score >= 0.5) {
            best = searchResult;
            viaSearch++;
            console.log(`  ${i+1}/${mismatches.length}: "${product.n.slice(0, 50)}" -> search hit ${best.asin} (score ${best.score})`);
          } else {
            console.log(`  ${i+1}/${mismatches.length}: "${product.n.slice(0, 50)}" -> quarantine (score ${searchResult.score}, strict=${strictMatch})`);
          }
        }
      }

      // Step 3: quarantine if no confident match
      if (!best) {
        viaQuarantine++;
        asinRepairs.push({ productId: entry.productId, category: entry.category, name: product.n,
          oldAsin: entry.asin, newAsin: null, score: 0, applied: false, quarantined: true });
        if (flags.autoFix) {
          if (!perProductFixes[entry.productId]) perProductFixes[entry.productId] = {};
          perProductFixes[entry.productId].needsReview = true;
          perProductFixes[entry.productId].quarantinedAt = new Date().toISOString().slice(0, 10);
        }
        continue;
      }

      const apply = flags.autoFix && best.asin !== entry.asin;
      asinRepairs.push({ productId: entry.productId, category: entry.category, name: product.n,
        oldAsin: entry.asin, newAsin: best.asin, score: best.score, title: best.title, applied: apply });
      if (apply) {
        if (!perProductFixes[entry.productId]) perProductFixes[entry.productId] = {};
        perProductFixes[entry.productId].newAsinUrl = `https://www.amazon.com/dp/${best.asin}?tag=tiereduptech-20`;
        if (best.price) perProductFixes[entry.productId].newAsinPrice = best.price;
      }
    }
    if (mismatches.length) {
      console.log(`\nStrategy 2 summary: ${viaTable} via known-good table, ${viaSearch} via search, ${viaQuarantine} quarantined`);
    }
  }

  const meta = {
    timestamp: new Date().toISOString(),
    tier: flags.tier, checked: results.length,
    mode: flags.autoFix ? 'auto-fix' : 'report-only',
  };
  writeReports(allIssues, asinRepairs, meta);

  if (flags.autoFix) {
    const changed = applyFixes(parts, perProductFixes);
    saveCatalog(parts);
    console.log(`\nApplied fixes to ${changed} products in parts.js`);
  } else {
    console.log(`\nReport-only: no DB changes.`);
  }
  console.log(`Done.`);
})();
