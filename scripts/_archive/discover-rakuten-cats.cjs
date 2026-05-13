(async () => {
  const basic = 'Basic ' + Buffer.from(process.env.RAKUTEN_CLIENT_ID + ':' + process.env.RAKUTEN_CLIENT_SECRET).toString('base64');
  const tr = await fetch('https://api.linksynergy.com/token', {
    method: 'POST',
    headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=password&scope=' + process.env.RAKUTEN_SID,
  });
  const { access_token } = await tr.json();

  // Test each of our part categories with their likely cat= value
  const tests = [
    { ourCat: 'CPU',         catTerm: 'Processors',          probe: 'AMD Ryzen 7 7700X' },
    { ourCat: 'GPU',         catTerm: 'Graphics Cards',      probe: 'RTX 4070' },
    { ourCat: 'Motherboard', catTerm: 'Motherboards',        probe: 'ASUS B650' },
    { ourCat: 'RAM',         catTerm: 'Memory',              probe: 'DDR5 6000' },
    { ourCat: 'Storage',     catTerm: 'Hard Drives',         probe: 'Samsung 990 Pro' },
    { ourCat: 'Storage',     catTerm: 'Solid State Drives',  probe: 'Samsung 990 Pro' },
    { ourCat: 'Storage',     catTerm: 'SSD',                 probe: 'Samsung 990 Pro' },
    { ourCat: 'PSU',         catTerm: 'Power Supplies',      probe: 'Corsair RM850' },
    { ourCat: 'Case',        catTerm: 'Computer Cases',      probe: 'Lian Li O11' },
    { ourCat: 'CPUCooler',   catTerm: 'CPU Fans',            probe: 'Noctua NH-D15' },
    { ourCat: 'CPUCooler',   catTerm: 'CPU Coolers',         probe: 'Noctua NH-D15' },
    { ourCat: 'Monitor',     catTerm: 'Monitors',            probe: 'LG 27' },
    { ourCat: 'CaseFan',     catTerm: 'Case Fans',           probe: 'Noctua 120mm' },
  ];

  for (const t of tests) {
    const url = 'https://api.linksynergy.com/productsearch/1.0?exact=' + encodeURIComponent(t.probe) + '&cat=' + encodeURIComponent(t.catTerm) + '&mid=44583&max=3';
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + access_token } });
    const xml = await r.text();
    const total = parseInt((xml.match(/<TotalMatches>(\d+)<\/TotalMatches>/) || [])[1] || '0', 10);
    const first = (xml.match(/<productname>(.*?)<\/productname>/) || [])[1] || '(none)';
    const firstCat = (xml.match(/<secondary>(.*?)<\/secondary>/) || [])[1] || '(none)';
    const tag = total > 0 ? '✓' : '✗';
    console.log(tag + ' ' + t.ourCat.padEnd(12) + ' cat="' + t.catTerm.padEnd(20) + '" probe="' + t.probe.padEnd(25) + '" total=' + total);
    if (total > 0) console.log('     first: ' + first.slice(0, 80));
    if (total > 0) console.log('     cat:   ' + firstCat.slice(0, 80));
  }
})();
