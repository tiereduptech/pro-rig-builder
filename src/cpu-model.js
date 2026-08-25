// =============================================================================
//  src/cpu-model.js
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  Pulls the model number out of a CPU name as the scanner reported it, so the
//  upgrade page can look the chip up in the catalog and in the baseline tables.
//
//  ── Why this is its own file ────────────────────────────────────────────────
//  The AMD pattern used to capture at most two trailing letters, so every X3D
//  chip lost its "3D": "Ryzen 7 5800X3D" came back as "5800X". That is not a
//  harmless truncation — "5800X" is a REAL, different, much slower processor,
//  so the page silently swapped the user's chip for the non-3D variant and then
//  recommended they buy the 3D one they already owned. Same shape for 7600X3D,
//  9950X3D and 7950X3D; 9800X3D and 7800X3D failed to resolve at all.
//
//  Model parsing is now here, on its own, with tests, because getting it wrong
//  is invisible on screen — every downstream figure still renders, just for
//  the wrong CPU.
// =============================================================================

// AMD desktop model suffixes, LONGEST FIRST — the alternation is ordered, so
// "X3D" must precede "X" and "XT"/"GT" must precede "X"/"G" or the shorter
// branch wins and eats only the first letter. Every suffix AMD currently ships
// on desktop parts is here; anything unknown falls through to a bare 4-digit
// model, which is the old behaviour and still resolves via the baseline tables.
const AMD_SUFFIXES = "X3D|XT|GT|X|G|F|E";

// Classic Intel naming: "Core i7-14700K". Tops out at two trailing letters
// (K, KF, KS, F, T), which the {0,2} bound covers. Left exactly as it was — the
// Core Ultra shapes are handled by a separate pattern below rather than by
// loosening this one, so classic parsing cannot regress.
const INTEL_RE = /CORE\s+(?:ULTRA\s+)?[IU]?[3579]-?(\d{3,5}[A-Z]{0,2})/;

// Core Ultra (Series 2, LGA1851) puts a SEPARATOR between the tier digit and the
// model number, which INTEL_RE has no allowance for — so every one of them
// extracted as null and the upgrade page could not identify the CPU at all.
//
// Three other places were already written for these models and were unreachable:
// intelGeneration()'s "3-digit bare numbers (Core Ultra 245/265) ... treat as gen
// 15" branch, inferCPUSocket's gen>=15 -> LGA1851 mapping, and the "245K"/"265K"/
// "285K" rows in CPU_BASELINE_INTEL.
//
// The shapes that actually occur, across scanner output and catalog listings:
//   "Intel Core Ultra 9 285K"                     tier, space, model
//   "Intel CPU Core Ultra5 225F Processor"        no space after "Ultra"
//   "Intel - Core Ultra 7 Processor 270K Plus"    a word between tier and model
//   "Core(TM) Ultra 5 Desktop Processor 225"      two words, and a trademark mark
//
// \W* absorbs the (R)/(TM)/®/™ debris and the separators; the bounded skip covers
// "Desktop"/"Processor"/"CPU" without letting the model number drift arbitrarily
// far from its tier digit.
const INTEL_ULTRA_RE = /CORE\W*ULTRA\W*[3579]\W+(?:(?:DESKTOP|PROCESSOR|CPU)\W+){0,2}(\d{3,5}[A-Z]{0,2})/;
const AMD_RE   = new RegExp(`RYZEN\\s*\\d\\s+(\\d{4}(?:${AMD_SUFFIXES})?)`);

/**
 * Extract {brand, model} from a scanner-reported CPU name.
 * Returns null when the name matches neither vendor's shape.
 *
 *   "AMD Ryzen 7 9800X3D"     -> { brand: "AMD",   model: "9800X3D" }
 *   "Intel Core i7-14700K"    -> { brand: "Intel", model: "14700K" }
 *   "Intel Core Ultra 9 285K" -> { brand: "Intel", model: "285K" }
 */
export function extractCPUModel(name) {
  if (!name) return null;
  const n = name.toUpperCase();
  let m = n.match(INTEL_RE);
  if (m) return { brand: "Intel", model: m[1] };
  m = n.match(INTEL_ULTRA_RE);
  if (m) return { brand: "Intel", model: m[1] };
  m = n.match(AMD_RE);
  if (m) return { brand: "AMD", model: m[1] };
  return null;
}
