// find-bb-cat-ids-v3.cjs
// Searches actual products and harvests their categoryPath leaf nodes

const KEY = process.env.BESTBUY_API_KEY;
if (!KEY) { console.error('Missing BESTBUY_API_KEY env var.'); process.exit(1); }

const queries = {
  Mouse: 'logitech g pro mouse',
  Keyboard: 'corsair k70 keyboard',
  Headset: 'steelseries arctis nova headset',
  GamingHeadset: 'razer blackshark gaming headset',
  Microphone: 'shure sm7b microphone',
  USBMicrophone: 'blue yeti usb microphone',
  Webcam: 'logitech c920 webcam',
  Streaming: 'elgato stream deck',
  PCIeCable: 'pcie riser cable',
  PSUCable: 'cable extension psu',
};

(async () => {
  const seenLeaf = new Map(); // id -> name
  const seenAll = new Map();

  for (const [label, query] of Object.entries(queries)) {
    const url = `https://api.bestbuy.com/v1/products(search=${encodeURIComponent(query)})?show=name,categoryPath&pageSize=10&format=json&apiKey=${KEY}`;
    try {
      const res = await fetch(url);
      const data = await res.json();
      console.log('\n=== "' + label + '" (' + (data.products?.length || 0) + ' results) ===');
      if (data.products && data.products.length > 0) {
        for (const p of data.products) {
          const path = p.categoryPath || [];
          const leaf = path[path.length - 1];
          if (leaf) {
            const key = leaf.id;
            seenLeaf.set(key, (seenLeaf.get(key) || 0) + 1);
            seenAll.set(leaf.id, leaf.name);
          }
        }
      }
    } catch (e) {
      console.log('Error:', e.message);
    }
    await new Promise(r => setTimeout(r, 250));
  }

  console.log('\n\n═══ Leaf categories found (id → name | hits) ═══');
  const sorted = [...seenAll.entries()].sort((a, b) => (seenLeaf.get(b[0]) || 0) - (seenLeaf.get(a[0]) || 0));
  for (const [id, name] of sorted) {
    console.log('  ' + id.padEnd(28) + ' ' + (name || '?').padEnd(35) + ' (' + seenLeaf.get(id) + ' hits)');
  }
})();
