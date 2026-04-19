/**
 * impact-test.js — v3 pagination diagnostic
 *
 * Filters don't work on our Creator tier. Now we need to know:
 *   1. What pagination mechanism does Impact use? (Page=N, Offset=N, cursor-based?)
 *   2. What's the max PageSize? (100, 500, 1000, higher?)
 *   3. What fields does the full response envelope contain?
 *
 * Once we know, we can write an efficient bulk downloader.
 */

const SID = process.env.IMPACT_ACCOUNT_SID;
const TOKEN = process.env.IMPACT_AUTH_TOKEN;
if (!SID || !TOKEN) {
  console.error('✗ Missing IMPACT env vars. Run: railway run node impact-test.js');
  process.exit(1);
}
const AUTH = 'Basic ' + Buffer.from(`${SID}:${TOKEN}`).toString('base64');
const BASE = `https://api.impact.com/Mediapartners/${SID}`;

async function impactGet(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const start = Date.now();
  const res = await fetch(url.toString(), {
    headers: { Authorization: AUTH, Accept: 'application/json' },
  });
  const elapsed = Date.now() - start;
  const text = await res.text();
  return { ok: res.ok, status: res.status, url: url.toString(), body: text, elapsed };
}

async function main() {
  console.log('── Impact Pagination Diagnostic ──\n');

  // Test 1: Pull page 1 with PageSize=5 and dump FULL envelope structure
  console.log('1. Dumping full response envelope structure (PageSize=5)...');
  const r1 = await impactGet('/Catalogs/28060/Items', { PageSize: 5 });
  if (!r1.ok) {
    console.error(`   ✗ HTTP ${r1.status}: ${r1.body.slice(0, 300)}`);
    process.exit(1);
  }
  const envelope = JSON.parse(r1.body);
  const topLevelKeys = Object.keys(envelope);
  console.log(`   ✓ Top-level keys in response: ${topLevelKeys.join(', ')}`);
  for (const k of topLevelKeys) {
    if (k === 'Items') {
      console.log(`     ${k}: Array[${envelope[k].length}]`);
    } else {
      const v = envelope[k];
      const display = typeof v === 'string' ? `"${v.slice(0, 80)}"` : JSON.stringify(v).slice(0, 100);
      console.log(`     ${k}: ${display}`);
    }
  }

  // Test 2: Try various PageSize values to find the cap
  console.log('\n2. Finding max PageSize (times the response)...');
  for (const size of [100, 500, 1000, 5000]) {
    const r = await impactGet('/Catalogs/28060/Items', { PageSize: size });
    if (!r.ok) {
      console.log(`   PageSize=${size}: ✗ HTTP ${r.status}`);
      continue;
    }
    const d = JSON.parse(r.body);
    console.log(`   PageSize=${size}: ${d.Items?.length || 0} items returned, ${r.elapsed}ms`);
  }

  // Test 3: Try pagination methods
  console.log('\n3. Testing pagination mechanisms (PageSize=5 across calls)...');

  // Standard: Page=N
  const p1 = await impactGet('/Catalogs/28060/Items', { PageSize: 5, Page: 1 });
  const p2 = await impactGet('/Catalogs/28060/Items', { PageSize: 5, Page: 2 });
  const d1 = JSON.parse(p1.body);
  const d2 = JSON.parse(p2.body);
  const firstId1 = d1.Items?.[0]?.CatalogItemId || d1.Items?.[0]?.Id || 'unknown';
  const firstId2 = d2.Items?.[0]?.CatalogItemId || d2.Items?.[0]?.Id || 'unknown';
  console.log(`   Page=1 first item id: ${firstId1}`);
  console.log(`   Page=2 first item id: ${firstId2}`);
  console.log(`   Page=N pagination ${firstId1 !== firstId2 ? '✓ WORKS' : '✗ returns same data'}`);

  // Alternative: Offset=N
  const o0 = await impactGet('/Catalogs/28060/Items', { PageSize: 5, Offset: 0 });
  const o5 = await impactGet('/Catalogs/28060/Items', { PageSize: 5, Offset: 5 });
  const od0 = JSON.parse(o0.body);
  const od5 = JSON.parse(o5.body);
  const firstIdO0 = od0.Items?.[0]?.CatalogItemId || od0.Items?.[0]?.Id || 'unknown';
  const firstIdO5 = od5.Items?.[0]?.CatalogItemId || od5.Items?.[0]?.Id || 'unknown';
  console.log(`   Offset=0 first item id: ${firstIdO0}`);
  console.log(`   Offset=5 first item id: ${firstIdO5}`);
  console.log(`   Offset=N pagination ${firstIdO0 !== firstIdO5 ? '✓ WORKS' : '✗ returns same data'}`);

  // Test 4: Show what an Items[0] looks like in full (to see ALL available fields)
  console.log('\n4. Full field list on a sample item (first 30 fields):');
  const sample = d1.Items?.[0];
  if (sample) {
    const fieldNames = Object.keys(sample);
    console.log(`   Total fields on item: ${fieldNames.length}`);
    for (const k of fieldNames.slice(0, 30)) {
      const v = sample[k];
      const display = v === null ? 'null'
                    : typeof v === 'string' ? `"${v.slice(0, 60)}"`
                    : JSON.stringify(v).slice(0, 60);
      console.log(`     ${k.padEnd(30)} ${display}`);
    }
    if (fieldNames.length > 30) console.log(`     ...and ${fieldNames.length - 30} more`);
  }

  console.log('\nDone. Based on max PageSize + pagination method, I can write the bulk downloader.');
}

main().catch(e => { console.error('\n✗ FATAL:', e); process.exit(1); });
