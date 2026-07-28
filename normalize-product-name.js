// ═══════════════════════════════════════════════════════════════════
// normalize-product-name.js — shared normalizer for catalog product names
//
// Converts catalog names like "AMD Ryzen 9 5900X 12-Core 3.7 GHz Socket AM4"
// into canonical keys like "AMD|Ryzen 9|5900X" used by the known-good ASIN table.
//
// Design goal: "5900X" must never collide with "5900XT" because the model
// number is a required token. Different models = different keys.
// ═══════════════════════════════════════════════════════════════════

// Common CPU patterns
const CPU_PATTERNS = [
  // Intel Core iX-YYYYY with optional suffix (K, KF, F, etc.)
  { rx: /\b(Intel)\s+Core\s+(i[3579])-(\d{4,5}[A-Z]{0,3})\b/i,
    fmt: (m) => `${m[1].toUpperCase()}|Core ${m[2].toLowerCase()}|${m[3].toUpperCase()}` },
  // Intel Core Ultra X YYYY (new naming)
  { rx: /\b(Intel)\s+Core\s+Ultra\s+(\d)\s+(\d{3}[A-Z]{0,3})\b/i,
    fmt: (m) => `${m[1].toUpperCase()}|Core Ultra ${m[2]}|${m[3].toUpperCase()}` },
  // AMD Ryzen X YYYYY with optional suffix (X, X3D, XT, G, etc.)
  { rx: /\b(AMD)\s+Ryzen\s+(\d)\s+(\d{4}[A-Z0-9]{0,3})\b/i,
    fmt: (m) => `${m[1].toUpperCase()}|Ryzen ${m[2]}|${m[3].toUpperCase()}` },
  // AMD Threadripper
  { rx: /\b(AMD)\s+(Ryzen\s+Threadripper|Threadripper)\s+(?:PRO\s+)?(\d{4}[A-Z0-9]{0,3}X?)\b/i,
    fmt: (m) => `${m[1].toUpperCase()}|Threadripper|${m[3].toUpperCase()}` },
];

// GPU patterns
const GPU_PATTERNS = [
  // NVIDIA RTX/GTX — brand + card series + number + optional TI/SUPER/TI SUPER
  { rx: /\b(RTX|GTX)\s*(\d{4})\s*(TI\s*SUPER|SUPER|TI)?\b/i,
    fmt: (m) => {
      const suffix = m[3] ? " " + m[3].toUpperCase().replace(/\s+/g, " ") : "";
      return `NVIDIA|${m[1].toUpperCase()}|${m[2]}${suffix}`;
    } },
  // AMD RX — similar, with XT/XTX
  { rx: /\b(RX)\s*(\d{3,4})\s*(XTX|XT)?\b/i,
    fmt: (m) => {
      const suffix = m[3] ? " " + m[3].toUpperCase() : "";
      return `AMD|RX|${m[2]}${suffix}`;
    } },
  // Intel Arc
  { rx: /\b(Arc)\s*([AB]\d{3})\b/i,
    fmt: (m) => `INTEL|Arc|${m[2].toUpperCase()}` },
];

// Motherboard patterns — more varied, so looser matching
const MOBO_PATTERNS = [
  // Common: Brand + chipset (Z790, B550, X670) + optional model suffix
  { rx: /\b(ASUS|MSI|GIGABYTE|ASRock|NZXT|EVGA|BIOSTAR)\b.*?\b([XZBH]\d{3}[A-Z]{0,2})\b/i,
    fmt: (m) => `${m[1].toUpperCase()}|MOBO|${m[2].toUpperCase()}` },
];

// RAM patterns
const RAM_PATTERNS = [
  // Brand + DDR4/5 + size + speed
  { rx: /\b(Corsair|G\.?SKILL|Kingston|TeamGroup|Crucial|Patriot|ADATA|XPG|Klevv|OLOy|Silicon Power)\b.*?(DDR[45])\s+(\d+)GB.*?(\d{4})MHz/i,
    fmt: (m) => `${m[1].toUpperCase().replace(/[\s.]/g, '')}|${m[2]}|${m[3]}GB-${m[4]}` },
];

// Storage patterns
const STORAGE_PATTERNS = [
  // Brand + capacity + type
  { rx: /\b(Samsung|WD|Western Digital|Seagate|Crucial|SanDisk|Kingston|Corsair|TeamGroup|SK hynix|Solidigm|ADATA|XPG|Lexar|SiliconPower|Silicon Power)\b.*?(\d+(?:\.\d+)?)\s*(TB|GB)\b.*?(NVMe|SATA|M\.2|SSD|HDD)/i,
    fmt: (m) => `${m[1].toUpperCase().replace(/\s+/g, '')}|${m[2]}${m[3].toUpperCase()}|${m[4].toUpperCase()}` },
];

// PSU patterns
const PSU_PATTERNS = [
  // Brand + wattage + efficiency rating
  { rx: /\b(Corsair|EVGA|Seasonic|Cooler Master|Thermaltake|be quiet|NZXT|ASUS|MSI|SUPER FLOWER|FSP|Antec|Rosewill|ARESGAME|Phanteks)\b.*?(\d{3,4})W.*?(Bronze|Silver|Gold|Platinum|Titanium)/i,
    fmt: (m) => `${m[1].toUpperCase().replace(/\s+/g, '')}|${m[2]}W|${m[3].toUpperCase()}` },
];

// Case patterns
const CASE_PATTERNS = [
  // Brand + model (first distinctive word after brand)
  { rx: /\b(NZXT|Corsair|Lian Li|Fractal Design|Phanteks|Cooler Master|Thermaltake|be quiet|MSI|ASUS|Hyte|Montech|DeepCool)\b\s+([A-Z0-9]+[\w-]*)/i,
    fmt: (m) => `${m[1].toUpperCase().replace(/\s+/g, '')}|CASE|${m[2].toUpperCase()}` },
];

const CATEGORY_PATTERNS = {
  CPU: CPU_PATTERNS,
  GPU: GPU_PATTERNS,
  Motherboard: MOBO_PATTERNS,
  RAM: RAM_PATTERNS,
  Storage: STORAGE_PATTERNS,
  PSU: PSU_PATTERNS,
  Case: CASE_PATTERNS,
};

/**
 * Normalize a product name into a canonical key.
 * Returns null if no pattern matches (can't canonicalize).
 *
 * @param {string} name - raw catalog name
 * @param {string} category - one of "CPU", "GPU", "Motherboard", "RAM", "Storage", "PSU", "Case"
 * @returns {string|null} canonical key like "AMD|Ryzen 9|5900X"
 */
export function canonicalizeProductName(name, category) {
  if (!name || !category) return null;
  const patterns = CATEGORY_PATTERNS[category];
  if (!patterns) return null;
  for (const { rx, fmt } of patterns) {
    const match = name.match(rx);
    if (match) return fmt(match);
  }
  return null;
}

/**
 * Check if two product names share the same canonical identity.
 * Example: "AMD Ryzen 9 5900X" matches "AMD Ryzen 9 5900X Processor"
 * but NOT "AMD Ryzen 9 5900XT 16-Core".
 */
export function sameCanonicalIdentity(nameA, nameB, category) {
  const a = canonicalizeProductName(nameA, category);
  const b = canonicalizeProductName(nameB, category);
  return a !== null && a === b;
}

/**
 * Extract the "model token" from a name — the distinguishing identifier.
 * Used for strict token-level matching (5900X ≠ 5900XT).
 */
export function extractModelToken(name, category) {
  const canonical = canonicalizeProductName(name, category);
  if (!canonical) return null;
  const parts = canonical.split('|');
  return parts[parts.length - 1]; // last segment is always the model
}

// ═══════════════════════════════════════════════════════════════════
// Capacity guards — shared by every ASIN-matching / price-copy path so a
// listing of the wrong capacity can never be attached to a product.
//
// Root cause they defend against: storage vendors (KingSpec, ORICO, …) reuse
// one boilerplate title across every capacity, differing only in the capacity
// token. Token-overlap scoring therefore "matches" a 128GB listing to a 2TB
// product. These helpers make capacity a hard gate, not a soft signal.
// ═══════════════════════════════════════════════════════════════════

/**
 * Parse the FIRST storage capacity found in free text, normalized to GB.
 * "2TB 2.5 SSD …" → 2000; "KingSpec 128GB …" → 128; "550MB/s" → ignored.
 * @returns {number|null} capacity in GB, or null if none present.
 */
export function parseCapacityGB(text) {
  if (!text) return null;
  // Scan for capacity tokens, skipping transfer rates: "6Gb/s", "550 GB/s", "6Gbps"
  // (the optional trailing /s or ps marks a rate, not a size). Return the first real size.
  const re = /(\d+(?:\.\d+)?)\s*(TB|GB)\b(\s*\/?\s*s\b|ps\b)?/gi;
  let m;
  while ((m = re.exec(String(text))) !== null) {
    if (m[3]) continue; // transfer-rate suffix → not a capacity
    const v = parseFloat(m[1]);
    if (!isFinite(v) || v <= 0) continue;
    return /tb/i.test(m[2]) ? v * 1000 : v;
  }
  return null;
}

/**
 * Do two capacities refer to the same drive size, allowing marketing rounding?
 * Matches 500↔512, 240/250↔256, 960↔1000, 1.92TB(1920)↔2000, 120↔128.
 * Rejects real tier gaps: 128↔2000, 1000↔2000, 500↔5000.
 * Rule: within 16GB absolute (covers small-cap 240/256) OR within 8%
 *       (covers 512/500, 1920/2000) — distinct tiers are ≥~2x apart, never <8%.
 */
export function capacitiesMatch(a, b) {
  if (a == null || b == null) return false;
  const hi = Math.max(a, b), lo = Math.min(a, b);
  if (hi - lo <= 16) return true;
  return (hi - lo) / hi <= 0.08;
}

/**
 * Non-blocking variant: returns true when capacities agree OR when at least one
 * side has no parseable capacity (can't compare → don't block non-storage cats).
 * Use this as the gate; only an ACTIVE conflict (both present, disagree) blocks.
 */
export function capacityCompatible(a, b) {
  if (a == null || b == null) return true;
  return capacitiesMatch(a, b);
}

/**
 * Heuristic: is this product a spinning hard drive (vs SSD/NVMe)?
 * Drives the $/TB floor — HDD NAND-free media floors lower than SSD.
 */
export function isHardDrive(product) {
  const s = `${product?.storageType || ''} ${product?.form || ''} ${product?.formFactor || ''} ${product?.n || ''}`.toLowerCase();
  if (/\bnvme\b|\bssd\b|solid state|\bm\.?2\b/.test(s)) return false;
  return /\bhdd\b|hard drive|hard disk|7200|5400|\brpm\b|barracuda|ironwolf|wd red|surveillance|skyhawk|exos|wd purple|wd black \d/.test(s);
}

/**
 * Is a price physically possible for the stated capacity?
 * SSD retail NAND can't sell below ~$15/TB; HDD below ~$8/TB. A $22.99 "2TB"
 * SSD ($11.5/TB) is impossible — the price belongs to a smaller drive.
 * @returns {boolean} true if plausible or not judgeable; false if impossibly cheap.
 */
export function isPricePlausibleForCapacity(price, capGB, { isHDD = false } = {}) {
  if (price == null || !capGB || capGB <= 0) return true; // can't judge → don't block
  const perTB = price / (capGB / 1000);
  return perTB >= (isHDD ? 8 : 15);
}

// ── ABSOLUTE per-type price TABLE (floors AND ceilings) ──────────────────────
// WHY ABSOLUTE, NOT RELATIVE: the discovery pipeline's relative floor drops rows
// above PRICE_MULT × the pool MEDIAN. That is structurally blind to a
// systematically inflated feed — when a whole category's feed prices run ~10x
// reality, the median inflates WITH them, so the threshold lands ~10x too high
// and nothing is dropped. A table anchored to real market cannot be moved by the
// bad data. The relative floor stays on as an additional intra-pool outlier check.
//
// WHY IT ALSO GOES STALE: the market moves under a fixed table. The prior DDR5
// ceiling of $10/GB was chosen when "real DDR5 tops ~$5/GB"; after the 2025–26
// DRAM price surge the live consumer catalog runs p50 ~$15/GB, p95 ~$21/GB, so
// $10 rejected 95% of REAL DDR5 — a stale ceiling silently gutting the catalog.
// That failure mode is why this table carries a calibration date and why
// validatePriceBatch() WARNS (failure-rate + age) and QUARANTINES rather than
// hard-dropping: a stale ceiling should never push bad data live, and never nuke
// good data either — flagged rows go to needsReview, never silently in or out.
//
// Recalibrated 2026-07-27 against live PER-SKU retail. RAM is keyed by memType ×
// ECC; ceilings sit above the real max + headroom, floors just below real min (a
// $59 "32GB DDR5" at $1.84/GB, or a mispriced/mismatched module, falls through).
//
// DDR5 ceiling RAISED 22 -> 40 on 2026-07-27: a 47-SKU live audit found $22 was
// ITSELF too tight for the DRAM shortage. Real premium DDR5 lists at $30-36/GB —
// G.SKILL Trident Z5 Royal 32GB @ $1149.99 = $35.9/GB, matched to the cent on
// Newegg; 128GB kits ~$26/GB. Of 47 rows the old ceiling flagged, only ONE was
// truly corrupt (a $796 single 32GB DDR4-3600 stick, ~9x its ~$85 market); the
// other 46 were real and the ceiling — not the data — was wrong. This is the SAME
// stale-ceiling failure the block above warns about, and it was caught precisely
// because the table QUARANTINES rather than drops: the 46 real rows went to review,
// not the bin. $40 clears the real ~$36 max with headroom and still catches absurd.
// DDR4 stays 20: it cleanly isolated the one corrupt stick; a real-but-stale DDR4
// kit ($766, ~2x market) sits just under it and is left live (reprice, not corrupt).
//
// VERIFICATION SOURCE: use NeweggBusiness product pages (neweggbusiness.com) as the
// clean exact-SKU price source. Newegg CONSUMER pages interleave "Sponsored" items,
// so naive scrapes grab the WRONG number (a $469 Team T-Force / $739 GPU bleeding
// into the buy box). The NEXT recalibration MUST verify against NeweggBusiness.
export const PRICE_TABLE_CALIBRATED_AT = '2026-07-27';
export const PRICE_TABLE = {
  RAM: {
    'DDR5':     { floor: 2.0, ceiling: 40 },   // consumer UDIMM; real max ~36/GB (2026-07-27 shortage, NeweggBusiness-verified)
    'DDR5-ECC': { floor: 3.0, ceiling: 35 },   // server RDIMM (now rejected pre-price; kept for completeness)
    'DDR4':     { floor: 0.6, ceiling: 20 },   // real body p95 14.2; isolates the one corrupt 9x stick
    'DDR4-ECC': { floor: 1.5, ceiling: 20 },
    'DDR3':     { floor: 0.5, ceiling: 18 },   // real max 14.25
  },
  Storage: {
    'SSD': { floor: 0.012, ceiling: 1.0 },     // real p99 0.48; 0% loss at 1.0
    'HDD': { floor: 0.006, ceiling: 0.35 },    // real p99 0.29; old 0.1 killed 17.8%
  },
  PSU: {
    'W': { floor: 0.008, ceiling: 0.8 },       // real p99 0.59
  },
  // CPU has no natural per-unit ($/core is meaningless across arch), so it is
  // gated on TOTAL price. A consumer/gaming desktop CPU floors ~$25 (budget
  // Athlon/Celeron) and ceilings ~$1500 (halo consumer parts top ~$700; the
  // headroom clears them and still isolates a mis-attached deal or a server/HEDT
  // part). Added 2026-07-28 — CPU previously had NO absolute bound (audit §2).
  CPU: {
    'TOTAL': { floor: 25, ceiling: 1500 },
  },
};
// Above this fraction of graded rows hitting a bound, suspect the TABLE is stale
// (not the data bad): warn loudly, quarantine the flagged rows, keep running.
export const STALE_CEILING_FAILURE_RATE = 0.30;
// Recalibrate the table at least this often; past it, the age warning fires.
export const PRICE_TABLE_MAX_AGE_DAYS = 90;

// Back-compat: the old flat ceiling exports, re-derived from PRICE_TABLE so any
// external reference keeps resolving. New code should read PRICE_TABLE directly.
export const RAM_PRICE_CEILING_PER_GB = { DDR5: PRICE_TABLE.RAM.DDR5.ceiling, DDR4: PRICE_TABLE.RAM.DDR4.ceiling, DDR3: PRICE_TABLE.RAM.DDR3.ceiling };
export const STORAGE_PRICE_CEILING_PER_GB = { SSD: PRICE_TABLE.Storage.SSD.ceiling, HDD: PRICE_TABLE.Storage.HDD.ceiling };
export const PSU_PRICE_CEILING_PER_W = PRICE_TABLE.PSU.W.ceiling;

// Resolve (category, specs, price) → { group, key, ppu, unit }. ppu is null when
// $/unit isn't computable (missing cap/watts) so callers SKIP (never block on
// missing data). RAM key gets a '-ECC' suffix when specs.ecc is true and an ECC
// band exists (ecc is what ramAttributes() computes, carried on catalog rows).
function resolvePriceKey(category, specs, price) {
  const s = specs || {};
  if (category === 'RAM') {
    const gen = String(s.memType || s.ramType || '').toUpperCase();
    const eccKey = gen + '-ECC';
    const key = s.ecc === true && PRICE_TABLE.RAM[eccKey] ? eccKey : gen;
    return { group: 'RAM', key, ppu: s.cap > 0 ? price / s.cap : null, unit: '$/GB' };
  }
  if (category === 'Storage' || category === 'ExternalStorage') {
    const key = (/HDD/i.test(s.storageType || '') || s.isHDD === true) ? 'HDD' : 'SSD';
    return { group: 'Storage', key, ppu: s.cap > 0 ? price / s.cap : null, unit: '$/GB' };
  }
  if (category === 'PSU') {
    const w = s.watts || s.wattage;
    return { group: 'PSU', key: 'W', ppu: w > 0 ? price / w : null, unit: '$/W' };
  }
  if (category === 'CPU') {
    // Gated on TOTAL price (no meaningful per-unit); ppu carries the raw price.
    return { group: 'CPU', key: 'TOTAL', ppu: price > 0 ? price : null, unit: '$' };
  }
  return { group: null, key: null, ppu: null, unit: null };
}

/**
 * Row-level price gate — the SHARED HELPER every price-write path calls.
 * Fail-open on missing data, QUARANTINE (never drop, never publish) on a bounds
 * miss. Returns { status, reason, ppu, unit, key, floor, ceiling } where status is
 *   'ok'         — within [floor, ceiling]
 *   'quarantine' — above ceiling or below floor → caller sets needsReview + quarantinedAt, KEEPS row
 *   'skip'       — not guarded, or $/unit not computable → admit unguarded
 */
export function priceValidate(category, specs, price) {
  const none = { status: 'skip', reason: null, ppu: null, unit: null, key: null, floor: null, ceiling: null };
  if (price == null || !(price > 0)) return none;
  const { group, key, ppu, unit } = resolvePriceKey(category, specs, price);
  const band = group && PRICE_TABLE[group] ? PRICE_TABLE[group][key] : null;
  if (!band || ppu == null) return { ...none, unit, key, floor: band ? band.floor : null, ceiling: band ? band.ceiling : null };
  const p = Number(ppu.toFixed(3));
  const reason = p > band.ceiling ? 'above_ceiling' : p < band.floor ? 'below_floor' : null;
  return { status: reason ? 'quarantine' : 'ok', reason, ppu: p, unit, key, floor: band.floor, ceiling: band.ceiling };
}

// Back-compat shim: the old boolean-reject shape, sourced from priceValidate.
// reject=true ONLY for above_ceiling, preserving the historical "ceiling" meaning
// for any caller not yet migrated to the richer priceValidate verdict.
export function absolutePriceCeiling(category, specs, price) {
  const v = priceValidate(category, specs, price);
  return { reject: v.reason === 'above_ceiling', ceiling: v.ceiling, unit: v.unit, ppu: v.ppu, key: v.key };
}

// Whole-number day gap between two 'YYYY-MM-DD' strings; null if either is unparseable.
function daysBetweenISO(fromISO, toISO) {
  const a = Date.parse(fromISO + 'T00:00:00Z'), b = Date.parse(toISO + 'T00:00:00Z');
  return (isNaN(a) || isNaN(b)) ? null : Math.round((b - a) / 86400000);
}

/**
 * Batch gate. Runs priceValidate over rows: [{ category, specs, price }] and, on a
 * bounds miss, QUARANTINES (caller stamps needsReview:true + quarantinedAt, KEEPS
 * the row). Fail-open in liveness (never throws/aborts), fail-closed in publishing.
 * Emits LOUD, NON-FATAL warnings:
 *   - failureRate > STALE_CEILING_FAILURE_RATE → ceiling suspected stale
 *   - table age    > PRICE_TABLE_MAX_AGE_DAYS  → recalibrate
 * failureRate = quarantined / (ok + quarantined); skipped rows aren't graded.
 * opts.today: 'YYYY-MM-DD' supplied by the caller — this module never reads a clock.
 */
export function validatePriceBatch(rows, opts) {
  const today = (opts && opts.today) || null;
  const ok = [], quarantined = [], skipped = [];
  for (const row of rows || []) {
    const verdict = priceValidate(row.category, row.specs, row.price);
    const entry = { row, verdict };
    (verdict.status === 'quarantine' ? quarantined : verdict.status === 'skip' ? skipped : ok).push(entry);
  }
  const graded = ok.length + quarantined.length;
  const failureRate = graded ? quarantined.length / graded : 0;
  const ceilingAgeDays = today ? daysBetweenISO(PRICE_TABLE_CALIBRATED_AT, today) : null;
  const warnings = [];
  if (failureRate > STALE_CEILING_FAILURE_RATE)
    warnings.push(`STALE-CEILING SUSPECTED: ${(failureRate * 100).toFixed(1)}% of ${graded} graded rows hit a bound (> ${STALE_CEILING_FAILURE_RATE * 100}%). Flagged rows QUARANTINED (needsReview), never published — recalibrate PRICE_TABLE.`);
  if (ceilingAgeDays != null && ceilingAgeDays > PRICE_TABLE_MAX_AGE_DAYS)
    warnings.push(`PRICE TABLE STALE: calibrated ${PRICE_TABLE_CALIBRATED_AT}, ${ceilingAgeDays}d ago (> ${PRICE_TABLE_MAX_AGE_DAYS}d). Bound-flagged rows QUARANTINED — recalibrate.`);
  return { ok, quarantined, skipped, failureRate: Number(failureRate.toFixed(4)), ceilingAgeDays, calibratedAt: PRICE_TABLE_CALIBRATED_AT, warnings };
}

export default {
  canonicalizeProductName, sameCanonicalIdentity, extractModelToken,
  parseCapacityGB, capacitiesMatch, capacityCompatible, isHardDrive, isPricePlausibleForCapacity,
  RAM_PRICE_CEILING_PER_GB, STORAGE_PRICE_CEILING_PER_GB, PSU_PRICE_CEILING_PER_W, absolutePriceCeiling,
  PRICE_TABLE, PRICE_TABLE_CALIBRATED_AT, PRICE_TABLE_MAX_AGE_DAYS, STALE_CEILING_FAILURE_RATE,
  priceValidate, validatePriceBatch,
};
