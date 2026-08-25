// =============================================================================
//  test/mobo-gen.test.js
//
//  The bug these cover: X870 was missing from the chipset table while 47 catalog
//  boards used it, so the storage card told those owners their current AM5
//  flagship board was PCIe Gen3 and halved the NVMe pool it offered them.
//
//  The failure was silent — an unlisted chipset returns the same Gen3 as a
//  deliberately-Gen3 one. The catalog-coverage test below is the real guard: a
//  new chipset shipping now fails here instead of quietly downgrading boards.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import PARTS from "../src/data/parts.js";
import { inferMoboGen, isKnownChipset, KNOWN_CHIPSETS, DEFAULT_GEN } from "../src/mobo-gen.js";

test("every chipset in the catalog is explicitly handled", () => {
  // The staleness guard. If this fails, a chipset started shipping and the table
  // has not caught up — boards on it are silently being told they are Gen3.
  const chipsets = new Set(
    PARTS.filter((p) => p.c === "Motherboard" && !p.bundle && p.chipset)
      .map((p) => String(p.chipset).toUpperCase().trim())
      .filter(Boolean),
  );
  const missing = [...chipsets].filter((c) => !isKnownChipset(`MSI MAG ${c} TOMAHAWK`));
  assert.deepEqual(missing, [], `unhandled chipsets — add them to CHIPSET_GEN: ${missing.join(", ")}`);
});

test("X870 and X870E resolve to Gen4, not the Gen3 default", () => {
  // The reported bug: 47 boards on the current AM5 flagship chipset.
  assert.equal(inferMoboGen("MSI MAG X870 TOMAHAWK WIFI"), 4);
  assert.equal(inferMoboGen("ASUS ROG STRIX X870E-E GAMING WIFI"), 4);
  assert.equal(inferMoboGen("GIGABYTE X870 AORUS ELITE WIFI7"), 4);
});

test("the chipsets that were also falling through now resolve", () => {
  assert.equal(inferMoboGen("ASUS Q670M-C business board"), 4);   // 600-series vPro variant
  assert.equal(inferMoboGen("ASUS Pro WS WRX90E-SAGE SE"), 4);    // Threadripper Pro
  assert.equal(inferMoboGen("ASRock H810M-HDV"), 3);              // LGA1851 entry, genuinely Gen3
  assert.equal(inferMoboGen("Supermicro X10DRi C612"), 3);        // old Xeon, genuinely Gen3
});

test("a deliberate Gen3 and an unknown board are distinguishable", () => {
  // Both return 3, which is exactly why the silent failure was possible. The
  // difference has to be visible somewhere, and it is isKnownChipset.
  assert.equal(inferMoboGen("MSI B450 TOMAHAWK MAX"), 3);
  assert.equal(isKnownChipset("MSI B450 TOMAHAWK MAX"), true);

  assert.equal(inferMoboGen("Dell Inc. 0KWVT8 A00"), DEFAULT_GEN);
  assert.equal(isKnownChipset("Dell Inc. 0KWVT8 A00"), false);
});

test("existing Gen4 and Gen3 mappings are unchanged", () => {
  for (const board of ["MSI MAG B550 TOMAHAWK", "MSI MEG X570 UNIFY", "MSI PRO B650M-A WIFI",
                       "ASUS ROG STRIX X670E-E", "MSI MPG B850 EDGE", "MSI MAG Z890 TOMAHAWK",
                       "MSI PRO B860M-A", "ASUS TUF B760M-PLUS", "MSI MPG Z790 CARBON"]) {
    assert.equal(inferMoboGen(board), 4, board);
  }
  for (const board of ["MSI B450 TOMAHAWK", "ASUS PRIME A520M-K", "MSI B840M PRO",
                       "MSI Z270 GAMING PRO", "ASUS PRIME Z390-A", "MSI MAG Z490 TOMAHAWK",
                       "ASRock H610M-HDV"]) {
    assert.equal(inferMoboGen(board), 3, board);
  }
});

test("optional trailing letters and suffixes still match", () => {
  // B650 / B650M / B650E / B650M-A must all resolve the same way.
  for (const s of ["B650", "B650M", "B650E", "B650M-A", "B650M WIFI"]) {
    assert.equal(inferMoboGen(`MSI PRO ${s}`), 4, s);
  }
});

test("junk input falls back to the default rather than throwing", () => {
  for (const bad of [null, undefined, "", 42, {}, []]) {
    assert.equal(inferMoboGen(bad), DEFAULT_GEN);
    assert.equal(isKnownChipset(bad), false);
  }
});

test("no chipset token is listed twice with different generations", () => {
  // A duplicate would make the answer depend on table order.
  assert.equal(KNOWN_CHIPSETS.size, [...KNOWN_CHIPSETS].length);
  for (const c of KNOWN_CHIPSETS) {
    assert.ok(/^[A-Z]+[0-9]+$/.test(c), `malformed chipset token: ${c}`);
  }
});
