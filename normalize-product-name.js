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

export default { canonicalizeProductName, sameCanonicalIdentity, extractModelToken };
