// Proves verify-prerender's assertions actually FIRE on each defect class — so a
// green run on real dist means "clean", not "gate broken". Covers the 5 hard + 3
// warn checks, including the shell-detection pair that guards the render race.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { assertPage } = require("../verify-prerender.cjs");

const URL = "https://prorigbuilder.com/parts/cpu/amd-ryzen-5-9600x-10004";
const PAD = "x".repeat(30001); // push html.length past the 30KB body floor

function page(over = {}) {
  const d = {
    title:     "<title>AMD Ryzen 5 9600X — Price, Specs | Pro Rig Builder</title>",
    ogTitle:   '<meta property="og:title" content="AMD Ryzen 5 9600X" data-rh="true">',
    canonical: `<link rel="canonical" href="${URL}" data-rh="true">`,
    robots:    '<meta name="robots" content="index, follow, max-image-preview:large">',
    ogUrl:     `<meta property="og:url" content="${URL}">`,
    desc:      '<meta name="description" content="AMD Ryzen 5 9600X 6-core AM5 desktop CPU">',
    productLd: '<script type="application/ld+json">{"@type":"Product","name":"AMD Ryzen 5 9600X"}</script>',
    body:      "<h1>AMD Ryzen 5 9600X</h1>" + PAD,
    ...over,
  };
  return `<!doctype html><html><head>${d.title}${d.ogTitle}${d.canonical}${d.robots}${d.ogUrl}${d.desc}${d.productLd}</head><body>${d.body}</body></html>`;
}
const hasHard = (r, prefix) => r.hard.some(m => m.startsWith(prefix));
const hasWarn = (r, sub) => r.warn.some(m => m.includes(sub));

test("a valid product page has 0 hard and 0 warn violations", () => {
  const r = assertPage(page(), URL);
  assert.deepEqual(r.hard, [], "hard: " + r.hard.join(" | "));
  assert.deepEqual(r.warn, [], "warn: " + r.warn.join(" | "));
});

// ── HARD ───────────────────────────────────────────────────────────────────
test("HARD robots: noindex fails", () => {
  assert.ok(hasHard(assertPage(page({ robots: '<meta name="robots" content="noindex">' }), URL), "robots"));
});
test("HARD robots: missing robots meta fails", () => {
  assert.ok(hasHard(assertPage(page({ robots: "" }), URL), "head-tag") ||
            hasHard(assertPage(page({ robots: "" }), URL), "robots"));
});
test("HARD head-tag: two <title> fails", () => {
  assert.ok(hasHard(assertPage(page({ title: "<title>a</title><title>b</title>" }), URL), "head-tag"));
});
test("HARD head-tag: duplicate og:title fails (the ~4600-page regression class)", () => {
  const dupe = '<meta property="og:title" content="a"><meta property="og:title" content="b">';
  assert.ok(hasHard(assertPage(page({ ogTitle: dupe }), URL), "head-tag"));
});
test("HARD canonical: wrong (non-self) canonical fails", () => {
  const wrong = '<link rel="canonical" href="https://prorigbuilder.com/parts/gpu/other-999">';
  assert.ok(hasHard(assertPage(page({ canonical: wrong }), URL), "canonical"));
});
test("HARD canonical: missing canonical fails", () => {
  assert.ok(hasHard(assertPage(page({ canonical: "" }), URL), "canonical") ||
            hasHard(assertPage(page({ canonical: "" }), URL), "head-tag"));
});
test("HARD product body: missing Product JSON-LD fails (shell sentinel)", () => {
  assert.ok(hasHard(assertPage(page({ productLd: "" }), URL), "product body"));
});
test("HARD shell leak: home h1 present fails", () => {
  assert.ok(hasHard(assertPage(page({ body: "<h1>Skip the shop visit</h1>" + PAD }), URL), "shell leak"));
});
test("HARD shell leak: 'Product Not Found' present fails", () => {
  assert.ok(hasHard(assertPage(page({ body: "<h1>Product Not Found</h1>" + PAD }), URL), "shell leak"));
});

// ── WARN (must NOT be hard) ──────────────────────────────────────────────────
test("WARN og:url != canonical warns, does not hard-fail", () => {
  const r = assertPage(page({ ogUrl: '<meta property="og:url" content="https://prorigbuilder.com/wrong">' }), URL);
  assert.ok(hasWarn(r, "og:url"));
  assert.deepEqual(r.hard, []);
});
test("WARN missing description warns only", () => {
  const r = assertPage(page({ desc: "" }), URL);
  assert.ok(hasWarn(r, "description"));
  assert.deepEqual(r.hard, []);
});
test("WARN body below size floor warns only", () => {
  const r = assertPage(page({ body: "<h1>AMD Ryzen 5 9600X</h1>" }), URL); // no PAD → tiny
  assert.ok(hasWarn(r, "body size"));
  assert.deepEqual(r.hard, []);
});
