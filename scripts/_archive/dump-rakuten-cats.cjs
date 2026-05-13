(async () => {
  const basic = 'Basic ' + Buffer.from(process.env.RAKUTEN_CLIENT_ID + ':' + process.env.RAKUTEN_CLIENT_SECRET).toString('base64');
  const tr = await fetch('https://api.linksynergy.com/token', {
    method: 'POST',
    headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=password&scope=' + process.env.RAKUTEN_SID,
  });
  const { access_token } = await tr.json();
  const r = await fetch('https://api.linksynergy.com/productsearch/1.0?keyword=' + encodeURIComponent('AMD Ryzen 9 9950X') + '&mid=' + process.env.RAKUTEN_NEWEGG_MID + '&max=50', {
    headers: { Authorization: 'Bearer ' + access_token },
  });
  const xml = await r.text();

  const cats = [...xml.matchAll(/<secondary>(.*?)<\/secondary>/g)].map(m => m[1]);
  const counts = {};
  for (const c of cats) counts[c] = (counts[c] || 0) + 1;
  console.log('=== Categories ===');
  for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
    console.log(v + 'x  ' + k);
  }

  // Also list the first 10 product names so we see what's coming back
  const names = [...xml.matchAll(/<productname>(.*?)<\/productname>/g)].map(m => m[1]);
  console.log('\n=== First 10 product names ===');
  for (const n of names.slice(0, 10)) console.log('  - ' + n.slice(0, 100));
})();
