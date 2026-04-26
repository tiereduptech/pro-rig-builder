// find-bestbuy-accessory-cats.cjs
// Searches Best Buy categories by name to find correct accessory IDs

const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) { console.error('Missing BESTBUY_API_KEY env var. Use: railway run node find-bestbuy-accessory-cats.cjs'); process.exit(1); }

const searches = [
  'Mouse',
  'Computer Mouse',
  'Mice',
  'Keyboard',
  'Computer Keyboard',
  'Headset',
  'Gaming Headset',
  'Headphones',
  'Microphone',
  'USB Microphone',
  'Webcam',
  'Mouse Pad',
  'PCIe',
  'PSU Cable',
  'Cable Extension',
];

(async () => {
  for (const name of searches) {
    const url = `https://api.bestbuy.com/v1/categories(name=${encodeURIComponent(name)})?show=id,name,url&pageSize=10&format=json&apiKey=${KEY}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      if (data.categories && data.categories.length > 0) {
        console.log('\n--- Searching: "' + name + '" ---');
        for (const c of data.categories.slice(0, 5)) {
          console.log('  ' + c.id.padEnd(30) + ' ' + c.name);
        }
      } else {
        console.log('\n--- "' + name + '" → NO MATCHES ---');
      }
    } catch (e) {
      console.log('Error for "' + name + '":', e.message);
    }
    // Rate limit: 5/sec
    await new Promise(r => setTimeout(r, 250));
  }
})();
