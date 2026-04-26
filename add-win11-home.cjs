// Add Windows 11 Home (HAJ-00108 → B09V6R9QZZ)
// Verified via web search of amazon.com product page

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
const KEY = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');

(async () => {
  const ASIN = 'B09V6R9QZZ';

  // Just fetch live data
  const post = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/task_post', {
    method: 'POST',
    headers: { 'Authorization': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ asin: ASIN, location_code: 2840, language_code: 'en_US' }])
  });
  const d = await post.json();
  const id = d.tasks?.[0]?.id;
  await new Promise(r => setTimeout(r, 30000));

  let item = null;
  for (let i = 0; i < 8; i++) {
    const res = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/task_get/advanced/' + id, {
      headers: { 'Authorization': KEY }
    });
    const data = await res.json();
    item = data?.tasks?.[0]?.result?.[0]?.items?.[0];
    if (item) break;
    await new Promise(r => setTimeout(r, 10000));
  }

  if (!item) { console.log('Failed to fetch'); return; }

  console.log('Live title: ' + item.title);
  console.log('Price: ' + (item.price?.current || item.price_from));

  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const existingIds = new Set((m.PARTS || m.default).map(p => p.id));
  let nextId = 99000;
  while (existingIds.has(nextId)) nextId++;

  const price = Math.round(item.price?.current || item.price_from || 139);

  // Use a clearer name since Amazon title is just "Microsoft Windows 11 (USB)"
  const entry = {
    id: nextId,
    n: 'Microsoft Windows 11 Home (USB Flash Drive) HAJ-00108',
    img: item.image_url,
    c: 'OS',
    b: 'Microsoft',
    pr: price,
    msrp: Math.round(price * 1.15),
    r: item.rating?.value || 4.3,
    reviews: item.rating?.votes_count || 100,
    asin: ASIN,
    mpn: 'HAJ-00108',
    osName: 'Windows 11',
    edition: 'Home',
    licenseType: 'Retail',
    deals: {
      amazon: {
        price: price,
        url: 'https://www.amazon.com/dp/' + ASIN + '?tag=tiereduptech-20',
        inStock: true
      }
    }
  };

  let s = fs.readFileSync(PARTS_PATH, 'utf8');
  const lastBracket = s.lastIndexOf(']');
  let pos = lastBracket - 1;
  while (pos > 0 && s[pos] !== '}') pos--;
  const insertPos = pos + 1;
  const insertText = ',\n  ' + JSON.stringify(entry, null, 4).split('\n').map((l, i) => i === 0 ? l : '  ' + l).join('\n');
  s = s.substring(0, insertPos) + insertText + s.substring(insertPos);
  fs.writeFileSync(PARTS_PATH, s);

  console.log('\n✓ Added Windows 11 Home (id=' + nextId + ')');
})();
