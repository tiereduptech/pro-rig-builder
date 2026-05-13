(async () => {
  const basic = 'Basic ' + Buffer.from(process.env.RAKUTEN_CLIENT_ID + ':' + process.env.RAKUTEN_CLIENT_SECRET).toString('base64');
  const tr = await fetch('https://api.linksynergy.com/token', {
    method: 'POST',
    headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=password&scope=' + process.env.RAKUTEN_SID,
  });
  const { access_token } = await tr.json();

  // Get a broader sample by removing exact and tallying cats containing 'graphic' or 'video card'
  const url = 'https://api.linksynergy.com/productsearch/1.0?keyword=' + encodeURIComponent('RTX 4090 GAMING') + '&mid=44583&max=100';
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + access_token } });
  const xml = await r.text();

  const items = [];
  const re = /<item>([\s\S]*?)<\/item>/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b = m[1];
    const g = t => (b.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>')) || [])[1] || '';
    items.push({ name: g('productname'), cat: g('secondary'), price: g('price') });
  }

  // Find items that LOOK like a standalone GPU
  const looksLikeGpu = items.filter(it =>
    /RTX|GeForce|Radeon|GPU|Graphics Card/i.test(it.name) &&
    !/Desktop|Workstation|Custom|PC|Computer|Mini PC|Build/i.test(it.name) &&
    parseFloat(it.price) > 100 && parseFloat(it.price) < 4000
  );

  console.log('=== Items that look like standalone GPUs ===');
  for (const it of looksLikeGpu.slice(0, 15)) {
    console.log('  $' + String(it.price).padStart(6) + '  ' + it.name.slice(0, 80));
    console.log('         cat: ' + it.cat);
  }

  // Tally categories of likely-GPU items
  const cats = {};
  for (const it of looksLikeGpu) {
    const leaf = it.cat.split('~~').pop();
    cats[leaf] = (cats[leaf] || 0) + 1;
  }
  console.log('\n=== Category leaves for likely GPUs ===');
  for (const [k, v] of Object.entries(cats).sort((a,b) => b[1] - a[1])) {
    console.log('  ' + String(v).padStart(3) + 'x  ' + k);
  }
})();
