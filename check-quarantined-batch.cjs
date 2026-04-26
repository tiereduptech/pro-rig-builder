const KEY = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  const quarantined = parts.filter(p => p.needsReview).slice(0, 5);

  console.log('Submitting 5 ASINs for verification...\n');
  const tasks = [];
  for (const p of quarantined) {
    const asinM = p.deals?.amazon?.url?.match(/\/dp\/([A-Z0-9]{10})/);
    if (!asinM) { console.log('No ASIN for ' + p.id); continue; }
    const asin = asinM[1];
    const post = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/task_post', {
      method: 'POST',
      headers: { 'Authorization': KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify([{ asin, location_code: 2840, language_code: 'en_US' }])
    });
    const d = await post.json();
    const id = d.tasks?.[0]?.id;
    if (id) {
      tasks.push({ id, asin, p });
      console.log('  Submitted ' + p.id + ' asin=' + asin + ' name="' + p.n.substring(0,50) + '"');
    }
    await new Promise(r => setTimeout(r, 200));
  }

  console.log('\nWaiting 40s...');
  await new Promise(r => setTimeout(r, 40000));

  console.log('\nFetching results:');
  for (const t of tasks) {
    const get = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/task_get/advanced/' + t.id, {
      headers: { 'Authorization': KEY }
    });
    const r = await get.json();
    const item = r?.tasks?.[0]?.result?.[0]?.items?.[0];
    if (item) {
      console.log('\nProduct id=' + t.p.id + ' asin=' + t.asin);
      console.log('  Stored: "' + t.p.n + '"');
      console.log('  Amazon: "' + (item.title || '').substring(0,80) + '"');
    } else {
      console.log('\n  ' + t.p.id + ' - no result');
    }
    await new Promise(r => setTimeout(r, 500));
  }
})();
