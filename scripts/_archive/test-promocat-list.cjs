(async () => {
  const basic = 'Basic ' + Buffer.from(process.env.RAKUTEN_CLIENT_ID + ':' + process.env.RAKUTEN_CLIENT_SECRET).toString('base64');
  const tr = await fetch('https://api.linksynergy.com/token', {
    method: 'POST',
    headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=password&scope=' + process.env.RAKUTEN_SID,
  });
  const { access_token } = await tr.json();

  // Try bare promocat endpoint to enumerate
  const tries = [
    'https://api.linksynergy.com/coupon/1.0?promocat',
    'https://api.linksynergy.com/coupon/1.0/promocat',
    'https://api.linksynergy.com/coupon/1.0?promocat=list',
  ];
  for (const url of tries) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + access_token } });
    const t = await r.text();
    console.log('\n=== ' + url + ' === HTTP ' + r.status);
    console.log(t.slice(0, 2500));
  }
})();
