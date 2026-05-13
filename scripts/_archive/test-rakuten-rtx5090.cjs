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
      items.push({
        name: g('productname'),
        sku: g('sku'),
        upc: g('upccode'),
        price: g('price'),
        sale: g('saleprice'),
        primary: g('primary'),
        secondary: g('secondary'),
        link: g('linkurl'),
      });
    }
    return items;
  }

  // 4 search variations from broad to specific
  const tests = [
    { label: 'exact full name',  params: 'exact=' + encodeURIComponent('ASUS TUF Gaming GeForce RTX 5090 32GB GDDR7 OC') + '&mid=44583&max=10' },
    { label: 'exact model SKU',  params: 'exact=' + encodeURIComponent('TUF-RTX5090-O32G-GAMING') + '&mid=44583&max=10' },
    { label: 'keyword RTX 5090', params: 'keyword=' + encodeURIComponent('ASUS TUF RTX 5090 32GB') + '&mid=44583&max=10' },
    { label: 'exact RTX 5090',   params: 'exact=' + encodeURIComponent('RTX 5090') + '&mid=44583&max=10' },
  ];

  for (const t of tests) {
    const url = 'https://api.linksynergy.com/productsearch/1.0?' + t.params;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + access_token } });
    const xml = await r.text();
    const total = parseInt((xml.match(/<TotalMatches>(\d+)<\/TotalMatches>/) || [])[1] || '0', 10);
    const items = parse(xml);
    console.log('\n=== ' + t.label + ' === total=' + total);
    for (const it of items.slice(0, 5)) {
      console.log('  $' + String(it.price).padStart(6) + ' (sale $' + it.sale + ')  ' + it.name.slice(0, 80));
      console.log('       primary:   ' + it.primary);
      console.log('       secondary: ' + it.secondary);
      console.log('       SKU: ' + it.sku + '  UPC: ' + it.upc);
    }
  }
})();
