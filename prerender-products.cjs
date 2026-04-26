// =============================================================================
//  prerender-products.cjs (resumable)
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Pre-renders top performers per category to dist/search/id-{id}.html.
//
//  Resumable: skips products that already have a pre-rendered HTML file,
//  so if a run fails partway through (Chrome resource exhaustion, network
//  hiccup, anything), simply re-run the script. Each invocation completes
//  whatever's missing.
//
//  Bonus: also restarts the browser+page every 25 renders for extra safety.
//
//  Usage:
//    node prerender-products.cjs               # process all missing
//    node prerender-products.cjs --force       # re-render everything
//    node prerender-products.cjs --verbose
// =============================================================================

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VERBOSE = process.argv.includes('--verbose');
const FORCE = process.argv.includes('--force');
const PORT = 4173;
const BASE = `http://localhost:${PORT}`;
const NAV_TIMEOUT = 30000;
const WAIT_TIMEOUT = 30000;
const RESTART_AT = 25;

const TOP_N_PER_CAT = {
  GPU: 20, CPU: 20, Motherboard: 10, RAM: 10, Storage: 10,
  PSU: 10, Case: 10, CPUCooler: 10, Monitor: 10,
};

if (!fs.existsSync(path.join('dist', 'index.html'))) {
  console.error('  ✗ dist/index.html not found. Run `vite build` first.');
  process.exit(1);
}

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch {
  console.error('  ✗ puppeteer not installed.');
  process.exit(1);
}

async function loadParts() {
  const partsPath = path.resolve('src/data/parts.js');
  const url = 'file://' + partsPath.replace(/\\/g, '/') + '?t=' + Date.now();
  const mod = await import(url);
  return mod.PARTS || mod.default || [];
}

function selectProducts(parts) {
  const selected = [];
  for (const [cat, n] of Object.entries(TOP_N_PER_CAT)) {
    const inCat = parts
      .filter((p) => p.c === cat && !p.needsReview && !p.bundle)
      .sort((a, b) => {
        const bd = (b.bench || 0) - (a.bench || 0);
        if (bd !== 0) return bd;
        const rd = (b.r || 0) - (a.r || 0);
        if (rd !== 0) return rd;
        return ((b.id || b._id || 0) - (a.id || a._id || 0));  // stable tie-break
      })
      .slice(0, n);
    selected.push(...inCat);
  }
  return selected;
}

async function waitForServer(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(BASE + '/');
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
}

async function renderOne(page, p, label) {
  const id = p.id || p._id;
  const slug = (p.slug || (p.n || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')).slice(0, 80);
  const url = `${BASE}/search?cat=${encodeURIComponent(p.c)}&id=${id}&slug=${slug}`;
  process.stdout.write(`  ${label} `);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    await page.waitForFunction(
      () => {
        const desc = document.querySelector('meta[name="description"]')?.content;
        const titleHasProduct = (document.title || '').length > 20;
        const hasProductLd = Array.from(document.querySelectorAll('script[type="application/ld+json"]'))
          .some((s) => /"@type"\s*:\s*"Product"/.test(s.textContent || ''));
        return titleHasProduct && desc && hasProductLd;
      },
      { timeout: WAIT_TIMEOUT, polling: 250 }
    );
    const html = await page.content();
    const out = path.join('dist', 'search', `id-${id}.html`);
    fs.writeFileSync(out, html, 'utf8');
    console.log(`✓  ${(html.length / 1024).toFixed(0)} kB`);
    return { ok: true };
  } catch (e) {
    console.log(`✗  ${e.message.slice(0, 60)}`);
    return { ok: false, error: e.message };
  }
}

async function main() {
  console.log('Pro Rig Builder — Product Pre-render (resumable)');
  console.log('================================================');

  const parts = await loadParts();
  console.log(`  Loaded ${parts.length} products`);

  let selected = selectProducts(parts).filter((p) => p.id || p._id);
  console.log(`  Selected ${selected.length} candidates`);

  // Resume mode: filter out products already pre-rendered.
  fs.mkdirSync(path.join('dist', 'search'), { recursive: true });
  const before = selected.length;
  if (!FORCE) {
    selected = selected.filter((p) => {
      const id = p.id || p._id;
      return !fs.existsSync(path.join('dist', 'search', `id-${id}.html`));
    });
    const skipped = before - selected.length;
    if (skipped > 0) {
      console.log(`  ✓ Skipping ${skipped} already-rendered products`);
    }
  }
  console.log(`  ${selected.length} to process this run`);

  if (selected.length === 0) {
    console.log('\n  ✓ All products already pre-rendered. Use --force to redo.\n');
    process.exit(0);
  }

  const isWin = process.platform === 'win32';
  const serveCmd = isWin ? 'cmd' : 'npx';
  const serveArgs = isWin
    ? ['/c', 'npx', 'serve', '-s', 'dist', '-l', String(PORT)]
    : ['serve', '-s', 'dist', '-l', String(PORT)];
  console.log(`  Starting local server on :${PORT}...`);
  const serveProc = spawn(serveCmd, serveArgs, {
    stdio: VERBOSE ? 'inherit' : 'pipe',
    detached: false,
  });

  const ready = await waitForServer();
  if (!ready) {
    console.error('  ✗ Local server did not start');
    serveProc.kill();
    process.exit(1);
  }
  console.log('  ✓ Server ready\n');

  let browser = await launchBrowser();
  let page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  let success = 0, failed = 0;
  const failedList = [];

  for (let i = 0; i < selected.length; i++) {
    if (i > 0 && i % RESTART_AT === 0) {
      console.log(`  ── Restarting browser+page (after ${i} renders this run) ──`);
      await page.close().catch(() => {});
      await browser.close().catch(() => {});
      browser = await launchBrowser();
      page = await browser.newPage();
      await page.setViewport({ width: 1280, height: 800 });
    }
    const p = selected[i];
    const label = `[${(i + 1).toString().padStart(3)}/${selected.length}] ${(p.c).padEnd(12)} ${(p.n || '').slice(0, 40).padEnd(40)}`;
    const result = await renderOne(page, p, label);
    if (result.ok) success++;
    else {
      failed++;
      failedList.push(`${p.c}/${p.id || p._id} ${(p.n || '').slice(0, 50)}`);
    }
  }

  await page.close().catch(() => {});
  await browser.close().catch(() => {});

  if (isWin) spawn('taskkill', ['/pid', serveProc.pid, '/T', '/F'], { stdio: 'ignore' });
  else serveProc.kill('SIGTERM');

  // Final tally — count the pre-rendered files on disk.
  const totalOnDisk = fs.readdirSync(path.join('dist', 'search'))
    .filter((f) => /^id-\w+\.html$/.test(f)).length;

  console.log('\n================================================');
  console.log(`  This run: ${success} ✓  ${failed} ✗`);
  console.log(`  Total pre-rendered on disk: ${totalOnDisk}`);
  if (failed > 0) {
    console.log(`\n  Failed in this run:`);
    for (const f of failedList.slice(0, 5)) console.log(`     ${f}`);
    if (failedList.length > 5) console.log(`     (and ${failedList.length - 5} more)`);
    console.log(`\n  Re-run \`node prerender-products.cjs\` to retry the failures.`);
  }
  console.log('================================================\n');

  process.exit(0);
}

main().catch((e) => {
  console.error('  ✗ Fatal:', e);
  process.exit(1);
});
