// =============================================================================
//  src/mobo-gen.js
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  What PCIe generation can we safely assume for an NVMe drive on this board?
//
//  CONSERVATIVE by design: a chipset counts as Gen5 only if EVERY SKU on it
//  guarantees a Gen5 M.2 slot. Where it is per-board (Z890, X670, B650) we floor
//  to Gen4, so we never recommend a drive the board cannot run at full speed.
//  An unknown or OEM string (Dell/HP/Lenovo) falls back to Gen3 on the same
//  principle: never have the user overpay for speed they may not get.
//
//  ── Why this is a table and not an if-chain ─────────────────────────────────
//  The chipset list goes stale every product cycle, and the failure is silent:
//  an unlisted chipset returns the same Gen3 as a deliberately-Gen3 one, so
//  "we decided this is Gen3" and "we have never heard of this" are
//  indistinguishable. X870 sat unlisted while 47 catalog boards used it, and the
//  storage card told those owners their board was Gen3.
//
//  As a table, KNOWN_CHIPSETS can be asserted against the live catalog, so a new
//  chipset shipping is a failing test rather than a quiet downgrade.
// =============================================================================

// [chipsets, pcieGen]. Order does not matter — every entry is distinct.
const CHIPSET_GEN = [
  // ── Gen4 ──────────────────────────────────────────────────────────────────
  ["B550|X570", 4],                              // AM4, later boards
  ["A620|B650|X670|X870|B850", 4],               // AM5. X870/X870E floored to Gen4
                                                 // beside X670: AMD's X870 spec does
                                                 // mandate a PCIe 5.0 M.2, but the
                                                 // rule above is "Gen5 only if EVERY
                                                 // SKU guarantees it", and Gen4 is
                                                 // unambiguously right either way.
  ["H510|B560|H570|Z590", 4],                    // LGA1200, later boards
  ["B660|H670|Q670|Z690|B760|H770|Z790", 4],     // LGA1700. Q670 is the vPro variant
                                                 // of the 600-series, same generation
                                                 // as the H670/Z690 beside it.
  ["B860|Z890", 4],                              // LGA1851
  ["WRX90|TRX50", 4],                            // Threadripper Pro workstation

  // ── Gen3 ──────────────────────────────────────────────────────────────────
  ["A320|B350|X370|B450|X470|A520", 3],          // AM4, early boards
  ["B840", 3],                                   // AM5 entry
  ["H110|B150|H170|Z170|B250|H270|Z270", 3],     // LGA1151 6th/7th gen
  ["H310|B360|B365|H370|Z370|Z390", 3],          // LGA1151 8th/9th gen
  ["H410|B460|H470|Z490", 3],                    // LGA1200 early
  ["H610", 3],                                   // LGA1700 entry
  ["H810", 3],                                   // LGA1851 entry
  ["C612|C602|X99|X299", 3],                     // older Xeon / HEDT server
  ["H97|Z97|B85|H81", 3],                        // LGA1150, Haswell era
];

// Every chipset token the table knows about, for the staleness assertion.
export const KNOWN_CHIPSETS = new Set(CHIPSET_GEN.flatMap(([pat]) => pat.split("|")));

// Trailing letter is optional ("B650" / "B650M" / "B650E" / "B650M-A") — a plain
// \b boundary will not match because the next character is a word character.
const matches = (pattern, s) => new RegExp("\\b(?:" + pattern + ")[A-Z]?\\b").test(s);

export const DEFAULT_GEN = 3;

/** PCIe generation to assume for a board, from its name. */
export function inferMoboGen(moboStr) {
  if (!moboStr || typeof moboStr !== "string") return DEFAULT_GEN;
  const s = moboStr.toUpperCase();
  for (const [pattern, gen] of CHIPSET_GEN) {
    if (matches(pattern, s)) return gen;
  }
  return DEFAULT_GEN;
}

/** Does this board name resolve to a chipset we have actually made a decision about? */
export function isKnownChipset(moboStr) {
  if (!moboStr || typeof moboStr !== "string") return false;
  const s = moboStr.toUpperCase();
  return CHIPSET_GEN.some(([pattern]) => matches(pattern, s));
}
