const KEY = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');
const ASIN = 'B0C4KQ9N79';

(async () => {
  console.log('Submitting task for ASIN:', ASIN);
  const post = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/task_post', {
    method: 'POST',
    headers: { 'Authorization': KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ asin: ASIN, location_code: 2840, language_code: 'en_US' }])
  });
  const d = await post.json();
  const id = d.tasks?.[0]?.id;
  console.log('Task ID:', id);
  console.log('Waiting 30s...');
  await new Promise(r => setTimeout(r, 30000));

  // Poll for up to 5 min
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 10000));
    const get = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/task_get/advanced/' + id, {
      headers: { 'Authorization': KEY }
    });
    const r = await get.json();
    const result = r?.tasks?.[0]?.result?.[0];
    if (result) {
      const item = result.items?.[0];
      console.log('\n=== Result ===');
      console.log('Title:', item?.title);
      console.log('Brand from data:', item?.brand);
      console.log('Price:', item?.price_from);
      console.log('In stock:', item?.is_available);
      return;
    }
    console.log('  poll ' + (i+1) + ' - not ready yet');
  }
})();
