/**
 * fix-brand-attribution.cjs
 * 
 * Re-detects brand on products that may have wrong attribution
 * (especially peripherals tagged AMD/Intel/NVIDIA).
 */

const fs = require('fs');
const APPLY = process.argv.includes('--apply');

// Match BRAND_LIST from apply-amazon-discoveries.cjs
const BRAND_LIST = [
  { name: 'AMD',           pat: /^AMD\b/i, fallback: /^(ryzen|epyc|threadripper)\b/i },
  { name: 'Intel',         pat: /^Intel\b/i, fallback: /^(core\s*(ultra|i[3579])|xeon|pentium|celeron|arc\s*[ab]\d{3})/i },
  { name: 'NVIDIA',        pat: /^NVIDIA\b/i },
  { name: 'ASUS',          pat: /^ASUS\b|^(ROG|TUF|Prime|ProArt|Strix|Dual)\s/i },
  { name: 'MSI',           pat: /^MSI\b/i },
  { name: 'Gigabyte',      pat: /^GIGABYTE\b|^AORUS\b/i },
  { name: 'ASRock',        pat: /^ASRock\b/i },
  { name: 'PNY',           pat: /^PNY\b/i },
  { name: 'EVGA',          pat: /^EVGA\b/i },
  { name: 'Zotac',         pat: /^ZOTAC\b/i },
  { name: 'XFX',           pat: /^XFX\b/i },
  { name: 'Sapphire',      pat: /^SAPPHIRE\b/i },
  { name: 'PowerColor',    pat: /^POWERCOLOR\b/i },
  { name: 'Corsair',       pat: /^CORSAIR\b/i },
  { name: 'G.Skill',       pat: /^G\.?SKILL\b/i },
  { name: 'Kingston',      pat: /^Kingston\b/i },
  { name: 'Crucial',       pat: /^Crucial\b/i },
  { name: 'Samsung',       pat: /^SAMSUNG\b/i },
  { name: 'Western Digital',pat: /^(WD|Western Digital|WD_BLACK)\b/i },
  { name: 'Seagate',       pat: /^Seagate\b/i },
  { name: 'SanDisk',       pat: /^SanDisk\b/i },
  { name: 'Lexar',         pat: /^Lexar\b/i },
  { name: 'TeamGroup',     pat: /^(TeamGroup|TEAMGROUP|Team Group|Team)\b/i },
  { name: 'Patriot',       pat: /^Patriot\b/i },
  { name: 'Sabrent',       pat: /^Sabrent\b/i },
  { name: 'KingSpec',      pat: /^KingSpec\b/i },
  { name: 'Inland',        pat: /^Inland\b/i },
  { name: 'Seasonic',      pat: /^Seasonic\b/i },
  { name: 'be quiet!',     pat: /^be\s*quiet!?\b/i },
  { name: 'Thermaltake',   pat: /^Thermaltake\b/i },
  { name: 'Cooler Master', pat: /^Cooler Master\b/i },
  { name: 'FSP',           pat: /^FSP\b/i },
  { name: 'Montech',       pat: /^MONTECH\b/i },
  { name: 'Apevia',        pat: /^Apevia\b/i },
  { name: 'NZXT',          pat: /^NZXT\b/i },
  { name: 'Lian Li',       pat: /^Lian Li\b|^LIAN LI\b/i },
  { name: 'Fractal Design',pat: /^Fractal Design\b/i },
  { name: 'Phanteks',      pat: /^Phanteks\b/i },
  { name: 'Antec',         pat: /^Antec\b/i },
  { name: 'Hyte',          pat: /^HYTE\b/i },
  { name: 'Jonsbo',        pat: /^Jonsbo\b/i },
  { name: 'MUSETEX',       pat: /^MUSETEX\b/i },
  { name: 'DarkFlash',     pat: /^DarkFlash\b/i },
  { name: 'Noctua',        pat: /^Noctua\b/i },
  { name: 'Arctic',        pat: /^Arctic\b|^ARCTIC\b/i },
  { name: 'Thermalright',  pat: /^Thermalright\b|^THERMALRIGHT\b/i },
  { name: 'Scythe',        pat: /^Scythe\b/i },
  { name: 'DeepCool',      pat: /^DeepCool\b|^DEEPCOOL\b/i },
  { name: 'Cougar',        pat: /^COUGAR\b/i },
  { name: 'Logitech',      pat: /^Logitech\b|^LOGITECH\b/i },
  { name: 'Razer',         pat: /^Razer\b|^RAZER\b/i },
  { name: 'SteelSeries',   pat: /^SteelSeries\b|^STEELSERIES\b|^Steel\s*Series\b/i },
  { name: 'HyperX',        pat: /^HyperX\b|^HYPERX\b|^Hyper\s*X\b/i },
  { name: 'Glorious',      pat: /^Glorious\b|^GLORIOUS\b/i },
  { name: 'Keychron',      pat: /^Keychron\b|^KEYCHRON\b/i },
  { name: 'Endgame Gear',  pat: /^Endgame\s*Gear\b|^ENDGAME\b/i },
  { name: 'Finalmouse',    pat: /^Finalmouse\b|^FinalMouse\b/i },
  { name: 'ROCCAT',        pat: /^ROCCAT\b|^Roccat\b/i },
  { name: 'Ducky',         pat: /^Ducky\b|^DUCKY\b/i },
  { name: 'Akko',          pat: /^Akko\b|^AKKO\b/i },
  { name: 'Royal Kludge',  pat: /^Royal\s*Kludge\b|^RK\b/i },
  { name: 'Epomaker',      pat: /^Epomaker\b|^EPOMAKER\b/i },
  { name: 'NuPhy',         pat: /^NuPhy\b|^NUPHY\b/i },
  { name: 'Lemokey',       pat: /^Lemokey\b/i },
  { name: 'Redragon',      pat: /^Redragon\b|^REDRAGON\b/i },
  { name: 'Blue',          pat: /^Blue\s+(Yeti|Snowball|Sona|Microphones)/i },
  { name: 'Shure',         pat: /^Shure\b|^SHURE\b/i },
  { name: 'Rode',          pat: /^R[ØO]DE\b|^Rode\b/i },
  { name: 'Audio-Technica',pat: /^Audio[\-\s]?Technica\b/i },
  { name: 'Elgato',        pat: /^Elgato\b|^ELGATO\b/i },
  { name: 'EPOS',          pat: /^EPOS\b/i },
  { name: 'Sennheiser',    pat: /^Sennheiser\b/i },
  { name: 'Beyerdynamic',  pat: /^Beyerdynamic\b/i },
  { name: 'Audeze',        pat: /^Audeze\b|^AUDEZE\b/i },
  { name: 'Turtle Beach',  pat: /^Turtle\s*Beach\b/i },
  { name: 'JBL',           pat: /^JBL\b/i },
  { name: 'Insta360',      pat: /^Insta360\b|^INSTA360\b/i },
  { name: 'Anker',         pat: /^Anker\b|^ANKER\b/i },
  { name: 'OBSBOT',        pat: /^OBSBOT\b|^Obsbot\b/i },
  { name: 'AVerMedia',     pat: /^AVerMedia\b|^Avermedia\b/i },
  { name: 'Microsoft',     pat: /^Microsoft\b/i },
  { name: 'Artisan',       pat: /^Artisan\b/i },
];

const RISKY = new Set(['Blue', 'AMD', 'Intel', 'Drop', 'Pulsar', 'Cherry']);

function detectBrand(title) {
  const t = (title || '').replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim();
  for (const b of BRAND_LIST) if (b.pat.test(t)) return b.name;
  for (const b of BRAND_LIST) if (b.fallback && b.fallback.test(t)) return b.name;
  for (const b of BRAND_LIST) {
    if (RISKY.has(b.name)) continue;
    const escaped = b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp('\\b' + escaped + '\\b', 'i').test(t)) return b.name;
  }
  return null;
}

(async () => {
  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...m.PARTS];

  // Focus on peripherals + any product where brand looks wrong
  let fixed = 0;
  const changes = [];

  for (const p of parts) {
    if (!p.b) continue;
    const detected = detectBrand(p.n);
    // Only correct if detected != current AND current is one of the risky names
    if (!detected) continue;
    if (detected === p.b) continue;
    // Only fix if current brand is a "risky" attribution
    if (!RISKY.has(p.b)) continue;
    fixed++;
    if (changes.length < 20) changes.push({ id: p.id, c: p.c, from: p.b, to: detected, n: p.n.slice(0, 80) });
    if (APPLY) p.b = detected;
  }

  console.log('Mode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('Fixed brand attributions:', fixed);
  console.log('\nFirst 20 changes:');
  changes.forEach(c => console.log('  [' + c.c + '] ' + c.from + ' -> ' + c.to + ' | ' + c.n));

  if (APPLY) {
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log('\nApplied.');
  }
})();
