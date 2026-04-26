// find-bestbuy-accessory-cats-v2.cjs
// Use name=* wildcard syntax for partial matches

const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) { console.error('Missing BESTBUY_API_KEY env var.'); process.exit(1); }

const searches = [
  'Mouse',
  'Mice',
  'Keyboard',
  'Headset',
  'Headphones',
  'Microphone',
  'Webcam',
  'Mouse Pad',
  'PCIe',
  'PSU',
  'Cable',
  'Riser',
  'Extension',
];

(async () => {
  for (const name of searches) {
    // Wildcard partial match: name=name*
    const url = `https://api.bestbuy.com/v1/categories(name=*${encodeURIComponent(name)}*)?show=id,name,url&pageSize=20&format=json&apiKey=${KEY}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      console.log('\n--- "' + name + '" ---');
      if (data.categories && data.categories.length > 0) {
        for (const c of data.categories.slice(0, 12)) {
          console.log('  ' + c.id.padEnd(28) + ' ' + c.name);
        }
      } else {
        console.log('  no matches');
      }
    } catch (e) {
      console.log('Error for "' + name + '":', e.message);
    }
    await new Promise(r => setTimeout(r, 250));
  }
})();
