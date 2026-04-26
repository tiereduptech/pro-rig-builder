const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) { console.error('Missing BESTBUY_API_KEY'); process.exit(1); }

const url = 'https://api.bestbuy.com/v1/products(categoryPath.id=pcmcat304600050013)?show=sku,name,customerReviewAverage,customerReviewCount&pageSize=5&format=json&apiKey=' + KEY;
console.log('URL:', url.replace(KEY, 'XXX'));

(async () => {
  const r = await fetch(url);
  const d = await r.json();
  console.log('Status:', r.status);
  if (d.products) {
    for (const p of d.products) {
      console.log('  ' + p.sku + ' | rating=' + p.customerReviewAverage + ' reviews=' + p.customerReviewCount + ' | ' + p.name?.substring(0, 60));
    }
  } else {
    console.log('Response:', JSON.stringify(d).substring(0, 500));
  }
})();
