// =============================================================================
//  PageMeta.jsx
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Per-page meta tags for Pro Rig Builder. Renders <title>, description,
//  canonical, Open Graph, Twitter Card, and JSON-LD structured data based on
//  the current page, category, or product.
//
//  Product detection works two ways:
//    1) Explicit `product` prop — caller passes a product object directly.
//    2) URL-based — when `parts` array is passed and the URL has ?id=N (the
//       Pro Rig Builder convention for product detail), this component looks
//       up the matching product and uses it.
//
//  Usage in App.jsx:
//    <PageMeta page={page} category={bc} parts={parts} />
//
//  Notes:
//    * Uses react-helmet-async (already wired in main.jsx via <HelmetProvider>).
//    * Canonical URLs always point to https://prorigbuilder.com (no trailing /).
//    * Title format follows Google's recommended pattern: "Page — Brand".
//    * Descriptions stay 120–160 chars where possible (optimal SERP display).
//    * JSON-LD Product schema enables rich snippets (stars, prices, "In Stock").
// =============================================================================

import React from "react";
import { Helmet } from "react-helmet-async";

const SITE = "https://prorigbuilder.com";
const BRAND = "Pro Rig Builder";
const DEFAULT_OG_IMAGE = `${SITE}/og-image.png`;

// ─── Static page metadata (matches `page` state values in App.jsx) ──────────
const PAGES = {
  home: {
    title: `${BRAND} — Free PC Part Picker, Builder & Hardware Scanner`,
    desc: "Build your PC with 3,950+ verified parts. Compare prices and specs side-by-side. Free PCPartPicker alternative with hardware scanner.",
    path: "/",
  },
  search: {
    title: `Search PC Parts — Specs, Prices & Deals | ${BRAND}`,
    desc: "Search and compare 3,950+ PC parts with verified specs, live prices, and deals from Amazon and Best Buy. Filter by socket, chipset, wattage, and more.",
    path: "/search",
  },
  builder: {
    title: `PC Builder — Build Your Custom PC Online | ${BRAND}`,
    desc: "Build your custom gaming or workstation PC. Auto-checks compatibility, calculates wattage, and shows live deals. Free and no signup required.",
    path: "/builder",
  },
  community: {
    title: `Community PC Builds & Inspiration | ${BRAND}`,
    desc: "Browse PC builds shared by the community. Get inspiration from gaming, streaming, workstation, and budget builds at every price point.",
    path: "/community",
  },
  tools: {
    title: `PC Builder Tools — FPS, Wattage & Bottleneck Calc | ${BRAND}`,
    desc: "Free PC tools: FPS estimator, wattage calculator, bottleneck checker, RAM speed advisor, and more. No signup, no ads, just answers.",
    path: "/tools",
  },
  upgrade: {
    title: `Upgrade Path — Personalized PC Upgrade Recommendations | ${BRAND}`,
    desc: "Get personalized upgrade recommendations based on your current PC and budget. Scan your hardware and see exactly what to upgrade first.",
    path: "/upgrade",
  },
  scanner: {
    title: `Free PC Hardware Scanner for Windows | ${BRAND}`,
    desc: "Download our free Windows hardware scanner. Auto-detects your CPU, GPU, RAM, motherboard, and storage. No install required, completely free.",
    path: "/scanner",
  },
  about: {
    title: `About ${BRAND} — Free, Verified, Independent`,
    desc: "Pro Rig Builder is a free PC part picker with 100% verified product data, live pricing, and zero paywalls. Built by PC enthusiasts.",
    path: "/about",
  },
  contact: {
    title: `Contact ${BRAND}`,
    desc: "Get in touch with the Pro Rig Builder team. Feedback, partnerships, and product corrections welcome.",
    path: "/contact",
  },
  privacy: {
    title: `Privacy Policy | ${BRAND}`,
    desc: "How Pro Rig Builder collects, uses, and protects your data. Plain English, no legalese.",
    path: "/privacy",
  },
  terms: {
    title: `Terms of Service | ${BRAND}`,
    desc: "Terms of service for using Pro Rig Builder, our hardware scanner, and our APIs.",
    path: "/terms",
  },
  affiliate: {
    title: `Affiliate Disclosure | ${BRAND}`,
    desc: "Pro Rig Builder is an Amazon Associate and earns from qualifying purchases. Full affiliate disclosure inside.",
    path: "/affiliate",
  },
  compare: {
    title: `Compare PC Parts Side-by-Side | ${BRAND}`,
    desc: "Compare CPUs, GPUs, motherboards, RAM, and more side-by-side. Full specs, benchmarks, and live pricing on every product.",
    path: "/compare",
  },
  "vs-pcpartpicker": {
    title: `Pro Rig Builder vs PCPartPicker — Which Is Better in 2026?`,
    desc: "Honest comparison of Pro Rig Builder vs PCPartPicker. Features, pricing, data accuracy, hardware scanner, and which one is right for you.",
    path: "/vs-pcpartpicker",
  },
  "pcpartpicker-alternative": {
    title: `Best PCPartPicker Alternative for 2026 | ${BRAND}`,
    desc: "Looking for a PCPartPicker alternative? Pro Rig Builder offers verified parts, live deals, free hardware scanner, and personalized upgrade paths.",
    path: "/pcpartpicker-alternative",
  },
  "best-pc-builder-tools": {
    title: `Best PC Builder Tools of 2026 — Free & Tested | ${BRAND}`,
    desc: "The best free PC builder tools of 2026. Part pickers, FPS estimators, bottleneck checkers, and wattage calculators ranked and reviewed.",
    path: "/best-pc-builder-tools",
  },
};

// ─── Category-specific overrides for /search?cat=X ──────────────────────────
const CATEGORY_META = {
  CPU: {
    title: `Compare CPUs — Intel & AMD Processors | ${BRAND}`,
    desc: "Compare every modern Intel and AMD CPU with verified specs, benchmarks, and live prices. Filter by socket, core count, TDP, and integrated graphics.",
  },
  GPU: {
    title: `Compare GPUs — NVIDIA & AMD Graphics Cards | ${BRAND}`,
    desc: "Compare NVIDIA RTX and AMD Radeon graphics cards. Verified specs, benchmarks, FPS estimates, and live prices from Amazon and Best Buy.",
  },
  Motherboard: {
    title: `Compare Motherboards — Intel & AMD | ${BRAND}`,
    desc: "Find the right motherboard. Filter by socket, chipset, form factor, RAM type, and M.2 slots. 480+ verified boards with live prices.",
  },
  RAM: {
    title: `Compare RAM — DDR4 & DDR5 Memory Kits | ${BRAND}`,
    desc: "Compare DDR4 and DDR5 memory kits by speed, capacity, latency, and price. 270+ verified kits with live deals.",
  },
  Storage: {
    title: `Compare SSDs & Hard Drives | ${BRAND}`,
    desc: "Compare NVMe SSDs, SATA SSDs, and HDDs by capacity, speed, and price. 560+ verified drives with live deals.",
  },
  PSU: {
    title: `Compare Power Supplies — 80+ Rated PSUs | ${BRAND}`,
    desc: "Compare 80+ certified power supplies by wattage, efficiency, modularity, and price. 180+ verified PSUs with live deals.",
  },
  Case: {
    title: `Compare PC Cases — ATX, mATX, ITX | ${BRAND}`,
    desc: "Compare PC cases by form factor, GPU clearance, fan support, and price. 340+ verified cases with live deals.",
  },
  CPUCooler: {
    title: `Compare CPU Coolers — Air & AIO | ${BRAND}`,
    desc: "Compare air coolers and AIO liquid coolers by socket support, height, fan size, and price. 300+ verified coolers.",
  },
  CaseFan: {
    title: `Compare Case Fans — 120mm, 140mm & RGB | ${BRAND}`,
    desc: "Compare case fans by size, airflow, noise, and price. 300+ verified fans with live deals.",
  },
  Monitor: {
    title: `Compare Gaming & Productivity Monitors | ${BRAND}`,
    desc: "Compare monitors by size, resolution, refresh rate, panel type, and price. 370+ verified monitors with live deals.",
  },
};

// ─── URL parsing — pulls ?cat= and ?id= for /search?cat=GPU&id=30345 ────────
function parseSearchUrl() {
  if (typeof window === "undefined") return { cat: null, id: null };
  const params = new URLSearchParams(window.location.search);
  return {
    cat: params.get("cat"),
    id: params.get("id"),
  };
}

// ─── Look up product in parts array by id (string compare for safety) ───────
function findProduct(parts, id) {
  if (!parts || !id) return null;
  return parts.find((p) => String(p.id) === String(id) || String(p._id) === String(id)) || null;
}

// ─── Build product-specific meta tags ───────────────────────────────────────
function buildProductMeta(product) {
  const name = product.n || product.name || "PC Part";
  const cat = product.c || product.category || "";
  const brand = product.b || product.brand || "";
  const price = product?.deals?.amazon?.price || product?.deals?.bestbuy?.price || product.pr;
  const slug = (product.slug || name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""));

  const titleParts = [];
  if (brand && !name.toLowerCase().includes(brand.toLowerCase())) titleParts.push(`${brand} ${name}`);
  else titleParts.push(name);
  if (cat) titleParts.push(cat);
  titleParts.push("Specs, Price & Reviews");
  titleParts.push(BRAND);

  let desc = brand && !name.toLowerCase().includes(brand.toLowerCase()) ? `${brand} ${name}` : name;
  desc += ` — full specs, benchmarks`;
  if (price) desc += `, current price $${price}`;
  desc += `, and live availability from Amazon and Best Buy.`;

  return {
    title: titleParts.join(" | ").slice(0, 70),
    desc: desc.slice(0, 160),
    path: `/search?cat=${encodeURIComponent(cat)}&id=${product.id || product._id}&slug=${slug}`,
  };
}

// ─── Build JSON-LD structured data ──────────────────────────────────────────
function buildJsonLd({ page, product, category, url, title, desc }) {
  // Product schema — produces rich snippets (stars, prices, in-stock) in SERPs.
  if (product) {
    const price = product?.deals?.amazon?.price || product?.deals?.bestbuy?.price || product.pr;
    const offerUrl = product?.deals?.amazon?.url || product?.deals?.bestbuy?.url || url;
    const inStock = product?.deals?.amazon?.inStock !== false;
    const ld = {
      "@context": "https://schema.org",
      "@type": "Product",
      name: product.n || product.name,
      ...(product.b || product.brand ? { brand: { "@type": "Brand", name: product.b || product.brand } } : {}),
      ...(product.c || product.category ? { category: product.c || product.category } : {}),
    };
    if (product.r && product.r > 0) {
      ld.aggregateRating = {
        "@type": "AggregateRating",
        ratingValue: String(product.r),
        reviewCount: String(product.rc || product.reviewCount || 1),
      };
    }
    if (price) {
      ld.offers = {
        "@type": "Offer",
        price: String(price),
        priceCurrency: "USD",
        availability: inStock ? "https://schema.org/InStock" : "https://schema.org/OutOfStock",
        url: offerUrl,
      };
    }
    return ld;
  }
  // Homepage: WebSite + SearchAction (lets Google add a search box to your SERP).
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
  // Category pages.
  if (page === "search" && category) {
    return {
      "@context": "https://schema.org",
      "@type": "CollectionPage",
      name: title,
      description: desc,
      url,
    };
  }
  return null;
}

// ─── Main component ─────────────────────────────────────────────────────────
export default function PageMeta({ page, category, product, parts }) {
  // URL-based product detection. Runs every render — cheap (one find on parts).
  // When App's state updates due to URL change, this re-evaluates automatically.
  let resolvedProduct = product || null;
  let resolvedCategory = category || null;
  if (!resolvedProduct && page === "search" && parts) {
    const { cat, id } = parseSearchUrl();
    if (id) {
      resolvedProduct = findProduct(parts, id);
    }
    if (cat && !resolvedCategory) resolvedCategory = cat;
  }

  // Resolve metadata.
  let meta;
  let ogType = "website";
  let ogImage = DEFAULT_OG_IMAGE;
  if (resolvedProduct) {
    meta = buildProductMeta(resolvedProduct);
    ogType = "product";
    // Use product image if available, falling back to default OG image.
    ogImage = resolvedProduct?.deals?.amazon?.image || resolvedProduct.img || DEFAULT_OG_IMAGE;
  } else if (page === "search" && resolvedCategory && CATEGORY_META[resolvedCategory]) {
    meta = {
      ...CATEGORY_META[resolvedCategory],
      path: `/search?cat=${encodeURIComponent(resolvedCategory)}`,
    };
  } else {
    meta = PAGES[page] || PAGES.home;
  }

  const url = SITE + meta.path;
  const jsonLd = buildJsonLd({
    page,
    product: resolvedProduct,
    category: resolvedCategory,
    url,
    title: meta.title,
    desc: meta.desc,
  });

  return (
    <Helmet>
      <title>{meta.title}</title>
      <meta name="description" content={meta.desc} />
      <link rel="canonical" href={url} />

      {/* Open Graph */}
      <meta property="og:site_name" content={BRAND} />
      <meta property="og:title" content={meta.title} />
      <meta property="og:description" content={meta.desc} />
      <meta property="og:url" content={url} />
      <meta property="og:type" content={ogType} />
      <meta property="og:image" content={ogImage} />

      {/* Twitter Card */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content={meta.title} />
      <meta name="twitter:description" content={meta.desc} />
      <meta name="twitter:image" content={ogImage} />

      {/* JSON-LD structured data */}
      {jsonLd && (
        <script type="application/ld+json">
          {JSON.stringify(jsonLd)}
        </script>
      )}
    </Helmet>
  );
}
