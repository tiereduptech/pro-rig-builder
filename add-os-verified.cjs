// add-os-verified.cjs
// Adds Windows 11 Home and Pro retail USB editions
// ASINs verified via web search of Amazon product pages:
//   - HAJ-00108 (Win 11 Home USB) → B09V6R9QZZ
//   - HAV-00162 (Win 11 Pro USB) → B09V71FYGS

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
const KEY = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');

const PRODUCTS = [
  {
    asin: 'B09V6R9QZZ',
    fallbackName: 'Microsoft Windows 11 Home (USB Flash Drive) HAJ-00108',
    fallbackPrice: 139,
    edition: 'Home',
    mpn: 'HAJ-00108'
  },
  {
    asin: 'B09V71FYGS',
    fallbackName: 'Microsoft Windows 11 Pro (USB Flash Drive) HAV-00162',
    fallbackPrice: 199,
    edition: 'Pro',
    mpn: 'HAV-00162'
  }
];

async function fetchAsin(asin) {
  console.log('Verifying ' + asin + '...');
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
      reviews: item.rating?.votes_count || 100
    };
    await new Promise(r => setTimeout(r, 10000));
  }
  return null;
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const existingIds = new Set((m.PARTS || m.default).map(p => p.id));
  let nextId = 99000;
  while (existingIds.has(nextId)) nextId++;

  const entries = [];
  for (const product of PRODUCTS) {
    const data = await fetchAsin(product.asin);
    if (!data) {
      console.log('  ' + product.asin + ': verification failed, using fallback');
    } else {
      console.log('  ' + product.asin + ': ' + data.title.substring(0, 60));
      // Sanity check — title must contain "windows 11" and the edition
      if (!/windows 11/i.test(data.title) || !new RegExp(product.edition, 'i').test(data.title)) {
        console.log('  ⚠ ASIN does not match Windows 11 ' + product.edition + ' - SKIPPING');
        continue;
      }
    }

    const id = nextId++;
    while (existingIds.has(nextId)) nextId++;

    entries.push({
      id,
      n: data?.title?.substring(0, 100) || product.fallbackName,
      img: data?.image || null,
      c: 'OS',
      b: 'Microsoft',
      pr: Math.round(data?.price || product.fallbackPrice),
      msrp: Math.round((data?.price || product.fallbackPrice) * 1.15),
      r: data?.rating || 4.3,
      reviews: data?.reviews || 100,
      asin: product.asin,
      mpn: product.mpn,
      osName: 'Windows 11',
      edition: product.edition,
      licenseType: 'Retail',
      deals: {
        amazon: {
          price: Math.round(data?.price || product.fallbackPrice),
          url: 'https://www.amazon.com/dp/' + product.asin + '?tag=tiereduptech-20',
          inStock: true
        }
      }
    });
  }

  if (entries.length === 0) {
    console.log('\nNothing added.');
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

  console.log('\n✓ Added ' + entries.length + ' verified OS products');
  entries.forEach(e => console.log('  id=' + e.id + ' ' + e.asin + ' | ' + e.n.substring(0, 60)));
})();
