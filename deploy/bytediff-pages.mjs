#!/usr/bin/env node
// bytediff-pages.mjs — byte-transparency diff for the Cloudflare Pages stack.
//
// Compares what a HOST serves against what is on disk in dist/, byte for byte.
// CP-3 asserts named tags; this asserts that nothing changed at all, which is
// the only check that can catch a zone feature rewriting HTML in a way no
// assertion happens to name (CUTOVER-cloudflare-pages.md §3.4).
//
//   HOST=https://pages-canary.prorigbuilder.com node deploy/bytediff-pages.mjs
//
// Exits non-zero if any route differs from disk.
//
// ── Why this walks all of dist/ and not just dist/parts ─────────────────────
//
// The original §4 loop sampled `find dist/parts` only. On 2026-08-15 it
// returned 12/12 clean against the canary while Email Obfuscation was actively
// rewriting six routes — because not one of the 5,493 product pages contains a
// mailto: and every affected route was outside /parts/. The check passed
// because it was not looking.
//
// The two halves of dist/ need opposite strategies, and the old loop applied
// the wrong one to both:
//
//   /parts/  — 5,493 pages, all from one template. High volume, low variety,
//              so a sample is genuinely representative. Sampled here.
//   the tail — 27 routes, each hand-built and structurally unique (the only
//              mailto:, the only <form>, the only long-form prose). Low volume,
//              high variety, and small enough to check EXHAUSTIVELY. A sample
//              of the tail is close to worthless: the defect lives in whichever
//              route the sample skipped.
//
// So: every tail route every run, plus a rotating sample of products.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const SITE = "https://prorigbuilder.com";
const HOST = (process.env.HOST || SITE).replace(/\/$/, "");
const SAMPLE = Number(process.env.SAMPLE || 12);

if (!fs.existsSync(DIST)) {
  console.error(`✗ no dist/ at ${DIST} — nothing to diff against`);
  process.exit(1);
}

// ── Signatures of the §3.4 features, so a diff names its cause ──────────────
// "REWRITTEN" alone sends you back to the dashboard guessing. These turn the
// same evidence into "Email Obfuscation is on".
const SIGNATURES = [
  [/\/cdn-cgi\/l\/email-protection/, "Email Obfuscation (§3.4)"],
  [/\/cdn-cgi\/scripts\/[^/]+\/cloudflare-static\/email-decode/, "Email Obfuscation (§3.4)"],
  [/\/cdn-cgi\/scripts\/[^/]+\/cloudflare-static\/rocket-loader/, "Rocket Loader (§3.4)"],
  [/type=["']text\/rocketscript["']/, "Rocket Loader (§3.4)"],
  [/data-cf-settings=/, "Rocket Loader (§3.4)"],
  [/\/cdn-cgi\/image\//, "Polish / Mirage (§3.4)"],
  [/\/cdn-cgi\/challenge-platform\//, "Bot Fight / WAF challenge (§3.5)"],
  [/__cf_bm|cf_chl_/, "Bot Fight / WAF challenge (§3.5)"],
];

const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : p.endsWith(".html") ? [p] : [];
});

// ── Build the route list ────────────────────────────────────────────────────
// dist/ emits every static page twice — `about.html` and `about/index.html` —
// and they are byte-identical (verified 2026-08-15, 25/25 pairs). One route
// serves both, so collapse them or the run doubles for no coverage.
const routeOf = file => {
  const rel = path.relative(DIST, file);
  if (rel === "404.html") return null;                       // handled separately
  if (rel === "index.html") return "/";
  return "/" + rel.replace(/\/index\.html$/, "").replace(/\.html$/, "");
};

const all = walk(DIST);
const byRoute = new Map();
for (const f of all) {
  const r = routeOf(f);
  if (r === null) continue;
  // Prefer the directory form as the on-disk reference: it is what the asset
  // service resolves an extensionless request to.
  if (!byRoute.has(r) || f.endsWith("/index.html")) byRoute.set(r, f);
}

const tail = [...byRoute].filter(([r]) => !r.startsWith("/parts/")).sort();
const products = [...byRoute].filter(([r]) => r.startsWith("/parts/")).sort();

// Rotating offset, same rationale as cp3-pages.mjs: a sample that is identical
// every run cannot detect a defect correlated with category or age.
const step = Math.max(1, Math.floor(products.length / Math.max(1, SAMPLE)));
const offset = Number(process.env.OFFSET ?? Math.floor(Date.now() / 86400000) % step);
const sampled = Array.from({ length: Math.min(SAMPLE, products.length) },
  (_, i) => products[(i * step + offset) % products.length]);

// dist/404.html is never served at /404.html — it is what the asset layer
// returns for an unmatched path. Probe it the way a client reaches it, and
// outside /parts/ so the resolver Function does not intercept (DESIGN §4.1).
const probe404 = ["/__bytediff-probe-" + Math.random().toString(36).slice(2, 10),
  path.join(DIST, "404.html")];

const targets = [...tail, ...sampled, probe404];

// ── Diff ────────────────────────────────────────────────────────────────────
const fetchBytes = async url => Buffer.from(await (await fetch(url, { redirect: "manual" })).arrayBuffer());

const describe = (disk, served) => {
  const named = SIGNATURES.filter(([re]) => re.test(served.toString("utf8")) && !re.test(disk.toString("utf8")))
    .map(([, name]) => name);
  let i = 0;
  while (i < disk.length && i < served.length && disk[i] === served[i]) i++;
  return {
    cause: [...new Set(named)],
    at: i,
    disk: disk.toString("utf8", i, i + 90).replace(/\s+/g, " "),
    served: served.toString("utf8", i, i + 90).replace(/\s+/g, " "),
    delta: served.length - disk.length,
  };
};

let clean = 0;
const failures = [];

for (const [route, file] of targets) {
  const disk = fs.readFileSync(file);
  let served;
  try {
    served = await fetchBytes(HOST + route);
  } catch (e) {
    // A check that cannot RUN counts as a failure, never as a pass.
    failures.push({ route, error: e.message });
    process.stdout.write("X");
    continue;
  }

  if (served.equals(disk)) {
    clean++;
    process.stdout.write(".");
    continue;
  }

  // Fetch again. An injection keyed per request (Email Obfuscation randomises
  // its cipher byte every response) produces a DIFFERENT body each time, which
  // is a far stronger tell than a single mismatch — and it rules out a stale
  // dist/ as the explanation.
  let varies = null;
  try {
    varies = !(await fetchBytes(HOST + route)).equals(served);
  } catch { /* one probe is enough to report the diff */ }

  failures.push({ route, file: path.relative(ROOT, file), varies, ...describe(disk, served) });
  process.stdout.write("X");
}

// ── Report ──────────────────────────────────────────────────────────────────
console.log(`\n\n── byte transparency ────────────────────────────────────────`);
console.log(`host:     ${HOST}`);
console.log(`tail:     ${tail.length} routes (exhaustive) + 404 probe`);
console.log(`products: ${sampled.length} of ${products.length} sampled (offset ${offset})`);
console.log(`clean:    ${clean} | differing: ${failures.length}`);

for (const f of failures) {
  if (f.error) { console.log(`\n  ✗ ${f.route}\n      fetch failed: ${f.error}`); continue; }
  console.log(`\n  ✗ ${f.route}   (${f.file}, ${f.delta > 0 ? "+" : ""}${f.delta} bytes)`);
  if (f.cause.length) console.log(`      cause:  ${f.cause.join(", ")}`);
  if (f.varies) console.log(`      body VARIES between two fetches — per-request injection, not a stale dist/`);
  console.log(`      at byte ${f.at}`);
  console.log(`      disk:   …${f.disk}…`);
  console.log(`      served: …${f.served}…`);
}

if (failures.length) {
  console.error(`\n██ NOT BYTE-TRANSPARENT: ${failures.length}/${targets.length} routes altered in flight ██`);
  process.exit(1);
}
console.log(`\n✓ byte-transparent: ${targets.length} routes identical to dist/.`);
