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
      items.push({ name: g('productname'), price: parseFloat(g('price')) || 0, cat: g('secondary'), sku: g('sku'), upc: g('upccode') });
    }
    return items;
  }

  const tests = [
    { label: 'exact=AMD Ryzen 9 9950X', params: 'exact=' + encodeURIComponent('AMD Ryzen 9 9950X') + '&mid=44583&max=20' },
    { label: 'exact + none=Custom,Desktop,PC', params: 'exact=' + encodeURIComponent('AMD Ryzen 9 9950X') + '&none=' + encodeURIComponent('Custom Desktop PC Workstation Computer') + '&mid=44583&max=20' },
    { label: 'exact + cat=Computer Processors', params: 'exact=' + encodeURIComponent('AMD Ryzen 9 9950X') + '&cat=' + encodeURIComponent('Computer Processors') + '&mid=44583&max=20' },
    { label: 'exact + cat=Processors', params: 'exact=' + encodeURIComponent('AMD Ryzen 9 9950X') + '&cat=Processors&mid=44583&max=20' },
  ];

  for (const t of tests) {
    const url = 'https://api.linksynergy.com/productsearch/1.0?' + t.params;
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + access_token } });
    const xml = await r.text();
    const total = parseInt((xml.match(/<TotalMatches>(\d+)<\/TotalMatches>/) || [])[1] || '0', 10);
    const items = parse(xml);
    console.log('\n=== ' + t.label + ' ===  total=' + total);
    for (const it of items.slice(0, 5)) {
      console.log('  $' + String(it.price).padStart(7) + '  ' + it.name.slice(0, 75));
      console.log('              cat: ' + it.cat.slice(0, 80));
    }
  }
})();
