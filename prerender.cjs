// =============================================================================
//  prerender.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Pre-renders the static marketing pages of Pro Rig Builder to HTML files
//  that crawlers (and social previews) can read without running JS.
//
//  How it works:
//    1) Spawns `npx serve -s dist -l 4173` to host the freshly-built bundle.
//    2) Boots headless Chrome via Puppeteer.
//    3) Visits each route, waits for react-helmet to populate <title> and
//       meta description, then dumps the rendered DOM to dist/{route}/index.html.
//    4) Kills the server.
//
//  Result:
//    - Direct hits to /search, /builder, etc. return real HTML (Bing, Twitter,
//      LinkedIn previews work).
//    - SPA hydration still takes over after JS loads — same React components
//      render the exact same DOM, so no hydration mismatch.
//    - Routes NOT pre-rendered (e.g. /product/[id]) still fall back to the SPA
//      shell via `serve -s` (single-page mode).
//
//  Pre-req: npm install --save-dev puppeteer
//  Usage:   node prerender.cjs            (after `npm run build`)
//           node prerender.cjs --verbose
// =============================================================================

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const VERBOSE = process.argv.includes('--verbose');
const PORT = 4173;
const BASE = `http://localhost:${PORT}`;
const TIMEOUT = 15000;

// Static marketing/utility routes — match the keys in PageMeta.jsx.
// Product pages are NOT in this list (3,870 of them; pre-render those in a
// separate batch script if SEO needs go beyond static pages).
const ROUTES = [
  '/',
  '/search',
  '/builder',
  '/community',
  '/tools',
  '/upgrade',
  '/scanner',
  '/about',
  '/contact',
  '/privacy',
  '/terms',
  '/affiliate',
  '/compare',
  '/vs-pcpartpicker',
  '/pcpartpicker-alternative',
  '/best-pc-builder-tools',
];

// ─── Sanity checks ───────────────────────────────────────────────────────────
if (!fs.existsSync(path.join('dist', 'index.html'))) {
  console.error('  ✗ dist/index.html not found. Run `npm run build` first.');
  process.exit(1);
}

let puppeteer;
try {
  puppeteer = require('puppeteer');
} catch {
  console.error('  ✗ puppeteer not installed. Run:');
  console.error('      npm install --save-dev puppeteer');
  process.exit(1);
}

// ─── Helper: wait for the local serve to actually be ready ───────────────────
async function waitForServer(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(BASE + '/');
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Pro Rig Builder — Pre-render');
  console.log('============================');

  // Spawn local server. We must use `cmd /c npx ...` on Windows or the spawn
  // returns a shell process whose kill() doesn't actually terminate npx.
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

  serveProc.on('error', (e) => {
    console.error('  ✗ serve failed to start:', e.message);
    process.exit(1);
  });

  const ready = await waitForServer();
  if (!ready) {
    console.error('  ✗ Local server did not respond within 7.5s. Aborting.');
    serveProc.kill();
    process.exit(1);
  }
  console.log('  ✓ Server ready');

  // Boot Puppeteer
  console.log('  Launching headless Chrome...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  let success = 0, failed = 0;

  for (const route of ROUTES) {
    const url = BASE + route;
    process.stdout.write(`  ${route.padEnd(32)} `);

    const page = await browser.newPage();
    try {
      // Block external resources for speed (we just need the HTML, not the
      // hydrated app actually working in the headless browser).
      await page.setRequestInterception(true);
      page.on('request', (req) => {
        const t = req.resourceType();
        if (t === 'image' || t === 'media' || t === 'font') {
          req.abort();
        } else {
          req.continue();
        }
      });

      await page.goto(url, { waitUntil: 'networkidle0', timeout: TIMEOUT });

      // Wait for react-helmet-async to populate <title> and description.
      await page.waitForFunction(
        () => {
          const titleOk = document.title && document.title.length > 5;
          const descOk = document.querySelector('meta[name="description"]')?.content?.length > 20;
          const bodyOk = document.body?.innerText?.length > 100;
          return titleOk && descOk && bodyOk;
        },
        { timeout: TIMEOUT }
      );

      // Snapshot the rendered HTML.
      const html = await page.content();

      // Sanity: confirm content actually rendered.
      const bodyText = await page.evaluate(() => document.body.innerText.length);
      if (bodyText < 100) {
        throw new Error(`body has only ${bodyText} chars of text — render likely failed`);
      }

      // Write to dist/{route}/index.html. Root '/' overwrites dist/index.html
      // (the SPA shell) with the pre-rendered version.
      const outDir = route === '/' ? 'dist' : path.join('dist', ...route.split('/').filter(Boolean));
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(path.join(outDir, 'index.html'), html, 'utf8');

      console.log(`✓  (${(html.length / 1024).toFixed(1)} kB, ${bodyText} chars body)`);
      success++;
    } catch (e) {
      console.log(`✗  ${e.message}`);
      failed++;
    } finally {
      await page.close();
    }
  }

  await browser.close();

  // Kill server (Windows needs the tree killed because npx spawns a child).
  if (isWin) {
    spawn('taskkill', ['/pid', serveProc.pid, '/T', '/F'], { stdio: 'ignore' });
  } else {
    serveProc.kill('SIGTERM');
  }

  console.log('\n============================');
  console.log(`  ✓ ${success} pre-rendered`);
  if (failed > 0) console.log(`  ✗ ${failed} failed`);
  console.log('============================\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('  ✗ Fatal:', e);
  process.exit(1);
});
