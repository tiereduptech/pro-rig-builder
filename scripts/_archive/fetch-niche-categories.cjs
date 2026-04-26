// fetch-niche-categories.cjs
// Searches Amazon for verified products in underpopulated categories

const fs = require('fs');
const PARTS_PATH = './src/data/parts.js';
const KEY = 'Basic ' + Buffer.from(process.env.DATAFORSEO_LOGIN + ':' + process.env.DATAFORSEO_PASSWORD).toString('base64');

// Per-category search queries + filtering rules
const CATEGORIES = {
  OS: {
    queries: ['windows 11 home usb retail', 'windows 11 pro usb retail', 'windows 11 home digital', 'windows 11 pro digital'],
    include: t => /windows 11/i.test(t) && /(home|pro)/i.test(t),
    exclude: t => /xbox|game|movie|book|laptop|pc desktop|computer|monitor|keyboard|mouse/i.test(t),
    minPrice: 80, maxPrice: 250,
    extractFields: t => {
      const f = {};
      f.osName = /windows 11/i.test(t) ? 'Windows 11' : null;
      f.edition = /pro/i.test(t) ? 'Pro' : 'Home';
      f.licenseType = /retail|usb|physical/i.test(t) ? 'Retail' : 'Digital';
      return f;
    }
  },
  Chair: {
    queries: ['gaming chair ergonomic', 'office chair lumbar support', 'secretlab gaming chair', 'herman miller chair', 'autonomous ergochair'],
    include: t => /chair/i.test(t),
    exclude: t => /cover|cushion|mat|wheel|caster|footrest|recliner home|dining|outdoor|rocking|car seat|cushion only/i.test(t),
    minPrice: 100, maxPrice: 2000,
    extractFields: t => ({})
  },
  Desk: {
    queries: ['standing desk electric', 'sit stand desk', 'l shaped gaming desk', 'computer desk 60 inch'],
    include: t => /desk/i.test(t) && /(stand|sit|computer|gaming|office|workstation)/i.test(t),
    exclude: t => /accessory|topper|riser|converter|mat|pad|lamp|organizer|drawer only|monitor|chair/i.test(t),
    minPrice: 150, maxPrice: 1500,
    extractFields: t => ({})
  },
  ThermalPaste: {
    queries: ['thermal paste cpu', 'thermal grizzly kryonaut', 'arctic mx-6 thermal paste', 'noctua nt-h2 thermal'],
    include: t => /thermal/i.test(t) && /(paste|compound|grease|conductonaut)/i.test(t),
    exclude: t => /pad|tape|cooler|fan|heatsink|vinyl/i.test(t),
    minPrice: 5, maxPrice: 50,
    extractFields: t => ({})
  },
  ExternalStorage: {
    queries: ['external ssd portable', 'samsung t9 ssd', 'crucial x9 portable ssd', 'sandisk extreme portable ssd', 'wd my passport hdd'],
    include: t => /(external|portable).*(ssd|hdd|drive|storage)/i.test(t) || /(ssd|hdd).*(portable|external)/i.test(t),
    exclude: t => /enclosure|case|cable|adapter|hub|nas|usb hub/i.test(t),
    minPrice: 50, maxPrice: 600,
    extractFields: t => {
      const f = {};
      const cap = t.match(/(\d+)\s*tb/i);
      if (cap) f.cap = parseInt(cap[1]) * 1000;
      else {
        const cg = t.match(/(\d+)\s*gb/i);
        if (cg) f.cap = parseInt(cg[1]);
      }
      f.driveType = /ssd/i.test(t) ? 'SSD' : 'HDD';
      return f;
    }
  },
  Antivirus: {
    queries: ['norton 360 deluxe', 'bitdefender total security', 'mcafee total protection', 'eset internet security', 'kaspersky plus'],
    include: t => /(antivirus|security|protection|360|defender|internet security|total security)/i.test(t),
    exclude: t => /book|guide|router|hardware/i.test(t),
    minPrice: 15, maxPrice: 150,
    extractFields: t => {
      const f = {};
      const dev = t.match(/(\d+)\s*device/i);
      if (dev) f.devices = parseInt(dev[1]);
      f.term = /1[\s-]?year|annual|12 month/i.test(t) ? '1 Year' : (/2[\s-]?year/i.test(t) ? '2 Years' : '1 Year');
      return f;
    }
  },
  ExternalOptical: {
    queries: ['external dvd drive usb', 'external blu-ray drive', 'usb dvd writer external', 'lg external blu-ray'],
    include: t => /(external|usb).*(dvd|blu.?ray|optical|cd)/i.test(t),
    exclude: t => /internal|sata|player only|tv|movie|case|tray/i.test(t),
    minPrice: 25, maxPrice: 200,
    extractFields: t => ({
      driveType: /blu.?ray/i.test(t) ? 'Blu-ray' : 'DVD',
      connection: /usb[\s-]?c/i.test(t) ? 'USB-C' : 'USB-A'
    })
  },
  UPS: {
    queries: ['ups battery backup', 'cyberpower 1500va ups', 'apc back-ups pro', 'tripp lite ups battery', 'eaton ups battery backup'],
    include: t => /(ups|uninterruptible|battery backup)/i.test(t),
    exclude: t => /replacement battery|battery only|cable|surge protector only|power strip/i.test(t),
    minPrice: 50, maxPrice: 800,
    extractFields: t => {
      const f = {};
      const va = t.match(/(\d{3,5})\s*va/i);
      if (va) f.va = parseInt(va[1]);
      const w = t.match(/(\d{3,4})\s*w(?:att|s)?/i);
      if (w) f.watts = parseInt(w[1]);
      return f;
    }
  }
};

function extractBrand(title) {
  const known = ['Samsung','Crucial','SanDisk','WD','Western Digital','Seagate','LaCie',
    'Microsoft','Norton','Bitdefender','McAfee','ESET','Kaspersky',
    'CyberPower','APC','Tripp Lite','Eaton','Belkin',
    'LG','ASUS','Pioneer','Verbatim',
    'Secretlab','Herman Miller','Autonomous','Razer','Corsair','SteelSeries','HON','GTRACING','Vitesse',
    'UPLIFT','IKEA','VIVO','FlexiSpot','SHW','Walker Edison','Tribesigns',
    'Noctua','Thermal Grizzly','Arctic','Cooler Master','Gelid'];
  for (const b of known) {
    if (title.toLowerCase().includes(b.toLowerCase())) return b;
  }
  return title.split(' ')[0];
}

(async () => {
  let totalAdded = 0;
  let s = fs.readFileSync(PARTS_PATH, 'utf8');

  // Get existing IDs
  const m = await import('file://' + process.cwd().replace(/\\/g,'/') + '/src/data/parts.js?t=' + Date.now());
  const parts = m.PARTS || m.default;
  const existingIds = new Set(parts.map(p => p.id));
  const existingAsins = new Set();
  parts.forEach(p => {
    const asin = p.deals?.amazon?.url?.match(/\/dp\/([A-Z0-9]{10})/)?.[1];
    if (asin) existingAsins.add(asin);
  });

  // Per category, allocate ID range
  const ID_RANGES = {
    OS: 99000, Antivirus: 99100, Chair: 99200, Desk: 99300,
    ThermalPaste: 99400, ExternalStorage: 99500, ExternalOptical: 99600, UPS: 99700
  };

  for (const [cat, config] of Object.entries(CATEGORIES)) {
    console.log('\n═══ ' + cat + ' ═══');

    // Submit searches
    const tasks = [];
    for (const q of config.queries) {
      const post = await fetch('https://api.dataforseo.com/v3/merchant/amazon/products/task_post', {
        method: 'POST',
        headers: { 'Authorization': KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify([{ keyword: q, location_code: 2840, language_code: 'en_US', depth: 20 }])
      });
      const d = await post.json();
      const id = d.tasks?.[0]?.id;
      if (id) tasks.push({ id, query: q });
      await new Promise(r => setTimeout(r, 200));
    }

    console.log('  Submitted ' + tasks.length + ' searches');
    await new Promise(r => setTimeout(r, 60000));

    // Fetch
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
                  title: item.title,
                  asin: item.data_asin,
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

    // Dedupe
    const seen = new Set();
    const dedup = allResults.filter(r => {
      if (!r.asin || seen.has(r.asin) || existingAsins.has(r.asin)) return false;
      seen.add(r.asin);
      return true;
    });

    // Filter
    const filtered = dedup.filter(r =>
      r.title && r.price && r.image &&
      r.rating && r.rating >= 4.0 &&
      r.reviewsCount >= 50 &&
      r.price >= config.minPrice && r.price <= config.maxPrice &&
      config.include(r.title) &&
      !config.exclude(r.title)
    );

    filtered.sort((a, b) => b.reviewsCount - a.reviewsCount);
    const top = filtered.slice(0, 8);

    console.log('  Filtered: ' + filtered.length + ', taking top: ' + top.length);
    top.forEach(r => console.log('    [' + r.asin + '] $' + r.price + ' ★' + r.rating + ' (' + r.reviewsCount + ') - ' + r.title.substring(0, 60)));

    // Build entries
    let nextId = ID_RANGES[cat];
    while (existingIds.has(nextId)) nextId++;

    const entries = [];
    for (const r of top) {
      const id = nextId++;
      while (existingIds.has(nextId)) nextId++;
      const customFields = config.extractFields(r.title);
      const entry = {
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
      };
      entries.push(entry);
    }

    if (entries.length === 0) continue;

    // Insert into parts.js
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
  console.log('\n✓ Total added: ' + totalAdded + ' products across niche categories');
})();
