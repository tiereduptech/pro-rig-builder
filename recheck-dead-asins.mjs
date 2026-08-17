// recheck-dead-asins.mjs
//
// Two-strike confirmation for dead Amazon ASINs.
//
// The full audit (amazon-asin-identity-audit.json) is STRIKE 1. This script is
// STRIKE 2: it re-queries only the ASINs that returned nothing, and quarantines
// a row ONLY when the ASIN comes back empty a second time. A single API blip
// must never quarantine a live row.
//
// Quarantine here is safe without human review because a dead ASIN is not a
// judgement call — Amazon returned no item, so the affiliate link is broken
// regardless of what the correct ASIN would have been. Nothing is ever
// relinked; needsReview + quarantinedAt only.
//
//   node recheck-dead-asins.mjs            # report only (default)
//   node recheck-dead-asins.mjs --apply    # write quarantine flags to parts.js

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const CREDS_PATH  = process.env.PRORIG_AMAZON_CREDS || 'C:\\rigfinder\\PRB-credentials.csv';
const PARTNER_TAG = 'tiereduptech-20';
const MARKETPLACE = 'www.amazon.com';
const TOKEN_URL   = 'https://api.amazon.com/auth/o2/token';
const SCOPE       = 'creatorsapi::default';
const GETITEMS    = 'https://creatorsapi.amazon/catalog/v1/getItems';
const REPORT_IN   = 'amazon-asin-identity-audit.json';
const REPORT_OUT  = 'dead-asin-recheck.json';

const APPLY = process.argv.includes('--apply');
const BATCH = 10;
const PAUSE_MS = 950;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const today = () => new Date().toISOString().slice(0, 10);

// ---- creds --------------------------------------------------------------
function parseCsv(text) {
  const rows = []; let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i+1] === '"') { field += '"'; i++; } else q = false; } else field += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\r') {}
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.some(v => v.trim() !== ''));
}
// ENV FIRST, CSV SECOND — the same order, and for the same reason, as
// amazon-paapi.js loadCreds(). This script is strike 2 of a two-strike
// quarantine whose strike 1 (amazon-asin-identity-audit.mjs) runs daily in CI
// via asin-identity-audit.yml. Reading credentials only from a CSV at a Windows
// path made strike 2 structurally unrunnable there: strike 1 kept producing
// dead-ASIN candidates that nothing could ever confirm, so broken affiliate
// links stayed live indefinitely. The env branch is what makes the second
// strike schedulable; the CSV branch is retained for local runs.
function loadCreds(p) {
  const id = process.env.AMAZON_CREATORS_CLIENT_ID;
  const secret = process.env.AMAZON_CREATORS_CLIENT_SECRET;
  if (id && secret) return { id, secret, source: 'env' };
  // Absent/!readable CSV returns null rather than throwing an ENOENT stack, so
  // the caller can name both places it looked.
  if (!p || !existsSync(p)) return null;
  try {
    const rows = parseCsv(readFileSync(p, 'utf8'));
    if (rows.length < 2) return null;
    const h = rows[0].map(x => x.trim().toLowerCase()), d = rows[1];
    const g = n => { const i = h.indexOf(n); return i === -1 ? '' : (d[i] || '').trim(); };
    const cid = g('credential id'), csec = g('secret');
    return cid && csec ? { id: cid, secret: csec, source: p } : null;
  } catch { return null; }
}
async function getToken(id, secret) {
  const res = await fetch(TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret, scope: SCOPE }).toString(),
  });
  const j = await res.json();
  if (!j.access_token) throw new Error('token failed: ' + JSON.stringify(j).slice(0, 300));
  return j.access_token;
}

let TOKEN = null, throttles = 0, hardErrors = 0;
async function call(body, tries = 4) {
  for (let a = 0; a < tries; a++) {
    let res, text;
    try {
      res = await fetch(GETITEMS, {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json',
                   Accept: 'application/json', 'x-marketplace': MARKETPLACE },
        body: JSON.stringify(body),
      });
      text = await res.text();
    } catch { await sleep(2000); continue; }
    if (res.status === 429) { throttles++; await sleep(2500 * (a + 1)); continue; }
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: res.status, ok: res.ok, json, raw: text };
  }
  hardErrors++;
  return { status: 0, ok: false, json: null, raw: 'exhausted retries' };
}
const itemsOf = j => j?.itemsResult?.items || j?.items || [];

async function loadCatalog() {
  const mod = await import(`file://${process.cwd().replace(/\\/g, '/')}/src/data/parts.js?t=${Date.now()}`);
  return [...mod.PARTS];
}
function saveCatalog(parts) {
  writeFileSync('./src/data/parts.js',
    `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`);
}

(async () => {
  console.log(`Dead-ASIN re-check (strike 2) — ${APPLY ? 'APPLY MODE' : 'REPORT ONLY'}\n`);

  const prior = JSON.parse(readFileSync(REPORT_IN, 'utf8'));
  const deadFindings = prior.findings.filter(f => f.class === 'dead-asin');
  const deadAsins = [...new Set(deadFindings.map(f => f.asin))];

  console.log(`strike-1 dead rows ......... ${deadFindings.length}`);
  console.log(`  already quarantined ...... ${deadFindings.filter(f => f.needsReview).length}`);
  console.log(`  live (not quarantined) ... ${deadFindings.filter(f => !f.needsReview).length}`);
  console.log(`unique ASINs to re-check ... ${deadAsins.length}  (${Math.ceil(deadAsins.length / BATCH)} calls)\n`);

  // HARD STOP, never a degraded run. confirmedDead below is computed as
  // "every dead ASIN the API did NOT hand back", so a credential failure that
  // let us reach the batch loop would return zero recoveries and read as
  // "all of them are confirmed dead" — mass quarantine from an auth error.
  // The only safe response to absent credentials is to exit before any of it.
  const creds = loadCreds(CREDS_PATH);
  if (!creds) {
    console.error('✗ No Amazon Creators credentials.');
    console.error('  Looked for: AMAZON_CREATORS_CLIENT_ID + AMAZON_CREATORS_CLIENT_SECRET (env)');
    console.error(`              then a credentials CSV at ${CREDS_PATH}`);
    console.error('  Set PRORIG_AMAZON_CREDS to point elsewhere, or export the two env vars.');
    process.exit(2);
  }
  console.log(`credentials ............... ${creds.source === 'env' ? 'env' : 'CSV ' + creds.source}\n`);
  TOKEN = await getToken(creds.id, creds.secret);

  // ---- strike 2 ---------------------------------------------------------
  const recovered = new Map();   // asin -> title
  const nBatches = Math.ceil(deadAsins.length / BATCH);
  for (let b = 0; b < nBatches; b++) {
    const chunk = deadAsins.slice(b * BATCH, (b + 1) * BATCH);
    const r = await call({
      marketplace: MARKETPLACE, partnerTag: PARTNER_TAG, partnerType: 'Associates',
      itemIds: chunk, itemIdType: 'ASIN',
      resources: ['itemInfo.title', 'offersV2.listings.price'],
    });
    for (const it of itemsOf(r.json)) recovered.set(it.asin, it?.itemInfo?.title?.displayValue || '(no title)');
    await sleep(PAUSE_MS);
  }

  const confirmedDead = deadAsins.filter(a => !recovered.has(a));

  console.log('RE-CHECK RESULT');
  console.log('-'.repeat(66));
  console.log(`  ASINs re-checked ......... ${deadAsins.length}`);
  console.log(`  CONFIRMED DEAD (2 of 2) .. ${confirmedDead.length}`);
  console.log(`  RECOVERED on retry ....... ${recovered.size}`);
  console.log(`  api throttles retried .... ${throttles}`);
  console.log(`  hard call failures ....... ${hardErrors}`);

  if (hardErrors > 0) {
    console.log('\n  ! Hard call failures occurred. Refusing to apply — a failed call is');
    console.log('    indistinguishable from a dead ASIN and would quarantine live rows.');
    process.exit(1);
  }

  if (recovered.size) {
    console.log('\nRECOVERED (strike-1 was a blip — NOT quarantined):');
    for (const [asin, title] of recovered) {
      const rows = deadFindings.filter(f => f.asin === asin);
      console.log(`  ${asin} -> ${title.slice(0, 70)}`);
      for (const f of rows) console.log(`      id=${f.id} (${f.cat}) ${String(f.storedName).slice(0, 60)}`);
    }
  }

  const deadSet = new Set(confirmedDead);
  const toQuarantine = deadFindings.filter(f => deadSet.has(f.asin) && !f.needsReview);
  const alreadyQ     = deadFindings.filter(f => deadSet.has(f.asin) && f.needsReview);
  const spared       = deadFindings.filter(f => !deadSet.has(f.asin));

  console.log('\nROW IMPACT');
  console.log('-'.repeat(66));
  console.log(`  rows on confirmed-dead ASINs ....... ${toQuarantine.length + alreadyQ.length}`);
  console.log(`    already quarantined ............. ${alreadyQ.length}`);
  console.log(`    TO QUARANTINE ................... ${toQuarantine.length}`);
  console.log(`  rows spared by recovery ........... ${spared.length}`);

  const byCat = {};
  for (const f of toQuarantine) byCat[f.cat] = (byCat[f.cat] || 0) + 1;
  console.log('\n  to-quarantine by category:');
  for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${c.padEnd(18)} ${n}`);
  }

  const out = {
    meta: {
      generatedAt: new Date().toISOString(),
      rule: 'two consecutive nothing-returned results = broken link',
      strike1Report: REPORT_IN, applied: APPLY,
      throttles, hardErrors,
    },
    totals: {
      strike1DeadRows: deadFindings.length,
      uniqueAsinsRechecked: deadAsins.length,
      confirmedDeadAsins: confirmedDead.length,
      recoveredAsins: recovered.size,
      rowsQuarantined: APPLY ? toQuarantine.length : 0,
      rowsPendingQuarantine: APPLY ? 0 : toQuarantine.length,
      rowsSparedByRecovery: spared.length,
    },
    recovered: [...recovered].map(([asin, title]) => ({
      asin, amazonTitle: title,
      rows: deadFindings.filter(f => f.asin === asin).map(f => ({ id: f.id, cat: f.cat, storedName: f.storedName })),
    })),
    quarantined: toQuarantine.map(f => ({
      id: f.id, cat: f.cat, asin: f.asin, storedName: f.storedName, storedPrice: f.storedPrice,
    })),
  };
  writeFileSync(REPORT_OUT, JSON.stringify(out, null, 2));
  console.log(`\nreport written to ${REPORT_OUT}`);

  // ---- apply ------------------------------------------------------------
  if (!APPLY) {
    console.log('\nREPORT ONLY — no catalog changes. Re-run with --apply to quarantine.');
    return;
  }

  const ids = new Set(toQuarantine.map(f => f.id));
  const parts = await loadCatalog();
  const stamp = today();
  let changed = 0;
  for (const p of parts) {
    if (!ids.has(p.id)) continue;
    p.needsReview = true;
    p.quarantinedAt = stamp;
    changed++;
  }
  if (changed !== ids.size) {
    console.log(`\n! id mismatch: expected ${ids.size} rows, matched ${changed}. Aborting write.`);
    process.exit(1);
  }
  saveCatalog(parts);
  console.log(`\nAPPLIED — ${changed} rows quarantined (needsReview=true, quarantinedAt=${stamp}).`);
  console.log('No relinks. No prices changed. Run scripts/split-parts-by-cat.cjs next.');
})();
