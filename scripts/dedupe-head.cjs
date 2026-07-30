// =============================================================================
//  scripts/dedupe-head.cjs
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  De-duplicates <head> tags in a prerendered HTML document.
//
//  WHY:
//    The static shell (index.html) ships a full set of default social/SEO
//    meta tags (og:*, twitter:*, title, canonical, ...). These are the
//    FALLBACK for any route react-helmet-async does not cover. At prerender
//    time, Helmet ALSO injects its own per-page versions of those tags,
//    marking every one it manages with `data-rh="true"`. Helmet APPENDS its
//    tags rather than replacing the pre-existing shell defaults, so every
//    prerendered page ends up with TWO og:title, TWO og:description, etc.
//    Duplicate head tags confuse social/AI crawlers.
//
//  WHAT THIS DOES:
//    For each Helmet-managed identity (a data-rh tag), remove the matching
//    NON-data-rh shell default of the SAME identity. Helmet's per-page value
//    wins; the shell default is dropped ONLY because Helmet supplied a
//    replacement.
//
//  WHAT THIS DELIBERATELY DOES NOT DO:
//    It never removes a shell default that Helmet did not replace. If Helmet
//    covers nothing for a route, all shell defaults survive untouched — the
//    fallback is preserved. This guarantees a tag identity can never drop to
//    zero occurrences: we only delete a duplicate when a Helmet copy remains.
//
//  cheerio round-trips these prerendered files byte-for-byte, so a page with
//  nothing to remove is returned unchanged.
// =============================================================================

const cheerio = require("cheerio");

// Link rels that are singletons per page (identity by rel alone, href ignored
// because Helmet's per-page href legitimately differs from the shell default).
// Every OTHER link rel (preconnect, dns-prefetch, preload, icon, manifest,
// stylesheet, alternate, ...) is multi-instance, so its identity includes the
// href — only an exact-duplicate href collapses, never distinct links.
const SINGLETON_RELS = new Set(["canonical", "amphtml"]);

function isHelmet($el) {
  return $el.attr("data-rh") === "true" || $el.attr("data-react-helmet") === "true";
}

// The identity of a head element: what makes two tags "the same tag" for the
// purpose of de-duplication. Returns null for elements we never dedupe
// (scripts, JSON-LD, style, comments, unkeyed metas, etc.).
function identityOf($, el) {
  const tag = (el.tagName || el.name || "").toLowerCase();
  const $el = $(el);

  if (tag === "meta") {
    const prop = $el.attr("property");
    if (prop) return "meta|property|" + prop.trim().toLowerCase();
    const name = $el.attr("name");
    if (name) return "meta|name|" + name.trim().toLowerCase();
    const httpEquiv = $el.attr("http-equiv");
    if (httpEquiv) return "meta|http-equiv|" + httpEquiv.trim().toLowerCase();
    if ($el.attr("charset") !== undefined) return "meta|charset";
    return null;
  }

  if (tag === "link") {
    const rel = ($el.attr("rel") || "").trim().toLowerCase();
    if (!rel) return null;
    if (SINGLETON_RELS.has(rel)) return "link|rel|" + rel;
    const href = ($el.attr("href") || "").trim();
    const hreflang = ($el.attr("hreflang") || "").trim().toLowerCase();
    return "link|rel|" + rel + "|hl|" + hreflang + "|href|" + href;
  }

  if (tag === "title") return "title";
  if (tag === "base") return "base";

  return null;
}

// De-duplicate <head> tags. Pure: returns a new HTML string (or the original
// string unchanged when there is nothing to remove).
function dedupeHeadTags(html) {
  if (typeof html !== "string" || html.indexOf("<head") === -1) return html;

  const $ = cheerio.load(html);
  const head = $("head").first();
  if (!head.length) return html;

  // Pass 1: collect every identity that Helmet manages on this page.
  const managed = new Set();
  head.children().each((_, el) => {
    const $el = $(el);
    if (!isHelmet($el)) return;
    const id = identityOf($, el);
    if (id) managed.add(id);
  });

  // No Helmet tags at all -> keep every shell default (fallback intact).
  if (managed.size === 0) return html;

  // Pass 2: remove non-Helmet shell tags whose identity Helmet also supplies.
  let removed = 0;
  head.children().each((_, el) => {
    const $el = $(el);
    if (isHelmet($el)) return; // never remove Helmet's own tags
    const id = identityOf($, el);
    if (id && managed.has(id)) {
      // Also drop the indentation/newline text node right before this tag, so
      // removal doesn't leave an empty line behind (keeps the head tidy).
      const prev = el.prev;
      if (prev && prev.type === "text" && /^\s*$/.test(prev.data || "")) {
        $(prev).remove();
      }
      $el.remove();
      removed++;
    }
  });

  if (removed === 0) return html; // nothing duplicated -> byte-identical output
  return $.html();
}

module.exports = { dedupeHeadTags, identityOf, isHelmet, SINGLETON_RELS };
