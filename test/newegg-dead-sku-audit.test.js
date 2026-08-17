// The rules that can condemn a catalog row, tested without an SFTP endpoint.
//
// WHY THIS TEST EXISTS
//   1,725 of the 2,666 Newegg rows have no other priced retailer, so a wrong
//   "dead" verdict here deletes the only buy link a product has. Two things
//   protect against that and both are one boolean away from being useless:
//     - two strikes before any death verdict
//     - a strike may only advance on a DIFFERENT feed snapshot, because
//       re-reading the same file twice is one observation, not a confirmation
//   The second is the subtle one. A dispatch-twice-in-five-minutes habit would
//   otherwise manufacture a second strike against a byte-identical feed and
//   condemn every sku that a single bad pull happened to miss.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const audit = require("../newegg-dead-sku-audit.cjs");

const { classifySighting, strikeVerdict, FULL_CATALOG_RE, partitionFeedsByFreshness, preflight } = audit;

// ── The preflight ────────────────────────────────────────────────────────
// Run 32057560889 spent 58 minutes and ~1.3GB of downloads to discover that
// streamTxtFeed was never exported. These tests are the reason that can only
// happen once.

test("preflight proves the parser contract before anything is downloaded", async () => {
  const proved = await preflight();
  assert.ok(proved.length >= 6, "preflight should report what it checked");
  assert.ok(proved.some((c) => /streamTxtFeed contract/.test(c)),
    "preflight must exercise the parser, not just check that the symbol exists");
});

test("preflight is cheap enough to be unconditional", async () => {
  const t0 = Date.now();
  await preflight();
  const ms = Date.now() - t0;
  assert.ok(ms < 1000, `preflight took ${ms}ms; it must stay far below the cost of a download`);
});

test("sftp-ingest still exports the parser the census imports", () => {
  const ingest = require("../sftp-ingest.cjs");
  assert.equal(typeof ingest.streamTxtFeed, "function");
  assert.equal(typeof ingest.parseTxtFeed, "function");
});

test("requiring sftp-ingest must not start an ingest", () => {
  // Without `require.main === module` around its main IIFE, importing the
  // parser launched a second full ingest: a competing SFTP session on a
  // throttled endpoint, and a write to parts.js from a read-only job.
  // Reaching this line at all means the guard held — an unguarded IIFE
  // throws on the missing FTP password and exits the test process.
  const ingest = require("../sftp-ingest.cjs");
  assert.ok(ingest.streamTxtFeed, "module loaded without running main");
});

// ── Feed freshness ───────────────────────────────────────────────────────
// The MKPL feed's mtime is 2023-03-16; the main mp feed's is current. Sightings
// resolve least-condemning-wins, so a stale `in-stock` OVERRIDES the live feed
// and hides a sku that has since died. Stale feeds are a correctness problem
// first and a 30-minute download second.

const NOW = Date.parse("2026-08-17T12:00:00Z");
const feed = (name, iso, kind = "mp") => ({ name, kind, size: 1e6, mtime: Date.parse(iso) });

test("a three-year-old feed is excluded, a current one is kept", () => {
  const { fresh, stale } = partitionFeedsByFreshness(
    [feed("44583_4681679_mp.txt.gz", "2026-08-17T12:32:00Z"),
     feed("44583_4681679_mp_MKPL.txt.gz", "2023-03-16T01:05:38Z", "MKPL")],
    { now: NOW });
  assert.deepEqual(fresh.map((f) => f.kind), ["mp"]);
  assert.deepEqual(stale.map((f) => f.kind), ["MKPL"]);
  assert.match(stale[0].reason, /2023-03-16/);
});

test("the ceiling is inclusive, so a feed exactly at the limit still counts", () => {
  const at = partitionFeedsByFreshness([feed("a", "2026-08-03T12:00:00Z")], { now: NOW, maxAgeDays: 14 });
  assert.equal(at.fresh.length, 1, "14.0 days old must not be excluded by a 14-day ceiling");
  const over = partitionFeedsByFreshness([feed("a", "2026-08-02T12:00:00Z")], { now: NOW, maxAgeDays: 14 });
  assert.equal(over.stale.length, 1);
});

test("--allow-stale-feeds keeps everything", () => {
  const { fresh, stale } = partitionFeedsByFreshness(
    [feed("old", "2023-03-16T01:05:38Z")], { now: NOW, allowStale: true });
  assert.equal(fresh.length, 1);
  assert.equal(stale.length, 0);
});

test("an unreadable mtime is not treated as stale", () => {
  // Dropping a feed because its timestamp was unparseable would silently cut
  // coverage, and this census condemns on absence.
  const { fresh, stale } = partitionFeedsByFreshness(
    [{ name: "weird", kind: "mp", size: 1, mtime: undefined }], { now: NOW });
  assert.equal(fresh.length, 1, "a bad timestamp must not remove a feed from the census");
  assert.equal(stale.length, 0);
});

test("a sku listed in-stock is alive", () => {
  assert.equal(classifySighting({ availability: "in-stock", is_deleted: "0" }), "alive");
  assert.equal(classifySighting({ availability: "In-Stock" }), "alive");
  assert.equal(classifySighting({ availability: "instock" }), "alive");
});

test("listed but not in stock is unbuyable, never dead", () => {
  for (const availability of ["out-of-stock", "backordered", "", "unavailable"]) {
    assert.equal(classifySighting({ availability }), "unbuyable",
      `availability=${JSON.stringify(availability)} must read as unbuyable`);
  }
});

test("is_deleted overrides any availability string", () => {
  assert.equal(classifySighting({ availability: "in-stock", is_deleted: "1" }), "deleted");
  assert.equal(classifySighting({ availability: "in-stock", is_deleted: "true" }), "deleted");
  assert.equal(classifySighting({ availability: "in-stock", is_deleted: "deleted" }), "deleted");
  // Anything else is not a deletion flag — "0", "", "no" must not condemn.
  assert.equal(classifySighting({ availability: "in-stock", is_deleted: "0" }), "alive");
  assert.equal(classifySighting({ availability: "in-stock", is_deleted: "" }), "alive");
});

test("one strike is pending, never dead", () => {
  const v = strikeVerdict({ gone: true, prevN: 0, sameSnapshot: false });
  assert.equal(v.n, 1);
  assert.equal(v.verdict, "pending");
});

test("two strikes across different snapshots confirm dead", () => {
  const v = strikeVerdict({ gone: true, prevN: 1, sameSnapshot: false });
  assert.equal(v.n, 2);
  assert.equal(v.verdict, "dead");
});

test("a second read of the SAME feed snapshot cannot advance a strike", () => {
  const v = strikeVerdict({ gone: true, prevN: 1, sameSnapshot: true });
  assert.equal(v.n, 1, "strike must be held at one against an identical feed");
  assert.equal(v.verdict, "pending");
  // And a first-ever sighting on a repeat snapshot still only earns one strike.
  assert.equal(strikeVerdict({ gone: true, prevN: 0, sameSnapshot: true }).n, 1);
});

test("a sku that is present earns no strike at all", () => {
  assert.deepEqual(strikeVerdict({ gone: false, prevN: 1 }), { n: 0, verdict: null });
});

test("only full product catalogs are accepted as absence evidence", () => {
  assert.ok(FULL_CATALOG_RE.test("44583_4681679_mp.txt.gz"));
  assert.ok(FULL_CATALOG_RE.test("44583_4681679_mp_MKPL.txt.gz"));
  // A delta feed carries CHANGES; absence from one means nothing. Feeding
  // deltas to an absence test would condemn the whole catalog on run one.
  assert.equal(FULL_CATALOG_RE.test("44583_4681679_mp_delta.txt.gz"), false);
  assert.equal(FULL_CATALOG_RE.test("44583_4681679_mp_delta_MKPL.txt.gz"), false);
  assert.equal(FULL_CATALOG_RE.test("44583_4681679_mp_template.txt.gz"), false);
});
