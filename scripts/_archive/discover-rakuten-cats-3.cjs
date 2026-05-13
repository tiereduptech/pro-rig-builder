(async () => {
  const basic = 'Basic ' + Buffer.from(process.env.RAKUTEN_CLIENT_ID + ':' + process.env.RAKUTEN_CLIENT_SECRET).toString('base64');
  const tr = await fetch('https://api.linksynergy.com/token', {
    method: 'POST',
    headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=password&scope=' + process.env.RAKUTEN_SID,
  });
  const { access_token } = await tr.json();

  const tests = [
    { label: 'GPU/Computer System Cooling', cat: 'Computer System Cooling Parts', probe: 'GeForce RTX 4070' },
    { label: 'GPU try Video Graphics',      cat: 'Video Graphics Cards',          probe: 'GeForce RTX 4070' },
    { label: 'GPU try Graphic Cards',       cat: 'Graphic Cards',                 probe: 'GeForce RTX 4070' },
    { label: 'GPU no cat exact phrase',     cat: null,                            probe: 'GeForce RTX 4070' },
    { label: 'Storage Hard Drives exact',   cat: 'Hard Drives',                   probe: 'Samsung 990 Pro' },
    { label: 'Storage Internal SSD',        cat: 'Internal Solid State Drives',   probe: 'Samsung 990 Pro' },
    { label: 'Storage Storage Devices',     cat: 'Storage Devices',               probe: 'Samsung 990 Pro' },
    { label: 'Case server cases',           cat: 'Desktop Computer & Server Cases', probe: 'Lian Li O11' },
    { label: 'CPUCooler Cooling Parts',     cat: 'Computer System Cooling Parts', probe: 'Noctua NH-D15' },
    { label: 'CaseFan Cooling Parts',       cat: 'Computer System Cooling Parts', probe: 'Noctua NF-A12' },
    { label: 'CaseFan Fans',                cat: 'Fans',                          probe: 'Noctua NF-A12' },
  ];

  for (const t of tests) {
    let url = 'https://api.linksynergy.com/productsearch/1.0?exact=' + encodeURIComponent(t.probe) + '&mid=44583&max=3';
    if (t.cat) url += '&cat=' + encodeURIComponent(t.cat);
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + access_token } });
    const xml = await r.text();
    const total = parseInt((xml.match(/<TotalMatches>(\d+)<\/TotalMatches>/) || [])[1] || '0', 10);
    const first = (xml.match(/<productname>(.*?)<\/productname>/) || [])[1] || '';
    const firstCat = (xml.match(/<secondary>(.*?)<\/secondary>/) || [])[1] || '';
    const firstPrice = (xml.match(/<price[^>]*>(.*?)<\/price>/) || [])[1] || '';
    const tag = total > 0 ? '✓' : '✗';
    console.log(tag + ' ' + t.label.padEnd(35) + ' total=' + total);
    if (total > 0) console.log('     $' + firstPrice + '  ' + first.slice(0, 75));
    if (total > 0) console.log('     cat: ' + firstCat.slice(0, 80));
  }
})();
