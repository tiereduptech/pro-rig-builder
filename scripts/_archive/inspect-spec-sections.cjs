const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
const AUTH = 'Basic ' + Buffer.from(LOGIN + ':' + PASSWORD).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

const TEST_ASIN = 'B07GBZ4Q68';

(async () => {
  const post = await fetch(BASE + '/merchant/amazon/asin/task_post', {
    method: 'POST',
    headers: { 'Authorization': AUTH, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ asin: TEST_ASIN, location_code: 2840, language_code: 'en_US' }]),
  });
  const postData = await post.json();
  const taskId = postData?.tasks?.[0]?.id;
  console.log('Task ID:', taskId);
  await new Promise(r => setTimeout(r, 25000));
  
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const get = await fetch(BASE + '/merchant/amazon/asin/task_get/advanced/' + taskId, {
      headers: { 'Authorization': AUTH },
    });
    const getData = await get.json();
    const result = getData?.tasks?.[0]?.result?.[0];
    if (result) {
      const item = result.items?.[0];
      if (item) {
        for (const section of (item.product_information || [])) {
          if (['Features & Specs', 'Item details', 'Measurements'].includes(section.section_name)) {
            console.log('\n=========================');
            console.log('SECTION: ' + section.section_name);
            console.log('=========================');
            console.log(JSON.stringify(section, null, 2).substring(0, 3000));
          }
        }
      }
      return;
    }
  }
})();
