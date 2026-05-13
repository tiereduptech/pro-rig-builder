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
      const g = t => (b.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>')) || [])[1] || '';
      items.push({ name: g('productname'), sku: g('sku'), upc: g('upccode'), price: g('price'), secondary: g('secondary') });
    }
    return items;
  }

  const tests = [
    { label: 'keyword=N82E16814126753', params: 'keyword=N82E16814126753' },
    { label: 'exact=N82E16814126753',   params: 'exact=N82E16814126753' },
    { label: 'sku param (long shot)',   params: 'sku=N82E16814126753' },
    { label: 'productid param',         params: 'productid=N82E16814126753' },
  ];

  for (const t of tests) {
    const url = 'https://api.linksynergy.com/productsearch/1.0?' + t.params + '&mid=44583&max=5';
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + access_token } });
    const xml = await r.text();
    const total = parseInt((xml.match(/<TotalMatches>(\d+)<\/TotalMatches>/) || [])[1] || '0', 10);
    const items = parse(xml);
    console.log('\n=== ' + t.label + ' === total=' + total);
    for (const it of items.slice(0, 3)) {
      console.log('  $' + it.price + '  ' + it.name.slice(0, 80));
      console.log('       cat: ' + it.secondary);
      console.log('       SKU: ' + it.sku + '  UPC: ' + it.upc);
    }
  }
})();
