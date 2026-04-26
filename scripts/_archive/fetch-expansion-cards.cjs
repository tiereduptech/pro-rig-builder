// fetch-expansion-cards.cjs
// Populate WiFiCard, EthernetCard, OpticalDrive, SoundCard

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
const KEY = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');

const CATEGORIES = {
  WiFiCard: {
    queries: [
      'pcie wifi 6e card desktop',
      'pcie wifi 7 card desktop',
      'usb wifi adapter desktop',
      'tp-link archer wifi pcie',
      'tp-link archer wifi usb',
      'asus pce wifi card',
      'intel ax210 wifi 6e',
      'wifi adapter long range pc'
    ],
    include: t => /(wifi|wi-fi|wireless adapter|802\.11|ax\d|wifi\s*[67])/i.test(t),
    exclude: t =>
      /motherboard|cpu|gpu|mesh router|router only|tablet|phone case|laptop dongle wireless mouse|wireless keyboard|wireless mouse|wireless headphone|wireless headset|wireless charger|smart bulb|smart plug|extender(?!.*adapter)|repeater(?!.*adapter)|access point/i.test(t),
    minPrice: 15, maxPrice: 200,
    extractFields: t => {
      const f = {};
      // WiFi standard
      if (/wi-?fi\s*7|802\.11be|be\d{4}/i.test(t)) f.wifiStandard = 'WiFi 7';
      else if (/wi-?fi\s*6e|ax\d{4}|6e\b/i.test(t)) f.wifiStandard = 'WiFi 6E';
      else if (/wi-?fi\s*6|ax\d{3}|802\.11ax/i.test(t)) f.wifiStandard = 'WiFi 6';
      else if (/wi-?fi\s*5|802\.11ac|ac\d{3,4}/i.test(t)) f.wifiStandard = 'WiFi 5';
      else f.wifiStandard = 'WiFi 6';
      // Interface
      if (/pcie|pci-e|pci express/i.test(t)) f.interface = 'PCIe';
      else if (/usb[- ]?c/i.test(t)) f.interface = 'USB-C';
      else if (/usb[- ]?3|usb 3\.0/i.test(t)) f.interface = 'USB 3.0';
      else if (/usb/i.test(t)) f.interface = 'USB';
      else f.interface = 'PCIe';
      // Bluetooth
      if (/bluetooth/i.test(t)) f.bluetooth = true;
      return f;
    }
  },
  EthernetCard: {
    queries: [
      '10gbe pcie network card',
      '2.5gbe pcie network card',
      '1gbe pcie ethernet card',
      'intel x550 10gb ethernet',
      'asus xg-c100c 10gbe',
      'tp-link 2.5gb pcie',
      '10g sfp+ network card pcie'
    ],
    include: t => /(ethernet|network adapter|nic|gigabit|10g|2\.5g|sfp\+|rj45)/i.test(t),
    exclude: t =>
      /switch\b|router\b|cable\b|patch panel|extender|wall plate|crimping|tester|cat[5-8]\s*cable|wifi\b/i.test(t),
    minPrice: 15, maxPrice: 300,
    extractFields: t => {
      const f = {};
      if (/10\s*gb|10gbe|10gigabit|10g\b/i.test(t)) f.speed = '10 Gbps';
      else if (/2\.5\s*gb|2\.5gbe|2\.5g\b/i.test(t)) f.speed = '2.5 Gbps';
      else if (/5\s*gb|5gbe|5g\b/i.test(t)) f.speed = '5 Gbps';
      else if (/1\s*gb|gigabit|1gbe|1g\b/i.test(t)) f.speed = '1 Gbps';
      else f.speed = '1 Gbps';
      f.interface = /pcie|pci-e/i.test(t) ? 'PCIe' : 'USB';
      if (/sfp\+/i.test(t)) f.connector = 'SFP+';
      else if (/rj-?45/i.test(t)) f.connector = 'RJ45';
      else f.connector = 'RJ45';
      return f;
    }
  },
  OpticalDrive: {
    queries: [
      'internal blu-ray drive sata',
      'internal dvd drive sata',
      'asus internal blu-ray writer',
      'lg internal dvd writer',
      'pioneer bdr internal blu-ray'
    ],
    include: t => /(blu-?ray|dvd|cd-rw|optical drive|bdr|dvdr|bd-?re)/i.test(t) && /(internal|sata|5\.25)/i.test(t),
    exclude: t => /external|usb|portable|player only|tray only|disc only|movie\b|game disc|empty case|enclosure/i.test(t),
    minPrice: 25, maxPrice: 200,
    extractFields: t => {
      const f = {};
      if (/blu-?ray|bdr|bd-?re/i.test(t)) f.driveType = 'Blu-ray';
      else if (/dvd/i.test(t)) f.driveType = 'DVD';
      else f.driveType = 'CD/DVD';
      f.interface = 'SATA';
      if (/4k|uhd/i.test(t)) f.uhd = true;
      return f;
    }
  },
  SoundCard: {
    queries: [
      'pcie sound card',
      'creative sound blaster pcie',
      'asus xonar sound card',
      'usb dac amplifier',
      'external usb sound card pc',
      'creative sound blaster x',
      'asus essence sound card'
    ],
    include: t => /(sound\s?card|sound\s?blaster|dac|audio interface|xonar|essence)/i.test(t),
    exclude: t => /headphone amp only|guitar amp|speaker|microphone\b|cable\b|adapter only|book|case only|video card/i.test(t),
    minPrice: 30, maxPrice: 500,
    extractFields: t => {
      const f = {};
      f.interface = /pcie|pci-e/i.test(t) ? 'PCIe' : (/usb/i.test(t) ? 'USB' : 'PCIe');
      if (/7\.1/i.test(t)) f.channels = '7.1';
      else if (/5\.1/i.test(t)) f.channels = '5.1';
      else if (/2\.0|stereo/i.test(t)) f.channels = '2.0';
      const dac = t.match(/(\d{2,3})\s*-?\s*bit/i);
      if (dac) f.bitDepth = dac[1] + '-bit';
      return f;
    }
  }
};

function extractBrand(title) {
  const known = ['TP-Link','tp-link','ASUS','ASRock','MSI','Gigabyte','GIGABYTE','AORUS',
    'Intel','Realtek','Killer','Qualcomm',
    'NETGEAR','Linksys','Ubiquiti','D-Link','EDIMAX','BrosTrend','Comfast',
    'Pioneer','LG','Lite-On','Samsung','Hitachi',
    'Creative','Sound Blaster','Sennheiser','Schiit','FiiO','iFi','Topping','SMSL',
    'Mellanox','Broadcom','10Gtek','TRENDnet'];
  for (const b of known) {
    if (title.toLowerCase().includes(b.toLowerCase())) return b.replace('tp-link','TP-Link').replace('GIGABYTE','Gigabyte');
  }
  return title.split(' ')[0];
}

(async () => {
  let totalAdded = 0;
  let s = fs.readFileSync(PARTS_PATH, 'utf8');

  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  const existingIds = new Set(parts.map(p => p.id));
  const existingAsins = new Set();
  parts.forEach(p => {
    const asin = p.deals?.amazon?.url?.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
    if (asin) existingAsins.add(asin);
  });

  const ID_RANGES = {
    WiFiCard: 96000, EthernetCard: 96100, OpticalDrive: 96200, SoundCard: 96300
  };

  for (const [cat, config] of Object.entries(CATEGORIES)) {
    console.log('\n═══ ' + cat + ' ═══');

    const tasks = [];
    for (const q of config.queries) {
      const post = await fetch('https://api.dataforseo.com/v3/merchant/amazon/products/task_post', {
        method: 'POST',
        headers: { 'Authorization': KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ keyword: q, location_code: 2840, language_code: 'en_US', depth: 20 }])
      });
      const d = await post.json();
      const id = d.tasks?.[0]?.id;
      if (id) tasks.push({ id });
      await new Promise(r => setTimeout(r, 200));
    }

    console.log('  Submitted ' + tasks.length + ' searches');
    await new Promise(r => setTimeout(r, 60000));

    const allResults = [];
    const pendingTasks = [...tasks];
    let attempt = 0;
    while (pendingTasks.length > 0 && attempt < 15) {
      attempt++;
      const stillPending = [];
      for (const t of pendingTasks) {
        try {
          const res = await fetch('https://api.dataforseo.com/v3/merchant/amazon/products/task_get/advanced/' + t.id, {
            headers: { 'Authorization': KEY }
          });
          const d = await res.json();
          const result = d?.tasks?.[0]?.result?.[0];
          if (result?.items) {
            for (const item of result.items) {
              if (item.title && item.data_asin) {
                allResults.push({
                  title: item.title, asin: item.data_asin,
                  price: item.price?.current || item.price_from || null,
                  rating: item.rating?.value || null,
                  reviewsCount: item.rating?.votes_count || 0,
                  image: item.image_url || null,
                });
              }
            }
          } else if (d?.tasks?.[0]?.status_code === 20100) {
            stillPending.push(t);
          }
        } catch (e) { stillPending.push(t); }
      }
      pendingTasks.length = 0;
      pendingTasks.push(...stillPending);
      if (pendingTasks.length > 0) await new Promise(r => setTimeout(r, 20000));
    }

    const seen = new Set();
    const dedup = allResults.filter(r => {
      if (!r.asin || seen.has(r.asin) || existingAsins.has(r.asin)) return false;
      seen.add(r.asin);
      return true;
    });

    const filtered = dedup.filter(r =>
      r.title && r.price && r.image &&
      r.rating && r.rating >= 4.0 &&
      r.reviewsCount >= 50 &&
      r.price >= config.minPrice && r.price <= config.maxPrice &&
      config.include(r.title) && !config.exclude(r.title)
    );

    filtered.sort((a, b) => b.reviewsCount - a.reviewsCount);
    const top = filtered.slice(0, 12);

    console.log('  Filtered: ' + filtered.length + ', taking top: ' + top.length);
    top.forEach(r => console.log('    [' + r.asin + '] $' + r.price + ' ★' + r.rating + ' (' + r.reviewsCount + ') - ' + r.title.substring(0, 60)));

    let nextId = ID_RANGES[cat];
    while (existingIds.has(nextId)) nextId++;

    const entries = [];
    for (const r of top) {
      const id = nextId++;
      while (existingIds.has(nextId)) nextId++;
      const customFields = config.extractFields(r.title);
      entries.push({
        id,
        n: r.title.substring(0, 100),
        img: r.image,
        c: cat,
        b: extractBrand(r.title),
        pr: Math.round(r.price),
        msrp: Math.round(r.price * 1.15),
        r: r.rating,
        reviews: r.reviewsCount,
        asin: r.asin,
        ...customFields,
        deals: {
          amazon: {
            price: Math.round(r.price),
            url: 'https://www.amazon.com/dp/' + r.asin + '?tag=tiereduptech-20',
            inStock: true
          }
        }
      });
    }

    if (entries.length === 0) continue;

    const lastBracket = s.lastIndexOf(']');
    let pos = lastBracket - 1;
    while (pos > 0 && s[pos] !== '}') pos--;
    const insertPos = pos + 1;
    const insertText = ',\n' + entries.map(e =>
      '  ' + JSON.stringify(e, null, 4).split('\n').map((l, i) => i === 0 ? l : '  ' + l).join('\n')
    ).join(',\n');
    s = s.substring(0, insertPos) + insertText + s.substring(insertPos);
    totalAdded += entries.length;
    entries.forEach(e => existingAsins.add(e.asin));
  }

  fs.writeFileSync(PARTS_PATH, s);
  console.log('\n✓ Total added: ' + totalAdded + ' expansion card products');
})();
