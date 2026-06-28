// Cross-retailer capacity audit. For every storage product and EACH retailer
// deal (amazon/newegg/bestbuy/msi/openbox), check two failure modes:
//   1. impossibly-cheap: deal $/TB below the physical floor (SSD $15, HDD $8)
//   2. confirmed-wrong-capacity: a capacity parseable from the deal's link/slug
//      that conflicts with the product's cap beyond marketing rounding.
// Also re-checks product name vs cap field.
import { parseCapacityGB, capacityCompatible, isHardDrive, isPricePlausibleForCapacity } from './normalize-product-name.js';

const mod = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
const storage = mod.PARTS.filter(p => p.c === 'Storage' || p.c === 'ExternalStorage');

// Parse a capacity hint from a retailer deal's URL/slug (decoded).
function dealUrlCap(deal) {
  const raw = [deal.url, deal.linkurl, deal.buy_url].filter(Boolean).join(' ');
  if (!raw) return null;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch {}
  decoded = decoded.replace(/[-_/]/g, ' ');
  const cap = parseCapacityGB(decoded);
  // Real drives are ≥100GB; a smaller "capacity" from a slug is noise
  // (a "2.5" form factor mangled to "5gb", a model number, etc.) — ignore it.
  return cap != null && cap >= 100 ? cap : null;
}

const impossiblyCheap = [];
const wrongCap = [];
const nameVsCap = [];

for (const p of storage) {
  const cap = p.cap != null ? p.cap : parseCapacityGB(p.n);
  const hdd = isHardDrive(p);

  // product name vs cap field
  const nc = parseCapacityGB(p.n);
  if (nc != null && p.cap != null && !capacityCompatible(nc, p.cap)) {
    nameVsCap.push(`id=${p.id} [${p.b}] name=${nc}GB cap=${p.cap}GB — ${p.n.slice(0,50)}`);
  }

  for (const [retailer, deal] of Object.entries(p.deals || {})) {
    if (!deal || typeof deal !== 'object') continue;
    const price = deal.saleprice ?? deal.price ?? null;

    // 1. impossibly cheap for capacity
    if ((p.c === 'Storage' || p.c === 'ExternalStorage') &&
        price != null && cap && !isPricePlausibleForCapacity(price, cap, { isHDD: hdd })) {
      impossiblyCheap.push(`id=${p.id} [${p.b}] ${retailer} $${price} / ${cap}GB = $${(price/(cap/1000)).toFixed(2)}/TB — ${p.n.slice(0,46)}`);
    }

    // 2. deal link capacity conflicts product capacity
    const urlCap = dealUrlCap(deal);
    if (cap != null && urlCap != null && !capacityCompatible(cap, urlCap)) {
      wrongCap.push(`id=${p.id} [${p.b}] ${retailer}: product ${cap}GB vs link ${urlCap}GB — ${p.n.slice(0,40)}`);
    }
  }
}

const line = (t, a) => { console.log(`\n${t}: ${a.length}` + (a.length ? '' : '   <-- target 0')); a.forEach(x => console.log('   ' + x)); };
console.log(`Storage/ExternalStorage products: ${storage.length}`);
line('IMPOSSIBLY-CHEAP deals (any retailer)', impossiblyCheap);
line('CONFIRMED WRONG-CAPACITY deals (link capacity != product, any retailer)', wrongCap);
line('NAME vs CAP-field disagree', nameVsCap);
console.log(`\nSUMMARY: impossiblyCheap=${impossiblyCheap.length}  wrongCapDeals=${wrongCap.length}  nameVsCap=${nameVsCap.length}`);
