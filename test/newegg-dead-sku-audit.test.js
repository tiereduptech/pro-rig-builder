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

const { classifySighting, strikeVerdict, priorStreakIsBlind, describeSuppression, describeRestoredFeeds, FULL_CATALOG_RE, DISCOVERY_IGNORE, partitionFeedsByFreshness, preflight } = audit;

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

// ── Incomplete coverage ──────────────────────────────────────────────────
// Run 32067140458 excluded the MKPL feed (mtime 2023-03-16, 1251 days old) and
// left 443 skus pending. 72 of those sit in the open-box and marketplace lanes,
// where MKPL is the plausible carrier. A sku that lives only in MKPL is absent
// from mp for a reason that has nothing to do with being dead, and on the next
// run it would have taken strike two on a file nobody opened.
//
// A SKIPPED feed and a FAILED feed are the same epistemic state. The census
// already refuses to condemn on a failed feed; these tests hold it to the same
// rule for an excluded one. The exclusion is deliberately NOT scoped to a
// guessed subset of skus — provenance is unknowable without reading the feed,
// so the rule is all-or-nothing.

test("an excluded feed blocks a death verdict outright", () => {
  const v = strikeVerdict({ gone: true, prevN: 1, sameSnapshot: false, coverageComplete: false });
  assert.equal(v.verdict, "pending",
    "an MKPL-only sku must not be condemned on a feed the census never read");
});

test("a blind run does not advance the strike either", () => {
  const v = strikeVerdict({ gone: true, prevN: 1, sameSnapshot: false, coverageComplete: false });
  assert.equal(v.n, 1,
    "letting n climb while blind only defers the false death to the first complete run");
  // Ten blind runs must leave the sku exactly where one did.
  let n = 0;
  for (let i = 0; i < 10; i++) n = strikeVerdict({ gone: true, prevN: n, coverageComplete: false }).n;
  assert.equal(n, 1, "no number of incomplete runs may add up to a death");
});

test("a confirmed death is withheld while coverage is incomplete, not forgotten", () => {
  const v = strikeVerdict({ gone: true, prevN: 2, sameSnapshot: false, coverageComplete: false });
  assert.equal(v.verdict, "pending", "no dead verdict may be issued while a feed is unread");
  assert.equal(v.n, 2, "the strike survives in state so it re-asserts when coverage returns");
  // Coverage returns; the same sku is dead again with no extra run required.
  assert.equal(strikeVerdict({ gone: true, prevN: v.n, sameSnapshot: true, coverageComplete: true }).verdict, "dead");
});

test("complete coverage is the default, so an unaware caller cannot silently condemn", () => {
  assert.equal(strikeVerdict({ gone: true, prevN: 1 }).verdict, "dead");
});

// ── Carrying strikes across a coverage change ────────────────────────────
// Holding the strike during a blind run is only half the fix. Run 32067140458
// ran BEFORE that rule existed and wrote 430 skus at n=1, every one of them
// earned with MKPL unread. Carried forward naively, the first complete census
// would find them at n=1, add a legitimate strike, and condemn all 430 on one
// blind observation plus one real one. A strike is a record of an observation;
// these were not observations.

test("strikes from a run that excluded a feed are not carried forward", () => {
  assert.equal(priorStreakIsBlind({ coverageComplete: false, streak: { A: { n: 1 } } }), true);
});

test("a pre-flag state file is judged by whether it recorded an exclusion", () => {
  // Exactly the shape run 32067140458 wrote: no coverageComplete key, MKPL excluded.
  assert.equal(priorStreakIsBlind({
    excludedFeeds: [{ name: "44583_4681679_mp_MKPL.txt.gz", ageDays: 1251 }],
    streak: { A: { n: 1 } },
  }), true, "the 430 strikes from the first census must not survive into a death");
  // A pre-flag run that read everything is still trustworthy.
  assert.equal(priorStreakIsBlind({ excludedFeeds: [], streak: { A: { n: 1 } } }), false);
});

test("strikes from a complete census survive", () => {
  assert.equal(priorStreakIsBlind({ coverageComplete: true, excludedFeeds: [], streak: { A: { n: 1 } } }), false);
  // An explicit true is trusted even if an exclusion was recorded for reporting.
  assert.equal(priorStreakIsBlind({ coverageComplete: true, excludedFeeds: [{ name: "x" }] }), false);
});

test("an absent or empty prior state is not treated as blind", () => {
  assert.equal(priorStreakIsBlind(), false);
  assert.equal(priorStreakIsBlind({}), false);
});

test("the two withholding rules compose — neither can be traded off against the other", () => {
  const both = strikeVerdict({ gone: true, prevN: 1, sameSnapshot: true, coverageComplete: false });
  assert.equal(both.n, 1);
  assert.equal(both.verdict, "pending");
  // A fresh snapshot does not buy back a missing feed...
  assert.equal(strikeVerdict({ gone: true, prevN: 1, sameSnapshot: false, coverageComplete: false }).verdict, "pending");
  // ...and complete coverage does not buy back a repeated snapshot.
  assert.equal(strikeVerdict({ gone: true, prevN: 1, sameSnapshot: true, coverageComplete: true }).verdict, "pending");
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

// ── Ignored is not the same as excluded ──────────────────────────────────
// An EXCLUDED feed is coverage nobody read, so it withholds every death
// verdict. An IGNORED feed was read in full and found to carry none of the
// rows in question, so it withholds nothing. Collapsing the two is how the
// census spent its time refusing to condemn 443 deals on the authority of a
// file that contained none of them.
const ignored = (name) => DISCOVERY_IGNORE.some((r) => r.re.test(name));

test("MKPL is dropped at discovery, so it can never become withheld coverage", () => {
  assert.ok(ignored("44583_4681679_mp_MKPL.txt.gz"),
    "run 32073301866 measured MKPL empty of catalog pendings — it is not coverage");
  // The main feed and other merchants' feeds must be untouched by this.
  assert.equal(ignored("44583_4681679_mp.txt.gz"), false);
  assert.equal(ignored("12345_4681679_mp.txt.gz"), false);
});

test("dropping MKPL does not loosen the freshness gate for anything else", () => {
  // The gate that suppresses on unread coverage stays exactly as strict; a
  // stale non-MKPL feed must still be excluded and still withhold verdicts.
  const parted = partitionFeedsByFreshness(
    [feed("44583_4681679_mp.txt.gz", "2026-08-17T09:27:55Z", "mp"),
     feed("44583_4681679_mp_OTHER.txt.gz", "2023-03-16T01:05:38Z", "OTHER")],
    { now: RUN_AT });
  assert.deepEqual(parted.stale.map((f) => f.kind), ["OTHER"],
    "a stale feed that was never measured must still suppress");
  assert.equal(strikeVerdict({ gone: true, prevN: 1, coverageComplete: false }).verdict, "pending");
});

// ── The suppression must announce itself ─────────────────────────────────
// bestbuy-dead-sku-audit stayed frozen for 95 days with its guard working
// perfectly and nobody reading it. A guard that reports once and then goes
// quiet is indistinguishable from one that is not needed. These tests hold the
// census to re-asserting the excluded feed's age on every run, with a
// consecutive-run count that grows so the drift is a number, not a memory.

const MKPL = {
  name: "44583_4681679_mp_MKPL.txt.gz",
  kind: "MKPL",
  mtime: Date.parse("2023-03-16T01:05:38Z"),
};
const RUN_AT = Date.parse("2026-08-17T20:46:15Z");   // run 32067140458

test("an excluded feed is reported with its age and the suppression it causes", () => {
  const s = describeSuppression([MKPL], { now: RUN_AT });
  assert.equal(s.maxAgeDays, 1251);
  assert.equal(s.headlines.length, 1);
  assert.match(s.headlines[0], /^MKPL last regenerated 1251 days ago \(2023-03-16\), deaths suppressed\.$/);
});

test("the consecutive-run count climbs so a long freeze cannot look like steady state", () => {
  assert.equal(describeSuppression([MKPL], { now: RUN_AT, priorRuns: 0 }).runs, 1);
  assert.equal(describeSuppression([MKPL], { now: RUN_AT, priorRuns: 94 }).runs, 95);
});

test("the age is recomputed every run, not carried from prior state", () => {
  const day1 = describeSuppression([MKPL], { now: RUN_AT });
  const day2 = describeSuppression([MKPL], { now: RUN_AT + 86400000 });
  assert.equal(day2.maxAgeDays, day1.maxAgeDays + 1,
    "the feed getting staler must show up as a bigger number without anyone updating a constant");
});

test("complete coverage produces no banner at all", () => {
  assert.equal(describeSuppression([], { now: RUN_AT }), null);
  assert.equal(describeSuppression(undefined, { now: RUN_AT }), null);
});

test("several excluded feeds are all named, oldest first", () => {
  const newer = { name: "b.txt.gz", kind: "OTHER", mtime: Date.parse("2026-01-01T00:00:00Z") };
  const s = describeSuppression([newer, MKPL], { now: RUN_AT });
  assert.deepEqual(s.feeds.map((f) => f.kind), ["MKPL", "OTHER"]);
  assert.equal(s.headlines.length, 2);
});

test("a feed that was excluded last run and is fresh now is called out", () => {
  const restored = describeRestoredFeeds(
    [{ name: "44583_4681679_mp.txt.gz" }, { name: MKPL.name }],
    [{ name: MKPL.name }],
  );
  assert.deepEqual(restored, [MKPL.name], "coverage returning is the event that un-suppresses deaths");
});

test("nothing is 'restored' when it was never excluded", () => {
  assert.deepEqual(describeRestoredFeeds([{ name: "44583_4681679_mp.txt.gz" }], []), []);
  assert.deepEqual(describeRestoredFeeds([{ name: "a" }], [{ name: "b" }]), []);
});
