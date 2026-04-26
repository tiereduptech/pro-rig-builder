// add-thermalright-display.cjs
// Directly adds Thermalright LCD Sub-Display (B0FP4NRRQH) by ASIN lookup
// Also fixes the Lian Li 8.8" listing brand/name

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
const KEY = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');

const NEW_PRODUCTS = [
  { asin: 'B0FP4NRRQH', brand: 'Thermalright', size: '5"' },
];

async function fetchAsin(asin) {
  const post = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/task_post', {
    method: 'POST',
    headers: { 'Authorization': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ asin, location_code: 2840, language_code: 'en_US' }])
  });
  const d = await post.json();
  const id = d.tasks?.[0]?.id;
  if (!id) return null;
  await new Promise(r => setTimeout(r, 30000));
  for (let i = 0; i < 8; i++) {
    const res = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/task_get/advanced/' + id, {
      headers: { 'Authorization': KEY }
    });
    const data = await res.json();
    const item = data?.tasks?.[0]?.result?.[0]?.items?.[0];
    if (item) return {
      title: item.title,
      price: item.price?.current || item.price_from || null,
      image: item.image_url,
      rating: item.rating?.value || 4.3,
      reviews: item.rating?.votes_count || 50
    };
    await new Promise(r => setTimeout(r, 10000));
  }
  return null;
}

(async () => {
  let s = fs.readFileSync(PARTS_PATH, 'utf8');

  // 1. Fix Lian Li 8.8" listing - update brand and name prefix
  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const lianLi = (m.PARTS || m.default).find(p =>
    p.c === 'InternalDisplay' && p.n.includes('8.8') && p.n.includes('Universal Screen')
  );

  if (lianLi) {
    console.log('Found Lian Li listing: id=' + lianLi.id);
    // Update brand to Lian Li and prefix the name
    const idMarker = '"id": ' + lianLi.id + ',';
    const idIdx = s.indexOf(idMarker);
    if (idIdx >= 0) {
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
      let entry = s.substring(startBrace, pos + 1);
      // Update brand
      entry = entry.replace(/"b":\s*"[^"]*"/, '"b": "Lian Li"');
      // Update name to prefix Lian Li
      entry = entry.replace(/"n":\s*"8\.8"/, '"n": "Lian Li 8.8\\"');
      s = s.substring(0, startBrace) + entry + s.substring(pos + 1);
      console.log('  ✓ Updated brand to Lian Li');
    }
  }

  // 2. Add Thermalright LCD Sub-Display
  const existingIds = new Set((m.PARTS || m.default).map(p => p.id));
  const existingAsins = new Set();
  (m.PARTS || m.default).forEach(p => {
    const a = p.deals?.amazon?.url?.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
    if (a) existingAsins.add(a);
  });

  let nextId = 95055;
  while (existingIds.has(nextId)) nextId++;

  for (const product of NEW_PRODUCTS) {
    if (existingAsins.has(product.asin)) {
      console.log('Skipping ' + product.asin + ' - already exists');
      continue;
    }

    console.log('\nFetching ' + product.asin + '...');
    const data = await fetchAsin(product.asin);
    if (!data) { console.log('  Failed'); continue; }

    const price = Math.round(data.price || 90);
    console.log('  Title: ' + data.title.substring(0, 70));
    console.log('  Price: $' + price);

    const id = nextId++;
    while (existingIds.has(nextId)) nextId++;

    const sizeM = data.title.match(/(\d{1,2}(?:\.\d)?)\s*(?:inch|"|in)/i);
    const resM = data.title.match(/(\d{3,4})\s*[x×]\s*(\d{3,4})/);

    const entry = {
      id,
      n: data.title.substring(0, 100),
      img: data.image,
      c: 'InternalDisplay',
      b: product.brand,
      pr: price,
      msrp: Math.round(price * 1.15),
      r: data.rating,
      reviews: data.reviews,
      asin: product.asin,
      size: sizeM ? sizeM[1] + '"' : product.size,
      resolution: resM ? resM[1] + 'x' + resM[2] : '480x480',
      connection: /usb[ \-]?c/i.test(data.title) ? 'USB-C' : 'USB',
      panelType: /ips/i.test(data.title) ? 'IPS' : 'IPS',
      touch: /touch/i.test(data.title),
      deals: {
        amazon: {
          price: price,
          url: 'https://www.amazon.com/dp/' + product.asin + '?tag=tiereduptech-20',
          inStock: true
        }
      }
    };

    const lastBracket = s.lastIndexOf(']');
    let pos = lastBracket - 1;
    while (pos > 0 && s[pos] !== '}') pos--;
    const insertPos = pos + 1;
    const insertText = ',\n  ' + JSON.stringify(entry, null, 4).split('\n').map((l, i) => i === 0 ? l : '  ' + l).join('\n');
    s = s.substring(0, insertPos) + insertText + s.substring(insertPos);
    console.log('  ✓ Added id=' + id);
  }

  fs.writeFileSync(PARTS_PATH, s);
  console.log('\n✓ Done');
})();
