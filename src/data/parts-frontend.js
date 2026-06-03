// =============================================================================
//  src/data/parts-frontend.js
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  Browser-side lazy loader for the parts catalog.
//
//  parts.js (the barrel) statically imports every per-category file, which is
//  fine server-side (prerender, sitemap) but would force Vite to bundle the
//  whole catalog into a single chunk. This module instead dynamic-imports each
//  category, letting Rollup split them into per-category chunks that download
//  on demand.
//
//  Contract:
//    PARTS                 — live array, starts empty, mutated in place as
//                            categories load. Existing consumers that hold a
//                            reference to this array see new products appear.
//    loadCategoryParts(c)  — loads ONE category by CAT_SLUG key
//                            (e.g. 'CPU'). Returns Promise<array>.
//    loadAllParts()        — loads every category in parallel.
//                            Returns Promise<full PARTS>.
//    subscribe(fn)         — fn() fires after each successful load so callers
//                            can recompute derived arrays. Returns unsubscribe.
//    isLoaded(catKey)      — fast cache check, no I/O.
//
//  Order: products are appended in category-slug-alpha order (matches the
//  parts/<cat>.js filenames). The server-side barrel preserves the original
//  CPUs-first ordering; the frontend doesn't — anything that depends on
//  positional order should sort explicitly.
// =============================================================================

// Static map from CAT_SLUG key → dynamic-import factory. Vite needs the import
// string to be statically analyzable (no variable template literals at the
// import call site) to emit a separate chunk per category, so we list them
// explicitly here. The filenames mirror scripts/url-slugs.cjs CAT_SLUG values.
const LOADERS = {
  CPU:              () => import('./parts/cpu.js'),
  GPU:              () => import('./parts/gpu.js'),
  Motherboard:      () => import('./parts/motherboard.js'),
  RAM:              () => import('./parts/ram.js'),
  Storage:          () => import('./parts/storage.js'),
  PSU:              () => import('./parts/psu.js'),
  Case:             () => import('./parts/case.js'),
  CPUCooler:        () => import('./parts/cpu-cooler.js'),
  CaseFan:          () => import('./parts/case-fan.js'),
  Monitor:          () => import('./parts/monitor.js'),
  Keyboard:         () => import('./parts/keyboard.js'),
  Mouse:            () => import('./parts/mouse.js'),
  MousePad:         () => import('./parts/mouse-pad.js'),
  Headset:          () => import('./parts/headset.js'),
  Microphone:       () => import('./parts/microphone.js'),
  Webcam:           () => import('./parts/webcam.js'),
  SoundCard:        () => import('./parts/sound-card.js'),
  WiFiCard:         () => import('./parts/wifi-card.js'),
  EthernetCard:     () => import('./parts/ethernet-card.js'),
  OpticalDrive:     () => import('./parts/optical-drive.js'),
  ExternalOptical:  () => import('./parts/external-optical-drive.js'),
  ExternalStorage:  () => import('./parts/external-storage.js'),
  InternalDisplay:  () => import('./parts/internal-display.js'),
  ThermalPaste:     () => import('./parts/thermal-paste.js'),
  ExtensionCables:  () => import('./parts/extension-cables.js'),
  UPS:              () => import('./parts/ups.js'),
  OS:               () => import('./parts/operating-system.js'),
  Antivirus:        () => import('./parts/antivirus.js'),
  Chair:            () => import('./parts/chair.js'),
  Desk:             () => import('./parts/desk.js'),
};

// PARTS is exported AS A LIVE REFERENCE. App.jsx imports it once at module
// init when the array may be empty; we mutate it in place (push) so any
// later derivation that re-reads it picks up new products without needing
// the consumer to re-import.
export const PARTS = [];

const _loaded = new Set();      // CAT keys already merged into PARTS
const _pending = new Map();     // CAT key → in-flight promise (de-dupes)
const _subscribers = new Set(); // callbacks fired after each successful load

export function isLoaded(catKey) {
  return _loaded.has(catKey);
}

export function allCategoryKeys() {
  return Object.keys(LOADERS);
}

export function subscribe(fn) {
  _subscribers.add(fn);
  return () => _subscribers.delete(fn);
}

function _notify() {
  for (const fn of _subscribers) {
    try { fn(); } catch (e) { console.warn('parts-frontend subscriber threw:', e); }
  }
}

export function loadCategoryParts(catKey) {
  if (_loaded.has(catKey)) return Promise.resolve(PARTS);
  if (_pending.has(catKey)) return _pending.get(catKey);
  const loader = LOADERS[catKey];
  if (!loader) return Promise.reject(new Error('Unknown catKey: ' + catKey));
  const p = loader().then(mod => {
    // The cat may have been merged by a concurrent loadAllParts; guard.
    if (!_loaded.has(catKey)) {
      const arr = mod.default || [];
      PARTS.push(...arr);
      _loaded.add(catKey);
      _notify();
    }
    _pending.delete(catKey);
    return PARTS;
  }, e => {
    _pending.delete(catKey);
    throw e;
  });
  _pending.set(catKey, p);
  return p;
}

export function loadAllParts() {
  return Promise.all(Object.keys(LOADERS).map(loadCategoryParts))
    .then(() => PARTS);
}

// Map URL slug → CAT key, for the initial-load gate in main.jsx.
const SLUG_TO_CAT = {};
{
  // Mirror of scripts/url-slugs.cjs CAT_SLUG, inverted. Inlined here so we
  // don't drag a server-only module into the browser bundle.
  const CAT_SLUG = {
    CPU:'cpu', GPU:'gpu', Motherboard:'motherboard', RAM:'ram', Storage:'storage',
    PSU:'psu', Case:'case', CPUCooler:'cpu-cooler', CaseFan:'case-fan',
    Monitor:'monitor', Keyboard:'keyboard', Mouse:'mouse', MousePad:'mouse-pad',
    Headset:'headset', Microphone:'microphone', Webcam:'webcam',
    SoundCard:'sound-card', WiFiCard:'wifi-card', EthernetCard:'ethernet-card',
    OpticalDrive:'optical-drive', ExternalOptical:'external-optical-drive',
    ExternalStorage:'external-storage', InternalDisplay:'internal-display',
    ThermalPaste:'thermal-paste', ExtensionCables:'extension-cables',
    UPS:'ups', OS:'operating-system', Antivirus:'antivirus',
    Chair:'chair', Desk:'desk',
  };
  for (const [k, v] of Object.entries(CAT_SLUG)) SLUG_TO_CAT[v] = k;
}

// Inspect a URL pathname and return the smallest set of categories that must
// be loaded to render that route. Routes that need broad data (builder,
// upgrade, home, search) return null to signal "load everything".
export function categoriesForPath(pathname) {
  const m = String(pathname || '').match(/^\/parts\/([^\/]+)(?:\/|$)/);
  if (!m) return null;
  const cat = SLUG_TO_CAT[m[1]];
  return cat ? [cat] : null;
}

// Convenience wrapper for main.jsx's initial-load gate.
export function loadPartsForPath(pathname) {
  const cats = categoriesForPath(pathname);
  if (!cats) return loadAllParts();
  return Promise.all(cats.map(loadCategoryParts)).then(() => PARTS);
}
