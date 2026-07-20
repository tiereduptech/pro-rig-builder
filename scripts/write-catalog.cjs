// =============================================================================
//  scripts/write-catalog.cjs
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  The ONLY sanctioned way to write the parts catalog.
//
//  Background: src/data/parts.js is an auto-generated barrel of per-category
//  chunk imports (scripts/split-parts-by-cat.cjs). Writing a JSON literal over
//  it is not itself wrong — 29 scripts do exactly that, and it is how catalog
//  mutations have always landed. What makes it safe is the MANDATORY re-split
//  afterwards, which regenerates parts/<cat>.js and the barrel from the literal.
//
//  That safety used to live in YAML (a separate "Re-split" workflow step), so
//  nothing stopped a literal write from being the last thing that happened. On
//  2026-06-27 that is exactly what went wrong (a4946d7c57): parts.js ended up
//  with a literal PARTS *and* a stray spread barrel — a hard SyntaxError that
//  broke prerender.cjs and sitemap generation until it was repaired by hand.
//
//  writeCatalog() moves that guarantee into code. The write is not "done" until
//  the chunks have been regenerated and the result re-imported and verified.
//  There is no partial success: either parts.js + parts/ are both current, or
//  the call throws and the on-disk catalog is exactly what it was before.
// =============================================================================

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT        = path.resolve(__dirname, '..');
const PARTS_JS    = path.join(ROOT, 'src/data/parts.js');
const PARTS_DIR   = path.join(ROOT, 'src/data/parts');
const SPLIT_JS    = path.join(__dirname, 'split-parts-by-cat.cjs');
const BACKUP_DIR  = path.join(ROOT, 'catalog-build/_catalog-backup');

// Temp lives beside parts.js so the promote is a same-filesystem rename
// (atomic) rather than a copy that can be observed half-written.
//
// The extension MUST stay ".js": step 3 verifies the temp by dynamic-importing
// it, and Node's ESM loader rejects unknown extensions outright
// (ERR_UNKNOWN_FILE_EXTENSION on ".tmp"). The leading dot keeps it out of the
// way; .gitignore covers it.
const TEMP_JS     = path.join(ROOT, 'src/data/.parts.tmp.js');

// A write that drops more than this fraction of the catalog is treated as a
// bug, not an intent. Real removals trickle (refresh caps them explicitly);
// a cliff means the caller lost the array. 5% of ~5,500 is ~275 products —
// far above any legitimate single run, far below "the array got clobbered".
const MAX_SHRINK = 0.05;

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');

// ── Backup ───────────────────────────────────────────────────────────────────
// Rolling snapshot of the PRE-write state (barrel + every chunk). The chunks
// are the real data — the June 27 recovery only worked because they survived —
// so a backup that captured parts.js alone would be worthless.
function snapshot() {
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(BACKUP_DIR, 'parts'), { recursive: true });
  if (fs.existsSync(PARTS_JS)) fs.copyFileSync(PARTS_JS, path.join(BACKUP_DIR, 'parts.js'));
  if (fs.existsSync(PARTS_DIR)) {
    for (const f of fs.readdirSync(PARTS_DIR)) {
      if (f.endsWith('.js')) {
        fs.copyFileSync(path.join(PARTS_DIR, f), path.join(BACKUP_DIR, 'parts', f));
      }
    }
  }
  return BACKUP_DIR;
}

// Import a module file fresh, bypassing the ESM module cache.
async function importFresh(file) {
  const url = 'file:///' + path.resolve(file).replace(/\\/g, '/') + '?t=' + Date.now() + '_' + process.hrtime.bigint();
  const mod = await import(url);
  return mod.PARTS || mod.default || [];
}

// ── Postflight ───────────────────────────────────────────────────────────────
// Assert parts.js is a BARREL, not a literal, and that it imports exactly the
// chunk files that exist on disk. This is the check that would have caught the
// dual-export corruption at write time instead of at the next prerender.
function assertBarrelShape() {
  const src = fs.readFileSync(PARTS_JS, 'utf8');

  const exportCount = (src.match(/^export\s+const\s+PARTS\s*=/gm) || []).length;
  if (exportCount !== 1) {
    throw new Error(`postflight: parts.js has ${exportCount} top-level "export const PARTS" (expected exactly 1). This is the 2026-06-27 dual-export corruption.`);
  }
  if (!/export\s+const\s+PARTS\s*=\s*\[\s*\.\.\._/.test(src)) {
    throw new Error('postflight: parts.js is not a spread barrel — the re-split did not take effect and the raw literal is still on disk.');
  }

  const imported = [...src.matchAll(/^import\s+_\d+\s+from\s+'\.\/parts\/(.+?)\.js';$/gm)].map(m => m[1]).sort();
  const onDisk = fs.readdirSync(PARTS_DIR).filter(f => f.endsWith('.js')).map(f => f.replace(/\.js$/, '')).sort();

  const missing = imported.filter(f => !onDisk.includes(f));
  const orphaned = onDisk.filter(f => !imported.includes(f));
  if (missing.length) throw new Error(`postflight: barrel imports chunks that do not exist: ${missing.join(', ')}`);
  if (orphaned.length) throw new Error(`postflight: chunk files exist that the barrel never imports (dead data): ${orphaned.join(', ')}`);

  return imported;
}

// Count products by importing each chunk directly, NOT by importing the barrel.
//
// This is not a stylistic choice. The barrel's `import _0 from './parts/x.js'`
// specifiers carry no cache-buster, so re-importing parts.js inside a process
// that already loaded it hands back the CACHED chunk modules — the barrel
// re-evaluates, but the data behind it is whatever was on disk the first time.
// Verifying through the barrel therefore silently checks pre-write data, which
// is exactly the case ingest hits: it calls saveParts() every 25 products, so
// every checkpoint after the first would have verified against stale chunks.
//
// Importing each chunk with its own buster reads what is actually on disk, and
// has the side benefit of proving every chunk parses on its own.
async function countFromChunks(chunkNames) {
  let total = 0;
  for (const name of chunkNames) {
    const arr = await importFresh(path.join(PARTS_DIR, name + '.js'));
    if (!Array.isArray(arr)) throw new Error(`postflight: chunk ${name}.js did not default-export an array`);
    total += arr.length;
  }
  return total;
}

/**
 * Write the catalog. Literal → verify → promote → re-split → verify barrel.
 *
 * @param {Array}  parts            the full catalog array (already mutated)
 * @param {object} opts
 * @param {number} opts.loadedCount count read at load time — the shrink brake
 *                                  compares against this
 * @param {string} opts.reason      short label for logs
 * @param {boolean} opts.dryRun     if true, writes nothing and returns null
 * @returns {Promise<{count:number, chunks:number, backup:string}|null>}
 */
async function writeCatalog(parts, { loadedCount, reason = 'catalog write', dryRun = false } = {}) {
  // ── 1. Preflight ───────────────────────────────────────────────────────────
  if (!Array.isArray(parts)) throw new Error('writeCatalog: parts is not an array');
  if (parts.length === 0) throw new Error('writeCatalog: refusing to write an empty catalog');

  if (typeof loadedCount === 'number' && loadedCount > 0) {
    const floor = Math.floor(loadedCount * (1 - MAX_SHRINK));
    if (parts.length < floor) {
      throw new Error(
        `writeCatalog: catastrophic shrink — writing ${parts.length} products but loaded ${loadedCount} ` +
        `(floor ${floor}, max ${MAX_SHRINK * 100}% loss). Refusing. If this removal is intentional, ` +
        `raise the cap deliberately rather than bypassing this brake.`,
      );
    }
  }

  if (dryRun) {
    console.log(`  [dry run] writeCatalog would write ${parts.length} products (${reason}) — nothing written.`);
    return null;
  }

  // ── 2. Write the literal to a TEMP file ────────────────────────────────────
  // parts.js is untouched at this point. A crash here leaves a stray .tmp and
  // a perfectly intact catalog.
  const header = '// Transient literal written by scripts/write-catalog.cjs.\n' +
                 '// If you are reading this in src/data/parts.js, a re-split did NOT complete —\n' +
                 '// run: node scripts/split-parts-by-cat.cjs\n';
  const body = 'export const PARTS = ' + JSON.stringify(parts, null, 2) + ';\n\nexport default PARTS;\n';
  fs.writeFileSync(TEMP_JS, header + body, 'utf8');

  // ── 3. Verify the temp actually parses and round-trips ─────────────────────
  // Any failure here — parse error, count drift — must clean up the temp and
  // leave parts.js untouched, so the catalog is exactly as it was.
  try {
    const roundTripped = await importFresh(TEMP_JS);
    if (roundTripped.length !== parts.length) {
      throw new Error(`writeCatalog: temp round-trip lost products — wrote ${parts.length}, read back ${roundTripped.length}`);
    }
  } catch (e) {
    fs.rmSync(TEMP_JS, { force: true });
    throw e;
  }

  // ── 4. Snapshot, then promote ──────────────────────────────────────────────
  const backup = snapshot();
  fs.renameSync(TEMP_JS, PARTS_JS);   // atomic; parts.js is now the literal

  // ── 5. Re-split — the step that makes the literal safe ─────────────────────
  // Shelled out rather than imported: split-parts-by-cat.cjs is a bare async
  // IIFE that calls process.exit, and three live workflows already invoke it
  // this exact way. Keeping the invocation identical means we inherit its own
  // before/after count assertion instead of re-implementing it.
  try {
    execFileSync(process.execPath, [SPLIT_JS], { cwd: ROOT, stdio: 'inherit' });
  } catch (e) {
    throw new Error(
      `writeCatalog: re-split FAILED after the literal was promoted. src/data/parts.js is currently a raw ` +
      `literal and src/data/parts/ is STALE — do not commit this state.\n` +
      `  Repair:  node scripts/split-parts-by-cat.cjs\n` +
      `  Rollback: restore from ${rel(backup)}\n` +
      `  Cause: ${e.message}`,
    );
  }

  // ── 6. Postflight — re-import and assert shape + count ─────────────────────
  const chunkNames = assertBarrelShape();
  const finalCount = await countFromChunks(chunkNames);
  if (finalCount !== parts.length) {
    throw new Error(
      `writeCatalog: post-split count mismatch — expected ${parts.length}, chunks hold ${finalCount}. ` +
      `Restore from ${rel(backup)}.`,
    );
  }

  console.log(`  Catalog written: ${finalCount} products across ${chunkNames.length} chunks (${reason}). Backup: ${rel(backup)}`);
  return { count: finalCount, chunks: chunkNames.length, backup };
}

module.exports = { writeCatalog, MAX_SHRINK };
