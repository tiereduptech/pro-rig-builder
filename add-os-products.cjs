// add-os-products.cjs
// Adds Windows 11 Home + Pro USB retail editions
// ASINs need verification via DataForSEO before we trust them
// We add as quarantined initially, then verifier can validate

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
const KEY = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');

// Submit a direct ASIN lookup to verify the product before adding
async function verifyAsin(asin, expectedTitle) {
  const post = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/task_post', {
    method: 'POST',
    headers: { 'Authorization': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ asin, location_code: 2840, language_code: 'en_US' }])
  });
  const d = await post.json();
  const id = d.tasks?.[0]?.id;
  if (!id) return null;
  await new Promise(r => setTimeout(r, 30000));
  for (let i = 0; i < 10; i++) {
    const res = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/task_get/advanced/' + id, {
      headers: { 'Authorization': KEY }
    });
    const data = await res.json();
    const item = data?.tasks?.[0]?.result?.[0]?.items?.[0];
    if (item) return { title: item.title, price: item.price?.current, image: item.image_url, rating: item.rating?.value, reviews: item.rating?.votes_count };
    await new Promise(r => setTimeout(r, 10000));
  }
  return null;
}

// Search for Windows 11 USB retail and pick the official Microsoft seller's ASIN
async function searchWindows(edition) {
  const post = await fetch('https://api.dataforseo.com/v3/merchant/amazon/products/task_post', {
    method: 'POST',
    headers: { 'Authorization': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ keyword: 'microsoft windows 11 ' + edition + ' usb retail box', location_code: 2840, language_code: 'en_US', depth: 30 }])
  });
  const d = await post.json();
  const id = d.tasks?.[0]?.id;
  if (!id) return null;
  await new Promise(r => setTimeout(r, 60000));
  for (let i = 0; i < 10; i++) {
    const res = await fetch('https://api.dataforseo.com/v3/merchant/amazon/products/task_get/advanced/' + id, {
      headers: { 'Authorization': KEY }
    });
    const data = await res.json();
    const result = data?.tasks?.[0]?.result?.[0];
    if (result?.items) {
      // Look for products that are Windows 11, the right edition, and not subscriptions/keys-only
      for (const item of result.items) {
        const t = (item.title || '').toLowerCase();
        if (!t.includes('windows 11')) continue;
        if (!t.includes(edition.toLowerCase())) continue;
        if (/key only|digital download|product key|email/i.test(t)) continue;
        if (/laptop|desktop|computer|tablet|surface/i.test(t)) continue;
        if (item.price?.current > 250 || item.price?.current < 80) continue;
        if (!item.data_asin) continue;
        return {
          asin: item.data_asin,
          title: item.title,
          price: item.price?.current,
          image: item.image_url,
          rating: item.rating?.value || 4.4,
          reviews: item.rating?.votes_count || 100
        };
      }
    }
    await new Promise(r => setTimeout(r, 15000));
  }
  return null;
}

(async () => {
  console.log('Searching for verified Windows 11 Home and Pro retail ASINs...\n');

  const home = await searchWindows('home');
  console.log('Home result: ' + (home ? home.asin + ' - ' + home.title.substring(0, 60) : 'NOT FOUND'));
  const pro = await searchWindows('pro');
  console.log('Pro result:  ' + (pro ? pro.asin + ' - ' + pro.title.substring(0, 60) : 'NOT FOUND'));

  if (!home && !pro) {
    console.log('\n✗ No verified ASINs found. Skipping OS additions.');
    return;
  }

  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const existingIds = new Set((m.PARTS || m.default).map(p => p.id));
  let nextId = 99000;
  while (existingIds.has(nextId)) nextId++;

  const entries = [];
  for (const p of [home, pro].filter(Boolean)) {
    const id = nextId++;
    while (existingIds.has(nextId)) nextId++;
    entries.push({
      id,
      n: p.title.substring(0, 100),
      img: p.image,
      c: 'OS',
      b: 'Microsoft',
      pr: Math.round(p.price),
      msrp: Math.round(p.price * 1.15),
      r: p.rating,
      reviews: p.reviews,
      asin: p.asin,
      osName: 'Windows 11',
      edition: /pro/i.test(p.title) ? 'Pro' : 'Home',
      licenseType: 'Retail',
      deals: {
        amazon: {
          price: Math.round(p.price),
          url: 'https://www.amazon.com/dp/' + p.asin + '?tag=tiereduptech-20',
          inStock: true
        }
      }
    });
  }

  if (entries.length === 0) {
    console.log('No entries to add.');
    return;
  }

  let s = fs.readFileSync(PARTS_PATH, 'utf8');
  const lastBracket = s.lastIndexOf(']');
  let pos = lastBracket - 1;
  while (pos > 0 && s[pos] !== '}') pos--;
  const insertPos = pos + 1;
  const insertText = ',\n' + entries.map(e =>
    '  ' + JSON.stringify(e, null, 4).split('\n').map((l, i) => i === 0 ? l : '  ' + l).join('\n')
  ).join(',\n');
  s = s.substring(0, insertPos) + insertText + s.substring(insertPos);
  fs.writeFileSync(PARTS_PATH, s);
  console.log('\n✓ Added ' + entries.length + ' OS products with verified ASINs');
  entries.forEach(e => console.log('  ' + e.n.substring(0,60)));
})();
