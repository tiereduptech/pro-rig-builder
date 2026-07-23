/**
 * catalog-classify.cjs  —  SINGLE SOURCE OF TRUTH for product classification.
 *
 * Brand detection, category detection, the compat/marketing-clause stripper, the
 * non-buildable (accessory) reject gate, spec extraction, and the category-aware
 * brand-plausibility check all live HERE and are required by every script that
 * touches the catalog:
 *   - expand-catalog-amazon.cjs   (discovery)
 *   - apply-amazon-discoveries.cjs (apply / quarantine)
 *   - verify-discoveries.cjs       (promote / un-quarantine)
 *
 * WHY: apply used to keep its own private copy of detectBrand/categorize. The
 * copies drifted, and the stale apply copy mis-branded an EVGA SuperNOVA as
 * "NVIDIA" and let a SATA power cable through as Storage. One module = the
 * scripts physically cannot disagree again. Add a rule once, every stage gets it.
 *
 * Everything here is PURE (no network, no fs) so it's trivially unit-testable.
 */

// ─── Compatibility / marketing clause stripping ───
// Amazon titles bury compat & marketing phrases ("RTX 5090 Ready",
// "Compatible with 24-Pin Motherboard", "for NVIDIA RTX...Graphics Cards")
// that wreck both categorization and brand detection. Strip them BEFORE any
// keyword matching so the product's own identity drives the decision.
function stripCompatClauses(title) {
  let s = ' ' + (title || '') + ' ';
  const clauses = [
    /\b(?:compatible|works?)\s+with\b[^|,]*/gi,            // "Compatible with 24-Pin Motherboard and 8-Pin/16-Pin GPU"
    /\bfor\s+(?:nvidia|amd|intel)\b[^|,]*/gi,              // "for NVIDIA RTX 20/30/40 Series and AMD Graphics Cards"
    /\b(?:rtx|gtx|rx|radeon|geforce)\b[^|,]*?\bready\b/gi, // "RTX 5090 AMD RX 9000 Ready"
    /\bnvidia\s+sli\b/gi,                                  // "NVIDIA SLI and Crossfire Ready"
    /\b(?:sli\s+and\s+)?crossfire\s+ready\b/gi,
    /\b(?:pcie\s*[\d.]+\s*)?(?:\d+\s*series\s*)?gpu\s+support\b/gi, // "PCIe 5.1 GPU Support", "50 Series GPU Support"
    /\bgpu-first\b/gi,                                     // "GPU-First Intelligent Voltage Stabilizer"
    /\b\d+\s*series\s+(?:gpu|graphics)\b/gi,
  ];
  for (const re of clauses) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

// Word-boundary-aware containment that won't match a brand inside a larger word
// (e.g. "intel" must NOT match "intelligent"). Tolerates punctuation in the
// brand token ("be quiet!", "G.Skill").
function brandInText(text, brand) {
  const core = brand.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp('(^|[^a-z0-9])' + core + '($|[^a-z0-9])', 'i').test(text.toLowerCase());
}

// Chip giants (AMD/Intel/NVIDIA) are LAST so a component-maker brand wins over a
// bare chip mention; for a real CPU the chip brand still matches as a fallback.
const BRANDS = ['ASUS','MSI','Gigabyte','ASRock','Corsair','G.Skill','Kingston','Crucial','Samsung','Western Digital','WD','Seagate','SanDisk','Lexar','TeamGroup','Patriot','EVGA','Seasonic','be quiet!','Cooler Master','NZXT','Lian Li','Fractal Design','Thermaltake','Phanteks','Noctua','Arctic','Thermalright','Scythe','DeepCool','Hyte','Antec','Rosewill','Segotep','MONTECH','GAMEMAX','PCCOOLER','darkFlash','Super Flower','FSP','SAMA','ARESGAME','XPG','ADATA','Sapphire','PowerColor','XFX','Zotac','PNY','Inno3D','Gainward','Palit','AMD','Intel','NVIDIA'];

// Product-series → brand. Catches units whose title leads with a series name
// (Corsair "RM850x", EVGA "SuperNOVA", ASUS "ROG Strix") and never says the brand.
const SERIES_BRAND = [
  [/\bsupernova\b/i, 'EVGA'],
  [/\b(rm[xe]?\d|rmx?\s*series|hx[i]?\d|cx[fim]?\d|ax[i]?\d|tx[m]?\d|sf\s*\d{2,})\b/i, 'Corsair'],
  [/\b(rog|tuf)\b/i, 'ASUS'],
  [/\b(mag|mpg|meg)\b/i, 'MSI'],
  [/\btoughpower\b/i, 'Thermaltake'],
  [/\b(focus\s+(?:gx|plus|gm|sgx)|focus\s+ssr|vertex\s+(?:px|gx)|prime\s+(?:px|tx)|core\s+(?:gx|gm))\b/i, 'Seasonic'],
];

// Amazon URLs encode the brand/series in the product slug (the path segment
// right before /dp/ASIN). For sponsored (sspa) links the real product path is
// in the url= query param. This is the most reliable brand source.
function brandFromUrl(url) {
  if (!url) return null;
  let u = url;
  try { u = decodeURIComponent(url); } catch { /* keep raw */ }
  const enc = u.match(/[?&]url=([^&]+)/);
  if (enc) { try { u = decodeURIComponent(enc[1]); } catch { /* keep */ } }
  const m = u.match(/\/([^/]+)\/(?:dp|gp\/product)\//i);
  if (!m) return null;
  const slug = m[1].replace(/[-_]+/g, ' ');
  for (const [re, brand] of SERIES_BRAND) if (re.test(slug)) return brand;
  for (const b of BRANDS) if (brandInText(slug, b)) return b;
  if (/\bquiet\b/i.test(slug)) return 'be quiet!';   // "be quiet!" truncates to "quiet" in slugs
  return null;
}

function detectBrand(title, url) {
  const clean = stripCompatClauses(title);
  // 1) URL slug — checked before the bare-name scan (most reliable).
  const fromUrl = brandFromUrl(url);
  if (fromUrl) return fromUrl;
  // 2) series → brand map.
  for (const [re, brand] of SERIES_BRAND) if (re.test(clean)) return brand;
  // 3) bare brand-name scan, word-boundary, chip giants last.
  for (const b of BRANDS) if (brandInText(clean, b)) return b;
  return null;
}

// Strong, unambiguous per-category signal from a compat-stripped title.
// Returns a category only when a real product noun is present — a bare model
// mention ("RTX 5090") is NOT enough (it's usually a compatibility blurb).
function detectCategory(cleanTitle) {
  const t = cleanTitle.toLowerCase();
  if (/\b(ryzen|core\s*i[3579]|core\s*ultra|threadripper|epyc)\b/.test(t)
      && !/\b(cooler|fan|motherboard|case|bundle|combo)\b/.test(t)) return 'CPU';
  // GPU requires an actual graphics-card noun (or GDDR VRAM), not just a model number.
  if (/\b(rtx|gtx|radeon|geforce|arc)\b/.test(t)
      && /\b(graphics card|video card|graphics processing|gddr\d?)\b/.test(t)) return 'GPU';
  if (/\bmotherboard\b/.test(t)
      || (/\b(x870e?|b850|b650e?|z890|z790|b760|a620|x670e?)\b/.test(t) && /\b(am5|am4|lga\s?\d{4})\b/.test(t))) return 'Motherboard';
  if ((/\bddr[45]\b/.test(t) && /\b(kit|dimm|sodimm|udimm|memory)\b/.test(t))
      || /\b\d+\s*gb\s*\(\s*\d+\s*x\s*\d+\s*gb\s*\)/.test(t)) return 'RAM';
  if (/\b(ssd|nvme|hard drive|hard disk|hdd)\b/.test(t) && !/\b(cooler|case|fan|enclosure|heatsink)\b/.test(t)) return 'Storage';
  if (/\b(power supply|psu)\b/.test(t)
      || (/\b\d{3,4}\s*w(att)?\b/.test(t) && /\b(80\s*\+?\s*plus|80\+|gold|platinum|bronze|titanium|modular|atx\s*3)\b/.test(t))) return 'PSU';
  if (/\b(pc case|computer case|mid.?tower|full.?tower|mini.?tower|chassis)\b/.test(t)
      && !/\b(accessory|upgrade kit|replacement|guide|feet|lift stand|riser|vertical gpu)\b/i.test(t)) return 'Case';
  if (/\b(cpu cooler|aio|liquid cooler|air cooler|tower cooler|heatsink|liquid freezer)\b/.test(t)) return 'CPUCooler';
  return null;
}

// The source query is the PRIOR (default). Override to another category ONLY on
// a strong, unambiguous title signal; otherwise keep the prior.
function categorize(title, sourceCat) {
  const signal = detectCategory(stripCompatClauses(title));
  return signal || sourceCat || null;
}

// Gate run BEFORE categorize: routes accessories / non-core-components to the
// rejected[] bucket. Patterns are specific enough not to fire on real CPU/GPU/
// Mobo/RAM/Storage/PSU/Case/Cooler listings. Returns a reason string or null.
//
// The cable/cord/pin-to-pin rules below were hardened after a "SATA Power Cable
// for Seasonic Antec PSUs ... 6 Pin to 3X 15 Pin" slipped through as a Storage
// product. Real PSUs are titled "...Power Supply"; they don't say "power cable",
// "power cord", "cable kit", or "<n> pin to <m> pin" — those are always the
// accessory describing itself.
function notBuildableReason(title) {
  const t = (title || '').toLowerCase();
  const rules = [
    [/\bcable (cover|extension|comb|sleev\w*|management)\b/, 'cable accessory'],
    [/\bextension cable\b|\bsleeved cable\b/, 'cable accessory'],
    [/\bpower cord\b/, 'power cord'],
    [/\bpower cable\b/, 'power cable'],
    [/\bcable kit\b/, 'cable kit'],
    [/\b\d+\s*pin\s+to\b/, 'pin-to-pin cable/adapter'],
    [/\badapter cable\b/, 'adapter cable'],
    // Bare "<connector> cable" is always the accessory. Narrow on purpose: real
    // PSUs say "PCIe 5.1", "12VHPWR Cable" or "12V-2x6 Cable" (none of which is a
    // <connector>+"cable" pair here), so they don't false-trip this.
    [/\b(pcie|pci-e|sata|eps|atx)\s+cable\b/, 'connector cable'],
    [/\b(rgb |argb )?lighting kit\b/, 'lighting/RGB accessory'],
    [/\b(fan|pwm) (hub|splitter)\b/, 'fan hub/splitter'],
    [/\b(rgb|argb) controller\b/, 'RGB controller'],
    [/\briser cable\b|\bpcie riser\b|\bgpu riser\b/, 'riser cable'],
    [/\banti.?sag\b|\bgpu (support )?bracket\b|\b(graphics card|gpu) holder\b/, 'GPU support bracket'],
    [/\bdust filter\b/, 'dust filter'],
    [/\bthermal (paste|grease|compound|pad)\b/, 'thermal accessory'],
    [/\bstand-?offs?\b|\bthumb-?screws?\b|\bscrewdriver\b/, 'hardware/fasteners'],

    // ── Hardened after the May-15 verify batch promoted 16 accessory rows ──
    // These disqualify on PRODUCT TYPE, which is exactly why the gate must run
    // BEFORE brand detection: "GSPSCN ... Rear Wiper Blade For Lincoln Corsair"
    // is an automotive part, NOT a Corsair PC component — rejecting on the type
    // means the bogus "Corsair" brand reading never gets a chance to matter.
    // (notBuildableReason takes only the title and is brand-agnostic; apply and
    // verify both call it first, so the product-type verdict always wins.)
    [/\bwiper blade\b/, 'wiper blade (automotive)'],
    [/\b(raised|stand|replacement) feet\b/, 'case feet/stand'],
    [/\b(side )?panel guide\b/i, 'case panel guide (accessory)'],
    [/\bmounting kits?\b/, 'cooler mounting kit'],
    [/\b(cpu ?cooler|cooler|mount(?:ing)?) bracket\b/, 'cooler mount bracket'],
    // Bare SSD heatsink sold by itself: "<drive> Heatsink FOR <models>". Real
    // drives say "SSD WITH Heatsink" / "Heatsink Included" / "Without Heatsink",
    // so the drive-word-immediately-before-"heatsink for" phrasing is the tell.
    [/\b(?:ssd|m\.?2|nvme) heatsink for\b/, 'SSD heatsink (accessory)'],
    [/\b(?:m\.?2|nvme|ssd|hdd|sata|usb)\b[^,|]*\benclosure\b/, 'drive enclosure'],
    // ── Hardened after the Jul-08 category-accuracy cleanup (dropped 83 cross-
    // category rows). Each pattern rejects a product TYPE that kept landing in the
    // wrong bucket via nightly ingests. Like the wiper-blade rule above, these run
    // BEFORE categorize/detectBrand, so the wrong-category source query never gets
    // to file them. Narrowed on purpose so they reject the STANDALONE accessory but
    // not a real fan/cooler/mic/headset that merely mentions the part as a feature
    // ("iCUE Link System Hub Kit", "Built-in Pop Filter", "Memory Foam Ear Pads").
    // Every pattern verified 0-false-positive against the full live catalog and
    // matches the exact rows the cleanup removed.
    [/\bdistro[\s-]?plate\b/, 'distro plate (custom-loop accessory)'],
    [/\b(?:control|system) hub\s*[-–]\s*(?:connect|digital|control|reduce|up to|rgb|argb|pwm|lighting)\b/, 'RGB/fan control hub (accessory)'],
    [/\bssd (?:hard drive )?adapter\b|\b22\d0\s+to\s+2280\b/, 'SSD form-factor adapter (accessory)'],
    [/\be-?gpu\b/, 'eGPU dock/enclosure (accessory)'],
    [/\bwind\s?screen\b|\bfurry\b|\bdead\s?cat\b|\bpop (?:filter|guard) (?:for|compatible)\b/, 'mic pop filter/windscreen (accessory)'],
    [/\bear\s?pads?(?:\s+cushions?)?\s+replacement\b|\breplacement\s+(?:ear\s?pads?|ear cushions?)\b/, 'replacement earpads (accessory)'],
    [/\bmic(?:rophone)? replacement\b|\breplacement (?:lapel |boom |detachable )?mic(?:rophone)?\b|\bcable replacement\b/, 'replacement headset mic/cable (accessory)'],
  ];
  for (const [re, reason] of rules) if (re.test(t)) return reason;
  return null;
}

// Category-aware brand plausibility. The chip giants make a narrow set of product
// types; a PSU/Case/Storage/Cooler "made by NVIDIA" (or AMD/Intel) is a brand
// mis-detection, not a real product. Returns true when the brand cannot plausibly
// make that category — callers use it to refuse auto-promotion (verify) and to
// refuse applying the row in the first place (apply). This catches the
// confidently-WRONG-brand case that the null-brand guard misses.
const CHIP_GIANT_CATEGORIES = {
  AMD:    ['CPU', 'GPU'],
  Intel:  ['CPU', 'GPU'],
  NVIDIA: ['GPU'],
};
function implausibleBrandForCategory(brand, category) {
  if (!brand || !category) return false;
  const allowed = CHIP_GIANT_CATEGORIES[brand];
  if (!allowed) return false;          // not a chip giant → this gate has no opinion
  return !allowed.includes(category);  // chip giant in a category it doesn't make → implausible
}

// Extract basic specs from a title for a known category.
function extractSpecs(title, category) {
  const specs = {};
  const t = title || '';

  if (category === 'CPU') {
    const cores = t.match(/(\d+)[\s-]*core/i);
    if (cores) specs.cores = parseInt(cores[1]);
    const socket = t.match(/\b(LGA\s?\d+|AM[45]|sTRX\d|sWRX\d|TR\d)\b/i);
    if (socket) specs.socket = socket[1].replace(/\s/g, '').toUpperCase();
    const tdp = t.match(/(\d+)\s*W\b/i);
    if (tdp) specs.tdp = parseInt(tdp[1]);
  } else if (category === 'GPU') {
    const vram = t.match(/(\d+)\s*GB\s*(GDDR|VRAM)/i);
    if (vram) specs.vram = parseInt(vram[1]);
  } else if (category === 'PSU') {
    const watts = t.match(/\b(\d{3,4})\s*W\b/);
    if (watts) specs.watts = parseInt(watts[1]);
    if (/80\+?\s*platinum/i.test(t)) specs.eff = '80+ Platinum';
    else if (/80\+?\s*gold/i.test(t)) specs.eff = '80+ Gold';
    else if (/80\+?\s*bronze/i.test(t)) specs.eff = '80+ Bronze';
    if (/fully modular/i.test(t)) specs.modular = 'Full';
    else if (/semi.?modular/i.test(t)) specs.modular = 'Semi';
    if (/atx\s*3\.[01]/i.test(t)) specs.atx3 = true;
  } else if (category === 'RAM') {
    // RAM titles come in two dialects. Amazon (curated) writes the specs
    // adjacently and uniformly: "Corsair Vengeance DDR5 32GB (2x16GB) 6000MHz
    // CL30". Newegg (raw feed) scatters them and omits the "MHz" suffix:
    // "Kingston FURY Beast 64GB (2 x 32GB) 288-Pin PC RAM DDR5 5200 (PC5 41600)"
    // or "64GB 5200MT/s DDR5 CL40". The old patterns only understood the Amazon
    // dialect (speed required a 4-digit+MHz/MT pair; cap required a trailing "(")
    // and so failed 594 of 628 real Newegg RAM listings — and also missed Amazon
    // ECC modules ("32GB ECC 4800MHz", no parenthesis). Each field below tries
    // the precise Amazon form first, then the looser Newegg forms.

    // memType — DDR generation, or inferred from the PCn marketing class.
    const ddr = t.match(/\bddr([2345])\b/i) || t.match(/\bpc([2345])[- ]?\d/i);
    if (ddr) specs.memType = 'DDR' + ddr[1];

    // capacity — the kit TOTAL, which both dialects state as the first "<n>GB"
    // ("64GB (2 x 32GB)", "32GB (2x16GB)", "32GB ECC"). No longer requires a
    // trailing "(", so bare "64GB 5200MT/s" and ECC modules now parse.
    const cap = t.match(/(\d+)\s*GB\b/i);
    if (cap) specs.cap = parseInt(cap[1]);

    // stick count — "(2 x 16GB)" / "(2x16GB)", or Newegg's reversed "(16GBx4)".
    const sticks = t.match(/\((\d+)\s*x\s*\d+\s*gb\)/i);
    if (sticks) specs.sticks = parseInt(sticks[1]);
    else { const rev = t.match(/\(\d+\s*gb\s*x\s*(\d+)\)/i); if (rev) specs.sticks = parseInt(rev[1]); }

    // speed in MT/s (the number DDR marketing prints as "MHz"). Priority:
    //   1. explicit "6000MHz" / "5200MT/s" / "800 MHz"  (3-5 digits)
    //   2. the bare "DDR5 5200" form Newegg uses (number right after the DDR gen)
    //   3. the PCn-NNNNN rating, where data rate = PC number / 8
    //      (PC5-41600 -> 5200, PC4-25600 -> 3200, PC3-6400 -> 800)
    let sp = t.match(/(\d{3,5})\s*(?:MHz|MT\/?s)\b/i);
    if (sp) specs.speed = parseInt(sp[1]);
    if (specs.speed == null && (sp = t.match(/\bddr[2345]\s*-?\s*(\d{4,5})\b/i))) specs.speed = parseInt(sp[1]);
    if (specs.speed == null && (sp = t.match(/\bpc[2345][- ]?(\d{4,5})\b/i))) specs.speed = Math.round(parseInt(sp[1]) / 8);

    // CAS latency
    const cl = t.match(/\bCL\s?(\d+)/i);
    if (cl) specs.cl = parseInt(cl[1]);
  } else if (category === 'Storage') {
    const cap = t.match(/(\d+)\s*(TB|GB)/i);
    if (cap) {
      const size = parseInt(cap[1]);
      specs.cap = cap[2].toLowerCase() === 'tb' ? size * 1000 : size;
    }
    if (/\bnvme\b/i.test(t)) specs.storageType = 'NVMe';
    else if (/\bhdd\b|hard drive|hard disk/i.test(t)) specs.storageType = 'HDD';
    else if (/\bssd\b/i.test(t)) specs.storageType = 'SSD';
  }
  return specs;
}

module.exports = {
  stripCompatClauses,
  brandInText,
  BRANDS,
  SERIES_BRAND,
  brandFromUrl,
  detectBrand,
  detectCategory,
  categorize,
  notBuildableReason,
  implausibleBrandForCategory,
  extractSpecs,
};
