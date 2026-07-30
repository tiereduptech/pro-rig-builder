// De-duplicate <head> tags at prerender time.
//
// The static shell ships default social/SEO meta (og:*, twitter:*, canonical,
// title) as a FALLBACK. react-helmet-async APPENDS its own per-page copies
// (marked data-rh="true") instead of replacing them, leaving every prerendered
// page with two of each. dedupeHeadTags() drops the shell default ONLY when a
// Helmet replacement exists, so:
//   - every Helmet-managed tag ends up appearing exactly once (Helmet's wins)
//   - a shell default Helmet did NOT replace is kept (fallback preserved)
//   - a tag identity can never reach zero occurrences
//
//   node --test
//
import test from 'node:test';
import assert from 'node:assert/strict';
import mod from '../scripts/dedupe-head.cjs';

const { dedupeHeadTags } = mod;

// Count occurrences of a head tag by a stable identifying substring.
function count(html, needle) {
  return html.split(needle).length - 1;
}

// A prerendered page: shell defaults (no data-rh) + Helmet copies (data-rh).
// This mirrors the real serialized output — shell tags first, Helmet appended.
function page({ withHelmet = true } = {}) {
  const shell = `
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Pro Rig Builder — Compare, Build &amp; Save on PC Parts</title>
    <meta name="description" content="Shell default description that is long enough." />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="https://prorigbuilder.com/" />
    <meta property="og:title" content="Pro Rig Builder — Compare, Build &amp; Save on PC Parts" />
    <meta property="og:description" content="Shell default og description long enough." />
    <meta property="og:image" content="https://prorigbuilder.com/og-image.png" />
    <meta property="og:image:width" content="1200" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:url" content="https://prorigbuilder.com/" />
    <meta name="twitter:title" content="Pro Rig Builder — Compare, Build &amp; Save on PC Parts" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />`;
  const helmet = withHelmet ? `
    <title data-rh="true">Ryzen 9 7900X | Pro Rig Builder</title>
    <link rel="canonical" href="https://prorigbuilder.com/parts/cpu/ryzen-9-7900x-1" data-rh="true" />
    <meta property="og:type" content="product" data-rh="true" />
    <meta property="og:url" content="https://prorigbuilder.com/parts/cpu/ryzen-9-7900x-1" data-rh="true" />
    <meta property="og:title" content="Ryzen 9 7900X | Pro Rig Builder" data-rh="true" />
    <meta property="og:description" content="Per-page og description for the CPU." data-rh="true" />
    <meta property="og:image" content="https://prorigbuilder.com/og-image.png" data-rh="true" />
    <meta property="og:image:width" content="1200" data-rh="true" />
    <meta name="description" content="Per-page description for the CPU product." data-rh="true" />
    <meta name="twitter:card" content="summary_large_image" data-rh="true" />
    <meta name="twitter:title" content="Ryzen 9 7900X | Pro Rig Builder" data-rh="true" />` : '';
  return `<!DOCTYPE html><html lang="en"><head>${shell}${helmet}</head><body><div id="root">content here that is long enough to be a real body</div></body></html>`;
}

test('every Helmet-managed head tag appears exactly once after dedupe', () => {
  const out = dedupeHeadTags(page());
  for (const id of [
    'property="og:type"',
    'property="og:url"',
    'property="og:title"',
    'property="og:description"',
    'property="og:image"',      // exact: property="og:image" (not og:image:width)
    'property="og:image:width"',
    'name="description"',
    'name="twitter:card"',
    'name="twitter:title"',
    '<title',
    'rel="canonical"',
  ]) {
    assert.equal(count(out, id), 1, `expected exactly one ${id}`);
  }
});

test('Helmet per-page value wins, not the shell default', () => {
  const out = dedupeHeadTags(page());
  // og:title must carry the product name, and the generic shell title must be gone.
  assert.ok(out.includes('content="Ryzen 9 7900X | Pro Rig Builder" data-rh="true"'));
  assert.equal(count(out, 'content="Pro Rig Builder — Compare, Build &amp; Save on PC Parts"'), 0);
  // og:type flipped website -> product.
  assert.ok(/property="og:type" content="product"/.test(out));
});

test('shell defaults Helmet did NOT replace are preserved (fallback)', () => {
  const out = dedupeHeadTags(page());
  // Helmet emits no twitter:url in this page; the shell one must survive.
  assert.equal(count(out, 'name="twitter:url"'), 1);
  // charset, viewport, and the font preconnect are shell-only -> untouched.
  assert.equal(count(out, 'charset="UTF-8"'), 1);
  assert.equal(count(out, 'name="viewport"'), 1);
  assert.equal(count(out, 'rel="preconnect"'), 1);
});

test('a tag identity never drops to zero occurrences', () => {
  const out = dedupeHeadTags(page());
  for (const id of ['property="og:title"', 'name="description"', '<title', 'name="twitter:url"']) {
    assert.ok(count(out, id) >= 1, `${id} must remain present`);
  }
});

test('no Helmet tags -> all shell defaults kept, output unchanged', () => {
  const input = page({ withHelmet: false });
  const out = dedupeHeadTags(input);
  assert.equal(out, input, 'fallback-only page must be returned byte-for-byte');
  assert.equal(count(out, 'property="og:title"'), 1);
});

test('non-string / headless input is returned unchanged', () => {
  assert.equal(dedupeHeadTags(''), '');
  assert.equal(dedupeHeadTags(null), null);
  assert.equal(dedupeHeadTags('<div>no head here</div>'), '<div>no head here</div>');
});
