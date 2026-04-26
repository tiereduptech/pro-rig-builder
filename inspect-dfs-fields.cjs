const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
const AUTH = 'Basic ' + Buffer.from(LOGIN + ':' + PASSWORD).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

// Test ASIN: pick a popular Logitech mouse
const TEST_ASIN = 'B07GBZ4Q68'; // Logitech G502 Hero

(async () => {
  // Submit task
  const post = await fetch(BASE + '/merchant/amazon/asin/task_post', {
    method: 'POST',
    headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ asin: TEST_ASIN, location_code: 2840, language_code: 'en_US' }]),
  });
  const postData = await post.json();
  const taskId = postData?.tasks?.[0]?.id;
  console.log('Task ID:', taskId);
  if (!taskId) { console.log(JSON.stringify(postData).substring(0, 500)); return; }

  // Wait
  console.log('Waiting 25s...');
  await new Promise(r => setTimeout(r, 25000));

  // Poll
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const get = await fetch(BASE + '/merchant/amazon/asin/task_get/advanced/' + taskId, {
      headers: { 'Authorization': AUTH },
    });
    const getData = await get.json();
    const result = getData?.tasks?.[0]?.result?.[0];
    if (result) {
      console.log('Got result. Items:', result.items?.length);
      const item = result.items?.[0];
      if (item) {
        console.log('\n=== Top-level keys ===');
        console.log(Object.keys(item).join(', '));
        console.log('\n=== Title ===');
        console.log(item.title);
        console.log('\n=== product_information ===');
        console.log(JSON.stringify(item.product_information, null, 2).substring(0, 2000));
      }
      return;
    }
    console.log('  poll ' + (i+1) + ' not ready');
  }
})();
