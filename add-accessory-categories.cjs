const fs = require('fs');
const p = 'dataforseo-discover.js';
let s = fs.readFileSync(p, 'utf8');

// =====================================================================
// 1. Add accessory categories to QUERIES (insert after CaseFan)
// =====================================================================
const oldQueriesEnd = `  CaseFan: [`;
// Find the end of CaseFan's array
const caseFanIdx = s.indexOf(oldQueriesEnd);
if (caseFanIdx < 0) { console.log('FATAL: CaseFan anchor missing'); process.exit(1); }

// Find the closing ] of CaseFan's array (the line right before "};" of QUERIES)
// CaseFan starts at line 127, queries const ends at "};" - find that
const queriesCloseIdx = s.indexOf('\n};\n', caseFanIdx);
if (queriesCloseIdx < 0) { console.log('FATAL: QUERIES close brace missing'); process.exit(1); }

const newCategoriesQueries = `  Mouse: [
    'gaming mouse', 'wireless gaming mouse', 'esports mouse', 'lightweight gaming mouse',
    'Logitech G Pro mouse', 'Logitech G502', 'Logitech MX Master',
    'Razer DeathAdder', 'Razer Viper', 'Razer Basilisk',
    'Glorious Model O', 'Glorious Model D',
    'Corsair gaming mouse', 'SteelSeries Aerox', 'SteelSeries Rival',
    'Pulsar gaming mouse', 'Endgame Gear mouse', 'Zowie mouse',
  ],
  Keyboard: [
    'gaming keyboard', 'mechanical keyboard', 'wireless mechanical keyboard',
    'TKL gaming keyboard', '60% mechanical keyboard', '75% mechanical keyboard',
    'Logitech G Pro keyboard', 'Logitech MX Keys',
    'Razer Huntsman', 'Razer BlackWidow', 'Razer Cynosa',
    'Corsair K70', 'Corsair K100', 'Corsair gaming keyboard',
    'SteelSeries Apex', 'Keychron mechanical keyboard',
    'GMMK keyboard', 'Akko mechanical keyboard', 'Drop keyboard',
  ],
  Headset: [
    'gaming headset', 'wireless gaming headset', 'wired gaming headset',
    'Logitech G Pro headset', 'Logitech G733',
    'Razer BlackShark', 'Razer Kraken',
    'SteelSeries Arctis Nova', 'SteelSeries Arctis 7',
    'HyperX Cloud', 'HyperX Cloud III',
    'Sennheiser HD 560S', 'Sennheiser HD 600', 'Audio-Technica gaming',
    'Astro A50', 'Beyerdynamic DT 770', 'Drop headphones',
  ],
  Microphone: [
    'USB microphone', 'streaming microphone', 'podcast microphone',
    'Blue Yeti', 'Blue Yeti X', 'Blue Snowball',
    'Shure MV7', 'Shure SM7B', 'Shure MV6',
    'Elgato Wave', 'HyperX QuadCast', 'Razer Seiren',
    'Rode NT-USB', 'Rode PodMic', 'Audio-Technica AT2020',
  ],
  Webcam: [
    '1080p webcam', '4K webcam', 'streaming webcam',
    'Logitech C920', 'Logitech Brio', 'Logitech StreamCam',
    'Razer Kiyo', 'Razer Kiyo Pro', 'Razer Kiyo Pro Ultra',
    'Elgato Facecam', 'Insta360 webcam', 'Anker PowerConf',
    'Opal C1', 'Aukey webcam',
  ],
  MousePad: [
    'large gaming mousepad', 'XL gaming mousepad', 'desk mat XXL',
    'Logitech G840', 'Razer Goliathus Extended', 'Razer Gigantus',
    'SteelSeries QcK', 'SteelSeries QcK Heavy', 'SteelSeries QcK Prism',
    'Corsair MM700', 'Glorious 3XL mousepad', 'HyperX Fury mousepad',
    'Pulsar mousepad', 'Artisan mousepad',
  ],
  ExtensionCables: [
    'PCIe riser cable', 'PCIe 4.0 riser cable', 'PCIe extension cable',
    'GPU power extension cable', '24-pin ATX extension cable', 'EPS 8-pin extension cable',
    'cable extension kit PSU', 'CableMod extension', 'Lian Li PCIe riser',
    'Thermaltake riser cable', 'CORSAIR Premium PSU cables', 'PCIe 5.0 cable',
    'GPU sag bracket', '12VHPWR adapter cable',
  ],
`;

s = s.substring(0, queriesCloseIdx + 1) + newCategoriesQueries + s.substring(queriesCloseIdx + 1);
console.log('✓ Added 7 accessory categories to QUERIES');

// =====================================================================
// 2. Add filter rules for the 7 categories (after CaseFan filter)
// =====================================================================
const filterAnchor = `  CaseFan:     { minPrice: 8,   maxPrice: 200,  minReviews: 2,  titleMustInclude: /fan|cooling/i },`;
const filterIdx = s.indexOf(filterAnchor);
if (filterIdx < 0) { console.log('FATAL: CaseFan filter anchor missing'); process.exit(1); }

const newFilters = `  CaseFan:     { minPrice: 8,   maxPrice: 200,  minReviews: 2,  titleMustInclude: /fan|cooling/i },
  Mouse:           { minPrice: 15,  maxPrice: 250,  minReviews: 50, titleMustInclude: /mouse|wireless/i },
  Keyboard:        { minPrice: 25,  maxPrice: 400,  minReviews: 30, titleMustInclude: /keyboard|mechanical|tkl|gaming/i },
  Headset:         { minPrice: 30,  maxPrice: 700,  minReviews: 30, titleMustInclude: /headset|headphone|gaming audio/i },
  Microphone:      { minPrice: 30,  maxPrice: 500,  minReviews: 30, titleMustInclude: /microphone|mic|podcast|streaming/i },
  Webcam:          { minPrice: 25,  maxPrice: 500,  minReviews: 30, titleMustInclude: /webcam|camera|streaming/i },
  MousePad:        { minPrice: 8,   maxPrice: 100,  minReviews: 30, titleMustInclude: /mouse\\s*pad|mousepad|desk mat/i },
  ExtensionCables: { minPrice: 5,   maxPrice: 200,  minReviews: 10, titleMustInclude: /cable|riser|extension|adapter/i },`;

s = s.replace(filterAnchor, newFilters);
console.log('✓ Added 7 accessory filter rules');

fs.writeFileSync(p, s);
console.log('\nDONE. New categories supported:');
console.log('  Mouse, Keyboard, Headset, Microphone, Webcam, MousePad, ExtensionCables');
