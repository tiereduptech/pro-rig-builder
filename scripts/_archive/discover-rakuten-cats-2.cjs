(async () => {
  const basic = 'Basic ' + Buffer.from(process.env.RAKUTEN_CLIENT_ID + ':' + process.env.RAKUTEN_CLIENT_SECRET).toString('base64');
  const tr = await fetch('https://api.linksynergy.com/token', {
    method: 'POST',
    headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=password&scope=' + process.env.RAKUTEN_SID,
  });
  const { access_token } = await tr.json();

  // Run without cat filter and tally secondary categories returned
  const probes = [
    { label: 'GPU',       q: 'GeForce RTX 4070' },
    { label: 'Storage',   q: 'NVMe SSD 1TB' },
    { label: 'Case',      q: 'PC Case ATX' },
    { label: 'CPUCooler', q: 'CPU Cooler air' },
    { label: 'CaseFan',   q: '120mm fan' },
  ];

  for (const p of probes) {
    const url = 'https://api.linksynergy.com/productsearch/1.0?keyword=' + encodeURIComponent(p.q) + '&mid=44583&max=100';
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + access_token } });
    const xml = await r.text();
    const cats = [...xml.matchAll(/<secondary>(.*?)<\/secondary>/g)].map(m => m[1]);
    const counts = {};
    for (const c of cats) {
      // tally just the LAST segment (most specific)
      const leaf = c.split('~~').pop();
      counts[leaf] = (counts[leaf] || 0) + 1;
    }
    console.log('\n=== ' + p.label + '  q="' + p.q + '" ===');
    for (const [k, v] of Object.entries(counts).sort((a,b) => b[1] - a[1]).slice(0, 8)) {
      console.log('  ' + String(v).padStart(3) + 'x  ' + k);
    }
  }
})();
