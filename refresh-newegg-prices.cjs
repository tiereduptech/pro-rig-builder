#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const PARTS_PATH = path.join(__dirname, 'src', 'data', 'parts.js');
const CLIENT_ID = process.env.RAKUTEN_CLIENT_ID;
const CLIENT_SECRET = process.env.RAKUTEN_CLIENT_SECRET;
const SID = process.env.RAKUTEN_SID;
const NEWEGG_MID = process.env.RAKUTEN_NEWEGG_MID || '44583';

if (!CLIENT_ID || !CLIENT_SECRET || !SID) {
  console.error('Missing required env vars');
  process.exit(1);
}

const RATE_DELAY_MS = 600;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Newegg matcher (shared ESM) — assigned at startup, used by searchBySku + migration.
let NEG = null;

let tokenCache = { token: null, expiresAt: 0 };
async function getToken() {
  if (tokenCache.token && Date.now() < tokenCache.expiresAt - 60000) return tokenCache.token;
  const auth = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.linksynergy.com/token', {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=password&scope=${SID}`
  });
  if (!res.ok) throw new Error(`Token: ${res.status} ${await res.text()}`);
  const data = await res.json();
  tokenCache = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return tokenCache.token;
}

async function searchBySku(sku) {
  const token = await getToken();
  const url = `https://api.linksynergy.com/productsearch/1.0?keyword=${encodeURIComponent(sku)}&mid=${NEWEGG_MID}&max=5`;
  // productsearch/1.0 returns XML (Accept:json is NOT honored). The previous code
  // called res.json() on "<result>…" and threw on every product, silently breaking
  // the daily refresh. Parse the XML with the shared parser instead.
  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${token}` } });
  if (!res.ok) {
    if (res.status === 429) { await sleep(60000); return searchBySku(sku); }
    throw new Error(`Search: ${res.status}`);
  }
  const xml = await res.text();
  return NEG.parseItems(xml); // [{ name, sku, upc, price, saleprice, linkurl, imageurl, ... }]
}

function pickPrice(item) {
  const sale = Number(item.saleprice || item.salePrice || 0);
  const price = Number(item.price || item.Price || 0);
  return { price: price > 0 ? price : sale, saleprice: sale > 0 && sale < price ? sale : null };
}

(async () => {
  console.log('Loading parts.js...');
  NEG = await import(`file://${path.join(__dirname, 'newegg-match.js').replace(/\\/g, '/')}`);
  const partsModule = await import(`file://${PARTS_PATH.replace(/\\/g, '/')}?t=${Date.now()}`);
  const parts = partsModule.PARTS;
  const matched = parts.filter(p => p?.deals?.newegg?.sku);
  console.log(`Found ${matched.length} products with Newegg matches`);

  let updated = 0, unchanged = 0, removed = 0, errored = 0, migrated = 0, flagged = 0;
  const changes = [];

  for (let i = 0; i < matched.length; i++) {
    const p = matched[i];
    const sku = p.deals.newegg.sku;
    if (i % 50 === 0) console.log(`Progress: ${i}/${matched.length} (updated=${updated} removed=${removed} errored=${errored})`);

    try {
      // B2: if pinned to a marketplace (9SI) listing, try to MIGRATE to a first-party
      // (N82E) listing via a name search instead of just re-pricing the reseller.
      if (NEG.isMarketplace(sku)) {
        const token = await getToken();
        const search = await NEG.searchNewegg(p, { token, mid: NEWEGG_MID });
        if (search.ok) {
          const best = NEG.selectWithFirstPartyPreference(search.candidates);
          if (best && NEG.isFirstParty(best.item.sku)) {
            const eff = (best.item.saleprice && best.item.saleprice > 0) ? best.item.saleprice : best.item.price;
            if (eff > 0 && NEG.neweggSanity(p, eff).pass) {
              p.deals.newegg = {
                sku: best.item.sku,
                price: best.item.price,
                ...(best.item.saleprice ? { saleprice: best.item.saleprice } : {}),
                linkurl: best.item.linkurl || p.deals.newegg.linkurl,
                imageurl: best.item.imageurl || p.deals.newegg.imageurl,
                sellerClass: 'official',
                matchedAt: p.deals.newegg.matchedAt || new Date().toISOString().slice(0, 10),
                matchMethod: best.match.method,
                matchScore: Number(best.match.score.toFixed(2)),
                migratedAt: new Date().toISOString(),
                migratedFrom: sku,
              };
              changes.push({ name: p.n, change: 'migrated-to-firstparty', from: sku, to: best.item.sku });
              migrated++; updated++;
              await sleep(RATE_DELAY_MS);
              continue;
            }
          }
        }
        // No first-party alternative (or it failed the gate) — fall through and
        // re-price the existing marketplace listing as before.
      }

      const items = await searchBySku(sku);
      const match = items.find(it => String(it.sku || it.SKU || '').trim() === String(sku).trim());
      
      if (!match) {
        if (!p.deals.newegg.staleSince) {
          p.deals.newegg.staleSince = new Date().toISOString();
          changes.push({ name: p.n, change: 'marked-stale', sku });
          updated++;
        }
        const staleDays = (Date.now() - new Date(p.deals.newegg.staleSince).getTime()) / 86400000;
        if (staleDays > 7) {
          delete p.deals.newegg;
          changes.push({ name: p.n, change: 'removed-stale-7d', sku });
          removed++;
        }
      } else {
        const { price, saleprice } = pickPrice(match);
        const newLink = match.linkurl || match.linkURL || p.deals.newegg.linkurl;
        const oldPrice = Number(p.deals.newegg.price);
        const oldSale = Number(p.deals.newegg.saleprice || 0);
        
        const changedPrice = price > 0 && (price !== oldPrice || saleprice !== oldSale || newLink !== p.deals.newegg.linkurl);
        // Gate the new price: don't write a wild outlier vs other retailers — flag instead.
        const effNew = saleprice && saleprice > 0 ? saleprice : price;
        const sane = NEG.neweggSanity(p, effNew).pass;
        if (changedPrice && !sane) {
          p.needsReview = true;
          p.quarantinedAt = new Date().toISOString().slice(0, 10);
          changes.push({ name: p.n, change: 'price-flagged', from: oldPrice, to: price, sku });
          flagged++;
        } else if (changedPrice) {
          p.deals.newegg.price = price;
          if (saleprice) p.deals.newegg.saleprice = saleprice;
          else delete p.deals.newegg.saleprice;
          p.deals.newegg.linkurl = newLink;
          p.deals.newegg.refreshedAt = new Date().toISOString();
          delete p.deals.newegg.staleSince;
          changes.push({ name: p.n, change: 'price-update', from: oldPrice, to: price, sku });
          updated++;
        } else {
          p.deals.newegg.refreshedAt = new Date().toISOString();
          delete p.deals.newegg.staleSince;
          unchanged++;
        }
      }
    } catch (e) {
      console.error(`Error refreshing ${p.n} (sku=${sku}):`, e.message);
      errored++;
    }
    await sleep(RATE_DELAY_MS);
  }

  console.log(`\n=== SUMMARY ===`);
  console.log(`Updated: ${updated} (incl. ${migrated} migrated to first-party) | Unchanged: ${unchanged} | Removed: ${removed} | Flagged: ${flagged} | Errored: ${errored}`);

  if (updated === 0 && removed === 0 && flagged === 0) {
    console.log('No changes to write.');
    return;
  }

  const header = '// Auto-merged catalog. Edit with care.\n';
  const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
  fs.writeFileSync(PARTS_PATH, header + body, 'utf8');
  console.log(`Wrote ${parts.length} products to parts.js`);

  fs.writeFileSync('newegg-refresh-summary.json', JSON.stringify({
    timestamp: new Date().toISOString(),
    updated, unchanged, removed, errored, migrated, flagged,
    sampleChanges: changes.slice(0, 20)
  }, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
