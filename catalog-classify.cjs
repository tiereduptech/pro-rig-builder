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
    // Feature/standard names that EMBED a chip-giant brand but do NOT indicate the
    // maker. These are the ~170-row brand-pollution source from the §3 audit: a
    // Dell monitor reads "AMD" off "AMD FreeSync"; a RAM kit reads "AMD"/"Intel"
    // off "AMD EXPO"/"Intel XMP". Strip the whole feature phrase before brand scan.
    /\bamd\s+free\s?sync\b/gi,                             // "AMD FreeSync (Premium)"
    /\bnvidia\s+g-?sync\b|\bg-?sync\s+compatible\b/gi,     // "NVIDIA G-Sync", "G-Sync Compatible"
    /\bamd\s+expo\b|\bexpo\s+(?:ready|profile|technology)\b/gi, // "AMD EXPO", "EXPO Ready"
    /\bintel\s+xmp\b|\bxmp\s+(?:ready|profile|\d(?:\.\d)?)\b/gi, // "Intel XMP", "XMP 3.0"
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
    // Order matters. A solid-state signal (NVMe / SSD / "solid state") WINS over
    // an HDD signal, because "HDD Replacement" / "hard drive" is marketing text on
    // SSD listings ("...2.5\" Internal SSD ... HDD Replacement for..."), NOT the
    // product type. RPM is the tie-breaker for the INVERSE spam case: only a
    // spinning disk has a rotational speed, so a real HDD keyword-stuffed with
    // "Solid State Drive" (e.g. a WD Purple 7200 RPM drive bundled with a cable)
    // still classifies HDD unless it actually carries the "SSD" token.
    if (/\bnvme/i.test(t)) specs.storageType = 'NVMe';   // trailing \b dropped so glued "NVMeSSD" (no space) still matches
    else if (/\brpm\b/i.test(t) && !/\bssd\b/i.test(t)) specs.storageType = 'HDD';
    else if (/\bssd\b|solid[\s-]?state/i.test(t)) specs.storageType = 'SSD';
    else if (/\bhdd\b|hard drive|hard disk/i.test(t)) specs.storageType = 'HDD';
  }
  return specs;
}

// Derived RAM attributes that are booleans/enums rather than numeric specs.
// Pure and unit-tested so the ECC-negation handling in particular can't regress:
// a bare "ECC" must NOT count when the title actually says the module is non-ECC,
// in any of the spellings vendors use ("non-ECC", "Non ECC", "NonECC",
// "without ECC", "no ECC"). Registered modules (RDIMM/LRDIMM) are ECC by
// definition and win regardless.
function ramAttributes(title) {
  const t = title || '';
  // "On-die ECC" is a STANDARD internal feature of every DDR5 die (a marketing
  // bullet on consumer gaming kits — Lexar Thor Z "…On-die ECC, PMIC…for Gaming"),
  // NOT server/ECC-UDIMM memory. It must not set the ecc flag, so strip the phrase
  // before reading a bare "ECC" as a real ECC signal. (Registered detection below
  // uses its own explicit tokens and is unaffected.)
  const tNoOnDie = t.replace(/\bon[-\s]?die\s+ecc\b/ig, '');
  const negEcc = /\b(non[-\s]?ecc|without\s+ecc|no\s+ecc)\b/i.test(t);
  // Registered memory is ECC by definition. Match HYPHENATED spellings too
  // ("R-DIMM", "LR-DIMM") — audit §3/§5 leak: the old /\b(rdimm|lrdimm)\b/ missed
  // the hyphen, so TEAMGROUP "... R-DIMM 192GB" workstation kits were tagged
  // UDIMM/non-ECC and slipped past the server gate.
  const registered = /\b(lr-?dimm|r-?dimm|registered|buffered)\b|\becc[\s-]*reg\b/i.test(t);
  const ecc = registered || (/\becc\b/i.test(tNoOnDie) && !negEcc);
  const rgb = /\brgb\b/i.test(t);
  // Laptop memory: literal SO-DIMM spellings PLUS the tokens vendors use when they
  // OMIT the word "SODIMM" — pin counts (204-pin DDR3, 260-pin DDR4, 262-pin DDR5)
  // and the words "laptop"/"notebook". Audit §3/§5 leak: the literal-only regex
  // missed "32GB ... Laptop Memory, 260-Pin" seed rows and tagged them UDIMM.
  // 288-pin (desktop DIMM) is deliberately NOT matched.
  const sodimm = /so-?dimm|s\.o\.dimm|\b(204|260|262)[\s-]*pin\b|\b(laptop|notebook)\b/i.test(t);
  const formFactor = sodimm ? 'SODIMM'
    : /\blr-?dimm\b/i.test(t) ? 'LRDIMM'
    : /\br-?dimm\b|\bregistered\b|\becc[\s-]*reg\b/i.test(t) ? 'RDIMM'
    : 'UDIMM';
  return { ecc, rgb, formFactor };
}

// RAM scope gate — SINGLE SOURCE for "does this RAM belong in a consumer/gaming
// DESKTOP catalog?". Called by the discovery pipeline (apply-newegg-discoveries)
// so laptop/server/ECC memory can never be re-added on a future ingest.
//
// In scope = unbuffered, non-ECC, desktop DIMM only. Rejected, in order:
//   • laptop  — SODIMM / SO-DIMM / 204-260-262-pin / "laptop" / "notebook"
//   • server  — RDIMM / R-DIMM / LRDIMM / LR-DIMM / registered / buffered
//   • ECC     — any ECC, INCLUDING consumer unbuffered ECC UDIMM (now out of scope)
// PRIMARY test is the formFactor/ecc that ramAttributes() computes; the raw-name
// regexes below are only a backstop for titles the attribute pass can't read.
function ramRejectReason(name) {
  const t = name || '';
  const a = ramAttributes(t);
  // A — form factor: keep only DIMM/UDIMM; anything else is out of scope.
  if (a.formFactor === 'SODIMM') return 'laptop_sodimm';
  if (a.formFactor === 'RDIMM' || a.formFactor === 'LRDIMM') return 'server_registered_ram';
  // B — server/registered name backstop (hyphenated forms + buffered + "server memory")
  if (/\b(lr-?dimm|r-?dimm|registered|buffered|server\s+memory)\b|\becc[\s-]*reg\b/i.test(t)) return 'server_registered_ram';
  // B — ECC now out of scope entirely (incl. consumer unbuffered ECC UDIMM)
  if (a.ecc) return 'ecc_ram';
  // A — laptop name backstop (defense in depth vs an attribute miss)
  if (/so-?dimm|s\.o\.dimm|\b(204|260|262)[\s-]*pin\b|\b(laptop|notebook)\b/i.test(t)) return 'laptop_sodimm';
  return null;
}

// Storage scope gate — "does this drive belong in a consumer/gaming DESKTOP
// catalog?". Modeled on ramRejectReason: the PRIMARY test is the COMPUTED form-
// factor / interface fields the catalog already carries (ff/form/formFactor +
// interface); the raw-name regex is only a backstop for rows missing those.
//
// Out of scope:
//   • enterprise/server — SAS interface, or U.2 / U.3 / EDSFF form factor
//   • external          — USB interface (belongs in ExternalStorage, not internal)
// In scope: internal SATA/NVMe desktop drives (M.2, 2.5", 3.5"). A 3.5" NAS/
// surveillance HDD has a DESKTOP-valid computed form factor and is deliberately
// NOT rejected here — gating it would be a name-regex policy call, not a form
// factor one, and is left to a separate decision.
//
// Out of scope ALSO: a whole NAS APPLIANCE (a networked storage SYSTEM with its
// own CPU / OS / enclosure — Synology DiskStation, QNAP, UGREEN NASync) rides into
// Storage on the word "NAS" but is a complete machine, not a drive a build selects.
// Derived Storage attributes (interface / form factor) read from the TITLE, the
// same way ramAttributes() derives DIMM formFactor. The discovery feed carries no
// structured interface field (attr_1..10 are opaque IDs), so on that path the
// storage scope gate has nothing to key on unless we compute it here. A catalog
// row that already carries a real p.interface/p.formFactor still wins — these are
// only the fallback when the structured field is absent.
//   • external transport wins over the inner bus: a "PCIe NVMe Portable External"
//     enclosure is an EXTERNAL drive regardless of the NVMe inside, so it must not
//     land in INTERNAL storage. That is why external is tested before SAS/NVMe/SATA.
function storageAttributes(title) {
  const t = String(title || '');
  let iface = null;
  if (/\b(external|portable|enclosure|thunderbolt)\b/i.test(t) || /\busb\b/i.test(t)) iface = 'USB';
  else if (/\bsas\b/i.test(t)) iface = 'SAS';
  else if (/\bnvme\b/i.test(t) || /\bpci[\s-]?e(xpress)?\b/i.test(t)) iface = 'NVMe';  // "PCIe" / "PCI Express" / "PCI-Express"
  else if (/\bsata\b/i.test(t)) iface = 'SATA';
  let formFactor = null;
  if (/\bu\.2\b/i.test(t)) formFactor = 'U.2';
  else if (/\bu\.3\b/i.test(t)) formFactor = 'U.3';
  else if (/\bedsff\b/i.test(t) || /\bE[13]\.[SL]\b/i.test(t)) formFactor = 'EDSFF';  // EDSFF ruler drives: E1.S/E1.L/E3.S/E3.L
  else if (/\bm\.2\b/i.test(t)) formFactor = 'M.2';
  const hotSwap = /\bhot[\s-]?swap(pable)?\b/i.test(t);   // "hot-swap" AND "hot swappable"
  return { interface: iface, formFactor, hotSwap };
}

function storageRejectReason(product) {
  // Accept a bare title string (discovery path) OR a catalog product object
  // (nightly / one-shot passes). A real structured field on the object wins;
  // otherwise fall back to what storageAttributes() reads from the title.
  const p = (product && typeof product === 'object') ? product : { n: product };
  const title = p.n || p.name || '';
  const a = storageAttributes(title);
  const ff = `${p.ff || ''} ${p.form || ''} ${p.formFactor || ''} ${a.formFactor || ''}`;
  const iface = String(p.interface || a.interface || '').toUpperCase().trim();
  // A — computed interface / form factor (PRIMARY)
  if (iface === 'SAS') return 'enterprise_sas';
  if (/\bU\.2\b|\bU\.3\b|\bEDSFF\b/i.test(ff)) return 'enterprise_form';
  if (p.hotSwap === true || a.hotSwap) return 'enterprise_hotswap';   // server/rackmount hot-swap carrier
  if (iface === 'USB') return 'external_usb';
  // B — raw-name backstop (only for rows whose fields didn't carry the signal)
  const t = title;
  if (/\b(sas|u\.2|u\.3|edsff)\b/i.test(t) || /\bE[13]\.[SL]\b/i.test(t)) return 'enterprise_sas';
  if (/\bhot[\s-]?swap(pable)?\b/i.test(t)) return 'enterprise_hotswap';
  if (/\b(external|portable|enclosure|thunderbolt)\b/i.test(t)) return 'external_usb';
  // C — whole NAS APPLIANCE, not a drive. Signal: a drive-BAY count on a NAS /
  //     NASync / DiskStation / Network-Attached-Storage unit. NAS-rated internal
  //     drives say "NAS Internal Hard Drive / NAS SSD" and never carry an "N-Bay"
  //     enclosure descriptor — that count is what separates the machine from the disk.
  if (/\b\d+[\s-]?bay\b/i.test(t)
      && /\b(nas|nasync|diskstation|network[\s-]attached\s+storage)\b/i.test(t)
      && !/\binternal\s+(hard\s+drive|solid[\s-]state|ssd|hdd)\b/i.test(t)) return 'nas_appliance';
  return null;
}

// CPU scope gate — server/HEDT parts do not belong in a consumer/gaming desktop
// catalog. PRIMARY test is the COMPUTED socket field; name is the backstop.
const CPU_SERVER_SOCKETS = new Set([
  'SP3', 'SP5', 'SP6', 'STRX4', 'SWRX8', 'TR4', 'TR5', 'STR5',
  'LGA2066', 'LGA2011', 'LGA3647', 'LGA4189', 'LGA4677', 'LGA1366',
]);
// Whole-SYSTEM detector — a complete prebuilt PC / laptop / AIO is not a component
// and breaks builds if it sits in a component category (a "Business Desktop" listed
// as a CPU, a laptop listed as a GPU). Category-agnostic: the same title test that
// rejects a prebuilt from CPU also finds one wrongly filed under GPU/Motherboard/etc.
//
// The false positives this MUST avoid (all verified against the live catalog):
//   • "Gaming Desktop Motherboard/Processor/Memory" — marketing on a real component
//   • "for Laptop & Desktop" / "Laptop Memory" — compatibility text on RAM/SSD
//   • "All-in-One CPU Liquid Cooler" (AIO) — a cooler, not an all-in-one PC
//   • "Liquid Freezer WS360 … Workstation" — a WS-series cooler, not a workstation PC
function prebuiltSystemReason(name) {
  const t = String(name || '');
  // (1) SPEC-BUNDLE — the decisive, low-false-positive signal. A whole machine lists a
  //     CPU model AND (an installed Windows edition OR both a RAM capacity and a storage
  //     capacity). No single component carries all of these: a RAM stick has no CPU +
  //     SSD, a bare CPU has no "8GB RAM + 512GB SSD + Windows 11 Home". Keyword tests on
  //     "desktop"/"laptop" alone are hopeless here — they hit "Desktop Computer Memory"
  //     and "for Pc or Laptop" compat text; this does not.
  const hasCPU = /\bcore\s+(i[3579]|ultra)\b|\bi[3579]-\d{4,5}[a-z]{0,2}\b|\bryzen\s+[3579]\b|\bintel\s+processor\b|\b(pentium|celeron|athlon)\b/i.test(t);
  const hasOSEdition = /\bwindows\s*1[01]\s+(home|pro|enterprise)\b/i.test(t);
  const hasRAM = /\b\d{1,3}\s?gb\b[^.|]{0,30}\b(ddr[45]|ram)\b/i.test(t) || /\bddr[45]\b[^.|]{0,20}\b\d{1,3}\s?gb\s*(ram)?\b/i.test(t);
  const hasStorage = /\b\d{2,4}\s?(gb|tb)\b[^.|]{0,30}\b(ssd|nvme|hdd|hard\s+drive|emmc|ufs)\b/i.test(t);
  if (hasCPU && (hasOSEdition || (hasRAM && hasStorage))) return 'prebuilt_system';
  // (1b) "Gaming PC/Desktop" that names BOTH a CPU model AND a GPU model is a whole
  //      machine ("Azure 3 Gaming PC, Ryzen 7 9700X, NVIDIA RTX 5060"). Bare "Gaming
  //      PC" stays allowed (it rides in case titles); the CPU+GPU pair is the gate —
  //      a case / CPU / GPU listing never names both a CPU model and a GPU model.
  const hasGPU = /\b(rtx|gtx)\s?\d{3,4}\b|\brx\s?\d{3,4}\b|\bgeforce\b|\bradeon\b/i.test(t);
  if (hasCPU && hasGPU && /\bgaming\s+(pc|desktop|computer|rig)\b/i.test(t)) return 'prebuilt_gaming';
  // (2) explicit prebuilt brand model lines — unambiguously whole machines even without
  //     a full spec list.
  if (/\b(prodesk|elitedesk|optiplex|thinkcentre|thinkstation|ideacentre|inspiron\s+desktop|pavilion\s+desktop|aspire\s+(tc|xc|c\d)|legion\s+tower|predator\s+orion|alienware\s+aurora|omen\s+\d+\s+desktop)\b/i.test(t)) return 'prebuilt_brand';
  // (3) explicit system nouns as the PRODUCT — backstop for spec-less listings. Kept
  //     TIGHT: "Desktop Computer" and "Mini PC" are EXCLUDED (they ride along in case
  //     titles / "Desktop Computer Memory"), and a "for/compatible-with ... Desktop"
  //     COMPAT clause is excluded ("Low Profile Video Card for Slim Desktop PC" is a GPU).
  //     Real prebuilts almost always also trip the spec-bundle above; this only helps a
  //     spec-less "HP Business Desktop"-style title.
  if (/\bbusiness\s+desktop\b|\bslim\s+desktop\b|\ball[- ]in[- ]one\s+(pc|computer|desktop)\b/i.test(t)
      && !/\b(for|compatible|supports?|fits?|works?\s+with|in\s+a)\b[^.|]{0,24}\bdesktop\b/i.test(t)) return 'prebuilt_noun';
  return null;
}

// Multi-component BUNDLE detector — two distinct buildable components sold in ONE
// listing (a "Ryzen 9 7900X + B650 Motherboard" combo). Left in a component
// category it MISPRICES the builder (a CPU+mobo combo shows as a bare CPU at the
// combined price) and, sharing no key with either single part, sits alongside them
// in browse. Category-agnostic: the same title test finds a combo whether it is
// filed as CPU or Motherboard.
//
// Signal: >=2 DISTINCT component types named as PRODUCTS, joined by an explicit
// combining token ("+", the word "bundle"/"combo", or "<processor> with <mobo>").
// Guards (each verified against a live-catalog false positive):
//   • VRM "N+M power stages" / "12+2+1" — stripped before the "+" test, so a plain
//     board ("ROG Strix B650-A ... 12 + 2 power stages, DDR5") is NOT a combo.
//   • Compatibility text ("supports/for/compatible/works with Ryzen") — carries no
//     combining token, so it never clears the >=2-types-with-join bar.
//   • Multipacks / accessory kits — a "Triple Fan Kit with Hub", an "SSD Upgrade
//     Kit with Transfer Cable", a "4TB SSD Bundle with 2 YR Protection Pack" name
//     only ONE buildable component (fans / storage), so present.length < 2 (and the
//     warranty guard drops the "Protection Pack" bundle word).
function bundleReason(name) {
  const raw = String(name || '');
  const t = raw
    .replace(/\b\d{1,2}\s*(?:\+\s*\d{1,2}\s*){1,3}(?:power\s*)?(?:stages?|phases?)/ig, ' ')
    .replace(/\b\d{1,2}\+\d{1,2}(?:\+\d{1,2}){0,2}\b/g, ' ');
  const TYPE = {
    cpu:    /\b(?:core\s+(?:i[3579]|ultra)\s*\d?|i[3579][-\s]\d{4,5}[a-z]{0,2}|ryzen\s+[3579]\s+\d{3,4}[a-z0-9]*|threadripper\s+(?:pro\s+)?\d{3,4})\b/i,
    mobo:   /\b(?:motherboard|mobo)\b/i,
    gpu:    /\b(?:(?:rtx|gtx)\s*\d{3,4}|rx\s*\d{3,4}|arc\s+[ab]\d{3})\b|\bgraphics\s+card\b/i,
    psu:    /\b(?:power\s+supply|psu)\b/i,
    ram:    /\b\d{1,3}\s?gb\b[^.|]{0,12}\bddr[45]\b/i,
    cooler: /\b(?:cpu|aio|air|liquid)\s+cooler\b/i,
  };
  const present = Object.keys(TYPE).filter((k) => TYPE[k].test(t));
  if (present.length < 2) return null;
  const warranty = /\b(?:warranty|protection|cps|care|coverage|plan)\b/i.test(t);
  const hasWord = /\b(?:combo|bundle)\b/i.test(t) && !warranty;
  const hasPlus = /[a-z0-9)™]\s*\+\s*[a-z0-9(]/i.test(t);
  const procWith = /\b(?:processor|cpu|gpu|graphics\s+card)\b[^.|]{0,50}\bwith\b[^.|]{0,60}\b(?:motherboard|mobo|power\s+supply|psu|cooler)\b/i.test(t);
  if (!(hasWord || hasPlus || procWith)) return null;   // no combining token → compatibility text, not a bundle
  return present.sort().join('+');
}

function cpuRejectReason(product) {
  const p = product || {};
  const sock = String(p.socket || '').toUpperCase().replace(/\s+/g, '');
  if (CPU_SERVER_SOCKETS.has(sock)) return 'server_hedt_socket';
  const pre = prebuiltSystemReason(p.n);        // a prebuilt PC is not a CPU
  if (pre) return pre;
  if (/\b(epyc|xeon|threadripper)\b/i.test(p.n || '')) return 'server_hedt_name';
  return null;
}

// PSU scope gate — a UPS / battery backup is NOT a power supply. Left in the PSU
// category it surfaces as a selectable build PSU and breaks builds (a 1500VA UPS
// has no ATX rail a build can draw from). Unlike RAM/Storage/CPU there is no
// computed field that separates a UPS from a PSU — both are "power" — so the NAME
// is the primary signal: a UPS is rated in VA and self-describes as UPS / battery
// backup / uninterruptible, none of which a real ATX PSU title carries.
//
// Second out-of-scope class: a REDUNDANT / hot-swap SERVER supply (a 1+1 / N+1
// dual-module or CRPS unit) is a paired enterprise part, not a single-rail ATX
// PSU a desktop build can select. Keyed on the REDUNDANCY signal (redundant /
// hot-swap / CRPS), never on a bare "1U/2U" — that appears as compat text on
// legit Flex-ATX SFF supplies ("Perfect for SFF PC, 1U IPC, and NAS", "Mini ITX/
// Flex ATX / 1U 500W ... PSU") which stay in scope.
function psuRejectReason(product) {
  const t = typeof product === 'string' ? product : (product && (product.n || product.name)) || '';
  if (/\buninterruptible\b|\bups\b|battery[\s-]?backup\b|\b\d{3,4}\s*va\b/i.test(t)) return 'ups_not_psu';
  if (/\bredundant\b/i.test(t) && /\b(power\s*supply|psu|module|\d\s*\+\s*\d)\b/i.test(t)) return 'server_redundant';
  if (/\bhot[\s-]?swap\b/i.test(t) && /\b(power\s*supply|psu|redundant|crps)\b/i.test(t)) return 'server_redundant';
  if (/\bcrps\b/i.test(t)) return 'server_redundant';
  // 1U/2U rackmount server PSU — but a consumer SFF PSU (Flex-ATX/SFX/SFF/
  // Mini-ITX) legitimately advertises "1U" CHASSIS COMPATIBILITY (see the
  // psu-scope test), so only reject when no consumer SFF form factor is present.
  if (/\b[12]U\b/.test(t) && !/\b(flex[\s-]?atx|sfx|sff|mini[\s-]?itx)\b/i.test(t)) return 'server_rackmount';
  if (/\b\d{2,3}\s?VDC\b/i.test(t)) return 'server_dc_module';   // 12/48/54 VDC telecom / network-switch PSU module (not consumer ATX AC)
  return null;
}

// Resolve the catalog brand for a DISCOVERED product. Prefer the title reading,
// but fall back to the authoritative feed manufacturer when detectBrand returns
// nothing OR an implausible chip-giant for the category (a mis-read off marketing
// text — "AMD EXPO" / "Intel XMP" on a memory kit). This also covers brand
// spellings the BRANDS patterns miss ("G. SKILL" / "G SKILL" vs "G.Skill") and
// brands not in the BRANDS list at all (Silicon Power, V-Color, KLEVV, …), which
// only ever resolve via the manufacturer field. The manufacturer for a RAM/PSU/
// etc. product is never a chip giant, so this guarantees no AMD/Intel/NVIDIA
// brand leaks onto a category those companies don't make.
function cleanManufacturer(s) {
  return String(s || '')
    .replace(/\b(technology|technologies|corp\.?|corporation|inc\.?|co\.?|ltd\.?|memory)\b/gi, '')
    .replace(/\s+/g, ' ').trim();
}
function resolveDiscoveryBrand(title, manufacturer, category) {
  let b = detectBrand(title, '');
  if (!b || implausibleBrandForCategory(b, category)) b = cleanManufacturer(manufacturer) || b || null;
  return b;
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
  ramAttributes,
  ramRejectReason,
  storageRejectReason,
  storageAttributes,
  cpuRejectReason,
  psuRejectReason,
  prebuiltSystemReason,
  bundleReason,
  cleanManufacturer,
  resolveDiscoveryBrand,
};
