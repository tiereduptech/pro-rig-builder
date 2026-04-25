const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) { console.error('Missing BESTBUY_API_KEY'); process.exit(1); }

async function show(q) {
  const url = 'https://api.bestbuy.com/v1/products(search=' + encodeURIComponent(q) + ')?show=name,categoryPath&pageSize=5&format=json&apiKey=' + KEY;
  const r = await fetch(url);
  const d = await r.json();
  console.log('\n=== ' + q + ' (' + (d.products?.length || 0) + ') ===');
  for (const p of (d.products || [])) {
    const leaf = p.categoryPath?.[p.categoryPath.length - 1];
    if (leaf) console.log('  ' + leaf.id.padEnd(28) + ' ' + leaf.name + '   <- ' + p.name.substring(0, 60));
  }
}

(async () => {
  await show('razer deathadder gaming mouse');
  await show('logitech mouse');
  await show('blue yeti microphone');
  await show('hyperx quadcast microphone');
  await show('audio technica at2020 microphone');
  await show('pcie 4.0 riser cable');
  await show('cablemod cable extension');
})();
