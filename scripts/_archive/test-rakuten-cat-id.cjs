(async () => {
  const basic = 'Basic ' + Buffer.from(process.env.RAKUTEN_CLIENT_ID + ':' + process.env.RAKUTEN_CLIENT_SECRET).toString('base64');
  const tr = await fetch('https://api.linksynergy.com/token', {
    method: 'POST',
    headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=password&scope=' + process.env.RAKUTEN_SID,
  });
  const { access_token } = await tr.json();

  const tests = [
    { label: 'cat=38 numeric', url: 'productsearch/1.0?keyword=RTX+4090&mid=44583&cat=38&max=5' },
    { label: 'cat=GPU', url: 'productsearch/1.0?keyword=RTX+4090&mid=44583&cat=GPU&max=5' },
    { label: 'cat=Video Cards', url: 'productsearch/1.0?keyword=RTX+4090&mid=44583&cat=' + encodeURIComponent('Video Cards') + '&max=5' },
    { label: 'cat=Graphics', url: 'productsearch/1.0?keyword=RTX+4090&mid=44583&cat=Graphics&max=5' },
    { label: 'linklocator categories for Newegg', url: 'linklocator/1.0/getCreativeCategories/44583' },
  ];

  for (const t of tests) {
    const r = await fetch('https://api.linksynergy.com/' + t.url, {
      headers: { Authorization: 'Bearer ' + access_token },
    });
    const text = await r.text();
    console.log('\n=== ' + t.label + ' === HTTP ' + r.status);
    console.log(text.slice(0, 1500));
  }
})();
