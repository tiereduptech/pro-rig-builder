const auth = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');

function flatten(pi) {
  const flat = {};
  for (const sec of pi || []) {
    if (sec.type === 'product_information_details_item' && sec.body) {
      for (const [k, v] of Object.entries(sec.body)) flat[k] = v;
    }
    if (Array.isArray(sec.contents)) {
      for (const c of sec.contents) {
        if (c.body && typeof c.body === 'object' && !Array.isArray(c.body)) {
          for (const [k, v] of Object.entries(c.body)) flat[k] = v;
        }
      }
    }
  }
  return flat;
}

(async () => {
  const s = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/task_post', {
    method: 'POST',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ asin: 'B0DXWWWTH8', location_code: 2840, language_code: 'en_US' }]),
  });
  const sd = await s.json();
  const tid = sd.tasks[0].id;
  console.log('Task:', tid);

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 5000));
    const r = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/task_get/advanced/' + tid, {
      headers: { Authorization: auth },
    });
    const d = await r.json();
    const t = d.tasks[0];
    if (t.status_code === 20000) {
      const item = t.result[0].items[0];
      const flat = flatten(item.product_information);
      console.log('\n=== All Amazon spec keys ===');
      for (const k of Object.keys(flat).sort()) {
        console.log('  ' + k + '  =  ' + JSON.stringify(flat[k]).slice(0, 80));
      }
      return;
    }
    console.log('  attempt', i, 'status', t.status_code);
  }
})();
