const KEY = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');

(async () => {
  // Get tasks_ready
  const r = await fetch('https://api.dataforseo.com/v3/merchant/amazon/asin/tasks_ready', { headers: { 'Authorization': KEY } });
  const d = await r.json();
  const all = d.tasks?.[0]?.result || [];
  const untagged = all.filter(t => !t.tag);
  console.log('Untagged tasks:', untagged.length);
  console.log('Fetching first 5 untagged to see ASINs...\n');

  for (const t of untagged.slice(0, 5)) {
    console.log('Task ID:', t.id, 'date:', t.date_posted);
    const res = await fetch('https://api.dataforseo.com' + t.endpoint_advanced, { headers: { 'Authorization': KEY } });
    const data = await res.json();
    const result = data.tasks?.[0]?.result?.[0];
    if (result) {
      const item = result.items?.[0];
      console.log('  data_asin:', item?.data_asin);
      console.log('  title:', (item?.title || '').substring(0, 80));
    } else {
      console.log('  No result. status:', data.tasks?.[0]?.status_message);
    }
    console.log('');
  }
})();
