// Corrective sweep: remove retailer deals confirmed wrong-capacity or impossibly
// cheap for the product (pre-guard bad attachments). Remove-only, never replace.
// Writes flat parts.js; caller then re-runs the split generator.
import { writeFileSync } from 'node:fs';
import { parseCapacityGB, capacityCompatible, isHardDrive, isPricePlausibleForCapacity } from './normalize-product-name.js';

const STORAGE_CATS = new Set(['Storage', 'ExternalStorage']);
const mod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
const parts = mod.PARTS;

function dealUrlCap(deal) {
  const raw = [deal.url, deal.linkurl, deal.buy_url].filter(Boolean).join(' ');
  if (!raw) return null;
  let d = raw; try { d = decodeURIComponent(raw); } catch {}
  d = d.replace(/[-_/]/g, ' ');
  const c = parseCapacityGB(d);
  return c != null && c >= 100 ? c : null;
}
function asinOf(url) { const m = (url || '').match(/dp\/([A-Z0-9]{10})/); return m ? m[1] : null; }

const removed = [];
for (const p of parts) {
  if (!STORAGE_CATS.has(p.c) || !p.deals) continue;
  const cap = p.cap != null ? p.cap : parseCapacityGB(p.n);
  for (const [retailer, deal] of Object.entries(p.deals)) {
    if (!deal || typeof deal !== 'object') continue;
    const price = deal.saleprice ?? deal.price ?? null;
    const cheap = price != null && cap && !isPricePlausibleForCapacity(price, cap, { isHDD: isHardDrive(p) });
    const urlCap = dealUrlCap(deal);
    const wrongCap = cap != null && urlCap != null && !capacityCompatible(cap, urlCap);
    if (cheap || wrongCap) {
      const reason = cheap ? `impossibly-cheap $${price}/${cap}GB` : `link ${urlCap}GB != product ${cap}GB`;
      // If we're removing the amazon deal and the top-level asin is that same wrong ASIN, clear it too.
      let clearedAsin = null;
      if (retailer === 'amazon' && p.asin && p.asin === asinOf(deal.url)) { clearedAsin = p.asin; delete p.asin; }
      delete p.deals[retailer];
      removed.push({ id: p.id, retailer, reason, clearedAsin, name: p.n.slice(0, 48) });
    }
  }
  if (Object.keys(p.deals).length === 0) delete p.deals;
}

removed.sort((a, b) => a.id - b.id);
console.log(`Removing ${removed.length} bad deals:\n`);
for (const r of removed) {
  console.log(`  id=${r.id} ${r.retailer.padEnd(7)} ${r.reason.padEnd(34)}${r.clearedAsin ? ' (+cleared asin ' + r.clearedAsin + ')' : ''} | ${r.name}`);
}

writeFileSync('./src/data/parts.js',
  `// Auto-merged catalog. Edit with care.\nexport const PARTS = ${JSON.stringify(parts, null, 2)};\n\nexport default PARTS;\n`);
console.log(`\nWrote flat src/data/parts.js (${parts.length} products). Now re-run the split generator.`);
