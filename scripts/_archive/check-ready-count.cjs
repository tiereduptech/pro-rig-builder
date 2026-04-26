const KEY = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');

(async () => {
  const r = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/tasks_ready', { headers: { 'Authorization': KEY } });
  const d = await r.json();
  console.log('Status:', r.status);
  const t = d.tasks?.[0];
  console.log('result_count:', t?.result_count);
  console.log('returned:', t?.result?.length);
  // Show date range
  const dates = (t?.result || []).map(r => r.date_posted).sort();
  console.log('Earliest:', dates[0]);
  console.log('Latest:', dates[dates.length - 1]);
  // Tag distribution
  const tags = {};
  for (const r of (t?.result || [])) {
    const tag = r.tag || '(no tag)';
    tags[tag] = (tags[tag] || 0) + 1;
  }
  console.log('\nTag distribution:');
  for (const [tag, count] of Object.entries(tags).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    console.log('  ' + tag + ': ' + count);
  }
})();
