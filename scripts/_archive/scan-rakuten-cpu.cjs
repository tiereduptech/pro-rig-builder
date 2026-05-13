(async () => {
  const basic = 'Basic ' + Buffer.from(process.env.RAKUTEN_CLIENT_ID + ':' + process.env.RAKUTEN_CLIENT_SECRET).toString('base64');
  const tr = await fetch('https://api.linksynergy.com/token', {
    method: 'POST',
    headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=password&scope=' + process.env.RAKUTEN_SID,
  });
  const { access_token } = await tr.json();

  function parse(xml) {
    const items = [];
    const re = /<item>([\s\S]*?)<\/item>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const b = m[1];
      const get = (t) => (b.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>')) || [])[1] || '';
      items.push({
        name: get('productname'),
        price: parseFloat(get('price')) || 0,
        cat: get('secondary'),
        sku: get('sku'),
      });
    }
    return items;
  }

  console.log('Scanning first 5 pages for standalone CPU products (no "Desktop"/"Computer" in cat)...\n');
  const cpuOnly = [];
  const cats = {};
  for (let p = 1; p <= 5; p++) {
    const r = await fetch('https://api.linksynergy.com/productsearch/1.0?keyword=' + encodeURIComponent('"AMD Ryzen 9 9950X"') + '&mid=44583&max=100&pagenumber=' + p, {
      headers: { Authorization: 'Bearer ' + access_token },
    });
    const xml = await r.text();
    const items = parse(xml);
    for (const it of items) {
      cats[it.cat] = (cats[it.cat] || 0) + 1;
      // Standalone CPU should NOT contain Desktop/Workstation/PC/Computer System keywords
      if (!/Desktop|Workstation|Computer System/i.test(it.cat) &&
          !/Custom|PC|Desktop|Workstation/i.test(it.name)) {
        cpuOnly.push(it);
      }
    }
  }

  console.log('=== Category breakdown ===');
  for (const [k, v] of Object.entries(cats).sort((a, b) => b[1] - a[1])) {
    console.log('  ' + v.toString().padStart(4) + 'x  ' + k);
  }

  console.log('\n=== Likely standalone CPU products (' + cpuOnly.length + ') ===');
  for (const it of cpuOnly.slice(0, 10)) {
    console.log('  $' + it.price.toString().padStart(6) + '  ' + it.name.slice(0, 80));
    console.log('         cat: ' + it.cat);
  }
})();
