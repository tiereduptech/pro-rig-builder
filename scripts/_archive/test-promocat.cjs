(async () => {
  const basic = 'Basic ' + Buffer.from(process.env.RAKUTEN_CLIENT_ID + ':' + process.env.RAKUTEN_CLIENT_SECRET).toString('base64');
  const tr = await fetch('https://api.linksynergy.com/token', {
    method: 'POST',
    headers: { Authorization: basic, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=password&scope=' + process.env.RAKUTEN_SID,
  });
  const { access_token } = await tr.json();

  const r = await fetch('https://api.linksynergy.com/coupon/1.0?promocat=*', {
    headers: { Authorization: 'Bearer ' + access_token },
  });
  console.log('HTTP ' + r.status);
  const t = await r.text();
  console.log(t.slice(0, 3000));
})();
