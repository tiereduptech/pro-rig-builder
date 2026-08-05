// =============================================================================
//  prerender.cjs
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  Pre-renders pages of Pro Rig Builder to static HTML:
//    - Static marketing/utility routes
//    - All ~5,290 indexable product pages (auto-loaded from parts.js)
//
//  Also writes a fresh public/sitemap.xml using the same product list, so
//  sitemap and prerendered files NEVER drift apart.
//
//  Usage:
//    node prerender.cjs                  # full prerender + sitemap
//    node prerender.cjs --incremental    # skip already-rendered pages
//    node prerender.cjs --verbose
//    node prerender.cjs --static-only    # skip products (fast dev iteration)
//    node prerender.cjs --concurrency=4  # default 8
//
//  Batched (range) mode -- used by prerender-batches.ps1 to defeat Chromes
//  long-lived state leak. Each batch is a FRESH node process that fully exits,
//  guaranteeing OS-level cleanup of leaked chrome.exe processes:
//    node prerender.cjs --start=0 --end=200    # render product routes [0,200)
//    node prerender.cjs --start=200 --end=400  # next window, fresh process
//
//  Range-mode rules:
//    * --start/--end slice the PRODUCT route list only (after isIndexable).
//    * Static routes are rendered ONLY in the batch that includes index 0.
//    * Sitemap writing is SKIPPED in range mode. Write it once at the end via:
//          node prerender.cjs --sitemap-only
// =============================================================================

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { productPath, isIndexable, loadParts, categoryBrowsePath, browsePageCount, BROWSE_PAGE_SIZE, CAT_SLUG } = require('./scripts/url-slugs.cjs');
const { dedupeHeadTags } = require('./scripts/dedupe-head.cjs');
// BROWSE_ROUTES_ENUMERATION_INSERTED
async function enumerateBrowseRoutes() {
  const parts = (await loadParts()).filter(isIndexable);
  const countsByCat = {};
  for (const p of parts) { countsByCat[p.c] = (countsByCat[p.c] || 0) + 1; }
  const routes = [];
// BROWSE_ROUTES_WIRED
const _browseRoutes = await enumerateBrowseRoutes();
if (typeof allRoutes !== 'undefined') {
  allRoutes.push(..._browseRoutes.map(p => ({ path: p, priority: "0.6", changefreq: "weekly" })));
} else if (typeof routes !== 'undefined') {
  routes.push(..._browseRoutes.map(p => ({ path: p, priority: "0.6", changefreq: "weekly" })));
}
  for (const [catKey, count] of Object.entries(countsByCat)) {
    if (!CAT_SLUG[catKey]) continue;
    const totalPages = browsePageCount(count);
    for (let n = 1; n <= totalPages; n++) {
      routes.push(categoryBrowsePath(catKey, n));
    }
  }
  return routes;
}

const VERBOSE       = process.argv.includes("--verbose");
const INCREMENTAL   = process.argv.includes("--incremental");
const STATIC_ONLY   = process.argv.includes("--static-only");
const SITEMAP_ONLY  = process.argv.includes("--sitemap-only");
const NO_SITEMAP    = process.argv.includes("--no-sitemap");
const CONCURRENCY   = (() => {
  const a = process.argv.find(a => a.startsWith("--concurrency="));
  return a ? parseInt(a.split("=")[1], 10) || 8 : 8;
})();
const RANGE_START   = (() => {
  const a = process.argv.find(a => a.startsWith("--start="));
  return a ? Math.max(0, parseInt(a.split("=")[1], 10) || 0) : null;
})();
const RANGE_END     = (() => {
  const a = process.argv.find(a => a.startsWith("--end="));
  return a ? parseInt(a.split("=")[1], 10) : null;
})();
const RANGE_MODE    = RANGE_START !== null || RANGE_END !== null;

const PORT    = 4173;
const BASE    = `http://localhost:${PORT}`;
const TIMEOUT = 40000;
const SITE    = "https://prorigbuilder.com";
const TODAY   = new Date().toISOString().split("T")[0];

const STATIC_ROUTES = [
  { path: "/",                              priority: "1.0", changefreq: "daily"   },
  { path: "/search",                        priority: "0.9", changefreq: "daily"   },
  { path: "/builder",                       priority: "0.9", changefreq: "weekly"  },
  { path: "/community",                     priority: "0.7", changefreq: "weekly"  },
  { path: "/tools",                         priority: "0.8", changefreq: "weekly"  },
  { path: "/tools/fps-estimator",           priority: "0.7", changefreq: "monthly" },
  { path: "/tools/bottleneck-calculator",   priority: "0.7", changefreq: "monthly" },
  { path: "/tools/will-it-run",             priority: "0.7", changefreq: "monthly" },
  { path: "/tools/compare-builds",          priority: "0.7", changefreq: "monthly" },
  { path: "/tools/build-wizard",            priority: "0.7", changefreq: "monthly" },
  { path: "/tools/power-calculator",        priority: "0.7", changefreq: "monthly" },
  { path: "/tools/compare-parts",           priority: "0.7", changefreq: "monthly" },
  { path: "/upgrade",                       priority: "0.8", changefreq: "weekly"  },
  { path: "/scanner",                       priority: "0.8", changefreq: "weekly"  },
  { path: "/about",                         priority: "0.6", changefreq: "monthly" },
  { path: "/contact",                       priority: "0.5", changefreq: "monthly" },
  { path: "/privacy",                       priority: "0.3", changefreq: "yearly"  },
  { path: "/terms",                         priority: "0.3", changefreq: "yearly"  },
  { path: "/affiliate",                     priority: "0.3", changefreq: "yearly"  },
  { path: "/compare",                       priority: "0.8", changefreq: "weekly"  },
  { path: "/vs-pcpartpicker",               priority: "0.8", changefreq: "monthly" },
  { path: "/pcpartpicker-alternative",      priority: "0.8", changefreq: "monthly" },
  { path: "/best-pc-builder-tools",         priority: "0.7", changefreq: "monthly" },
  { path: "/pc-hardware-scanner",           priority: "0.8", changefreq: "monthly" },
  { path: "/what-can-i-upgrade",            priority: "0.8", changefreq: "monthly" },
  { path: "/will-it-fit",                   priority: "0.8", changefreq: "monthly" },
  { path: "/parts/cpu",                     priority: "0.8", changefreq: "weekly"  },
  { path: "/parts/gpu",                     priority: "0.8", changefreq: "weekly"  },
  { path: "/parts/motherboard",             priority: "0.8", changefreq: "weekly"  },
  { path: "/parts/ram",                     priority: "0.8", changefreq: "weekly"  },
  { path: "/parts/storage",                 priority: "0.8", changefreq: "weekly"  },
  { path: "/parts/psu",                     priority: "0.8", changefreq: "weekly"  },
  { path: "/parts/case",                    priority: "0.8", changefreq: "weekly"  },
  { path: "/parts/cpu-cooler",              priority: "0.8", changefreq: "weekly"  },
  { path: "/parts/monitor",                 priority: "0.8", changefreq: "weekly"  },
];

if (!fs.existsSync(path.join("dist", "index.html"))) {
  console.error("  X dist/index.html not found. Run `vite build` first.");
  process.exit(1);
}

function xmlEscape(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;");
}

function outPathFor(route) {
  const parts = route.split("/").filter(Boolean);
  return route === "/" ? path.join("dist", "index.html") : path.join("dist", ...parts, "index.html");
}

async function writeSitemap() {
  console.log("  Writing public/sitemap.xml...");
  const parts = (await loadParts()).filter(isIndexable);
  const sitemapEntries = [];
  for (const sr of STATIC_ROUTES) {
    sitemapEntries.push(
      `  <url>\n    <loc>${xmlEscape(SITE + sr.path)}</loc>\n    <lastmod>${TODAY}</lastmod>\n    <changefreq>${sr.changefreq}</changefreq>\n    <priority>${sr.priority}</priority>\n  </url>`
    );
  }
  for (const p of parts) {
    const u = productPath(p);
    if (!u) continue;
    sitemapEntries.push(
      `  <url>\n    <loc>${xmlEscape(SITE + u)}</loc>\n    <lastmod>${TODAY}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.6</priority>\n  </url>`
    );
  }
  const sitemap = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${sitemapEntries.join("\n")}\n</urlset>\n`;

  fs.mkdirSync("public", { recursive: true });
  fs.writeFileSync(path.join("public", "sitemap.xml"), sitemap, "utf8");
  fs.writeFileSync(path.join("dist", "sitemap.xml"), sitemap, "utf8");
  console.log(`  OK sitemap.xml written (${sitemapEntries.length} urls)`);
}

async function waitForServer(retries = 60) {
  for (let i = 0; i < retries; i++) {
    try { const res = await fetch(BASE + "/"); if (res.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

async function renderRoute(browser, route) {
  const page = await browser.newPage();
  try {
    await page.setRequestInterception(true);
    page.on("request", (req) => {
      const t = req.resourceType();
      if (t === "image" || t === "media" || t === "font") req.abort();
      else req.continue();
    });

    await page.goto(BASE + route, { waitUntil: "networkidle0", timeout: TIMEOUT });

    await page.waitForFunction((targetRoute) => {
      const _t = document.title || "";
      const _p = location.pathname || "/";
      // Generic home/site title fallbacks that must NOT appear on a sub-route.
      const HOME_TITLE_RE = /Compare, Build & Save on PC Parts|Free PC Part Picker & Hardware Scanner/i;
      const titleOk = _t.length > 5 && (_p === "/" || !HOME_TITLE_RE.test(_t));
      const descOk  = document.querySelector('meta[name="description"]')?.content?.length > 20;
      const bodyOk  = document.body?.innerText?.length > 100;
      const c = document.querySelector('link[rel="canonical"]')?.href || "";
      const p = location.pathname || "/";
      let canonOk;
      if (p === "/") {
        canonOk = /prorigbuilder\.com\/?$/.test(c);
      } else {
        const seg1 = "/" + p.replace(/^\//, "").split("/")[0];
        canonOk = c.includes("prorigbuilder.com" + seg1);
      }
      // Product pages hydrate their category chunk lazily; every generic check
      // above passes on the pre-hydration SHELL, which is how a product route
      // could serialize with no price, no detail and no badges. Worse, when the
      // product isn't yet in the loaded catalog the app falls back to the home
      // view, so location.pathname is an unreliable signal here — key off the
      // ROUTE WE ASKED FOR, not where the SPA currently thinks it is. Require the
      // product view's own readiness sentinel — a hidden <span data-product-ready>
      // rendered ONLY once the product is found — so we never snapshot a shell.
      // If it never appears we time out and write NOTHING (retried next run),
      // which is strictly better than a shell. Also makes the condition/3P badges
      // deterministic. Non-product routes are unaffected.
      // ONLY product-detail routes: /parts/<cat>/<slug>-<id>. The trailing -<id>
      // and the $ anchor exclude the category index (/parts/<cat>) and the browse
      // pages (/parts/<cat>/browse, /parts/<cat>/browse/page-N) — those have no
      // product sentinel and must NOT be gated on one.
      const isProductRoute = /^\/parts\/[^/]+\/[^/]+-\d+$/.test(targetRoute || _p);
      const productOk = !isProductRoute || !!document.querySelector('[data-product-ready]');
      return titleOk && descOk && bodyOk && canonOk && productOk;
    }, { timeout: TIMEOUT }, route);

    await new Promise(r => setTimeout(r, 100));

    // Strip the shell's default head tags that Helmet has already replaced,
    // so each social/SEO head tag appears exactly once. See scripts/dedupe-head.cjs.
    const html = dedupeHeadTags(await page.content());
    const bodyChars = await page.evaluate(() => document.body.innerText.length);
    if (bodyChars < 100) throw new Error(`body only ${bodyChars} chars`);

    const out = outPathFor(route);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, html, "utf8");
    return { ok: true, route, size: html.length, body: bodyChars };
  } catch (e) {
    return { ok: false, route, error: e.message };
  } finally {
    try { await page.close(); } catch {}
  }
}

async function runPool(items, worker, concurrency, onProgress) {
  let i = 0, done = 0;
  const results = [];
  async function next() {
    while (i < items.length) {
      const idx = i++;
      const r = await worker(items[idx]);
      results.push(r);
      done++;
      onProgress(done, items.length, r);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, next));
  return results;
}

async function main() {
  console.log("Pro Rig Builder - Pre-render");
  console.log("============================");

  if (SITEMAP_ONLY) {
    await writeSitemap();
    process.exit(0);
  }

  console.log(`  Concurrency: ${CONCURRENCY}`);
  if (INCREMENTAL) console.log("  Mode: incremental (skip existing)");
  if (STATIC_ONLY) console.log("  Mode: static-only");
  if (RANGE_MODE)  console.log(`  Mode: range [start=${RANGE_START ?? 0}, end=${RANGE_END ?? "EOF"})`);

  let puppeteer;
  try { puppeteer = require("puppeteer"); }
  catch { console.error("  X puppeteer not installed. Run: npm install --save-dev puppeteer"); process.exit(1); }

  const parts = STATIC_ONLY ? [] : (await loadParts()).filter(isIndexable);
  console.log(`  Loaded ${parts.length} indexable products`);

  const allProductRoutes = parts.map(p => productPath(p)).filter(Boolean);

  const start = RANGE_START ?? 0;
  const end   = RANGE_END ?? allProductRoutes.length;
  const productRoutes = RANGE_MODE ? allProductRoutes.slice(start, end) : allProductRoutes;

  const includeStatic = (!RANGE_MODE || start === 0) && !process.argv.includes("--no-static");
  const allRoutes = [
    ...(includeStatic ? STATIC_ROUTES.map(r => r.path) : []),
    ...productRoutes,
  ];

  if (RANGE_MODE) {
    console.log(`  Range: ${productRoutes.length} product routes [${start},${Math.min(end, allProductRoutes.length)}) of ${allProductRoutes.length} total`);
    if (includeStatic) console.log(`  Range: including ${STATIC_ROUTES.length} static routes (start===0)`);
  }

  let toRender = allRoutes;
  if (INCREMENTAL) {
    toRender = allRoutes.filter(r => !fs.existsSync(outPathFor(r)));
    console.log(`  Incremental: ${toRender.length} of ${allRoutes.length} need rendering`);
  }

  if (toRender.length === 0) {
    console.log("  Nothing to render in this range. Done.");
    if (!RANGE_MODE && !NO_SITEMAP) await writeSitemap();
    process.exit(0);
  }

  const isWin = process.platform === "win32";
  const serveCmd = "node";
  const serveArgs = ["server.cjs"];
  console.log(`  Starting local server (server.cjs) on :${PORT}...`);
  const serveProc = spawn(serveCmd, serveArgs, { stdio: VERBOSE ? "inherit" : "pipe", detached: false, env: { ...process.env, PORT: String(PORT) } });
  serveProc.on("error", (e) => { console.error("  X serve failed:", e.message); process.exit(1); });

  function killServer() {
    if (isWin) spawn("taskkill", ["/pid", serveProc.pid, "/T", "/F"], { stdio: "ignore" });
    else serveProc.kill("SIGTERM");
  }

  if (!(await waitForServer())) {
    console.error("  X Local server did not respond. Aborting.");
    killServer();
    process.exit(1);
  }
  console.log("  OK Server ready");

  const CHUNK_SIZE = 15;

  async function launchBrowser() {
    return await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
      protocolTimeout: 180000,
    });
  }

  console.log("  Launching headless Chrome...");
  let browser = await launchBrowser();

  if (toRender.length > 1) {
    console.log("  Warmup: rendering first route sequentially...");
    const warmupResult = await renderRoute(browser, toRender[0]);
    if (warmupResult.ok) console.log(`  OK Warmup done (${warmupResult.size} bytes)`);
    else console.log(`  ! Warmup failed: ${warmupResult.error} - continuing anyway`);
  }

  const startedAt = Date.now();
  const failures = [];
  let lastLog = Date.now();
  let totalDone = toRender.length > 1 ? 1 : 0;

  const poolRoutes = toRender.length > 1 ? toRender.slice(1) : toRender;

  for (let chunkStart = 0; chunkStart < poolRoutes.length; chunkStart += CHUNK_SIZE) {
    const chunk = poolRoutes.slice(chunkStart, chunkStart + CHUNK_SIZE);
    await runPool(
      chunk,
      async (route) => {
        let result = await renderRoute(browser, route);
        if (!result.ok && /Connection|Target closed|navigation/i.test(result.error || "")) {
          result = await renderRoute(browser, route);
        }
        return result;
      },
      CONCURRENCY,
      (chunkDone, chunkTotal, r) => {
        if (!r.ok) failures.push(r);
        const done = totalDone + chunkDone;
        const total = toRender.length;
        const now = Date.now();
        if (now - lastLog > 2000 || done === total) {
          const elapsed = (now - startedAt) / 1000;
          const rate = elapsed > 0 ? done / elapsed : 0;
          const eta  = rate > 0 ? Math.round((total - done) / rate) : 0;
          const pct  = ((done / total) * 100).toFixed(1);
          console.log(`  ${done}/${total} (${pct}%) - ${rate.toFixed(1)}/s - ETA ${eta}s - failed: ${failures.length}`);
          lastLog = now;
        }
      }
    );
    totalDone += chunk.length;

    if (chunkStart + CHUNK_SIZE < poolRoutes.length) {
      try { await browser.close(); } catch {}
      browser = await launchBrowser();
    }
  }

  try { await browser.close(); } catch {}
  killServer();

  const success = toRender.length - failures.length;
  const failed  = failures.length;
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

  if (failed > 0) {
    const failFile = RANGE_MODE
      ? `prerender-failures-${start}-${Math.min(end, allProductRoutes.length)}.json`
      : "prerender-failures.json";
    fs.writeFileSync(failFile, JSON.stringify(failures, null, 2));
    console.log(`  Logged ${failed} failures to ${failFile}`);
  } else if (!RANGE_MODE && fs.existsSync("prerender-failures.json")) {
    fs.unlinkSync("prerender-failures.json");
  }

  if (!RANGE_MODE && !NO_SITEMAP) {
    await writeSitemap();
  } else if (RANGE_MODE) {
    console.log("  (range mode: sitemap skipped -- run --sitemap-only at the end)");
  }

  console.log("\n============================");
  console.log(`  OK ${success} pre-rendered in ${elapsed}s`);
  if (failed > 0) console.log(`  X  ${failed} failed (see failures json)`);
  console.log("============================\n");

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { console.error("  X Fatal:", e); process.exit(1); });
