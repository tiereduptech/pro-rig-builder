/**
 * apply-amazon-discoveries.cjs
 *
 * Cleans up and applies Amazon discoveries to parts.js.
 * - Fixes brand detection (prioritize first brand mentioned in title, plus heuristic rules)
 * - Detects and SKIPS bundles
 * - Adds products as needsReview: true so they're quarantined until verified
 * - Generates unique IDs that don't collide with existing
 *
 * USAGE:
 *   node apply-amazon-discoveries.cjs              # dry run, show what would be added
 *   node apply-amazon-discoveries.cjs --apply      # write to parts.js
 */

const fs = require('fs');
const { isRenewedTitle } = require('./condition.cjs');
const CC = require('./catalog-classify.cjs');
const APPLY = process.argv.includes('--apply');

// Better brand detection with priority
const BRAND_LIST = [
  // CPU/GPU brands (typically AT START of title)
  { name: 'AMD',           pat: /^AMD\b/i, fallback: /^(ryzen|epyc|threadripper)\b/i },
  { name: 'Intel',         pat: /^Intel\b/i, fallback: /^(core\s*(ultra|i[3579])|xeon|pentium|celeron|arc\s*[ab]\d{3})/i },
  { name: 'NVIDIA',        pat: /^NVIDIA\b/i, fallback: null },
  // GPU partners
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
  // RAM/Storage
  { name: 'Corsair',       pat: /^CORSAIR\b/i },
  { name: 'G.Skill',       pat: /^G\.?SKILL\b/i },
  { name: 'Kingston',      pat: /^Kingston\b/i },
  { name: 'Crucial',       pat: /^Crucial\b/i },
  { name: 'Samsung',       pat: /^SAMSUNG\b/i },
  { name: 'Western Digital', pat: /^(WD|Western Digital|WD_BLACK)\b/i },
  { name: 'Seagate',       pat: /^Seagate\b/i },
  { name: 'SanDisk',       pat: /^SanDisk\b/i },
  { name: 'Lexar',         pat: /^Lexar\b/i },
  { name: 'TeamGroup',     pat: /^(TeamGroup|TEAMGROUP|Team Group|Team)\b/i },
  { name: 'Patriot',       pat: /^Patriot\b/i },
  { name: 'Sabrent',       pat: /^Sabrent\b/i },
  { name: 'KingSpec',      pat: /^KingSpec\b/i },
  { name: 'Inland',        pat: /^Inland\b/i },
  // PSU
  { name: 'Seasonic',      pat: /^Seasonic\b/i },
  { name: 'be quiet!',     pat: /^be\s*quiet!?\b/i },
  { name: 'Thermaltake',   pat: /^Thermaltake\b/i },
  { name: 'Cooler Master', pat: /^Cooler Master\b/i },
  { name: 'FSP',           pat: /^FSP\b/i },
  { name: 'Montech',       pat: /^MONTECH\b/i },
  { name: 'Apevia',        pat: /^Apevia\b/i },
  { name: 'NZXT',          pat: /^NZXT\b/i },
  // Cases
  { name: 'Lian Li',       pat: /^Lian Li\b|^LIAN LI\b/i },
  { name: 'Fractal Design',pat: /^Fractal Design\b/i },
  { name: 'Phanteks',      pat: /^Phanteks\b/i },
  { name: 'Antec',         pat: /^Antec\b/i },
  { name: 'Hyte',          pat: /^HYTE\b/i },
  { name: 'Jonsbo',        pat: /^Jonsbo\b/i },
  { name: 'MUSETEX',       pat: /^MUSETEX\b/i },
  { name: 'Montech',       pat: /^MONTECH\b/i },
  { name: 'DarkFlash',     pat: /^DarkFlash\b/i },
  // Coolers
  { name: 'Noctua',        pat: /^Noctua\b/i },
  { name: 'Arctic',        pat: /^Arctic\b|^ARCTIC\b/i },
  { name: 'Thermalright',  pat: /^Thermalright\b|^THERMALRIGHT\b/i },
  { name: 'Scythe',        pat: /^Scythe\b/i },
  { name: 'DeepCool',      pat: /^DeepCool\b|^DEEPCOOL\b/i },
  { name: 'Cougar',        pat: /^COUGAR\b/i },
  // Peripheral brands
  { name: 'Logitech',     pat: /^Logitech\b|^LOGITECH\b/i },
  { name: 'Razer',        pat: /^Razer\b|^RAZER\b/i },
  { name: 'SteelSeries',  pat: /^SteelSeries\b|^STEELSERIES\b|^Steel\s*Series\b/i },
  { name: 'HyperX',       pat: /^HyperX\b|^HYPERX\b|^Hyper\s*X\b/i },
  { name: 'Glorious',     pat: /^Glorious\b|^GLORIOUS\b/i },
  { name: 'Keychron',     pat: /^Keychron\b|^KEYCHRON\b/i },
  { name: 'Endgame Gear', pat: /^Endgame\s*Gear\b|^ENDGAME\b/i },
  { name: 'Pulsar',       pat: /^Pulsar\b|^PULSAR\b/i },
  { name: 'Finalmouse',   pat: /^Finalmouse\b|^FinalMouse\b/i },
  { name: 'ROCCAT',       pat: /^ROCCAT\b|^Roccat\b/i },
  { name: 'Cherry',       pat: /^Cherry\b|^CHERRY\b/i },
  { name: 'Ducky',        pat: /^Ducky\b|^DUCKY\b/i },
  { name: 'Akko',         pat: /^Akko\b|^AKKO\b/i },
  { name: 'Royal Kludge', pat: /^Royal\s*Kludge\b|^RK\b/i },
  { name: 'Epomaker',     pat: /^Epomaker\b|^EPOMAKER\b/i },
  { name: 'NuPhy',        pat: /^NuPhy\b|^NUPHY\b/i },
  { name: 'Lemokey',      pat: /^Lemokey\b/i },
  { name: 'Redragon',     pat: /^Redragon\b|^REDRAGON\b/i },
  // Audio
  { name: 'Blue',         pat: /^Blue\s+(Yeti|Snowball|Sona|Microphones)/i },
  { name: 'Shure',        pat: /^Shure\b|^SHURE\b/i },
  { name: 'Rode',         pat: /^R[ØO]DE\b|^Rode\b/i },
  { name: 'Audio-Technica',pat: /^Audio[\-\s]?Technica\b/i },
  { name: 'Elgato',       pat: /^Elgato\b|^ELGATO\b/i },
  { name: 'EPOS',         pat: /^EPOS\b/i },
  { name: 'Sennheiser',   pat: /^Sennheiser\b/i },
  { name: 'Beyerdynamic', pat: /^Beyerdynamic\b/i },
  { name: 'Audeze',       pat: /^Audeze\b|^AUDEZE\b/i },
  { name: 'Turtle Beach', pat: /^Turtle\s*Beach\b/i },
  { name: 'JBL',          pat: /^JBL\b/i },
  // Webcam
  { name: 'Insta360',     pat: /^Insta360\b|^INSTA360\b/i },
  { name: 'Anker',        pat: /^Anker\b|^ANKER\b/i },
  { name: 'OBSBOT',       pat: /^OBSBOT\b|^Obsbot\b/i },
  { name: 'AVerMedia',    pat: /^AVerMedia\b|^Avermedia\b/i },
  { name: 'Microsoft',    pat: /^Microsoft\b/i },
  // Mousepad
  { name: 'Artisan',      pat: /^Artisan\b/i },
];

function detectBrand(title) {
  // Strip trademark symbols and normalize whitespace
  const t = (title || '').replace(/[™®©]/g, '').replace(/\s+/g, ' ').trim();
  // Try prefix-match patterns (high confidence)
  for (const b of BRAND_LIST) {
    if (b.pat.test(t)) return b.name;
  }
  // Try fallbacks (e.g. "Ryzen 9..." → AMD)
  for (const b of BRAND_LIST) {
    if (b.fallback && b.fallback.test(t)) return b.name;
  }
  // Last resort: word-boundary contains anywhere
  // Skip risky short brand names that would match common English words
  const RISKY = new Set(['Blue', 'AMD', 'Intel', 'Drop', 'Pulsar', 'Cherry']);
  for (const b of BRAND_LIST) {
    if (RISKY.has(b.name)) continue;
    const escaped = b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&');
    const re = new RegExp('\\b' + escaped + '\\b', 'i');
    if (re.test(t)) return b.name;
  }
  return null;
}

// Detect bundles to exclude
// Reject laptops, prebuilt PCs, all-in-ones, mini-PCs
function isExcluded(title) {
  const t = (title || '').toLowerCase();
  if (/\blaptop\b|\bnotebook\b|\bideapad\b|\blatitude\b|\bidea(centre|pad)\b|\binspiron\b|\bpavilion laptop\b|\bthinkpad\b|\bmacbook\b|\benvy\b\s/i.test(title)) return 'laptop';
  if (/\bgaming pc\b|\bprebuilt\b|\bpre[\-\s]?built\b|\bdesktop computer\b|\bbusiness desktop\b|\btower pc\b|\bmini pc\b/i.test(title)) return 'prebuilt';
  if (/\ball[\-\s]?in[\-\s]?one\b|\baio pc\b/i.test(title)) return 'aio';
  if (/\bworkstation\b/i.test(title) && /\bcomplete\b|\bpc\b|\bsystem\b/i.test(title)) return 'workstation-pc';
  if (/\boptiplex\b|\bthinkcentre\b|\belitedesk\b|\bprodesk\b/i.test(title)) return 'oem-prebuilt';
  return null;
}

function isBundle(title) {
  const t = (title || '').toLowerCase();
  // Multiple major components in one listing
  if (/\bbundle\b|\bcombo\b|\bkit with\b/i.test(title)) return true;
  // Two of these = bundle
  let count = 0;
  if (/\bcpu\b|\bryzen\b|\bcore\s*i\d|\bcore\s*ultra/i.test(t)) count++;
  if (/\bgpu\b|\bgraphics card\b|\brtx\b|\brx\s?\d/i.test(t)) count++;
  if (/\bpsu\b|\bpower supply\b/i.test(t)) count++;
  if (/\bmotherboard\b|\bmobo\b/i.test(t)) count++;
  if (/\bdesktop computer\b|\bgaming pc\b|\bprebuilt\b/i.test(t)) count++;
  return count >= 2;
}

(async () => {
  const stagingPath = './catalog-build/_amazon-discoveries.json';
  if (!fs.existsSync(stagingPath)) {
    console.error('Staging file not found:', stagingPath);
    process.exit(1);
  }
  const staging = JSON.parse(fs.readFileSync(stagingPath, 'utf8'));
  console.log('Loaded discoveries from:', staging.generatedAt);
  console.log('Total discoveries:', staging.totalDiscoveries);

  const m = await import('file://' + process.cwd().replace(/\\/g, '/') + '/src/data/parts.js?t=' + Date.now());
  const parts = [...m.PARTS];
  const existingIds = new Set(parts.map(p => p.id));
  const maxId = Math.max(...parts.map(p => p.id || 0));

  // Generate unique IDs
  function nextId(start) {
    let id = start;
    while (existingIds.has(id)) id++;
    existingIds.add(id);
    return id;
  }

  const added = [];
  const skipped = { bundle: 0, noBrand: 0, noPrice: 0, renewed: 0 };
  let nextNewId = maxId + 1;

  for (const [cat, list] of Object.entries(staging.discoveries)) {
    for (const d of list) {
      // Skip laptops, prebuilts, etc
      const excluded = isExcluded(d.title);
      if (excluded) { skipped[excluded] = (skipped[excluded] || 0) + 1; continue; }
      // Skip bundles
      if (isBundle(d.title) || CC.bundleReason(d.title)) { skipped.bundle++; continue; }
      // CONDITION GATE: a renewed/refurbished/used listing is a different-condition
      // SKU — never attach it to a New-product catalog row (see condition.cjs). This
      // is the gate the Newegg feed already has (conditionMismatch) and the Amazon
      // discovery path was missing.
      if (isRenewedTitle(d.title)) { skipped.renewed++; continue; }
      // Re-detect brand with better logic
      const brand = detectBrand(d.title);
      if (!brand) { skipped.noBrand++; continue; }
      // Skip if no price (can't show it as a deal)
      if (!d.price || d.price <= 0) { skipped.noPrice++; continue; }

      const id = nextId(nextNewId);
      nextNewId = id + 1;

      const product = {
        id,
        c: cat,
        n: d.title,
        b: brand,
        pr: d.price,
        msrp: d.price,
        r: d.rating || null,
        img: d.image || null,
        needsReview: true,   // quarantine until verified
        deals: {
          amazon: {
            asin: d.asin,
            url: 'https://www.amazon.com/dp/' + d.asin + '?tag=tiereduptech-20',
            price: d.price,
            inStock: true,
          },
        },
        ...d.specs,
        addedAt: new Date().toISOString(),
        source: 'amazon-discovery',
      };
      added.push(product);
    }
  }

  console.log('\n--- APPLY RESULTS ---');
  console.log('Mode:', APPLY ? 'APPLY' : 'DRY RUN');
  console.log('New products to add:', added.length);
  console.log('Skipped:');
  Object.entries(skipped).forEach(([k, v]) => console.log('  ' + k + ': ' + v));

  const byCat = {};
  added.forEach(p => byCat[p.c] = (byCat[p.c] || 0) + 1);
  console.log('\nBy category:');
  Object.entries(byCat).sort((a,b) => b[1] - a[1]).forEach(([c, n]) => console.log('  ' + c + ': ' + n));

  console.log('\nFirst 15 to be added:');
  added.slice(0, 15).forEach((p, i) => {
    console.log((i+1) + '. [' + p.c + '] [' + p.b + '] $' + p.pr + ' | ' + p.n.slice(0, 80));
  });

  if (APPLY) {
    parts.push(...added);
    const header = '// Auto-merged catalog. Edit with care.\n';
    const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
    fs.writeFileSync('src/data/parts.js', header + body, 'utf8');
    console.log('\nApplied: ' + added.length + ' new products added to parts.js (needsReview=true, quarantined)');
  } else {
    console.log('\nThis was a DRY RUN. Run with --apply to write to parts.js');
  }
})();
