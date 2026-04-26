// curate-strict-v2.cjs
// V2 adds: product-line aliases (e.g. "ATH-M50X" → Audio-Technica, "Cloud III" → HyperX)

const fs = require('fs');
const path = require('path');

const INPUT_DIR = './catalog-build/amazon-discovery';

// Brand allowlist per category
const BRANDS = {
  mouse: ['Logitech', 'Razer', 'SteelSeries', 'Corsair', 'HyperX', 'Glorious', 'Pulsar',
          'Endgame Gear', 'Zowie', 'BenQ', 'Roccat', 'Cooler Master', 'ASUS', 'ROG',
          'Keychron', 'Pwnage', 'Finalmouse', 'XTRFY', 'Lamzu', 'Redragon', 'VAXEE',
          'NinjaTrail', 'Microsoft', 'Apple'],
  keyboard: ['Logitech', 'Razer', 'Corsair', 'HyperX', 'SteelSeries', 'ASUS', 'ROG',
             'Keychron', 'Akko', 'GMMK', 'Drop', 'Ducky', 'Glorious', 'Redragon',
             'Cooler Master', 'Roccat', 'NuPhy', 'Epomaker', 'Wooting', 'Microsoft',
             'Apple', 'Logi'],
  headset: ['Logitech', 'Razer', 'SteelSeries', 'HyperX', 'Corsair', 'Sennheiser',
            'Audio-Technica', 'Beyerdynamic', 'Astro', 'Astro Gaming', 'Turtle Beach',
            'Bose', 'Sony', 'Drop', 'Cooler Master', 'EPOS', 'JBL', 'Apple'],
  microphone: ['Blue', 'Shure', 'Rode', 'RØDE', 'Elgato', 'Audio-Technica', 'HyperX',
               'Razer', 'Logitech', 'Beyerdynamic', 'Sennheiser', 'AKG', 'Samson',
               'MAONO', 'FIFINE', 'TONOR', 'Yamaha'],
  webcam: ['Logitech', 'Razer', 'Microsoft', 'Elgato', 'Insta360', 'Anker', 'Opal',
           'Aukey', 'AVerMedia', 'OBSBOT', 'EMEET', 'Papalook', 'NexiGo'],
  mousepad: ['SteelSeries', 'Logitech', 'Razer', 'Corsair', 'Glorious', 'HyperX',
             'Pulsar', 'Artisan', 'Cooler Master', 'BenQ', 'Zowie', 'Endgame Gear',
             'Roccat', 'Lethal Gaming', 'XTRFY'],
  extensioncables: ['CableMod', 'Corsair', 'EVGA', 'Lian Li', 'Thermaltake', 'AsiaHorse',
                    'StarTech.com', 'Cable Matters', 'Phanteks', 'NZXT', 'be quiet!',
                    'Antec', 'Seasonic', 'Cooler Master'],
};

// Product-line aliases: regex pattern → brand
// Used when title doesn't contain the brand name explicitly
const PRODUCT_ALIASES = {
  mouse: [
    [/\bM\d{3,4}\b/i, 'Logitech'], // M510, M325, etc.
    [/\bMX\s*(Anywhere|Master|Vertical|Ergo)\b/i, 'Logitech'],
    [/\bG(Pro|502|305|703|703|703|604|703|HUB)\b/i, 'Logitech'],
    [/\bDeathAdder\b/i, 'Razer'],
    [/\bBasilisk\b/i, 'Razer'],
    [/\bViper\b/i, 'Razer'],
    [/\bNaga\b/i, 'Razer'],
    [/\bMamba\b/i, 'Razer'],
    [/\bAerox\b/i, 'SteelSeries'],
    [/\bRival\b/i, 'SteelSeries'],
    [/\bSensei\b/i, 'SteelSeries'],
    [/\bModel\s*[ODX]\b/i, 'Glorious'],
    [/\bPulsefire\b/i, 'HyperX'],
    [/\bScimitar\b/i, 'Corsair'],
    [/\bIronclaw\b/i, 'Corsair'],
    [/\bSabre\b/i, 'Corsair'],
    [/\bM65\b/i, 'Corsair'],
    [/\bEC\d\b/i, 'Zowie'],
    [/\bFK\d\b/i, 'Zowie'],
    [/\bZA\d\b/i, 'Zowie'],
    [/\bS-\d\b/i, 'Zowie'],
  ],
  keyboard: [
    [/\bMK\d{2,3}\b/i, 'Logitech'],
    [/\bMX\s*(Keys|Mechanical)\b/i, 'Logitech'],
    [/\bG\s*(Pro|915|815|413|915|HUB|915 LIGHTSPEED|413|413|913)\b/i, 'Logitech'],
    [/\bApex\s*(Pro|3|5|7|9)/i, 'SteelSeries'],
    [/\bBlackWidow\b/i, 'Razer'],
    [/\bHuntsman\b/i, 'Razer'],
    [/\bCynosa\b/i, 'Razer'],
    [/\bOrnata\b/i, 'Razer'],
    [/\bTartarus\b/i, 'Razer'],
    [/\bK\d{2,3}\b/i, 'Corsair'],
    [/\bAlloy\b/i, 'HyperX'],
    [/\bROG\s+(Strix|Azoth|Falchion|Claymore)/i, 'ASUS'],
    [/\bKBD\d/i, 'GMMK'],
    [/\bErgo\s+K860\b/i, 'Logitech'],
  ],
  headset: [
    [/\bATH-M\d{2,3}/i, 'Audio-Technica'],
    [/\bATH-/i, 'Audio-Technica'],
    [/\bDT\s*\d{3,4}\s*(Pro|PRO)?\b/i, 'Beyerdynamic'],
    [/\bMDR\d{4}/i, 'Sony'],
    [/\bWH-/i, 'Sony'],
    [/\bHD\s*\d{3,4}/i, 'Sennheiser'],
    [/\bMomentum\b/i, 'Sennheiser'],
    [/\bCloud\s*(I|II|III|3|2|Stinger|Flight|Mix|Alpha|Revolver|Core)\b/i, 'HyperX'],
    [/\bArctis\b/i, 'SteelSeries'],
    [/\bBlackShark\b/i, 'Razer'],
    [/\bKraken\b/i, 'Razer'],
    [/\bBarracuda\b/i, 'Razer'],
    [/\bBlackwidow\b/i, 'Razer'],
    [/\bA\d{2}\s+(Wireless|Headset)/i, 'Astro Gaming'],
    [/\bA50\b/i, 'Astro Gaming'],
    [/\bA40\b/i, 'Astro Gaming'],
    [/\bStealth\b/i, 'Turtle Beach'],
    [/\bRecon\b/i, 'Turtle Beach'],
    [/\bQuietComfort\b/i, 'Bose'],
    [/\bPanda\b/i, 'Drop'],
    [/\bH\d{3,4}/i, 'Logitech'],
    [/\bG\s*(Pro|733|432|935|933)/i, 'Logitech'],
    [/\bHS\d/i, 'Corsair'],
    [/\bVoid\b/i, 'Corsair'],
    [/\bVirtuoso\b/i, 'Corsair'],
  ],
  microphone: [
    [/\b(Blue\s*)?Yeti\b/i, 'Blue'],
    [/\bSnowball\b/i, 'Blue'],
    [/\bSM\d{2,3}/i, 'Shure'],
    [/\bMV\d/i, 'Shure'],
    [/\bAT\d{4}/i, 'Audio-Technica'],
    [/\bATR\d/i, 'Audio-Technica'],
    [/\bNT(-USB|\d)/i, 'Rode'],
    [/\bPodMic\b/i, 'Rode'],
    [/\bWave(\s+\d)?\b/i, 'Elgato'],
    [/\bQuadCast\b/i, 'HyperX'],
    [/\bSolocast\b/i, 'HyperX'],
    [/\bSeiren\b/i, 'Razer'],
    [/\bC01U\b/i, 'Samson'],
    [/\bQ\d[a-z]?\b/i, 'Samson'],
  ],
  webcam: [
    [/\bC9\d{2}\b/i, 'Logitech'],   // C920, C922, C925, C930
    [/\bC\d{3,4}/i, 'Logitech'],     // C270, C310, C615, etc.
    [/\bBrio\b/i, 'Logitech'],
    [/\bStreamCam\b/i, 'Logitech'],
    [/\bMX\s*Brio\b/i, 'Logitech'],
    [/\bKiyo\b/i, 'Razer'],
    [/\bFacecam\b/i, 'Elgato'],
    [/\bLifeCam\b/i, 'Microsoft'],
    [/\bPowerConf\b/i, 'Anker'],
  ],
  mousepad: [
    [/\bQcK\b/i, 'SteelSeries'],
    [/\bGoliathus\b/i, 'Razer'],
    [/\bGigantus\b/i, 'Razer'],
    [/\bSphex\b/i, 'Razer'],
    [/\bMM\d{3,4}\b/i, 'Corsair'],
    [/\bG\d{3,4}\s*(Mouse Pad|Cloth|Hard)/i, 'Logitech'],
    [/\bPowerplay\b/i, 'Logitech'],
    [/\bFury\b/i, 'HyperX'],
  ],
  extensioncables: [
    [/\bRM\d{3,4}/i, 'Corsair'],
    [/\bHX\d{3,4}/i, 'Corsair'],
    [/\bAX\d{3,4}/i, 'Corsair'],
  ],
};

const CATEGORY_KEYWORDS = {
  mouse: [/\bmouse\b/i, /\bdeathadder\b/i, /\bbasilisk\b/i, /\bviper\b/i, /\bnaga\b/i],
  keyboard: [/\bkeyboard\b/i, /\bkeypad\b/i, /\bblackwidow\b/i, /\bhuntsman\b/i, /\bapex\b/i],
  headset: [/\bheadset\b/i, /\bheadphone/i, /\bgaming\s+audio\b/i, /\bath-/i, /\bdt\s*\d{3,4}/i, /\bcloud\s/i, /\barctis\b/i, /\bquietcomfort\b/i],
  microphone: [/\bmicrophone\b/i, /\bmic\b/i, /\byeti\b/i, /\bsm\d{2,3}/i, /\bsnowball\b/i, /\bquadcast\b/i, /\bat\d{4}/i, /\bnt-?usb\b/i, /\bpodmic\b/i],
  webcam: [/\bwebcam\b/i, /\bweb\s*camera\b/i, /\bc9\d{2}\b/i, /\bbrio\b/i, /\bfacecam\b/i, /\bkiyo\b/i],
  mousepad: [/\bmouse\s*pad\b/i, /\bmousepad\b/i, /\bdesk\s*mat\b/i, /\bgaming\s*surface\b/i, /\bqck\b/i, /\bgoliathus\b/i, /\bpowerplay\b/i],
  extensioncables: [/\bcable\b/i, /\briser\b/i, /\bextension\b/i, /\badapter\b/i, /\b12vhpwr\b/i],
};

const NEGATIVE_KEYWORDS = {
  mouse: [/mouse\s*pad/i, /mousepad/i, /\bbungee\b/i, /\bglue\b/i, /\bcombo\b/i],
  keyboard: [/keycap/i, /key\s*cap/i, /switch tester/i, /\blube\b/i, /stabilizer/i, /\bcase only\b/i, /palm\s*rest/i, /\bcombo\b/i],
  headset: [/headset stand/i, /\bstand for\b/i, /\bholder\b/i, /\breplacement\b/i, /ear pads?$/i, /splitter/i],
  microphone: [/mic stand/i, /mic\s+arm/i, /pop\s+filter/i, /shock\s*mount/i, /windscreen/i, /\bboom\s+arm\b/i, /\bisolation\s+shield\b/i],
  webcam: [/webcam cover/i, /privacy cover/i, /ring light/i],
  mousepad: [/keyboard/i, /wrist\s*rest/i, /\bbungee\b/i, /coaster/i],
  extensioncables: [/usb\s*cable\b/i, /charging cable/i, /\bhdmi cable\b/i, /\bdisplayport cable\b/i, /\bethernet\b/i, /aux cable/i],
};

function detectBrand(title, allowedBrands, aliasList) {
  if (!title) return null;
  const sorted = [...allowedBrands].sort((a, b) => b.length - a.length);
  for (const brand of sorted) {
    const escaped = brand.replace(/[.*+?^${}()|[\]\\!]/g, '\\$&');
    const re = new RegExp('\\b' + escaped + '\\b', 'i');
    if (re.test(title)) return brand;
  }
  // Check product-line aliases
  for (const [pattern, brand] of (aliasList || [])) {
    if (pattern.test(title)) return brand;
  }
  return null;
}

function passesCategory(title, category) {
  return (CATEGORY_KEYWORDS[category] || []).some(re => re.test(title));
}

function isNegative(title, category) {
  return (NEGATIVE_KEYWORDS[category] || []).some(re => re.test(title));
}

function fallbackBrand(price) {
  if (price && price < 30) return 'Budget';
  return 'Misc';
}

function aggressiveDedupKey(item) {
  const brand = (item.brand || '').toLowerCase();
  const cleanTitle = (item.title || '').toLowerCase()
    .replace(/[\(\[\{].*?[\)\]\}]/g, '')
    .replace(/[,\-:|—–_]/g, ' ')
    .replace(/\d+\s*(dpi|hz|mm|hours|gb|mb|inch|oz|g\b|grams|w\b|watts)/gi, '')
    .replace(/\b(gaming|wireless|wired|usb|rgb|black|white|red|blue|with|the|new|2024|2025|2026|edition|bluetooth|optical|laser|mechanical|membrane|switches|keys|premium|pro|elite|essential|programmable|tactile|linear|ergonomic|customizable|low\s+profile|ultralight|ultra\s*lightweight|hot\s*swappable|by)\b/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(w => w.length > 1 && !/^\d+$/.test(w))
    .slice(0, 4)
    .join(' ');
  return brand + '|' + cleanTitle;
}

const categories = ['mouse', 'keyboard', 'headset', 'microphone', 'webcam', 'mousepad', 'extensioncables'];

console.log('═══ STRICT CLEANUP V2 (with aliases) ═══\n');

let grandTotal = 0;
for (const cat of categories) {
  const inputPath = path.join(INPUT_DIR, 'curated-' + cat + '.json');
  if (!fs.existsSync(inputPath)) continue;

  const initial = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const allowedBrands = BRANDS[cat] || [];
  const aliases = PRODUCT_ALIASES[cat] || [];

  const stats = { initial: initial.length, rating: 0, category: 0, negative: 0, dupes: 0, kept: 0, branded: 0, budget: 0, misc: 0 };

  let items = initial.filter(item => {
    if ((item.rating || 0) < 4.0) { stats.rating++; return false; }
    if (!passesCategory(item.title, cat)) { stats.category++; return false; }
    if (isNegative(item.title, cat)) { stats.negative++; return false; }
    return true;
  });

  for (const item of items) {
    const detected = detectBrand(item.title, allowedBrands, aliases);
    if (detected) {
      item.brand = detected;
      stats.branded++;
    } else {
      item.brand = fallbackBrand(item.price);
      if (item.brand === 'Budget') stats.budget++;
      else stats.misc++;
    }
  }

  const seen = new Map();
  for (const item of items) {
    const key = aggressiveDedupKey(item);
    const existing = seen.get(key);
    if (!existing || (item._score || 0) > (existing._score || 0)) {
      if (existing) stats.dupes++;
      seen.set(key, item);
    } else {
      stats.dupes++;
    }
  }
  items = [...seen.values()];

  stats.kept = items.length;
  grandTotal += items.length;
  fs.writeFileSync(inputPath, JSON.stringify(items, null, 2));

  console.log(cat.toUpperCase());
  console.log('  initial:' + stats.initial + ' | rejected: rating=' + stats.rating + ' wrong-cat=' + stats.category + ' negative=' + stats.negative + ' dupes=' + stats.dupes);
  console.log('  kept: ' + stats.kept + ' (branded=' + stats.branded + ', Budget=' + stats.budget + ', Misc=' + stats.misc + ')');
  console.log('  Top 5:');
  items.slice(0, 5).forEach((p, i) => {
    console.log('    ' + (i+1) + '. ' + p.brand.padEnd(15) + ' | $' + (p.price+'').padEnd(7) + ' | ' + p.rating + '★ ' + (p.reviews+'').padEnd(7) + ' | ' + p.title.substring(0, 60));
  });
  console.log('');
}

console.log('═══ TOTAL: ' + grandTotal + ' curated products ═══');
