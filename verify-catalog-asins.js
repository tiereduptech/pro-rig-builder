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
import { loadOverrides, buildOverrideIndex } from './asin-override-table.js';
import { canonicalizeProductName, extractModelToken,
         parseCapacityGB, capacityCompatible, capacitiesMatch,
         isHardDrive, isPricePlausibleForCapacity } from './normalize-product-name.js';
import { selectNewOffer, lowestAnyConditionPrice, amazonPriceSanity } from './amazon-price.js';
// The price-drift gate lives in ONE place. Threshold, titleMatches, and
// analyzeResult are imported — never re-declared here (see drift-gate.js).
import { STORAGE_CATS, titleMatches, analyzeResult,
         driftGateStaleness, DRIFT_GRADED_TYPES, DRIFT_FLAGGED_TYPES,
         linkVerificationCurrent, lastDealChangedAt, stampDealChange } from './drift-gate.js';
import { isRenewedTitle } from './condition.cjs';
// Spend guards (dollar ceiling + scoped exact-count + full-tier band) live in ONE
// pure, unit-tested module — never re-declared here. See verify-spend-guard.js.
import { evaluateSpendGuard, COST_PER_SELLERS_TASK } from './verify-spend-guard.js';
// PA API is a free second opinion on rows DataForSEO cannot confirm. Its client
// never throws: missing creds, a 401, or AssociateNotEligible all degrade to an
// empty result plus an alert, so the run continues on DataForSEO alone.
import { resolveItems, onPaapiAlert, paapiStatus, preflightPaapi, BATCH_MAX as PAAPI_BATCH } from './amazon-paapi.js';
let PAAPI_RUN_SUMMARY = null;

const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
// A --dry-run posts ZERO tasks and never calls the API — it exists to PROVE the
// scope before anyone spends, so it must run without credentials. --paapi-preflight
// only checks the (free) PA API config and posts nothing either. Only a real
// (task-posting) run requires DataForSEO credentials.
if (!process.argv.includes('--dry-run') && !process.argv.includes('--paapi-preflight')
    && (!LOGIN || !PASSWORD)) {
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
const ASIN_FIX_MIN_SCORE = 0.8;
// COST_PER_SELLERS_TASK is imported from verify-spend-guard.js (single source of
// truth for spend math, shared with the ceiling projection). MEASURED $0.00150/call.

// ═══ STRATEGY 2: Known-good ASIN overrides table ═══
// The table is keyed by canonicalizeProductName(), which is a CLASS for GPUs,
// cases and boards — "NVIDIA|RTX|5080" is 31 distinct cards. This lookup used
// to answer any of them with the same ASIN at score 1.0, and it is the FIRST
// thing tried when repairing a mismatched ASIN, on a cron that runs with
// --fix-asins every two days. asin-override-table.js refuses a key that answers
// for more than one product and requires each entry to name the product it was
// verified for. See rekey-asin-overrides.mjs for how the table was bound.
const ASIN_OVERRIDES = loadOverrides();
console.log(`Loaded ${Object.keys(ASIN_OVERRIDES).length} known-good ASIN overrides`);
let OVERRIDE_INDEX = { lookup: () => null, stats: {}, refusals: [] };

/** Must be called once the catalog is loaded — the ambiguity guard counts products. */
function armOverrideTable(parts) {
  OVERRIDE_INDEX = buildOverrideIndex(parts, ASIN_OVERRIDES);
  const ambiguous = [...OVERRIDE_INDEX.namesPerKey.entries()]
    .filter(([k, names]) => ASIN_OVERRIDES[k] && names.size > 1);
  if (ambiguous.length) {
    console.warn(`  ${ambiguous.length} override key(s) answer for more than one product and will be REFUSED:`);
    ambiguous.slice(0, 10).forEach(([k, names]) => console.warn(`    ${k} -> ${names.size} products`));
  }
}

function lookupKnownGoodASIN(product) {
  return OVERRIDE_INDEX.lookup(product);
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
  excludeIds: getFlag('--exclude-ids', true),
  onlyIds: getFlag('--only-ids', true),
  expectCount: getFlag('--expect-count', true) != null ? Number(getFlag('--expect-count', true)) : null,
  // Run ONLY the PA API config gate (one free Amazon call), print its state, exit.
  // A credential-free config check that needs no DataForSEO spend — used to prove
  // the fail-loud path and to sanity-check wiring before a real nightly run.
  paapiPreflight: getFlag('--paapi-preflight'),
  // Self-test hook: force the gate to see PA API as not_configured regardless of
  // creds, so the fail-loud path can be exercised even where creds ARE present
  // (e.g. a CI run proving the gate still fires). Never used by the nightly cron.
  forceUnconfigured: getFlag('--force-unconfigured'),
};
// Optional exclusion set (e.g. the SUSPECT_VS_LIST wrong-baseline cohort, which is
// a separate bug we must NOT touch in the price sweep). JSON file = array of ids.
let EXCLUDE_IDS = new Set();
if (flags.excludeIds) {
  try {
    EXCLUDE_IDS = new Set(JSON.parse(readFileSync(flags.excludeIds, 'utf8')).map(Number));
    console.log(`Excluding ${EXCLUDE_IDS.size} product ids (from ${flags.excludeIds})`);
  } catch (e) { console.error(`Failed to load --exclude-ids: ${e.message}`); process.exit(1); }
}
// Optional INCLUSION allowlist — an explicit id list (JSON array). Unlike a category
// or reviewFlag filter, an id list cannot silently WIDEN scope: if the file fails to
// load we abort (never fall back to the full tier), and the resolved count is printed
// + asserted (see --expect-count) so a mis-apply is caught before a single task posts.
// This is the guard against the "billed 2,782 rows instead of the subset" failure.
let ONLY_IDS = null;
if (flags.onlyIds) {
  try {
    ONLY_IDS = new Set(JSON.parse(readFileSync(flags.onlyIds, 'utf8')).map(Number));
    if (!ONLY_IDS.size) throw new Error('id list is empty');
    console.log(`Scoping to ${ONLY_IDS.size} product ids (from ${flags.onlyIds})`);
  } catch (e) { console.error(`Failed to load --only-ids: ${e.message}`); process.exit(1); }
}
if (!flags.tier) { console.error('Must specify --tier (1|2|3|4|all)'); process.exit(1); }
if (!flags.dryRun && !flags.reportOnly && !flags.autoFix && !flags.paapiPreflight) {
  console.error('Must specify mode: --dry-run, --report-only, --auto-fix, or --paapi-preflight');
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

async function loadCatalog() {
  const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js?t=${Date.now()}`);
  return [...mod.PARTS];
}
function saveCatalog(parts) {
  writeFileSync('./src/data/parts.js',
    `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`);
}
// The tier's CURRENT catalog population — all rows in the tier's categories, before
// the ASIN/exclude/link-verified filters. The full-tier spend band derives from THIS
// every run, so it tracks the catalog as it grows and needs no hand-set constant.
function tierCategoryCount(parts, tier) {
  const cats = tier === 'all' ? Object.values(TIERS).flat() : (TIERS[tier] || []);
  return parts.filter(p => cats.includes(p.c)).length;
}
function selectProducts(parts, tier) {
  const cats = tier === 'all' ? Object.values(TIERS).flat() : (TIERS[tier] || []);
  const candidates = parts.filter(p => cats.includes(p.c) && extractASIN(p.deals?.amazon?.url) && !EXCLUDE_IDS.has(p.id)
    && (!ONLY_IDS || ONLY_IDS.has(p.id)));
  // Skip rows a human verified whose deal has NOT changed since (see
  // linkVerificationCurrent in drift-gate.js — it invalidates the moment the deal's
  // link identity changes, so this is not a permanent bypass). REPORT-ONLY, never
  // silent: an over-used or stuck marker must be visible, not quietly shrink coverage.
  const skipped = candidates.filter(linkVerificationCurrent);
  if (skipped.length) {
    console.log(`\nLink-verified skip: ${skipped.length} row(s) (human-verified, deal unchanged since verification):`);
    for (const p of skipped) {
      console.log(`  #${p.id}  linkVerifiedAt=${p.linkVerifiedAt}  dealChanged<=${lastDealChangedAt(p)}  "${(p.n || '').slice(0, 48)}"`);
    }
  }
  const products = candidates.filter(p => !linkVerificationCurrent(p));
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
    // Sellers endpoint (not asin): returns per-offer condition + seller so we can
    // pick the NEW Buy Box price instead of price_from (lowest offer, any condition).
    const resp = await dfs('POST', '/merchant/amazon/sellers/task_post', payload);
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
          const resp = await dfs('GET', `/merchant/amazon/sellers/task_get/advanced/${taskId}`);
          const task = resp.tasks?.[0];
          if (!task) return;
          const isPending = task.status_code === 20100 || task.status_code === 40602 || !task.result;
          if (isPending) return;
          const t = pending.get(taskId);
          // Sellers result[0] = { asin, title, items:[offers], ... } — keep the whole
          // object so analyzeResult can read title AND select the New offer.
          const result0 = task.result?.[0];
          if (task.status_code === 20000 && result0) {
            results.set(taskId, { ...t, data: result0, status: task.status_code });
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
    const match = titleMatches(product.n, title, product.cap, product.b);
    // Never let a wrong-capacity listing become the chosen candidate.
    if (match.capConflict) continue;
    if (!best || match.score > best.score) {
      best = { asin, title, score: match.score, price: r.price?.current || r.price_from };
    }
  }
  return best;
}


function applyFixes(parts, perProductFixes) {
  let changed = 0;
  for (const p of parts) {
    const fix = perProductFixes[p.id];
    if (!fix) continue;
    let productChanged = false;
    if (fix.amazonPrice != null && p.deals?.amazon) {
      p.deals.amazon.price = fix.amazonPrice;
      // Provenance tag: '1p' (Amazon-sold) vs '3p' (marketplace Buy Box). A 3P price
      // has already cleared the harder cross-retailer gate; the tag is retained for
      // buyer disclosure + audit. Absence = legacy row written before tagging.
      if (fix.priceSource) {
        p.deals.amazon.priceSource = fix.priceSource;
        p.deals.amazon.priceSeller = fix.priceSeller ?? null;
      }
      productChanged = true;
    }
    // Provenance + staleness clock on a confirmed observation, whether or not the
    // price itself moved. Written outside the amazonPrice branch on purpose: a
    // stable price is still a confirmed price.
    if (fix.priceConfirmedAt && p.deals?.amazon) {
      if (p.deals.amazon.priceConfirmedAt !== fix.priceConfirmedAt) productChanged = true;
      p.deals.amazon.priceConfirmedAt = fix.priceConfirmedAt;
      if (fix.priceSource) {
        p.deals.amazon.priceSource = fix.priceSource;
        p.deals.amazon.priceSeller = fix.priceSeller ?? null;
      }
      if (fix.priceResolvedVia) p.deals.amazon.priceResolvedVia = fix.priceResolvedVia;
    }
    // Buy Box could not be confirmed New: the stored price is KEPT as-is and only
    // tagged, so an ambiguous listing never blanks a good row. Tag-only — this
    // branch deliberately writes no price and sets no needsReview.
    if (fix.priceConfidence && p.deals?.amazon) {
      if (p.deals.amazon.priceConfidence !== fix.priceConfidence) productChanged = true;
      p.deals.amazon.priceConfidence = fix.priceConfidence;
      if (fix.priceConfidence === 'unconfirmed') {
        p.deals.amazon.priceUnconfirmedReason = fix.priceUnconfirmedReason ?? null;
        p.deals.amazon.priceUnconfirmedAt = new Date().toISOString().slice(0, 10);
      } else {
        delete p.deals.amazon.priceUnconfirmedReason;
        delete p.deals.amazon.priceUnconfirmedAt;
      }
    }
    if (fix.amazonInStock != null && p.deals?.amazon) {
      p.deals.amazon.inStock = fix.amazonInStock; productChanged = true;
    }
    if (fix.newAsinUrl) {
      p.deals.amazon.url = fix.newAsinUrl;
      if (fix.newAsinPrice != null) p.deals.amazon.price = fix.newAsinPrice;
      // The link identity changed → invalidate any prior human link verification, so
      // a swapped ASIN goes back through the gate instead of riding a stale marker.
      stampDealChange(p, new Date().toISOString().slice(0, 10));
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

// Exit with a definite code even when a real fetch just left an idle keep-alive
// socket in undici's pool — otherwise process.exit() can race that handle and, on
// Windows, abort with a libuv assertion (wrong exit code). Closing the dispatcher
// first drains the pool so the code is exactly what we intend, on every platform.
async function hardExit(code) {
  try { const { getGlobalDispatcher } = await import('undici'); await getGlobalDispatcher().close(); } catch { /* best effort */ }
  process.exit(code);
}

// PA API CONFIG GATE — the same principle as the prerender hard gate: a
// verification that cannot reach its buy-box source must say so, not commit a
// green run. The two failure states are deliberately made to look NOTHING alike
// in the log (red ::error:: box + exit vs yellow ::warning:: box + continue) so
// "our wiring is broken" is never mistaken for "Amazon is gating us right now":
//
//   our_bug (not_configured / bad creds) -> FAIL THE JOB. Runs BEFORE postTasks,
//     so it fails for $0 without billing a single DataForSEO task.
//   gated (403 AssociateNotEligible)     -> WARN and continue on DataForSEO. This
//     is expected until the Associates account clears the sales threshold.
//
// `fatal` is false only in --dry-run, where nothing is verified or committed
// anyway: there it downgrades to an informational warning that names what a real
// run WOULD do. Returns the preflight result so the caller can log context.
async function runPaapiGate(probeAsins, { fatal, force }) {
  const pf = force
    ? { state: 'our_bug', reason: 'not_configured', detail: '--force-unconfigured (self-test)' }
    : await preflightPaapi(probeAsins);

  if (pf.state === 'ok') {
    console.log(`\n✓ PA API preflight OK — credentials valid, Amazon reachable (${pf.detail}).`);
    return pf;
  }

  if (pf.state === 'our_bug') {
    console.log(`::error title=PA API not configured::${pf.reason} — buy-box verification source unreachable (${pf.detail})`);
    console.error('\n\x1b[41m\x1b[97m' + '━'.repeat(72) + '\x1b[0m');
    console.error('\x1b[41m\x1b[97m  ✗✗✗  PA API NOT CONFIGURED — THIS IS OUR BUG  ✗✗✗' + ' '.repeat(19) + '\x1b[0m');
    console.error('\x1b[41m\x1b[97m' + '━'.repeat(72) + '\x1b[0m');
    console.error(`\x1b[91m  reason : ${pf.reason}`);
    console.error(`  detail : ${pf.detail}`);
    console.error('  AMAZON_CREATORS_CLIENT_ID / AMAZON_CREATORS_CLIENT_SECRET are not');
    console.error('  reaching this job. The buy-box confirmation pass has no source.');
    console.error(fatal
      ? '  FAILING THE JOB — an unverifiable run must not commit as a success.\x1b[0m'
      : '  (--dry-run: NOT failing, but a REAL run WOULD fail and exit 1 here.)\x1b[0m');
    console.error('\x1b[91m' + '━'.repeat(72) + '\x1b[0m');
    if (fatal) await hardExit(1);
    return pf;
  }

  if (pf.state === 'gated') {
    console.log(`::warning title=PA API gated by Amazon (AssociateNotEligible)::${pf.reason} — continuing on DataForSEO; buy-box confirmation (PASS 2) skipped this run`);
    console.warn('\n\x1b[43m\x1b[30m' + '─'.repeat(72) + '\x1b[0m');
    console.warn('\x1b[43m\x1b[30m  ⚠  PA API gated by Amazon: AssociateNotEligible (HTTP 403)' + ' '.repeat(13) + '\x1b[0m');
    console.warn('\x1b[43m\x1b[30m' + '─'.repeat(72) + '\x1b[0m');
    console.warn(`\x1b[33m  This is EXPECTED right now — the Associates account is below the`);
    console.warn('  qualifying-sales threshold, so Amazon has revoked PA API access.');
    console.warn('  Amazon\'s gate, NOT our bug. Continuing the run on DataForSEO alone;');
    console.warn('  buy-box confirmation (PASS 2) is skipped. Rechecks automatically next run.\x1b[0m');
    console.warn('\x1b[33m' + '─'.repeat(72) + '\x1b[0m');
    return pf;
  }

  // degraded — transient token/network/5xx. Not our bug, not a permanent gate.
  console.log(`::warning title=PA API unreachable (transient)::${pf.reason} — continuing on DataForSEO; buy-box confirmation skipped this run`);
  console.warn(`\n⚠ PA API unreachable this run (${pf.reason}: ${pf.detail}). Transient — continuing on DataForSEO, buy-box confirmation skipped.`);
  return pf;
}

(async () => {
  const parts = await loadCatalog();
  // Before anything consults the override table: count how many products each
  // key answers for, so a class key is refused rather than believed.
  armOverrideTable(parts);
  const products = selectProducts(parts, flags.tier);
  const ids = products.map(p => p.id);
  console.log(`━━━ Verifier v2 ━━━`);
  console.log(`  Tier: ${flags.tier}${ONLY_IDS ? ` (scoped to ${ONLY_IDS.size}-id allowlist)` : ''}`);
  console.log(`  Products: ${products.length}`);
  console.log(`  Est cost: $${(products.length * COST_PER_SELLERS_TASK).toFixed(2)} (sellers endpoint)${flags.fixAsins ? ' + ASIN searches' : ''}`);
  console.log(`  Bills: sellers-task only${flags.fixAsins ? ' + products-endpoint ASIN searches (!!)' : ' — NO products-endpoint ASIN searches'}`);
  console.log(`  First 5 ids: ${ids.slice(0, 5).join(', ')}`);
  console.log(`  Last 5 ids:  ${ids.slice(-5).join(', ')}`);
  console.log(`  Mode: ${flags.dryRun ? 'DRY RUN' : flags.autoFix ? 'AUTO-FIX' : 'REPORT-ONLY'}${flags.fixAsins ? ' + ASIN repair' : ''}`);

  // ── Spend guards (see verify-spend-guard.js) ────────────────────────────────
  // One decision replaces the old flat POST_HARD_CAP=200, which could not tell a
  // broken scope from a legit 2114-row full-tier nightly and blacked out the whole
  // paid pipeline for a week. Runs in EVERY mode, dry-run included, so a dry-run
  // proves the scope AND the projected spend before anyone bills a single task.
  const guard = evaluateSpendGuard(products.length, {
    scoped: !!ONLY_IDS,
    onlyIdsSize: ONLY_IDS ? ONLY_IDS.size : null,
    expectCount: flags.expectCount,
    tier: flags.tier,
    tierBaseline: tierCategoryCount(parts, flags.tier),   // CURRENT tier population
    fixAsins: flags.fixAsins,
    todayISO: new Date().toISOString().slice(0, 10),
  });
  guard.warnings.forEach(w => console.warn(`⚠ ${w}`));
  console.log(`  Projected worst-case spend: $${guard.projected.total.toFixed(2)} ` +
    `(sellers $${guard.projected.sellers.toFixed(2)}` +
    `${flags.fixAsins ? ` + ASIN-search worst case $${guard.projected.asinSearches.toFixed(2)}` : ''})` +
    ` vs ceiling $${guard.ceiling.toFixed(2)}`);
  if (guard.abort) {
    console.error(`\n${guard.reason}`);
    process.exit(1);
  }

  // ── PA API config gate (see runPaapiGate) ───────────────────────────────────
  // Runs BEFORE postTasks so a wiring bug fails for $0. Fatal in every real mode;
  // informational only in --dry-run (which verifies/commits nothing anyway). The
  // probe uses a real in-scope ASIN so an eligibility gate is actually observed.
  const probeAsins = products.map(p => extractASIN(p.deals?.amazon?.url)).filter(Boolean).slice(0, 1);
  // Fatal in every real mode AND in an explicit --paapi-preflight check; only a
  // --dry-run downgrades a config bug to an informational warning.
  await runPaapiGate(probeAsins, { fatal: !flags.dryRun || flags.paapiPreflight, force: flags.forceUnconfigured });
  if (flags.paapiPreflight) {
    console.log('\n--paapi-preflight: config gate only, no tasks posted, $0 spent. Exiting 0.');
    return;
  }

  if (flags.dryRun) { console.log(`\nDry run complete — ZERO tasks posted, $0 spent.`); return; }

  const tasks = await postTasks(products);
  const results = await fetchAllResults(tasks);
  console.log(`\nGot ${results.length} results`);

  const byProduct = new Map(parts.map(p => [p.id, p]));

  // ── PASS 1: DataForSEO only ─────────────────────────────────────────────
  const pass1 = [];
  for (const r of results) {
    const product = byProduct.get(r.productId);
    if (!product) continue;
    pass1.push({ r, product, out: analyzeResult(product, r.data) });
  }

  // ── PASS 2: PA API second opinion on the unconfirmed rows ───────────────
  // DataForSEO cannot see buy-box ownership; PA API can. Measured, it resolves
  // 93% of the `unlabeled_buybox` class to a clean New buy box. PA API is free,
  // batches 10 ASINs per call, and — critically — degrades to an empty result
  // rather than throwing, so a revoked credential silently costs us nothing but
  // the resolution itself. See amazon-paapi.js for the circuit breaker.
  const unconfirmed = pass1.filter(x => x.out.fixes?.priceConfidence === 'unconfirmed');
  if (unconfirmed.length) {
    const asins = unconfirmed.map(x => extractASIN(x.product.deals?.amazon?.url)).filter(Boolean);
    console.log(`\nPA API second opinion on ${unconfirmed.length} unconfirmed rows (${Math.ceil(asins.length / PAAPI_BATCH)} free calls)...`);
    onPaapiAlert(a => console.log(`  !! PA API DEGRADED (${a.reason}): ${a.detail}\n     Falling back to keep-price for all remaining rows — run continues.`));
    const items = await resolveItems(asins);
    let upgraded = 0;
    for (const x of unconfirmed) {
      const asin = extractASIN(x.product.deals?.amazon?.url);
      const item = asin ? items.get(asin) : null;
      if (!item) continue;
      const redo = analyzeResult(x.product, x.r.data, item);
      if (redo.fixes?.priceConfidence === 'confirmed') { x.out = redo; upgraded++; }
    }
    const st = paapiStatus();
    console.log(`  resolved ${upgraded}/${unconfirmed.length} via PA API` +
                `${st.available ? '' : ` (PA API disabled: ${st.disabledReason})`}` +
                `  [calls=${st.stats.calls} throttled=${st.stats.throttled} errors=${st.stats.batchErrors}]`);
    PAAPI_RUN_SUMMARY = { attempted: unconfirmed.length, upgraded, ...st };
  }

  const allIssues = [];
  const perProductFixes = {};
  for (const { r, product, out } of pass1) {
    allIssues.push({ productId: r.productId, asin: r.asin, name: product.n, category: product.c, issues: out.issues });
    if (Object.keys(out.fixes).length) perProductFixes[r.productId] = out.fixes;
  }

  // Drift-gate staleness: if a whole category drift-quarantines an implausible
  // share, the GATE is stale (the market moved), not the data. Warn, never drop.
  const perCat = {};
  for (const e of allIssues) {
    if (!e.issues.some(i => DRIFT_GRADED_TYPES.has(i.type))) continue;
    const c = (perCat[e.category] ||= { graded: 0, flagged: 0 });
    c.graded++;
    if (e.issues.some(i => DRIFT_FLAGGED_TYPES.has(i.type))) c.flagged++;
  }
  const { warnings: driftWarnings } = driftGateStaleness(perCat, new Date().toISOString().slice(0, 10));
  if (driftWarnings.length) {
    console.log(`\n⚠ DRIFT GATE STALENESS (${driftWarnings.length}):`);
    driftWarnings.forEach(w => console.log(`  ${w}`));
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
          // Capacity must agree, and the candidate's price must be physically
          // possible for the capacity — never attach a wrong-size/impossible ASIN.
          const storedCap = product.cap ?? parseCapacityGB(product.n);
          const capOk = capacityCompatible(storedCap, parseCapacityGB(searchResult.title || ''));
          const priceOk = !STORAGE_CATS.has(product.c) ||
            isPricePlausibleForCapacity(searchResult.price, storedCap, { isHDD: isHardDrive(product) });
          if (strictMatch && capOk && priceOk && searchResult.score >= 0.5) {
            best = searchResult;
            viaSearch++;
            console.log(`  ${i+1}/${mismatches.length}: "${product.n.slice(0, 50)}" -> search hit ${best.asin} (score ${best.score})`);
          } else {
            const why = !capOk ? 'capacity' : !priceOk ? '$/TB' : !strictMatch ? 'model' : 'score';
            console.log(`  ${i+1}/${mismatches.length}: "${product.n.slice(0, 50)}" -> quarantine (reject=${why}, score ${searchResult.score})`);
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

      // CONDITION GATE: a search hit whose TITLE advertises renewed/refurbished/used
      // is a different-condition SKU, not a New match — never swap the live link onto
      // it, even if best.price passes the sanity band. Quarantine for human relink.
      // (Mirrors newegg-match.js conditionMismatch; shared markers in condition.cjs.)
      if (isRenewedTitle(best.title)) {
        viaQuarantine++;
        asinRepairs.push({ productId: entry.productId, category: entry.category, name: product.n,
          oldAsin: entry.asin, newAsin: best.asin, score: best.score, title: best.title,
          applied: false, quarantined: true, rejected: 'renewed-title' });
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
        // best.price is from products-search — condition UNKNOWN (could be used/3P).
        // Only carry it over if it passes the sanity gate; otherwise update the URL
        // and let the next sellers verification pass set the confirmed New price.
        if (best.price && amazonPriceSanity(product, best.price).pass) {
          perProductFixes[entry.productId].newAsinPrice = best.price;
        } else {
          perProductFixes[entry.productId].needsReview = true;
          perProductFixes[entry.productId].quarantinedAt = new Date().toISOString().slice(0, 10);
        }
      }
    }
    if (mismatches.length) {
      console.log(`\nStrategy 2 summary: ${viaTable} via known-good table, ${viaSearch} via search, ${viaQuarantine} quarantined`);
      const os = OVERRIDE_INDEX.stats;
      console.log(`  override table: ${os.hits} answered | refused ${os.refusedAmbiguous} (key answers for >1 product), ` +
        `${os.refusedBinding} (verified for another product), ${os.refusedUnbound} (names no product)`);
      OVERRIDE_INDEX.refusals.slice(0, 10).forEach((r) => console.log(`    refused ${r.id}: ${r.why}`));
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
