(async () => {
  const basic = 'Basic ' + Buffer.from(process.env.RAKUTEN_CLIENT_ID + ':' + process.env.RAKUTEN_CLIENT_SECRET).toString('base64');
  const tr = await fetch('https://api.linksynergy.com/token', {
    method: 'POST',
    headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=password&scope=' + process.env.RAKUTEN_SID,
  });
  const { access_token } = await tr.json();

  // Same query the script would build for id 10001 (AMD Ryzen 9 9950X)
  // Script's extractKeywords would produce "AMD Ryzen 9 9950X"
  const url = 'https://api.linksynergy.com/productsearch/1.0?' + new URLSearchParams({
    exact: 'AMD Ryzen 9 9950X',
    cat: 'Processors',
    mid: '44583',
    max: '20',
  });
  console.log('URL: ' + url);

  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + access_token } });
  const xml = await r.text();
  const total = parseInt((xml.match(/<TotalMatches>(\d+)<\/TotalMatches>/) || [])[1] || '0', 10);
  console.log('HTTP ' + r.status + '  total=' + total + '  bytes=' + xml.length);

  const re = /<item>([\s\S]*?)<\/item>/g;
  let m, n = 0;
  while ((m = re.exec(xml)) !== null && n < 5) {
    const b = m[1];
    const g = t => (b.match(new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>')) || [])[1] || '';
    console.log('\n  ' + (++n) + '. ' + g('productname').slice(0, 80));
    console.log('     $' + g('price') + ' (sale $' + g('saleprice') + ')');
    console.log('     UPC: ' + g('upccode'));
    console.log('     cat: ' + g('secondary'));
  }
})();
