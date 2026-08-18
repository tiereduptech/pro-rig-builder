// =============================================================================
//  PageMeta.jsx
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Per-page meta tags for Pro Rig Builder. Renders <title>, description,
//  canonical, Open Graph, Twitter Card, and JSON-LD structured data
//  (Product, WebSite, CollectionPage, BreadcrumbList) based on context.
//
//  Breadcrumb schema (NEW):
//    Adds BreadcrumbList JSON-LD per page so Google can show breadcrumbs
//    in SERPs (e.g. "prorigbuilder.com › Search › GPU › RTX 4090") instead
//    of just the raw URL. Improves CTR and rankings.
//
//  Trail rules:
//    Home page         → no breadcrumb (already at root)
//    Static page       → Home › {Page}
//    Category browse   → Home › Search › {Category}
//    Product page      → Home › Search › {Category} › {Product Name}
//
//  Usage in App.jsx (unchanged):
//    <PageMeta page={page} category={bc} parts={ACTIVE_SEED_PARTS} />
// =============================================================================

import React from "react";
import { Helmet } from "react-helmet-async";
import { bundleH1, bundleTitle, bundleLdName } from "./bundle-name.js";

const SITE = "https://prorigbuilder.com";
const BRAND = "Pro Rig Builder";
const DEFAULT_OG_IMAGE = `${SITE}/og-image.png`;

// ─── E-E-A-T entities ───────────────────────────────────────────────────────
// Person + Organization JSON-LD emitted on every page so Google has a stable
// author + publisher graph. Guide pages reference these by @id rather than
// repeating the entity inline. dateModified bumps when guide copy is revised.
const GUIDE_LAST_UPDATED = "2026-05-31";

const PERSON_LD = {
  "@context": "https://schema.org",
  "@type": "Person",
  "@id": `${SITE}/#coby`,
  name: "Coby Poluk",
  givenName: "Coby",
  jobTitle: "Owner, Computer Repair Shop & Custom PC Builder",
  description: "Owner of TieredUp Tech, a Texas computer repair shop and custom PC brand. Builds, repairs, and consults on PC upgrades day-to-day.",
  worksFor: { "@type": "Organization", "@id": `${SITE}/#tieredup` },
  url: `${SITE}/about`,
  sameAs: ["https://tiereduptech.com"],
};

const ORG_LD = {
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": `${SITE}/#tieredup`,
  name: "TieredUp Tech, Inc.",
  url: "https://tiereduptech.com",
  logo: `${SITE}/og-image.png`,
  address: {
    "@type": "PostalAddress",
    addressLocality: "Orange",
    addressRegion: "TX",
    addressCountry: "US",
  },
};

// Guide pages get an Article JSON-LD with author/publisher/dateModified.
// Keys match the PAGES map (and the URL-derived page key from routeFromUrl).
const GUIDE_PAGES = new Set([
  "vs-pcpartpicker",
  "pcpartpicker-alternative",
  "best-pc-builder-tools",
  "pc-hardware-scanner",
  "what-can-i-upgrade",
  "will-it-fit",
]);

function buildGuideArticleLd({ page, url, title, desc }) {
  if (!GUIDE_PAGES.has(page)) return null;
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: title,
    description: desc,
    url,
    image: DEFAULT_OG_IMAGE,
    dateModified: GUIDE_LAST_UPDATED,
    author: { "@id": `${SITE}/#coby` },
    publisher: { "@id": `${SITE}/#tieredup` },
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
  };
}

// ─── Static page metadata ───────────────────────────────────────────────────
const PAGES = {
  home: {
    title: `${BRAND} — Free PC Part Picker & Hardware Scanner`,
    desc: "Build your PC with 5,500+ verified parts. Compare prices and specs side-by-side. Free PCPartPicker alternative with a hardware scanner.",
    path: "/",
    crumbLabel: null,
  },
  search: {
    title: `Search PC Parts — Specs, Prices & Deals | ${BRAND}`,
    desc: "Search and compare 5,500+ PC parts with verified specs, live prices, and deals from Amazon, Best Buy, and Newegg. Filter by every spec.",
    path: "/search",
    crumbLabel: "Search",
  },
  builder: {
    title: `PC Builder — Build Your Custom PC Online | ${BRAND}`,
    desc: "Build your custom gaming or workstation PC. Auto-checks compatibility, calculates wattage, and shows live deals. Free and no signup required.",
    path: "/builder",
    crumbLabel: "PC Builder",
  },
  community: {
    title: `Community PC Builds & Inspiration | ${BRAND}`,
    desc: "Browse PC builds shared by the community. Get inspiration from gaming, streaming, workstation, and budget builds at every price point.",
    path: "/community",
    crumbLabel: "Community",
  },
  tools: {
    title: `Free PC Builder Tools — FPS & Wattage | ${BRAND}`,
    desc: "Free PC tools: FPS estimator, wattage calculator, bottleneck checker, build wizard, and parts comparison. No signup, no ads, just answers.",
    path: "/tools",
    crumbLabel: "Tools",
  },
  "tools/fps-estimator": {
    title: `FPS Estimator — Game FPS for Any Build | ${BRAND}`,
    desc: "See projected FPS for popular games across any GPU + CPU combo at 1080p, 1440p, and 4K. Free FPS calculator, no signup needed.",
    path: "/tools/fps-estimator",
    crumbLabel: "FPS Estimator",
  },
  "tools/bottleneck-calculator": {
    title: `Bottleneck Calculator — CPU vs GPU | ${BRAND}`,
    desc: "Find out if your CPU or GPU is the weak link in your PC build. Get exact bottleneck severity percentage with targeted upgrade tips.",
    path: "/tools/bottleneck-calculator",
    crumbLabel: "Bottleneck Calculator",
  },
  "tools/will-it-run": {
    title: `Will It Run? — Game Compatibility | ${BRAND}`,
    desc: "Check if your existing PC can handle specific games at your target resolution and quality settings. Free game compatibility checker.",
    path: "/tools/will-it-run",
    crumbLabel: "Will It Run",
  },
  "tools/compare-builds": {
    title: `Compare PC Builds Side-by-Side | ${BRAND}`,
    desc: "Compare two PC builds side by side. See FPS differences, bench scores, total cost, and which build wins at your target resolution.",
    path: "/tools/compare-builds",
    crumbLabel: "Compare Builds",
  },
  "tools/build-wizard": {
    title: `Build Wizard — Auto PC for Your Budget | ${BRAND}`,
    desc: "Enter your budget and use case. We'll generate a fully compatible, optimized PC parts list automatically — no manual research needed.",
    path: "/tools/build-wizard",
    crumbLabel: "Build Wizard",
  },
  "tools/power-calculator": {
    title: `PSU Wattage Calculator — PC Power Needs | ${BRAND}`,
    desc: "Calculate exactly how many watts your PC needs. Free PSU calculator factoring in GPU TDP, transient spikes, and headroom for upgrades.",
    path: "/tools/power-calculator",
    crumbLabel: "Power Calculator",
  },
  "tools/compare-parts": {
    title: `Compare PC Parts — CPU, GPU & RAM | ${BRAND}`,
    desc: "Compare any two PC parts side by side. See specs, benchmarks, current prices, and which is the better value for your build.",
    path: "/tools/compare-parts",
    crumbLabel: "Compare Parts",
  },
  upgrade: {
    title: `PC Upgrade Path — Smart Recommendations | ${BRAND}`,
    desc: "Get personalized PC upgrade recommendations based on your current hardware and budget. Scan your rig, see what to upgrade first.",
    path: "/upgrade",
    crumbLabel: "Upgrade",
  },
  scanner: {
    title: `Free PC Hardware Scanner for Windows | ${BRAND}`,
    desc: "Download our free Windows hardware scanner. Auto-detects your CPU, GPU, RAM, motherboard, and storage. No install required, completely free.",
    path: "/scanner",
    crumbLabel: "Scanner",
  },
  about: {
    title: `About ${BRAND} — Free, Verified, Independent`,
    desc: "Pro Rig Builder is a free PC part picker with 100% verified product data, live pricing, and zero paywalls. Built by PC enthusiasts.",
    path: "/about",
    crumbLabel: "About",
  },
  contact: {
    title: `Contact ${BRAND} — Feedback & Partnerships`,
    desc: "Get in touch with the Pro Rig Builder team. We welcome feedback on tools, partnership inquiries, and product data corrections.",
    path: "/contact",
    crumbLabel: "Contact",
  },
  privacy: {
    title: `Privacy Policy | ${BRAND}`,
    desc: "How Pro Rig Builder collects, uses, and protects your data — in plain English. Covers cookies, analytics, and our scanner's local-only design.",
    path: "/privacy",
    crumbLabel: "Privacy",
  },
  terms: {
    title: `Terms of Service | ${BRAND}`,
    desc: "Terms of service for using Pro Rig Builder, our free PC builder tools, and the Pro Rig hardware scanner. Your rights, our rules, and the fine print.",
    path: "/terms",
    crumbLabel: "Terms",
  },
  affiliate: {
    title: `Affiliate Disclosure | ${BRAND}`,
    desc: "Pro Rig Builder is an Amazon Associate and earns from qualifying purchases. Read our full affiliate disclosure covering how our links and commissions work.",
    path: "/affiliate",
    crumbLabel: "Affiliate",
  },
  compare: {
    title: `Compare PC Parts Side-by-Side | ${BRAND}`,
    desc: "Compare CPUs, GPUs, motherboards, RAM, and more side-by-side. Full specs, benchmarks, and live pricing on every product.",
    path: "/compare",
    crumbLabel: "Compare",
  },
  "vs-pcpartpicker": {
    title: `Pro Rig Builder vs PCPartPicker — Which Is Better in 2026?`,
    desc: "Honest comparison of Pro Rig Builder vs PCPartPicker. Features, pricing, data accuracy, hardware scanner, and which one is right for you.",
    path: "/vs-pcpartpicker",
    crumbLabel: "vs PCPartPicker",
  },
  "pcpartpicker-alternative": {
    title: `Best PCPartPicker Alternative for 2026 | ${BRAND}`,
    desc: "Looking for a PCPartPicker alternative? Pro Rig Builder offers verified parts, live deals, free hardware scanner, and personalized upgrade paths.",
    path: "/pcpartpicker-alternative",
    crumbLabel: "PCPartPicker Alternative",
  },
  "best-pc-builder-tools": {
    title: `Best PC Builder Tools of 2026 — Ranked | ${BRAND}`,
    desc: "The best free PC builder tools of 2026. Part pickers, FPS estimators, bottleneck checkers, and wattage calculators — ranked and reviewed.",
    path: "/best-pc-builder-tools",
    crumbLabel: "Best PC Builder Tools",
  },
  "pc-hardware-scanner": {
    title: `PC Hardware Scanner — Free Windows Tool | ${BRAND}`,
    desc: "Find out what's in your PC. Our free Windows hardware scanner detects your CPU, GPU, RAM, motherboard and storage in seconds, then suggests upgrades.",
    path: "/pc-hardware-scanner",
    crumbLabel: "PC Hardware Scanner",
  },
  "what-can-i-upgrade": {
    title: `What Can I Upgrade In My PC? | ${BRAND}`,
    desc: "Wondering what you can upgrade in your PC? Find the single upgrade with the biggest performance gain for your budget, based on your real hardware.",
    path: "/what-can-i-upgrade",
    crumbLabel: "What Can I Upgrade",
  },
  "will-it-fit": {
    title: `Will This GPU Fit My Case? | ${BRAND}`,
    desc: "Will your new GPU fit your case? Learn how to check graphics card length, slot width, and cooler clearance so you never buy a part that won't fit.",
    path: "/will-it-fit",
    crumbLabel: "Will It Fit",
  },
};

// ─── Category-specific overrides for /search?cat=X ──────────────────────────
const CATEGORY_META = {
  CPU: { title: `Compare CPUs — Intel & AMD Processors | ${BRAND}`, desc: "Compare every modern Intel and AMD CPU with verified specs, benchmarks, and live prices. Filter by socket, core count, TDP, and integrated graphics." },
  GPU: { title: `Compare GPUs — NVIDIA & AMD Graphics Cards | ${BRAND}`, desc: "Compare NVIDIA RTX and AMD Radeon graphics cards. Verified specs, benchmarks, FPS estimates, and live prices from Amazon and Best Buy." },
  Motherboard: { title: `Compare Motherboards — Intel & AMD | ${BRAND}`, desc: "Find the right motherboard. Filter by socket, chipset, form factor, RAM type, and M.2 slots. 480+ verified boards with live prices." },
  RAM: { title: `Compare RAM — DDR4 & DDR5 Memory Kits | ${BRAND}`, desc: "Compare DDR4 and DDR5 memory kits by speed, capacity, latency, and price. 270+ verified kits with live deals." },
  Storage: { title: `Compare SSDs & Hard Drives | ${BRAND}`, desc: "Compare NVMe SSDs, SATA SSDs, and HDDs by capacity, speed, and price. 560+ verified drives with live deals." },
  PSU: { title: `Compare Power Supplies — 80+ Rated PSUs | ${BRAND}`, desc: "Compare 80+ certified power supplies by wattage, efficiency, modularity, and price. 180+ verified PSUs with live deals." },
  Case: { title: `Compare PC Cases — ATX, mATX, ITX | ${BRAND}`, desc: "Compare PC cases by form factor, GPU clearance, fan support, and price. 340+ verified cases with live deals." },
  CPUCooler: { title: `Compare CPU Coolers — Air & AIO | ${BRAND}`, desc: "Compare air coolers and AIO liquid coolers by socket support, height, fan size, and price. 300+ verified coolers." },
  CaseFan: { title: `Compare Case Fans — 120mm, 140mm & RGB | ${BRAND}`, desc: "Compare case fans by size, airflow, noise, and price. 300+ verified fans with live deals." },
  Monitor: { title: `Compare Gaming & Productivity Monitors | ${BRAND}`, desc: "Compare monitors by size, resolution, refresh rate, panel type, and price. 370+ verified monitors with live deals." },
};

function parseSearchUrl() {
  if (typeof window === "undefined") return { cat: null, id: null };
  const params = new URLSearchParams(window.location.search);
  return { cat: params.get("cat"), id: params.get("id") };
}

function findProduct(parts, id) {
  if (!parts || !id) return null;
  return parts.find((p) => String(p.id) === String(id) || String(p._id) === String(id)) || null;
}

// Self-route: derive page key, product, and category from window.location.
// Does NOT rely on App.jsx's `page` state to avoid hydration-order/race bugs
// where the prerender captures Helmet output before App.jsx routing settles.
function routeFromUrl(parts) {
  if (typeof window === "undefined") return { page: "home", product: null, category: null };
  const pathname = window.location.pathname || "/";

  // /parts/{cat}/{slug}-{id}
  const prodMatch = pathname.match(/^\/parts\/[^/]+\/.*-(\d+)$/);
  if (prodMatch && parts) {
    const product = findProduct(parts, prodMatch[1]);
    if (product) return { page: "product", product, category: null };
  }

  // /parts/{cat}  (category index page — no product id)
  const browseMatch = pathname.match(/^\/parts\/([^/]+)\/browse(?:\/page-(\d+))?\/?$/);
  if (browseMatch) {
    const catKey = SLUG_TO_CAT[browseMatch[1]];
    if (catKey) {
      const pageNum = browseMatch[2] ? Math.max(1, parseInt(browseMatch[2], 10) || 1) : 1;
      return { page: "category-browse", product: null, category: catKey, browsePage: pageNum };
    }
  }

  const catIdxMatch = pathname.match(/^\/parts\/([^/]+)\/?$/);
  if (catIdxMatch) {
    const catKey = SLUG_TO_CAT[catIdxMatch[1]];
    if (catKey) return { page: "category-index", product: null, category: catKey };
  }

  // /search?cat=X or /search?id=Y
  if (pathname === "/search" || pathname === "/search/") {
    const { cat, id } = parseSearchUrl();
    if (id && parts) {
      const product = findProduct(parts, id);
      if (product) return { page: "product", product, category: null };
    }
    return { page: "search", product: null, category: cat || null };
  }

  // /tools/{tool} → use composite key into PAGES
  const toolMatch = pathname.match(/^\/tools\/([\w-]+)\/?$/);
  if (toolMatch) {
    const key = `tools/${toolMatch[1]}`;
    if (PAGES[key]) return { page: key, product: null, category: null };
  }

  // Top-level path
  const base = pathname.replace(/^\//, "").split("/")[0];
  if (!base) return { page: "home", product: null, category: null };
  if (PAGES[base]) return { page: base, product: null, category: null };

  return { page: "home", product: null, category: null };
}

// URL category slug map - MUST MATCH scripts/generate-sitemap.cjs CAT_SLUG
const URL_CAT_SLUG = {
  "CPU":"cpu","GPU":"gpu","Motherboard":"motherboard","RAM":"ram","Storage":"storage",
  "PSU":"psu","Case":"case","CPUCooler":"cpu-cooler","CaseFan":"case-fan","Monitor":"monitor",
  "Keyboard":"keyboard","Mouse":"mouse","MousePad":"mouse-pad","Headset":"headset",
  "Microphone":"microphone","Webcam":"webcam","SoundCard":"sound-card","WiFiCard":"wifi-card",
  "EthernetCard":"ethernet-card","OpticalDrive":"optical-drive","ExternalOptical":"external-optical-drive",
  "ExternalStorage":"external-storage","InternalDisplay":"internal-display","ThermalPaste":"thermal-paste",
  "ExtensionCables":"extension-cables","UPS":"ups","OS":"operating-system","Antivirus":"antivirus",
  "Chair":"chair","Desk":"desk",
};

// Reverse map: URL slug → catalog category key (for /parts/{slug} index pages).
const SLUG_TO_CAT = Object.fromEntries(Object.entries(URL_CAT_SLUG).map(([k, v]) => [v, k]));

// Category index page metadata. Title noun + body phrasing tuned to keep
// titles ≤60 and descriptions in the 120–160 window. Year is derived live.
const CAT_INDEX = {
  CPU:         { noun: "CPUs",           kw: "Compare Processors", long: "CPUs and processors" },
  GPU:         { noun: "Graphics Cards", kw: "Compare GPUs",       long: "graphics cards" },
  Motherboard: { noun: "Motherboards",   kw: "Intel & AMD",        long: "motherboards" },
  RAM:         { noun: "RAM",            kw: "DDR5 & DDR4 Memory",  long: "RAM and memory kits" },
  Storage:     { noun: "SSDs",           kw: "NVMe, SATA & HDD",    long: "SSDs and hard drives" },
  PSU:         { noun: "Power Supplies", kw: "80+ Rated PSUs",      long: "power supplies" },
  Case:        { noun: "PC Cases",       kw: "ATX, mATX & ITX",     long: "PC cases" },
  CPUCooler:   { noun: "CPU Coolers",    kw: "Air & AIO",           long: "CPU coolers" },
  Monitor:     { noun: "Monitors",       kw: "Gaming & 4K",         long: "gaming monitors" },
};

function buildCategoryIndexMeta(catKey) {
  const ci = CAT_INDEX[catKey];
  const slug = URL_CAT_SLUG[catKey];
  if (!ci || !slug) return null;
  const year = new Date().getFullYear();
  return {
    title: `Best ${ci.noun} ${year} — ${ci.kw} | ${BRAND}`,
    desc: `Compare the best ${ci.long} of ${year}, ranked by benchmark and price. Verified specs, live deals, and value grades on every model.`,
    path: `/parts/${slug}`,
  };
}

function buildCategoryBrowseMeta(catKey, pageNum) {
  const ci = CAT_INDEX[catKey];
  const slug = URL_CAT_SLUG[catKey];
  if (!ci || !slug) return null;
  const safePage = Math.max(1, pageNum || 1);
  const pageSuffix = safePage > 1 ? ` - Page ${safePage}` : "";
  const pathSuffix = safePage > 1 ? `/browse/page-${safePage}` : "/browse";
  return {
    title: `Browse ${ci.noun}${pageSuffix} | ${BRAND}`,
    desc: `Browse every ${ci.long.toLowerCase()} in the catalog, ranked by performance. Verified specs and live deals on every model.`,
    path: `/parts/${slug}${pathSuffix}`,
  };
}

// Slug function - MUST MATCH scripts/generate-sitemap.cjs slugify()
function urlSlugify(name) {
  const norm = String(name || "")
    .toLowerCase().replace(/\s+/g, " ").replace(/[^a-z0-9 ]/g, "").trim();
  return norm.replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")
    .replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 80).replace(/-$/, "");
}

// Per-category spec extractors. Each returns short tokens to splice into the
// meta description so it carries real signal (TDP, socket, CFM, panel type, …)
// rather than generic filler.
function categorySpecs(p) {
  const c = p.c, bits = [];
  if (c === "CPU") {
    if (p.cores && p.threads) bits.push(`${p.cores}-core ${p.threads}-thread`);
    if (p.socket) bits.push(p.socket);
    if (p.boostClock) bits.push(`${p.boostClock} GHz boost`);
    if (p.tdp) bits.push(`${p.tdp}W TDP`);
  } else if (c === "GPU") {
    if (p.vram) bits.push(`${p.vram}GB VRAM`);
    if (p.tdp) bits.push(`${p.tdp}W TDP`);
    const len = p.gpuLen || p.length;
    if (len) bits.push(`${len}mm long`);
  } else if (c === "Motherboard") {
    if (p.socket) bits.push(p.socket);
    if (p.chipset) bits.push(p.chipset);
    if (p.ff) bits.push(p.ff);
    if (p.memType) bits.push(p.memType);
  } else if (c === "RAM") {
    if (p.cap && p.sticks) bits.push(`${p.cap}GB (${p.sticks}x${Math.round(p.cap / p.sticks)}GB)`);
    if (p.ramType || p.memType) bits.push(p.ramType || p.memType);
    if (p.speed) bits.push(`${p.speed} MHz`);
    if (p.cl) bits.push(`CL${p.cl}`);
  } else if (c === "Storage") {
    if (p.cap) bits.push(p.cap >= 1000 ? `${(p.cap / 1000).toFixed(p.cap % 1000 === 0 ? 0 : 1)}TB` : `${p.cap}GB`);
    if (p.storageType) bits.push(p.storageType);
    if (p.interface) bits.push(p.interface);
    if (p.ff) bits.push(p.ff);
  } else if (c === "PSU") {
    if (p.watts) bits.push(`${p.watts}W`);
    if (p.eff) bits.push(p.eff);
    if (p.modular) bits.push(`${p.modular} modular`);
    if (p.atx3) bits.push("ATX 3.0");
  } else if (c === "Case") {
    if (p.ff) bits.push(p.ff);
    if (p.tower) bits.push(`${p.tower} tower`);
    if (p.maxGPU) bits.push(`max GPU ${p.maxGPU}mm`);
  } else if (c === "CPUCooler") {
    if (p.coolerType) bits.push(p.coolerType);
    if (p.tdp_rating) bits.push(`${p.tdp_rating}W rating`);
    if (p.height) bits.push(`${p.height}mm tall`);
  } else if (c === "CaseFan") {
    if (p.size) bits.push(`${p.size}mm`);
    if (p.cfm) bits.push(`${p.cfm} CFM`);
    if (p.noise) bits.push(`${p.noise} dBA`);
  } else if (c === "Monitor") {
    if (p.screenSize) bits.push(`${p.screenSize}"`);
    if (p.res || p.resolution) bits.push(p.res || p.resolution);
    if (p.refresh) bits.push(`${p.refresh}Hz`);
    if (p.panel) bits.push(p.panel);
  }
  return bits;
}

// Title builder: stay ≤ 60 chars. Try long form, then short form, then truncate.
function buildProductTitle(displayName) {
  const FULL = ` — Price, Specs & Reviews | ${BRAND}`;
  const SHORT = ` | ${BRAND}`;
  if ((displayName + FULL).length <= 60) return displayName + FULL;
  if ((displayName + SHORT).length <= 60) return displayName + SHORT;
  const maxName = 60 - SHORT.length;
  let truncated = displayName.slice(0, maxName);
  const lastSpace = truncated.lastIndexOf(" ");
  if (lastSpace > 30) truncated = truncated.slice(0, lastSpace);
  return truncated.replace(/[\s\-—|,]+$/, "") + SHORT;
}

// Description builder: aim for 120-160 chars with real per-category specs.
// Dedupe and skip anything already mentioned in the displayName.
function buildProductDesc(displayName, p) {
  const price = p?.deals?.amazon?.price || p?.deals?.bestbuy?.price || p.pr;
  let specs = categorySpecs(p);
  const seen = new Set();
  specs = specs.filter(s => { const k = s.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
  const nameL = displayName.toLowerCase();
  specs = specs.filter(s => !nameL.includes(s.toLowerCase()));

  const TAIL = " Compare specs, benchmarks, and live deals from Amazon, Best Buy, and Newegg.";
  const TAIL_SHORT = " Compare specs, benchmarks, and live deals.";
  const priceSentence = price ? ` Current price $${price}.` : "";

  const head = (n) => displayName + (specs.length && n ? `: ${specs.slice(0, n).join(", ")}.` : ".");
  let d = head(4) + priceSentence + TAIL;

  // Shrink to fit 160
  if (d.length > 160) {
    for (let n = 3; n >= 0 && d.length > 160; n--) d = head(n) + priceSentence + TAIL;
    if (d.length > 160) d = head(0) + priceSentence + TAIL_SHORT;
    if (d.length > 160) {
      const cut = d.slice(0, 160).lastIndexOf(" ");
      d = (cut > 100 ? d.slice(0, cut) : d.slice(0, 157)).replace(/[\s,.\-]+$/, "") + "…";
    }
  }
  // If still short and we have more specs, splice extras in
  if (d.length < 120 && specs.length > 4) {
    const extra = specs.slice(4).join(", ");
    const padded = d.replace(/\.(\s|$)/, `, ${extra}.$1`);
    if (padded.length <= 160) d = padded;
  }
  return d;
}

function buildProductMeta(p) {
  const name = p.n || p.name || "PC Part";
  const cat = p.c || p.category || "";
  const brand = p.b || p.brand || "";
  const cSlug = URL_CAT_SLUG[cat];
  const nSlug = urlSlugify(name);
  const canonicalPath = (cSlug && nSlug && (p.id || p._id))
    ? `/parts/${cSlug}/${nSlug}-${p.id || p._id}`
    : `/search?cat=${encodeURIComponent(cat)}&id=${p.id || p._id}`;

  // Bundles: description + title lead with the FULL combo so both components
  // ("Ryzen 9 7900X + B650 … Motherboard") are in the meta, and the title keeps
  // both + "Bundle" inside 60 chars by dropping the "Price, Specs & Reviews"
  // boilerplate. og/twitter title uses the full-combo H1 form. Scoped to p.bundle.
  const isBundle = p.bundle === true;
  const displayName = isBundle
    ? bundleH1(p)
    : (brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name);

  return {
    title: isBundle ? bundleTitle(p) : buildProductTitle(displayName),
    ogTitle: isBundle ? bundleH1(p) : undefined,
    desc: buildProductDesc(displayName, p),
    path: canonicalPath,
  };
}

// ─── Build BreadcrumbList JSON-LD ───────────────────────────────────────────
// Returns null when no breadcrumb is appropriate (homepage).
function buildBreadcrumbLd({ page, product, category }) {
  const items = [
    { name: "Home", url: SITE + "/" },
  ];

  // Product page: Home › Search › {Category} › {Product Name}
  if (product) {
    const cat = product.c || product.category || "";
    items.push({ name: "Search", url: `${SITE}/search` });
    if (cat) items.push({ name: cat, url: `${SITE}/search?cat=${encodeURIComponent(cat)}` });
    const productName = product.n || "Product";
    // Product crumb has no url (it's the current page)
    items.push({ name: productName.slice(0, 90) });
  } else if (page === "category-index" && category) {
    // Category index: Home › Search › {Category noun}
    items.push({ name: "Search", url: `${SITE}/search` });
    items.push({ name: (CAT_INDEX[category] && CAT_INDEX[category].noun) || category });
  } else if (page === "search" && category) {
    // Category page: Home › Search › {Category}
    items.push({ name: "Search", url: `${SITE}/search` });
    items.push({ name: category });
  } else if (page && page !== "home" && PAGES[page]) {
    // Static page: Home › {Page Label}
    items.push({ name: PAGES[page].crumbLabel || page });
  } else {
    // Homepage — no breadcrumb.
    return null;
  }

  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      ...(it.url ? { item: it.url } : {}),
    })),
  };
}

// ─── Build primary JSON-LD (Product / WebSite / CollectionPage) ─────────────
function buildPrimaryLd({ page, product, category, url, title, desc }) {
  if (product) {
    // ONE offer, described consistently. Availability used to read deals.amazon
    // and nothing else, so `undefined !== false` made every product without an
    // Amazon deal InStock by default — a Best Buy-only row that Best Buy itself
    // reports sold out was telling Google it was buyable. Price and url mean-
    // while came off two independent || chains that could name different
    // retailers. Pick the offer first — buyable ahead of not, in the precedence
    // this has always used — then read price, url and availability off that same
    // deal, so the three can never describe different listings.
    const OFFER_ORDER = [
      ['amazon',  (d) => d?.price],
      ['bestbuy', (d) => d?.price],
      ['newegg',  (d) => d?.saleprice || d?.price],
      ['msi',     (d) => d?.price],
    ];
    const priced = OFFER_ORDER
      .map(([key, priceOf]) => {
        const deal = product?.deals?.[key];
        return { deal, price: priceOf(deal), url: deal?.url || deal?.linkurl };
      })
      .filter((o) => typeof o.price === "number" && o.price > 0);
    const offer = priced.find((o) => o.deal.inStock !== false) || priced[0] || null;
    const price = offer ? offer.price : product.pr;
    const offerUrl = offer?.url || url;
    // No priced deal at all leaves no evidence either way; the pre-existing
    // default (InStock) stands rather than inventing an OutOfStock claim.
    const inStock = offer ? offer.deal.inStock !== false : true;
    const image = product?.deals?.amazon?.image || product.img
      || product?.deals?.newegg?.imageurl || DEFAULT_OG_IMAGE;
    // priceValidUntil: prices refresh on every catalog rebuild; give Google a
    // near-future date (30 days) so Rich Results stays valid without overstating.
    const validUntil = new Date(Date.now() + 30 * 864e5).toISOString().split("T")[0];
    const sku = String(product.id || product._id || "");
    const mpn = product.mpn || product?.deals?.newegg?.sku || sku;
    const ld = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: product.bundle ? bundleLdName(product) : (product.n || product.name),
      ...(image ? { image } : {}),
      ...(desc ? { description: desc } : {}),
      ...(product.b || product.brand ? { brand: { "@type": "Brand", name: product.b || product.brand } } : {}),
      ...(product.c || product.category ? { category: product.c || product.category } : {}),
      ...(sku ? { sku } : {}),
      ...(mpn ? { mpn } : {}),
    };
    if (product.r && product.r > 0) {
      ld.aggregateRating = {
        "@type": "AggregateRating",
        ratingValue: String(product.r),
        reviewCount: String(product.rc || product.reviewCount || 1),
        bestRating: "5",
      };
    }
    if (price) {
      ld.offers = {
        "@type": "Offer",
        price: String(price),
        priceCurrency: "USD",
        availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        priceValidUntil: validUntil,
        url: offerUrl,
      };
    }
    return ld;
  }
  if (page === "home") {
    return {
      "@context": "https://schema.org",
      "@type": "WebSite",
      name: BRAND,
      url: SITE,
      potentialAction: {
        "@type": "SearchAction",
        target: `${SITE}/search?q={search_term_string}`,
        "query-input": "required name=search_term_string",
      },
    };
  }
  if ((page === "search" || page === "category-index") && category) {
    return {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: title,
      description: desc,
      url,
      author: { "@id": `${SITE}/#coby` },
      publisher: { "@id": `${SITE}/#tieredup` },
    };
  }
  return null;
}

// ─── Main component ─────────────────────────────────────────────────────────
export default function PageMeta({ page, category, product, parts }) {
  // Prefer URL-derived routing — `page` prop may lag during prerender/hydration,
  // and only stores top-level pathBase (e.g. "tools") not subroutes ("tools/fps-estimator").
  const fromUrl = routeFromUrl(parts);
  const resolvedProduct = product || fromUrl.product;
  const resolvedCategory = category || fromUrl.category;
  const effectivePage = resolvedProduct ? "product" : (fromUrl.page || page || "home");

  let meta;
  let ogType = "website";
  let ogImage = DEFAULT_OG_IMAGE;
  if (resolvedProduct) {
    meta = buildProductMeta(resolvedProduct);
    ogType = "product";
    ogImage = resolvedProduct?.deals?.amazon?.image || resolvedProduct.img || DEFAULT_OG_IMAGE;
  } else if (effectivePage === "category-index" && resolvedCategory) {
    meta = buildCategoryIndexMeta(resolvedCategory) || PAGES.search;
  } else if (effectivePage === "category-browse" && resolvedCategory) {
    const _pn = (fromUrl && fromUrl.browsePage) || 1;
    meta = buildCategoryBrowseMeta(resolvedCategory, _pn) || PAGES.search;
  } else if (effectivePage === "search" && resolvedCategory && CATEGORY_META[resolvedCategory]) {
    meta = { ...CATEGORY_META[resolvedCategory], path: `/search?cat=${encodeURIComponent(resolvedCategory)}` };
  } else {
    meta = PAGES[effectivePage] || PAGES.home;
  }

  const url = SITE + meta.path;
  const primaryLd = buildPrimaryLd({ page: effectivePage, product: resolvedProduct, category: resolvedCategory, url, title: meta.title, desc: meta.desc });
  const breadcrumbLd = buildBreadcrumbLd({ page: effectivePage, product: resolvedProduct, category: resolvedCategory });
  const articleLd = buildGuideArticleLd({ page: effectivePage, url, title: meta.title, desc: meta.desc });
  if (articleLd) ogType = "article";

  return (
    <Helmet>
      <title>{meta.title}</title>
      <meta name="description" content={meta.desc} />
      <link rel="canonical" href={url} />

      {/* Open Graph */}
      <meta property="og:site_name" content={BRAND} />
      <meta property="og:title" content={meta.ogTitle || meta.title} />
      <meta property="og:description" content={meta.desc} />
      <meta property="og:url" content={url} />
      <meta property="og:type" content={ogType} />
      <meta property="og:image" content={ogImage} />

      {/* Twitter Card */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={meta.ogTitle || meta.title} />
      <meta name="twitter:description" content={meta.desc} />
      <meta name="twitter:image" content={ogImage} />

      {/* Primary structured data (Product / WebSite / CollectionPage) */}
      {primaryLd && (
        <script type="application/ld+json">{JSON.stringify(primaryLd)}</script>
      )}

      {/* BreadcrumbList structured data — improves SERP appearance */}
      {breadcrumbLd && (
        <script type="application/ld+json">{JSON.stringify(breadcrumbLd)}</script>
      )}

      {/* Article structured data with author + publisher + dateModified (guide pages only) */}
      {articleLd && (
        <script type="application/ld+json">{JSON.stringify(articleLd)}</script>
      )}

      {/* Sitewide E-E-A-T graph: Person (author) + Organization (publisher).
          Emitted on every page so Google can resolve @id references from
          Article / CollectionPage schema back to a single canonical entity. */}
      <script type="application/ld+json">{JSON.stringify(PERSON_LD)}</script>
      <script type="application/ld+json">{JSON.stringify(ORG_LD)}</script>
    </Helmet>
  );
}
