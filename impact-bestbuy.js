/**
 * Impact.com + Best Buy catalog helper for Pro Rig Builder
 *
 * Reads IMPACT_ACCOUNT_SID and IMPACT_AUTH_TOKEN from environment.
 *
 * Usage:
 *   node scripts/impact-bestbuy.js list
 *   node scripts/impact-bestbuy.js preview <catalogId>
 *   node scripts/impact-bestbuy.js preview <catalogId> 20   (show 20 items)
 *
 * With Railway env vars (recommended):
 *   railway run node scripts/impact-bestbuy.js list
 *
 * With shell env vars (no Railway CLI):
 *   $env:IMPACT_ACCOUNT_SID="..."; $env:IMPACT_AUTH_TOKEN="..."; node scripts/impact-bestbuy.js list
 */

const SID = process.env.IMPACT_ACCOUNT_SID;
const TOKEN = process.env.IMPACT_AUTH_TOKEN;

if (!SID || !TOKEN) {
  console.error("✗ Missing credentials.");
  console.error("  Set IMPACT_ACCOUNT_SID and IMPACT_AUTH_TOKEN, or run via `railway run`.");
  process.exit(1);
}

const BASE = `https://api.impact.com/Mediapartners/${SID}`;
const AUTH = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");

async function api(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    headers: { Authorization: AUTH, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`✗ ${res.status} ${res.statusText}`);
    console.error(text.slice(0, 500));
    throw new Error(`API error ${res.status}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    console.error("Response was not JSON:");
    console.error(text.slice(0, 500));
    throw new Error("Non-JSON response");
  }
}

async function listCatalogs() {
  console.log("Fetching available catalogs from Impact...\n");
  const data = await api("/Catalogs");
  const catalogs = data.Catalogs || [];

  if (!catalogs.length) {
    console.log("No catalogs available.");
    console.log("This usually means:");
    console.log("  - You're not yet approved in any brand's program, OR");
    console.log("  - The brand(s) you joined don't publish catalogs via Impact, OR");
    console.log("  - Your token doesn't have Catalogs scope enabled.");
    return;
  }

  console.log(`Found ${catalogs.length} catalog(s):\n`);
  catalogs.forEach((c, i) => {
    console.log(`[${i + 1}]`);
    console.log(`  ID:              ${c.Id}`);
    console.log(`  Name:            ${c.Name || "(unnamed)"}`);
    console.log(`  Campaign:        ${c.CampaignName || "—"} (id: ${c.CampaignId || "—"})`);
    console.log(`  Product count:   ${c.NumberOfProducts ?? "—"}`);
    console.log(`  Last updated:    ${c.LastUpdateDate || c.LastModificationDate || "—"}`);
    console.log(`  Items endpoint:  ${c.Uri || BASE + "/Catalogs/" + c.Id + "/Items"}`);
    console.log("");
  });

  console.log("Next step: pick the Best Buy catalog ID above and run:");
  console.log(`  node scripts/impact-bestbuy.js preview <catalogId>`);
}

async function previewCatalog(catalogId, limit = 5) {
  console.log(`Fetching ${limit} sample items from catalog ${catalogId}...\n`);

  // Impact catalogs expose items at /Catalogs/<id>/Items with pagination
  const data = await api(`/Catalogs/${catalogId}/Items`, { PageSize: limit, Page: 1 });

  const items = data.CatalogItems || data.Items || [];
  const total = data["@total"] || data.Total || "unknown";

  console.log(`Catalog reports ${total} total items.\n`);
  console.log(`--- FIELD STRUCTURE (first item) ---`);
  if (items[0]) {
    const keys = Object.keys(items[0]).sort();
    console.log(`Fields: ${keys.join(", ")}\n`);
    console.log(`--- SAMPLE ITEM #1 ---`);
    console.log(JSON.stringify(items[0], null, 2));
  } else {
    console.log("(no items returned — catalog may be empty or the response shape is different)");
    console.log("Raw response:");
    console.log(JSON.stringify(data, null, 2).slice(0, 2000));
    return;
  }

  if (items.length > 1) {
    console.log(`\n--- SAMPLE ITEM #2 ---`);
    console.log(JSON.stringify(items[1], null, 2));
  }

  // Quick stats useful for ingest planning
  console.log(`\n--- INGEST-PLANNING STATS ---`);
  const withUpc = items.filter((x) => x.Upc || x.UPC || x.upc).length;
  const withSku = items.filter((x) => x.Sku || x.SKU || x.sku || x.ManufacturerSku).length;
  const withMpn = items.filter((x) => x.Mpn || x.MPN || x.ModelNumber || x.ManufacturerPartNumber).length;
  const withPrice = items.filter((x) => x.CurrentPrice || x.Price || x.OriginalPrice).length;
  const withStock = items.filter((x) => x.StockAvailability !== undefined || x.InStock !== undefined).length;

  console.log(`  Items with UPC:          ${withUpc}/${items.length}`);
  console.log(`  Items with SKU:          ${withSku}/${items.length}`);
  console.log(`  Items with MPN/Model:    ${withMpn}/${items.length}`);
  console.log(`  Items with price:        ${withPrice}/${items.length}`);
  console.log(`  Items with stock status: ${withStock}/${items.length}`);
}

// ── Main ─────────────────────────────────────────────
const [, , mode, arg1, arg2] = process.argv;

(async () => {
  try {
    if (mode === "list") {
      await listCatalogs();
    } else if (mode === "preview" && arg1) {
      await previewCatalog(arg1, parseInt(arg2) || 5);
    } else {
      console.log("Usage:");
      console.log("  node scripts/impact-bestbuy.js list");
      console.log("  node scripts/impact-bestbuy.js preview <catalogId> [limit]");
    }
  } catch (e) {
    console.error("\n✗ Failed:", e.message);
    process.exit(1);
  }
})();
