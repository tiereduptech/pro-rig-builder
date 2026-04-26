const LOGIN = process.env.DATAFORSEO_LOGIN;
const PASSWORD = process.env.DATAFORSEO_PASSWORD;
const AUTH = 'Basic ' + Buffer.from(LOGIN + ':' + PASSWORD).toString('base64');
const BASE = 'https://api.dataforseo.com/v3';

(async () => {
  console.log('=== tasks_ready ===');
  const ready = await fetch(BASE + '/merchant/amazon/asin/tasks_ready', { headers: { 'Authorization': AUTH } });
  const readyData = await ready.json();
  console.log('Status:', ready.status);
  console.log(JSON.stringify(readyData, null, 2).substring(0, 2000));

  console.log('\n=== tasks_fixed (any failed?) ===');
  const fixed = await fetch(BASE + '/merchant/amazon/asin/tasks_fixed', { headers: { 'Authorization': AUTH } });
  const fixedData = await fixed.json();
  console.log(JSON.stringify(fixedData, null, 2).substring(0, 1000));
})();
