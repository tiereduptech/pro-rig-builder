// =============================================================================
//  src/ProductPage.jsx
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  Full-page product detail view for SEO-clean URLs:
//      /parts/{categorySlug}/{nameSlug}-{id}
//
//  This is the page Google crawls when it hits a product URL from sitemap.xml.
//  Rendered standalone (full DOM with content) so pre-rendering captures it.
//
//  Props:
//    productId   string|number  - the id parsed from the URL tail
//    parts       array          - ACTIVE_SEED_PARTS from App.jsx
//    go          fn(pageName)   - navigation back to home/search/etc
//
//  PageMeta is rendered by the parent App.jsx (not here) so meta tags fire
//  before this component mounts. We just render the visible content.
// =============================================================================
import React from "react";
import { ExternalLink, ChevronRight } from "lucide-react";

// --- Self-contained helpers (mirrors App.jsx but no imports needed) ---------
function priceOf(p) {
  if (!p) return null;
  const a = p?.deals?.amazon?.price;
  const b = p?.deals?.bestbuy?.price;
  const n = p?.deals?.newegg?.saleprice ?? p?.deals?.newegg?.price;
  const m = p?.deals?.msi?.price;
  const candidates = [a, b, n, m, p.pr].filter(x => typeof x === "number" && x > 0);
  return candidates.length ? Math.min(...candidates) : null;
}
function fmtPrice(n) {
  if (n == null) return "—";
  return n >= 100 ? n.toFixed(0) : n.toFixed(2);
}
function cleanName(p) {
  if (!p) return "";
  return String(p.n || "").replace(/\s*\(.*?\)\s*/g, " ").replace(/\s+/g, " ").trim();
}
function Stars({ r, s = 14 }) {
  const rating = Number(r) || 0;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 2, fontSize: s, color: "#F5A623" }}>
      {[1,2,3,4,5].map(i => (
        <span key={i} style={{ opacity: rating >= i ? 1 : 0.25 }}>★</span>
      ))}
      <span style={{ marginLeft: 4, fontSize: s - 2, color: "var(--dim)", fontFamily: "var(--mono)" }}>
        {rating.toFixed(1)}
      </span>
    </span>
  );
}

// --- Spec rows by category --------------------------------------------------
// Render the right spec fields for each product type. Only show fields
// that have a value (no "—" rows for missing data — accuracy first).
function getSpecs(p) {
  const rows = [];
  const push = (k, v) => { if (v != null && v !== "") rows.push([k, v]); };
  switch (p.c) {
    case "CPU":
      push("Socket", p.socket);
      push("Cores / Threads", p.cores && p.threads ? `${p.cores} / ${p.threads}` : null);
      push("Base Clock", p.baseClock ? `${p.baseClock} GHz` : null);
      push("Boost Clock", p.boostClock ? `${p.boostClock} GHz` : null);
      push("TDP", p.tdp ? `${p.tdp}W` : null);
      push("L3 Cache", p.l3 ? `${p.l3} MB` : null);
      push("Architecture", p.arch);
      push("Memory Support", p.memType);
      push("Integrated Graphics", p.igpu ? "Yes" : null);
      push("PassMark Score", p.cpuMark);
      break;
    case "GPU":
      push("Memory", p.vram ? `${p.vram} GB` : null);
      push("Memory Type", p.vramType);
      push("Power Draw", p.tdp ? `${p.tdp}W` : null);
      push("PCIe", p.pcie);
      push("Length", p.length ? `${p.length} mm` : null);
      push("PassMark G3D", p.g3dMark);
      break;
    case "Motherboard":
      push("Socket", p.socket);
      push("Chipset", p.chipset);
      push("Form Factor", p.ff);
      push("Memory Type", p.memType);
      push("Memory Slots", p.memSlots);
      push("M.2 Slots", p.m2Slots);
      push("SATA Ports", p.sata);
      break;
    case "RAM":
      push("Type", p.ramType);
      push("Capacity", p.cap ? `${p.cap} GB` : null);
      push("Sticks", p.sticks);
      push("Speed", p.speed ? `${p.speed} MHz` : null);
      break;
    case "Storage":
      push("Capacity", p.cap ? `${p.cap} GB` : null);
      push("Interface", /nvme/i.test(p.n || "") ? "NVMe" : /ssd/i.test(p.n || "") ? "SATA SSD" : "HDD");
      break;
    case "PSU":
      push("Wattage", p.watts ? `${p.watts}W` : null);
      push("Efficiency", p.eff);
      push("Modular", p.modular);
      break;
    case "Case":
      push("Form Factor", p.ff);
      push("Max GPU Length", p.gpuMax ? `${p.gpuMax} mm` : null);
      break;
  }
  push("Brand", p.b);
  return rows;
}

// --- Retailer buy buttons ---------------------------------------------------
function BuyButton({ retailer, deal }) {
  if (!deal || !deal.url && !deal.linkurl) return null;
  const url = deal.url || deal.linkurl;
  const price = deal.saleprice ?? deal.price;
  if (!url || !price) return null;
  const labels = {
    amazon: "View on Amazon",
    bestbuy: "View on Best Buy",
    newegg: "View on Newegg",
    msi: "View on MSI",
  };
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener sponsored nofollow"
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "12px 16px",
        background: "var(--bg3)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        textDecoration: "none",
        color: "var(--txt)",
        fontFamily: "var(--ff)",
        fontWeight: 600,
      }}
    >
      <span>{labels[retailer] || retailer}</span>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: "var(--mono)", color: "var(--mint)" }}>
          ${fmtPrice(price)}
        </span>
        <ExternalLink size={14} />
      </span>
    </a>
  );
}

// --- Category URL slug map (must match generate-sitemap.cjs) ---------------
const CAT_SLUG = {
  CPU: "cpu", GPU: "gpu", Motherboard: "motherboard", RAM: "ram",
  Storage: "storage", PSU: "psu", Case: "case", CPUCooler: "cpu-cooler",
  CaseFan: "case-fan", Monitor: "monitor", Keyboard: "keyboard",
  Mouse: "mouse", MousePad: "mouse-pad", Headset: "headset",
  Microphone: "microphone", Webcam: "webcam", SoundCard: "sound-card",
  WiFiCard: "wifi-card", EthernetCard: "ethernet-card",
  OpticalDrive: "optical-drive", ExternalOptical: "external-optical-drive",
  ExternalStorage: "external-storage", InternalDisplay: "internal-display",
  ThermalPaste: "thermal-paste", ExtensionCables: "extension-cables",
  UPS: "ups", OS: "operating-system", Antivirus: "antivirus",
  Chair: "chair", Desk: "desk",
};

// --- Main component ---------------------------------------------------------
export default function ProductPage({ productId, parts, go }) {
  const p = parts && parts.find(x => String(x.id) === String(productId));

  // --- Not found state ------------------------------------------------------
  if (!p) {
    return (
      <div style={{ maxWidth: 760, margin: "60px auto", padding: 24, fontFamily: "var(--ff)" }}>
        <h1 style={{ fontSize: 28, fontWeight: 800, color: "var(--txt)" }}>Product Not Found</h1>
        <p style={{ color: "var(--dim)", marginTop: 12, fontSize: 15 }}>
          We could not find product ID <code style={{ fontFamily: "var(--mono)" }}>{String(productId)}</code> in
          our catalog. It may have been removed or quarantined for data review.
        </p>
        <button
          onClick={() => go && go("search")}
          style={{
            marginTop: 20, padding: "10px 18px", borderRadius: 6,
            background: "var(--accent)", color: "#fff", border: "none",
            fontWeight: 700, cursor: "pointer", fontFamily: "var(--ff)",
          }}
        >
          Browse all parts →
        </button>
      </div>
    );
  }

  const price = priceOf(p);
  const specs = getSpecs(p);
  const catSlug = CAT_SLUG[p.c] || p.c.toLowerCase();
  const categoryLabel = p.c.replace(/([A-Z])/g, " $1").trim();

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "24px 20px", fontFamily: "var(--ff)" }}>
      {/* Breadcrumb (visible, matches BreadcrumbList JSON-LD from PageMeta) */}
      <nav
        aria-label="Breadcrumb"
        style={{
          display: "flex", alignItems: "center", gap: 6, fontSize: 13,
          color: "var(--dim)", marginBottom: 16, flexWrap: "wrap",
        }}
      >
        <a onClick={() => go && go("home")} style={{ color: "var(--dim)", cursor: "pointer" }}>Home</a>
        <ChevronRight size={12} />
        <a onClick={() => go && go("search")} style={{ color: "var(--dim)", cursor: "pointer" }}>Parts</a>
        <ChevronRight size={12} />
        <span>{categoryLabel}</span>
        <ChevronRight size={12} />
        <span style={{ color: "var(--txt)", fontWeight: 600 }}>{cleanName(p)}</span>
      </nav>

      {/* Header: image + title + price */}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 320px) 1fr", gap: 32, alignItems: "start" }}>
        <div style={{ background: "var(--bg4)", borderRadius: 12, padding: 24, display: "flex", justifyContent: "center", alignItems: "center", minHeight: 280 }}>
          {p.img ? (
            <img src={p.img} alt={cleanName(p)} style={{ maxWidth: "100%", maxHeight: 280, objectFit: "contain" }} />
          ) : (
            <span style={{ fontSize: 80, color: "var(--dim)" }}>📦</span>
          )}
        </div>

        <div>
          <div style={{ fontSize: 11, fontFamily: "var(--mono)", letterSpacing: 1.5, color: "var(--dim)", textTransform: "uppercase", marginBottom: 6 }}>
            {categoryLabel}{p.b ? ` · ${p.b}` : ""}
          </div>
          <h1 style={{ fontSize: 28, fontWeight: 800, color: "var(--txt)", lineHeight: 1.25, margin: "0 0 12px 0" }}>
            {cleanName(p)}
          </h1>
          {p.r != null && (
            <div style={{ marginBottom: 14 }}>
              <Stars r={p.r} />
            </div>
          )}
          {price != null && (
            <div style={{ fontFamily: "var(--mono)", fontSize: 36, fontWeight: 800, color: "var(--mint)", marginBottom: 4 }}>
              ${fmtPrice(price)}
            </div>
          )}
          {p.msrp && price && p.msrp > price && (
            <div style={{ fontSize: 13, color: "var(--dim)" }}>
              MSRP <span style={{ textDecoration: "line-through" }}>${fmtPrice(p.msrp)}</span> · You save ${fmtPrice(p.msrp - price)}
            </div>
          )}

          {/* Buy buttons */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 8, marginTop: 20, maxWidth: 360 }}>
            <BuyButton retailer="amazon"  deal={p?.deals?.amazon} />
            <BuyButton retailer="bestbuy" deal={p?.deals?.bestbuy} />
            <BuyButton retailer="newegg"  deal={p?.deals?.newegg} />
            <BuyButton retailer="msi"     deal={p?.deals?.msi} />
          </div>
        </div>
      </div>

      {/* Specs table */}
      {specs.length > 0 && (
        <section style={{ marginTop: 40 }}>
          <h2 style={{ fontSize: 20, fontWeight: 700, color: "var(--txt)", marginBottom: 12 }}>
            Specifications
          </h2>
          <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
            {specs.map(([k, v], i) => (
              <div
                key={k}
                style={{
                  display: "grid",
                  gridTemplateColumns: "200px 1fr",
                  padding: "10px 16px",
                  background: i % 2 === 0 ? "var(--bg3)" : "transparent",
                  fontSize: 14,
                  borderBottom: i < specs.length - 1 ? "1px solid var(--border)" : "none",
                }}
              >
                <span style={{ color: "var(--dim)" }}>{k}</span>
                <span style={{ color: "var(--txt)", fontWeight: 500 }}>{v}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* SEO body copy — gives Google text content beyond just specs */}
      <section style={{ marginTop: 40 }}>
        <h2 style={{ fontSize: 20, fontWeight: 700, color: "var(--txt)", marginBottom: 12 }}>
          About the {cleanName(p)}
        </h2>
        <p style={{ color: "var(--txt)", fontSize: 15, lineHeight: 1.6 }}>
          The <strong>{cleanName(p)}</strong>{p.b ? ` from ${p.b}` : ""} is a {categoryLabel.toLowerCase()} listed
          in the Pro Rig Builder catalog. {price != null ? `Current best price: $${fmtPrice(price)}. ` : ""}
          Compare specs, check compatibility with the rest of your build, and find live deals across Amazon,
          Best Buy, and Newegg below.
        </p>
        {p.bench != null && (
          <p style={{ color: "var(--txt)", fontSize: 15, lineHeight: 1.6, marginTop: 10 }}>
            PassMark benchmark score: <strong>{p.bench}</strong> (normalized 0–100). Use this number to
            compare raw performance against other {categoryLabel.toLowerCase()}s in the catalog.
          </p>
        )}
      </section>
    </div>
  );
}