// C1-Newegg: migrate marketplace (9SI) listings to Newegg-Official (N82E) where
// one exists. The first-party SELECTION is peer-independent (the official listing
// is inherently the trustworthy source), so NO dispersion gate here — per the
// approved adjusted sequence. Then label sellerClass on every Newegg deal.
//   railway run node migrate-newegg-firstparty.mjs            # dry run
//   railway run node migrate-newegg-firstparty.mjs --apply
import { writeFileSync } from 'node:fs';
import * as NEG from './newegg-match.js';

const APPLY = process.argv.includes('--apply');
const CID = process.env.RAKUTEN_CLIENT_ID, SECRET = process.env.RAKUTEN_CLIENT_SECRET;
const SID = process.env.RAKUTEN_SID, MID = process.env.RAKUTEN_NEWEGG_MID || '44583';
if (!CID || !SECRET || !SID) { console.error('Missing Rakuten creds'); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PARTS_PATH = process.cwd().replace(/\\/g, '/') + '/src/data/parts.js';

let tok = { t: null, exp: 0 };
async function getToken() {
  if (tok.t && Date.now() < tok.exp - 60000) return tok.t;
  const auth = 'Basic ' + Buffer.from(`${CID}:${SECRET}`).toString('base64');
  const r = await fetch('https://api.linksynergy.com/token', { method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'password', scope: SID }).toString() });
  if (!r.ok) throw new Error('token ' + r.status);
  const d = await r.json();
  tok = { t: d.access_token, exp: Date.now() + (d.expires_in || 3600) * 1000 };
  return tok.t;
}

const mod = await import(`file://${PARTS_PATH}?t=${Date.now()}`);
const parts = mod.PARTS;
const marketplace = parts.filter(p => NEG.isMarketplace(p.deals?.newegg?.sku));
console.log(`Marketplace (9SI) products: ${marketplace.length}`);

const token = await getToken();
let migrated = 0, keptNoFP = 0, noResult = 0, errs = 0;
const changes = [];
for (let i = 0; i < marketplace.length; i++) {
  const p = marketplace[i];
  let r;
  try { r = await NEG.searchNewegg(p, { token, mid: MID }); }
  catch (e) { errs++; await sleep(300); continue; }
  if (r.ok) {
    const best = NEG.selectWithFirstPartyPreference(r.candidates);
    if (best && NEG.isFirstParty(best.item.sku)) {
      const it = best.item;
      const from = p.deals.newegg.sku, fromPrice = p.deals.newegg.saleprice ?? p.deals.newegg.price;
      p.deals.newegg = {
        sku: it.sku, price: it.price,
        ...(it.saleprice ? { saleprice: it.saleprice } : {}),
        linkurl: it.linkurl, imageurl: it.imageurl,
        sellerClass: 'official',
        matchedAt: p.deals.newegg.matchedAt || new Date().toISOString().slice(0, 10),
        matchMethod: best.match.method, matchScore: Number(best.match.score.toFixed(2)),
        migratedAt: new Date().toISOString().slice(0, 10), migratedFrom: from,
      };
      migrated++;
      changes.push({ id: p.id, name: p.n, from, to: it.sku, fromPrice, toPrice: it.saleprice ?? it.price });
    } else keptNoFP++;
  } else noResult++;
  if ((i + 1) % 50 === 0) console.log(`  ${i + 1}/${marketplace.length} (migrated=${migrated} keptNoFP=${keptNoFP} noResult=${noResult})`);
  await sleep(300);
}

// Label sellerClass on EVERY newegg deal by item-number prefix (covers kept-marketplace).
let labeled = 0;
for (const p of parts) {
  const d = p.deals?.newegg; if (!d) continue;
  const cls = NEG.sellerClass(d.sku);
  if (d.sellerClass !== cls) { d.sellerClass = cls; labeled++; }
}

console.log(`\n=== C1-NEWEGG ===`);
console.log(`Migrated 9SI→N82E:   ${migrated}`);
console.log(`Kept (no N82E found): ${keptNoFP}`);
console.log(`No search result:     ${noResult}`);
console.log(`Errors:               ${errs}`);
console.log(`sellerClass labeled:  ${labeled}`);
writeFileSync(process.cwd().replace(/\\/g, '/') + `/verify-reports/c1-newegg-migration-${new Date().toISOString().replace(/[:.]/g,'-').slice(0,19)}.json`,
  JSON.stringify({ migrated, keptNoFP, noResult, errs, labeled, changes }, null, 2));

if (APPLY) {
  writeFileSync(PARTS_PATH, '// Auto-merged catalog. Edit with care.\n' + 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n');
  console.log('APPLIED to parts.js.');
} else console.log('DRY RUN — re-run with --apply.');
