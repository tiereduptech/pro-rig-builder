// =============================================================================
//  generate-image-sitemap.cjs
//  Copyright © 2026 TieredUp Tech, Inc.
//
//  Adds Google Image Sitemap markup to sitemap.xml so product images get
//  indexed by Google Images.
//
//  How it works:
//    1) Parses public/sitemap.xml.
//    2) For every product URL with ?id=N, looks up that product in parts.js
//       and reads its `img` field.
//    3) Injects <image:image> tags into each <url> entry.
//    4) Adds the image: namespace to the root <urlset>.
//    5) Writes updated sitemap to public/sitemap.xml.
//
//  Result:
//    Per Google's Image Sitemap spec, search engines can now associate each
//    page URL with its featured product image. This signals what the image
//    represents (vs. having to crawl + interpret the page) and significantly
//    boosts image search visibility.
//
//  Usage:
//    node generate-image-sitemap.cjs              # update sitemap.xml in place
//    node generate-image-sitemap.cjs --dry-run    # preview only
// =============================================================================

const fs = require('fs');
const path = require('path');

const DRY_RUN = process.argv.includes('--dry-run');
const SITEMAP = path.join('public', 'sitemap.xml');

if (!fs.existsSync(SITEMAP)) {
  console.error(`  ✗ ${SITEMAP} not found`);
  process.exit(1);
}

// ─── Load parts.js ──────────────────────────────────────────────────────────
async function loadParts() {
  const partsPath = path.resolve('src/data/parts.js');
  const url = 'file://' + partsPath.replace(/\\/g, '/') + '?t=' + Date.now();
  const mod = await import(url);
  return mod.PARTS || mod.default || [];
}

// XML attribute escape — sitemap URLs already use & encoding so just handle
// the basics here.
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Main ───────────────────────────────────────────────────────────────────
(async () => {
  console.log('Pro Rig Builder — Image Sitemap Generator');
  console.log('=========================================');

  const parts = await loadParts();
  console.log(`  Loaded ${parts.length} products`);

  // Build id → product index for fast lookup.
  const byId = new Map();
  for (const p of parts) {
    const id = p.id || p._id;
    if (id) byId.set(String(id), p);
  }

  let xml = fs.readFileSync(SITEMAP, 'utf8');
  const before = xml;

  // 1) Add image namespace to <urlset> if not already present.
  const nsRe = /<urlset\b[^>]*>/;
  const urlsetMatch = xml.match(nsRe);
  if (!urlsetMatch) {
    console.error('  ✗ Could not find <urlset> tag in sitemap.xml');
    process.exit(1);
  }
  if (!urlsetMatch[0].includes('xmlns:image')) {
    const updated = urlsetMatch[0].replace(/>$/, ' xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">');
    xml = xml.replace(urlsetMatch[0], updated);
    console.log('  ✓ Added image namespace to <urlset>');
  } else {
    console.log('  – Image namespace already present');
  }

  // 2) For each <url> block, find product URLs (?id=N) and inject <image:image>.
  // Match each <url>...</url> block individually.
  let injected = 0;
  let skipped = 0;
  let alreadyHadImage = 0;

  xml = xml.replace(/<url>([\s\S]*?)<\/url>/g, (block) => {
    // Skip if this url already has an image entry.
    if (/<image:image>/.test(block)) {
      alreadyHadImage++;
      return block;
    }

    const locMatch = block.match(/<loc>([^<]+)<\/loc>/);
    if (!locMatch) return block;

    // Decode entity-encoded ampersands in the URL so we can parse query string.
    const url = locMatch[1].replace(/&amp;/g, '&');
    const idMatch = url.match(/[?&]id=(\d+)/);
    if (!idMatch) return block;  // not a product URL

    const id = idMatch[1];
    const p = byId.get(id);
    if (!p) {
      skipped++;
      return block;
    }

    // Use the highest-quality image we can find in the product record.
    // Prefer Amazon's _SL500_ variant when available (larger, better for image search).
    let imgUrl = (p.deals?.amazon?.image) || p.img || (p.deals?.bestbuy?.image);
    if (!imgUrl) {
      skipped++;
      return block;
    }
    // Bump SL300 to SL500 for higher resolution where applicable.
    imgUrl = imgUrl.replace(/_AC_SL300_/, '_AC_SL500_');

    // Build the <image:image> entry. Includes loc and an optional title +
    // caption for richer Google Image Search results.
    // Match PageMeta logic: only prefix brand when the name doesn't already include it.
    const name = p.n || 'PC Part';
    const brand = p.b || '';
    const title = brand && !name.toLowerCase().includes(brand.toLowerCase())
      ? `${brand} ${name}`
      : name;
    const caption = `${title} — ${p.c || 'PC Component'}`;

    const imageBlock = `\n    <image:image>\n      <image:loc>${xmlEscape(imgUrl)}</image:loc>\n      <image:title>${xmlEscape(title)}</image:title>\n      <image:caption>${xmlEscape(caption)}</image:caption>\n    </image:image>`;

    // Insert right before </url>.
    injected++;
    return block.replace(/(\s*)<\/url>/, `${imageBlock}$1</url>`);
  });

  console.log(`  ✓ Injected images into ${injected} URL entries`);
  if (alreadyHadImage > 0) console.log(`  – ${alreadyHadImage} URLs already had image entries`);
  if (skipped > 0) console.log(`  – ${skipped} product URLs had no image data (skipped)`);

  if (xml === before) {
    console.log('\n  No changes — sitemap already has image sitemap markup');
    process.exit(0);
  }

  if (DRY_RUN) {
    console.log('\n  --dry-run: changes NOT written. First modified entry:');
    const sample = xml.match(/<url>[^]*?<image:image>[^]*?<\/url>/);
    if (sample) console.log(sample[0].slice(0, 600));
  } else {
    fs.writeFileSync(SITEMAP, xml, 'utf8');
    // Also update the dist/ copy if present so we don't have to rebuild.
    const distSitemap = path.join('dist', 'sitemap.xml');
    if (fs.existsSync(distSitemap)) {
      fs.writeFileSync(distSitemap, xml, 'utf8');
      console.log('  ✓ Updated public/sitemap.xml + dist/sitemap.xml');
    } else {
      console.log('  ✓ Updated public/sitemap.xml');
    }
  }

  // Quick stats.
  const sizeKB = Math.round(Buffer.byteLength(xml, 'utf8') / 1024);
  console.log(`\n  Final sitemap size: ${sizeKB} kB`);
  console.log('  ✓ Image sitemap generation complete');
})();
