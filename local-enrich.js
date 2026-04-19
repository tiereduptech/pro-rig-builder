/**
 * local-enrich.js — enrich discovered Amazon products without any API calls
 *
 * Input:  catalog-build/amazon-discovery/{category}.json
 * Output: catalog-build/enriched/{category}.json
 *
 * Does:
 *   - Extracts brand from title
 *   - Parses category-specific specs (socket/chipset, capacity/speed, wattage, etc.)
 *   - Cleans product name (strips marketing copy)
 *   - Normalizes Amazon URL to minimal form (dp/{asin}?tag=...)
 *   - Dedupes near-duplicates (same model, different bundles)
 *   - Sorts by popularity (boughtPastMonth desc, then reviews desc)
 *
 * USAGE:
 *   node local-enrich.js                   # all categories
 *   node local-enrich.js --category cpu    # one category
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';

const INPUT_DIR = './catalog-build/amazon-discovery';
const OUTPUT_DIR = './catalog-build/enriched';

const args = process.argv.slice(2);
const getFlag = (name, hasValue = false) => {
  const i = args.indexOf(name);
  if (i === -1) return hasValue ? null : false;
  return hasValue ? args[i + 1] : true;
};
const flags = {
  category: getFlag('--category', true),
};

// ─────────────────────────────────────────────────────────────────────────────
// Brand extraction — prioritized patterns
//
// Strategy: most-specific first. Match product-line names that imply a brand
// BEFORE falling back to direct brand name matches. Order matters.
// ─────────────────────────────────────────────────────────────────────────────

const BRAND_PATTERNS = [
  // ─── Motherboard brand inference from product line ───
  // MSI: MEG/MPG/MAG are proprietary product families
  { re: /\b(MEG|MPG|MAG)\s+[A-Z0-9]/i, name: 'MSI' },
  // ASUS: ROG / TUF / Prime / ProArt are proprietary
  { re: /\b(ROG\s+(Strix|Crosshair|Maximus|Hero|Apex|Extreme|Rampage)|TUF\s+Gaming|TUF\s+[A-Z]|ProArt|Prime\s+[A-Z]|Strix\s+[A-Z])/i, name: 'ASUS' },
  // Gigabyte: AORUS is proprietary
  { re: /\bAORUS\b/i, name: 'Gigabyte' },
  // ASRock: Phantom Gaming / Taichi / Steel Legend / Nova are proprietary
  { re: /\b(Phantom\s+Gaming|Steel\s+Legend|Taichi\b)/i, name: 'ASRock' },

  // ─── Direct brand-name match (motherboard/GPU/PSU/case brands) ───
  { re: /\bASUS\b/i, name: 'ASUS' },
  { re: /\bMSI\b/i, name: 'MSI' },
  { re: /\bGIGABYTE\b/i, name: 'Gigabyte' },
  { re: /\bASRock\b/i, name: 'ASRock' },
  { re: /\bNZXT\b/i, name: 'NZXT' },
  { re: /\bEVGA\b/i, name: 'EVGA' },
  { re: /\bBiostar\b/i, name: 'Biostar' },

  // ─── CPUs ───
  // Ryzen/Threadripper always = AMD
  { re: /\bRyzen\b|\bThreadripper\b|\bAthlon\b/i, name: 'AMD' },
  // Core i-series / Core Ultra always = Intel
  { re: /\bCore\s+(i[3579]|Ultra)\b|\bIntel\b|\bXeon\b|\bPentium\b|\bCeleron\b/i, name: 'Intel' },
  { re: /\bAMD\b/i, name: 'AMD' },

  // ─── GPU partner brands ───
  { re: /\bPNY\b/i, name: 'PNY' },
  { re: /\bZOTAC\b/i, name: 'ZOTAC' },
  { re: /\bSapphire\b/i, name: 'Sapphire' },
  { re: /\bPowerColor\b/i, name: 'PowerColor' },
  { re: /\bXFX\b/i, name: 'XFX' },
  { re: /\bYeston\b/i, name: 'Yeston' },
  { re: /\bGainward\b/i, name: 'Gainward' },
  { re: /\bINNO3D\b/i, name: 'INNO3D' },
  { re: /\bGalax(y)?\b/i, name: 'Galax' },

  // ─── RAM: brand inference from product line ───
  // Samsung RAM is rare on Amazon; major RAM brands:
  { re: /\bVengeance\b/i, name: 'Corsair' },              // Corsair's memory line
  { re: /\bTrident\s+Z/i, name: 'G.Skill' },             // G.Skill's memory line
  { re: /\bFURY\s+(Beast|Renegade|Impact)/i, name: 'Kingston' },  // Kingston FURY family
  { re: /\bBallistix\b/i, name: 'Crucial' },             // Crucial/Micron's memory line
  { re: /\bT-Force\b|\bT-Create\b/i, name: 'TeamGroup' }, // TeamGroup's memory line
  { re: /\bDominator\b/i, name: 'Corsair' },             // Corsair flagship DDR5

  // ─── RAM: direct brand names ───
  { re: /\bCorsair\b/i, name: 'Corsair' },
  { re: /\bG\.?Skill\b/i, name: 'G.Skill' },
  { re: /\bKingston\b/i, name: 'Kingston' },
  { re: /\bCrucial\b/i, name: 'Crucial' },
  { re: /\b(Team(Group)?)\b/i, name: 'TeamGroup' },
  { re: /\bPatriot\b/i, name: 'Patriot' },
  { re: /\bADATA\b/i, name: 'ADATA' },
  { re: /\bSilicon\s+Power\b/i, name: 'Silicon Power' },
  { re: /\bGIGASTONE\b/i, name: 'Gigastone' },
  { re: /\bTimetec\b/i, name: 'Timetec' },
  { re: /\bOLOy\b/i, name: 'OLOy' },
  { re: /\bA-Tech\b/i, name: 'A-Tech' },

  // ─── Storage: product line → brand ───
  // Samsung: 990 PRO/EVO, 980 PRO, 870 EVO/QVO are all Samsung
  { re: /\b(990\s+(PRO|EVO)|980\s+PRO|970\s+(EVO|PRO)|870\s+(EVO|QVO|PRO)|860\s+(EVO|QVO|PRO))\b/i, name: 'Samsung' },
  // WD: WD_Black, SN850X, SN770, SN5000, SN7100, etc.
  { re: /\bWD[_\s]?(Black|Blue|Red|Green|Elements|Gold)\b|\bSN\d{3,4}[A-Z]?\b/i, name: 'WD' },
  // Seagate: BarraCuda, IronWolf, FireCuda, Exos
  { re: /\b(BarraCuda|IronWolf|FireCuda|Exos|SkyHawk)\b/i, name: 'Seagate' },
  // Crucial: BX500, MX500, T500, T700, T705, P5, P3 are all Crucial SSDs
  { re: /\b(BX500|MX500|T[357]00|T705|P[35]\s+Plus|P[35]\b)\b/i, name: 'Crucial' },
  // Kingston: KC3000, NV2, A2000, etc.
  { re: /\b(KC\d{3,4}|NV[23]|A2000)\b/i, name: 'Kingston' },
  // SanDisk
  { re: /\bSanDisk\b/i, name: 'SanDisk' },

  // ─── Storage: direct brand ───
  { re: /\bSamsung\b/i, name: 'Samsung' },
  { re: /\bWestern\s+Digital\b|\bWD\b/i, name: 'WD' },
  { re: /\bSeagate\b/i, name: 'Seagate' },
  { re: /\bSabrent\b/i, name: 'Sabrent' },
  { re: /\bSK\s*Hynix\b/i, name: 'SK Hynix' },
  { re: /\bTEAMGROUP\b/i, name: 'TeamGroup' },
  { re: /\bLexar\b/i, name: 'Lexar' },
  { re: /\bAddlink\b/i, name: 'Addlink' },
  { re: /\bSolidigm\b/i, name: 'Solidigm' },
  { re: /\bNetac\b/i, name: 'Netac' },

  // ─── PSU: product line → brand ───
  // Corsair: RM/RMx/RMe/HX/AX/SF series
  { re: /\bRM\d{3,4}[a-z]?\b|\bHX\d{3,4}\b|\bAX\d{3,4}\b|\bSF\d{3,4}\b/i, name: 'Corsair' },
  // Thermaltake: Toughpower, Smart, GF family
  { re: /\bToughpower\b/i, name: 'Thermaltake' },
  // EVGA SuperNOVA
  { re: /\bSuperNOVA\b/i, name: 'EVGA' },
  // Seasonic Focus / Prime
  { re: /\bSeasonic\s+(Focus|Prime|Core)\b/i, name: 'Seasonic' },

  // ─── PSU: direct brand ───
  { re: /\bSeasonic\b/i, name: 'Seasonic' },
  { re: /\bbe\s*quiet!?\b/i, name: 'be quiet!' },
  { re: /\bThermaltake\b/i, name: 'Thermaltake' },
  { re: /\bSilverStone\b/i, name: 'SilverStone' },
  { re: /\bFSP\b/i, name: 'FSP' },
  { re: /\bCooler\s+Master\b/i, name: 'Cooler Master' },
  { re: /\bMontech\b/i, name: 'Montech' },
  { re: /\bXPG\b/i, name: 'XPG' },
  { re: /\bSUPER\s*FLOWER\b/i, name: 'Super Flower' },

  // ─── Case brands ───
  { re: /\bLian\s*Li\b/i, name: 'Lian Li' },
  { re: /\bO11D\b|\bO11\s+Dynamic\b/i, name: 'Lian Li' },      // Lian Li's O11 family
  { re: /\bFractal\s+Design\b/i, name: 'Fractal Design' },
  { re: /\bMeshify\b|\bNorth\b.*\bPC\b|\bTorrent\b/i, name: 'Fractal Design' },  // Fractal product lines
  { re: /\bHYTE\b/i, name: 'HYTE' },
  { re: /\bPhanteks\b/i, name: 'Phanteks' },
  { re: /\bDeepcool\b/i, name: 'Deepcool' },
  { re: /\bDARKROCK\b/i, name: 'DARKROCK' },
  { re: /\bMUSETEX\b/i, name: 'MUSETEX' },
  { re: /\bJonsbo\b/i, name: 'Jonsbo' },
  { re: /\bAntec\b/i, name: 'Antec' },
  { re: /\bSegotep\b/i, name: 'Segotep' },
  { re: /\bSAMA\b/i, name: 'SAMA' },
  { re: /\bInWin\b|\bIn\s+Win\b/i, name: 'InWin' },
  { re: /\bGamdias\b/i, name: 'Gamdias' },
  { re: /\bAerocool\b/i, name: 'Aerocool' },
  { re: /\bRaidmax\b/i, name: 'Raidmax' },
  { re: /\bCorsair\b/i, name: 'Corsair' },  // has case line too

  // ─── Cooler brands ───
  { re: /\bNoctua\b|\bNH-[A-Z]\d/i, name: 'Noctua' },
  { re: /\bArctic\b|\bP1[24]\s+(Pro\s+)?PST\b|\bLiquid\s+Freezer\b/i, name: 'Arctic' },
  { re: /\bThermalright\b|\bPeerless\s+Assassin\b/i, name: 'Thermalright' },
  { re: /\bDark\s+Rock\b/i, name: 'be quiet!' },
  { re: /\bID-COOLING\b/i, name: 'ID-COOLING' },
  { re: /\bENDORFY\b/i, name: 'ENDORFY' },
  { re: /\bKraken\b/i, name: 'NZXT' },    // NZXT Kraken coolers
  { re: /\biCUE\s+H\d{3}i\b|\biCUE\s+Titan\b/i, name: 'Corsair' },  // Corsair coolers
  { re: /\bGalahad\b/i, name: 'Lian Li' },  // Lian Li Galahad
  { re: /\bHyper\s+2\d{2}\b/i, name: 'Cooler Master' },
  { re: /\bAK620\b|\bAK400\b/i, name: 'Deepcool' },

  // ─── Monitor brands ───
  { re: /\bLG\b/i, name: 'LG' },
  { re: /\bUltraGear\b/i, name: 'LG' },
  { re: /\bDell\b/i, name: 'Dell' },
  { re: /\bAlienware\b/i, name: 'Alienware' },
  { re: /\bAOC\b/i, name: 'AOC' },
  { re: /\bBenQ\b/i, name: 'BenQ' },
  { re: /\bViewSonic\b/i, name: 'ViewSonic' },
  { re: /\bAcer\b/i, name: 'Acer' },
  { re: /\bHP\b/i, name: 'HP' },
  { re: /\bPhilips\b/i, name: 'Philips' },
  { re: /\bKTC\b/i, name: 'KTC' },
  { re: /\bInnocn\b/i, name: 'Innocn' },
  { re: /\bSceptre\b/i, name: 'Sceptre' },
  { re: /\bSansui\b|\bSANSUI\b/i, name: 'Sansui' },
  { re: /\bcocopar\b/i, name: 'cocopar' },
  { re: /\bAmazon\s+Basics\b/i, name: 'Amazon Basics' },
  { re: /\bKoorui\b/i, name: 'Koorui' },
  { re: /\bViotek\b/i, name: 'Viotek' },
  { re: /\bPixio\b/i, name: 'Pixio' },
  { re: /\bTitan\s+Army\b/i, name: 'Titan Army' },
  { re: /\bMSI\s+(MAG|MPG|MEG)\s+\d/i, name: 'MSI' }, // MSI monitor lines
  { re: /\bOdyssey\b/i, name: 'Samsung' },  // Samsung Odyssey monitor line

  // ─── Case fan product-line inference ───
  { re: /\bNF-[AFP]\d/i, name: 'Noctua' },    // Noctua fan models
  { re: /\bP1[24]\s+(Pro\s+)?(PST|Black|5\s+Pack)?\b/i, name: 'Arctic' }, // Arctic P12/P14
  { re: /\bRS120\b|\bRiing\b|\bPure\s+Plus\b/i, name: 'Thermaltake' },
  { re: /\bSilent\s+Wings\b|\bPure\s+Wings\b|\bLight\s+Wings\b/i, name: 'be quiet!' },
  { re: /\bUNI\s*Fan\b|\bSL[- ]?INF\b|\bSL120\b|\bSL140\b/i, name: 'Lian Li' },
  { re: /\bQL120\b|\bLL120\b|\bSP120\b|\bML120\b|\bAF120\b/i, name: 'Corsair' },
  { re: /\bFD-F\b|\bAspect\b|\bDynamic\s+X2\b/i, name: 'Fractal Design' },
];

function extractBrand(title) {
  for (const { re, name } of BRAND_PATTERNS) {
    if (re.test(title)) return name;
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Spec extraction per category
// ─────────────────────────────────────────────────────────────────────────────

function extractMotherboardSpecs(title) {
  const s = {};
  const socket = title.match(/\b(AM4|AM5|sTR5|LGA\s*1700|LGA\s*1851|LGA\s*2066|LGA\s*4677)\b/i);
  if (socket) s.socket = socket[1].toUpperCase().replace(/\s/g, '');

  const chipset = title.match(/\b(X870E|X870|B850E|B850|B840|A620|X670E|X670|B650E|B650|Z890|Z790|B860|B760|H810|H610)\b/i);
  if (chipset) s.chipset = chipset[1].toUpperCase();

  // Order matters: check specific patterns before generic ATX/ITX
  if      (/\b(Micro[- ]ATX|mATX|M-ATX)\b/i.test(title)) s.formFactor = 'mATX';
  else if (/\b(Mini[- ]ITX)\b/i.test(title))             s.formFactor = 'Mini-ITX';
  else if (/\b(E-ATX|EATX)\b/i.test(title))              s.formFactor = 'E-ATX';
  else if (/\bATX\b/i.test(title))                       s.formFactor = 'ATX';
  else if (/\bITX\b/i.test(title))                       s.formFactor = 'ITX';

  return s;
}

function extractCpuSpecs(title) {
  const s = {};
  const ryzen = title.match(/\bRyzen\s+(3|5|7|9)\s+(\d{4}(?:X3D|X|G|GE|GX|F)?)/i);
  if (ryzen) { s.series = `Ryzen ${ryzen[1]}`; s.model = ryzen[2]; s.socket = 'AM5'; }

  const intelCore = title.match(/\bCore\s+(?:Ultra\s+)?(i3|i5|i7|i9|[3579])\s*-?\s*(\d{4,5}[A-Z]{0,3})/i);
  if (intelCore) { s.series = `Core ${intelCore[1]}`; s.model = intelCore[2]; s.socket = /14\d00|13\d00|12\d00/.test(intelCore[2]) ? 'LGA1700' : 'LGA1851'; }

  const cores = title.match(/\b(\d+)[- ]?[cC]ore/);
  if (cores) s.cores = parseInt(cores[1]);

  return s;
}

function extractGpuSpecs(title) {
  const s = {};
  const rtx = title.match(/\bRTX\s+(\d{4})(\s+Ti)?(\s+Super)?/i);
  if (rtx) {
    s.model = `RTX ${rtx[1]}${rtx[2] || ''}${rtx[3] || ''}`.replace(/\s+/g, ' ').trim();
    const digit = rtx[1].charAt(0);
    s.generation = digit === '5' ? 'RTX 50' : digit === '4' ? 'RTX 40' : digit === '3' ? 'RTX 30' : digit === '2' ? 'RTX 20' : 'Older';
  }
  const rx = title.match(/\bRX\s+(\d{4})\s*(XT|GRE)?/i);
  if (rx) {
    s.model = `RX ${rx[1]}${rx[2] ? ' ' + rx[2].toUpperCase() : ''}`;
    const digit = rx[1].charAt(0);
    s.generation = digit === '9' ? 'RX 9000' : digit === '7' ? 'RX 7000' : digit === '6' ? 'RX 6000' : digit === '5' ? 'RX 5000' : 'Older';
  }

  // VRAM — store as NUMBER (App.jsx appends "GB" at render time)
  const vram = title.match(/\b(\d+)\s*GB\b/i);
  if (vram) s.vram = parseInt(vram[1]);

  // Fan count
  if (/\btriple[- ]?fan\b|\b3[- ]fan\b/i.test(title))       s.fans = 3;
  else if (/\bdual[- ]?fan\b|\b2[- ]fan\b|\btwin[- ]fan\b/i.test(title)) s.fans = 2;
  else if (/\bsingle[- ]?fan\b|\b1[- ]fan\b/i.test(title))  s.fans = 1;

  // RGB lighting — boolean (App.jsx SF.rgb displays as Yes/No)
  if (/\b(aRGB|ARGB|addressable[ -]RGB|RGB)\b/i.test(title))    s.rgb = true;
  else                                                           s.rgb = false;

  // Color detection
  if (/\bWhite\b/i.test(title)) s.color = 'White';
  else if (/\bBlack\b/i.test(title)) s.color = 'Black';

  return s;
}

function extractRamSpecs(title) {
  const s = {};
  const ddr = title.match(/\bDDR([345])\b/i);
  if (ddr) s.type = `DDR${ddr[1]}`;

  // Speed: e.g. "6000", "DDR5-6400", "6400 MT/s"
  const speed = title.match(/\b([34567]\d{3})\s*(?:MT\/s|MHz|CL)?/);
  if (speed) s.speed = parseInt(speed[1]);

  // Kit format — try several variants in order of specificity
  // "32GB (2x16GB)" — total with kit in parens
  // "2x16GB" — bare kit notation
  // "2 x 16GB" — spaced
  // "(2 x 16GB)" — spaced in parens
  let kit = title.match(/\((\d+)\s*x\s*(\d+)\s*GB\)/i)
         || title.match(/\b(\d+)\s*x\s*(\d+)\s*GB\b/i);
  if (kit) {
    s.kit = `${kit[1]}x${kit[2]}GB`;
  } else {
    // Fallback: single capacity like "16GB" or "32GB" — treat as 1xNGB
    const cap = title.match(/\b(\d+)\s*GB\b/i);
    if (cap) s.kit = `1x${cap[1]}GB`;
  }

  // Also store flat capacity (total) for reference
  const capacityFlat = title.match(/\b(\d+)\s*GB\b/i);
  if (capacityFlat) s.capacity = `${capacityFlat[1]}GB`;

  return s;
}

function extractStorageSpecs(title) {
  const s = {};
  const capacity = title.match(/\b(\d+(?:\.\d+)?)\s*(TB|GB)\b/i);
  if (capacity) s.capacity = `${capacity[1]}${capacity[2].toUpperCase()}`;

  if (/NVMe|M\.2|PCIe\s*(3|4|5)/i.test(title)) s.form = 'NVMe';
  else if (/SATA|2\.5"/.test(title)) s.form = 'SATA SSD';
  else if (/HDD|hard drive|3\.5"/i.test(title)) s.form = 'HDD';

  if (/Gen5|PCIe\s*5/i.test(title)) s.pcie = 'Gen5';
  else if (/Gen4|PCIe\s*4/i.test(title)) s.pcie = 'Gen4';
  else if (/Gen3|PCIe\s*3/i.test(title)) s.pcie = 'Gen3';

  return s;
}

function extractPsuSpecs(title) {
  const s = {};
  const watts = title.match(/\b(\d{3,4})\s*W\b/i);
  if (watts) s.wattage = parseInt(watts[1]);

  const rating = title.match(/80\s*(?:Plus|\+)\s*(Gold|Platinum|Titanium|Bronze|Silver|White|Standard)/i);
  if (rating) s.efficiency = rating[1];

  if (/\b(Fully|Full)\s+Modular\b/i.test(title)) s.modular = 'Full';
  else if (/\bSemi[- ]?Modular\b/i.test(title)) s.modular = 'Semi';
  else if (/\bNon[- ]?Modular\b/i.test(title)) s.modular = 'Non-Modular';

  // RGB detection (boolean — App.jsx SF.rgb renders as Yes/No)
  if (/\b(ARGB|aRGB|addressable[ -]RGB)\b/i.test(title)) s.rgb = true;
  else if (/\bRGB\b/i.test(title)) s.rgb = true;
  else s.rgb = false;

  // Color detection
  if (/\bWhite\b/i.test(title)) s.color = 'White';
  else if (/\bBlack\b/i.test(title)) s.color = 'Black';

  return s;
}

function extractCaseSpecs(title) {
  const s = {};
  // Order matters: check more specific patterns first so "Micro-ATX" doesn't match as "ATX"
  if      (/\b(Micro[- ]ATX|mATX|M-ATX)\b/i.test(title)) s.formFactor = 'mATX';
  else if (/\b(Mini[- ]ITX)\b/i.test(title))             s.formFactor = 'Mini-ITX';
  else if (/\b(E-ATX|EATX)\b/i.test(title))              s.formFactor = 'E-ATX';
  else if (/\bATX\b/i.test(title))                       s.formFactor = 'ATX';
  else if (/\bITX\b/i.test(title))                       s.formFactor = 'ITX';

  if      (/Full[- ]Tower/i.test(title)) s.tower = 'Full';
  else if (/Mid[- ]Tower/i.test(title))  s.tower = 'Mid';
  else if (/Mini[- ]Tower/i.test(title)) s.tower = 'Mini';

  if (/Tempered Glass/i.test(title)) s.glass = true;

  // Color
  if (/\bWhite\b/i.test(title)) s.color = 'White';
  else if (/\bBlack\b/i.test(title)) s.color = 'Black';

  return s;
}

function extractCoolerSpecs(title) {
  const s = {};
  if (/\b(360|420)\s*mm\b/i.test(title)) s.type = 'AIO', s.radiator = title.match(/\b(360|420)\s*mm\b/i)[1];
  else if (/\b(280|240)\s*mm\b/i.test(title)) s.type = 'AIO', s.radiator = title.match(/\b(280|240)\s*mm\b/i)[1];
  else if (/\bAIO\b|\bLiquid/i.test(title)) s.type = 'AIO';
  else if (/Air Cooler|Heatsink|Tower/i.test(title)) s.type = 'Air';

  return s;
}

function extractMonitorSpecs(title) {
  const s = {};
  const size = title.match(/\b(\d{2})["\s]?(?:inch)?\b/i);
  if (size && parseInt(size[1]) >= 21 && parseInt(size[1]) <= 65) s.size = parseInt(size[1]); // number, App.jsx adds "in"

  if (/\b4K|3840\s*x\s*2160|UHD\b/i.test(title)) s.resolution = '4K';
  else if (/\b(1440p|QHD|2560\s*x\s*1440)\b/i.test(title)) s.resolution = '1440p';
  else if (/\b(1080p|FHD|1920\s*x\s*1080)\b/i.test(title)) s.resolution = '1080p';
  else if (/\b(3440\s*x\s*1440|UWQHD)\b/i.test(title)) s.resolution = '3440x1440 UW';
  else if (/\b(5120\s*x\s*1440)\b/i.test(title)) s.resolution = '5120x1440 SuperUW';

  const refresh = title.match(/\b(\d{2,3})\s*Hz\b/i);
  if (refresh) s.refresh = parseInt(refresh[1]);

  if (/\bOLED\b/i.test(title)) s.panel = 'OLED';
  else if (/\bIPS\b/i.test(title)) s.panel = 'IPS';
  else if (/\bVA\b/i.test(title)) s.panel = 'VA';
  else if (/\bTN\b/i.test(title)) s.panel = 'TN';

  // Curved (boolean)
  s.curved = /\bcurved|curve\s+\d{3,4}R|1500R|1000R|1800R\b/i.test(title);

  // Contrast ratio — occasionally in titles like "1000:1", "3000:1", "1M:1"
  const contrast = title.match(/\b(\d+(?:,\d{3})*|\d+M?):1\b/);
  if (contrast) s.contrast = `${contrast[1]}:1`;

  return s;
}

function extractCaseFanSpecs(title) {
  const s = {};
  const size = title.match(/\b(120|140|200)\s*mm\b/i);
  if (size) s.size = parseInt(size[1]); // number, App.jsx can add "mm"

  if (/\b(ARGB|aRGB|addressable[ -]RGB)\b/i.test(title)) s.rgb = true;
  else if (/\bRGB\b/i.test(title)) s.rgb = true;
  else s.rgb = false;

  if (/\bPWM\b/i.test(title)) s.pwm = true;

  // Pack count
  let m = title.match(/\b(\d+)[- ]?pack\b/i)
       || title.match(/pack of\s*(\d+)/i)
       || title.match(/\bset of\s*(\d+)/i)
       || title.match(/\b(\d+)\s*x\s*(?:120|140|200)\s*mm/i);
  if (m) s.pack = parseInt(m[1]);

  // CFM (airflow) — rarely in titles, but try anyway
  const cfm = title.match(/(\d+(?:\.\d+)?)\s*CFM/i);
  if (cfm) s.cfm = parseFloat(cfm[1]);

  return s;
}

const SPEC_EXTRACTORS = {
  Motherboard: extractMotherboardSpecs,
  CPU: extractCpuSpecs,
  GPU: extractGpuSpecs,
  RAM: extractRamSpecs,
  Storage: extractStorageSpecs,
  PSU: extractPsuSpecs,
  Case: extractCaseSpecs,
  CPUCooler: extractCoolerSpecs,
  Monitor: extractMonitorSpecs,
  CaseFan: extractCaseFanSpecs,
};

// ─────────────────────────────────────────────────────────────────────────────
// Name cleaning — strip marketing copy after a threshold of commas
// ─────────────────────────────────────────────────────────────────────────────

function cleanName(title, brand) {
  let n = title;
  // Remove "with", "for", "featuring" clauses
  n = n.replace(/\s*[,-]\s*(with|for|featuring|includes?|bundle|comes with)\s+.*$/i, '');
  // Cut at 3rd comma (marketing copy)
  const parts = n.split(',');
  if (parts.length > 3) n = parts.slice(0, 3).join(',').trim();
  // Drop trailing commas, parens with garbage
  n = n.replace(/\s*\([^)]{40,}\).*$/g, '');
  n = n.replace(/,\s*$/g, '');
  n = n.trim();
  // Strip brand prefix if very long (improves dedup)
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// URL cleaning — strip Amazon tracking params
// ─────────────────────────────────────────────────────────────────────────────

function cleanAmazonUrl(url, asin) {
  if (!asin) return url;
  return `https://www.amazon.com/dp/${asin}?tag=tiereduptech-20`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Dedup within category — collapse near-identical product listings
// ─────────────────────────────────────────────────────────────────────────────

function dedupe(products) {
  // Group by brand + first 40 chars of name
  const groups = new Map();
  for (const p of products) {
    const key = `${p.brand || '?'}|${p.name.toLowerCase().slice(0, 40)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }

  const kept = [];
  for (const [_, group] of groups) {
    // Keep the one with the most reviews (most popular variant)
    group.sort((a, b) => (b.reviews || 0) - (a.reviews || 0));
    kept.push(group[0]);
  }
  return kept;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main enrichment
// ─────────────────────────────────────────────────────────────────────────────

function enrichProduct(raw) {
  const brand = extractBrand(raw.title);
  const extractor = SPEC_EXTRACTORS[raw.category];
  const specs = extractor ? extractor(raw.title) : {};

  return {
    asin: raw.asin,
    brand,
    category: raw.category,
    name: cleanName(raw.title, brand),
    fullTitle: raw.title,
    price: raw.price,
    currency: raw.currency,
    rating: raw.rating,
    reviews: raw.reviews,
    boughtPastMonth: raw.boughtPastMonth,
    isAmazonChoice: raw.isAmazonChoice,
    isBestSeller: raw.isBestSeller,
    imageUrl: raw.imageUrl,
    amazonUrl: cleanAmazonUrl(raw.amazonUrl, raw.asin),
    specs,
    discoveredVia: raw.discoveredVia,
  };
}

function main() {
  console.log('\n── Local Enrichment ──\n');

  if (!existsSync(INPUT_DIR)) {
    console.error(`Input dir not found: ${INPUT_DIR}. Run dataforseo-discover.js first.`);
    process.exit(1);
  }
  mkdirSync(OUTPUT_DIR, { recursive: true });

  const files = readdirSync(INPUT_DIR).filter(f => f.endsWith('.json') && !f.startsWith('_'));

  let totalIn = 0;
  let totalOut = 0;
  for (const file of files) {
    const category = file.replace('.json', '').replace(/^./, c => c.toUpperCase())
      .replace('Cpucooler', 'CPUCooler')
      .replace('Casefan', 'CaseFan')
      .replace('Cpu', 'CPU')
      .replace('Gpu', 'GPU')
      .replace('Ram', 'RAM')
      .replace('Psu', 'PSU');

    if (flags.category && category.toLowerCase() !== flags.category.toLowerCase()) continue;

    const raw = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf-8'));
    totalIn += raw.length;

    const enriched = raw.map(enrichProduct);
    const deduped = dedupe(enriched);
    // Sort by popularity
    deduped.sort((a, b) => (b.boughtPastMonth || 0) - (a.boughtPastMonth || 0) || (b.reviews || 0) - (a.reviews || 0));

    totalOut += deduped.length;

    const outPath = join(OUTPUT_DIR, file);
    writeFileSync(outPath, JSON.stringify(deduped, null, 2));

    const withBrand = deduped.filter(p => p.brand).length;
    console.log(`  ${category.padEnd(12)} ${raw.length.toString().padStart(4)} → ${deduped.length.toString().padStart(4)} (brand coverage: ${Math.round(withBrand/deduped.length*100)}%)`);
  }

  console.log(`\nTotal: ${totalIn} → ${totalOut} products enriched\n`);
  console.log(`Output: ${OUTPUT_DIR}/`);
}

main();
