// The rules that decide when the census runs, tested without an SFTP endpoint.
//
// WHY THIS TEST EXISTS
// The watcher is the only thing that will ever start a Newegg census again, so
// its two failure modes are both silent:
//   - fires on a snapshot the census already read -> a 10-minute run that
//     abstains, every 30 minutes, forever. Noise that trains people to ignore it.
//   - never fires, or never complains -> the bestbuy-dead-sku-audit outcome:
//     95 days of a working guard nobody looked at.
// Neither shows up as a crash. They only show up here.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const watch = require("../newegg-feed-watch.cjs");
const audit = require("../newegg-dead-sku-audit.cjs");

const { snapshotIdOf, decideWatch, describeAlarm, preflight } = watch;

const DAY = 86400000;
const NOW = Date.parse("2026-08-18T00:00:00.000Z");
const feed = (over = {}) => ({ name: "44583_4681679_mp.txt.gz", kind: "mp", size: 157027503, mtime: NOW - DAY, ...over });

// ── The contract with the census ─────────────────────────────────────────
// If these two ever compute different ids, every other test here is testing
// the wrong thing.

test("the watcher can still reach the census's discovery functions", () => {
  assert.deepEqual(preflight().length, 3);
  assert.equal(typeof audit.discoverFeeds, "function",
    "the census must keep exporting discoverFeeds — the watcher shares it rather than copying it");
});

test("snapshotIdOf reproduces the census's id format exactly", () => {
  // Mirrors newegg-dead-sku-audit.cjs:
  //   feedStats.filter(ok).map(f => `${f.name}@${f.mtime}:${f.size}`).sort().join('|')
  const f = feed({ mtime: 1786997275000 });
  assert.equal(snapshotIdOf([f]), "44583_4681679_mp.txt.gz@1786997275000:157027503");
  assert.equal(snapshotIdOf([f]), [f].map((x) => `${x.name}@${x.mtime}:${x.size}`).sort().join("|"),
    "any divergence here fires the census on snapshots it will call identical");
});

test("the id is order-independent, because discovery order is not stable", () => {
  const a = feed({ name: "a_mp.txt.gz" });
  const b = feed({ name: "b_mp.txt.gz" });
  assert.equal(snapshotIdOf([a, b]), snapshotIdOf([b, a]));
});

test("size alone moves the id — a republish at the same mtime is still new", () => {
  assert.notEqual(snapshotIdOf([feed()]), snapshotIdOf([feed({ size: 157027504 })]));
});

// ── The fire rule ────────────────────────────────────────────────────────

test("a moved snapshot dispatches", () => {
  const fresh = [feed({ mtime: NOW - DAY })];
  const d = decideWatch({ snapshotId: snapshotIdOf(fresh), fresh, now: NOW,
    prev: { snapshotId: "old@1:1", lastDispatchedId: "old@1:1" } });
  assert.equal(d.action, "dispatch");
  assert.equal(d.moved, true);
});

test("the same snapshot cannot fire twice, however often it is seen", () => {
  const fresh = [feed()];
  const id = snapshotIdOf(fresh);
  let prev = { snapshotId: id, lastDispatchedId: id };
  for (let i = 0; i < 48; i++) {                     // a full day of 30-minute ticks
    const d = decideWatch({ snapshotId: id, fresh, now: NOW + i * 1800000, prev });
    assert.equal(d.action, "hold", `tick ${i} re-fired on a snapshot the census already read`);
    prev = d.state;
  }
});

test("a dispatch that never submitted is retried on the next tick", () => {
  // lastDispatchedId is written by the script only after the dispatch lands.
  // If it were written on intent, a failed `gh workflow run` would block its own
  // retry until the next publish — a day of silence caused by a transient error.
  const fresh = [feed()];
  const id = snapshotIdOf(fresh);
  const d = decideWatch({ snapshotId: id, fresh, now: NOW, prev: { snapshotId: id, lastDispatchedId: null } });
  assert.equal(d.action, "dispatch");
});

test("state carries the dispatched id forward only when told to", () => {
  const fresh = [feed()];
  const d = decideWatch({ snapshotId: snapshotIdOf(fresh), fresh, now: NOW, prev: {} });
  assert.equal(d.state.lastDispatchedId, null,
    "decideWatch must not record a dispatch it did not perform");
});

test("a first run with no state at all still fires", () => {
  const fresh = [feed()];
  const d = decideWatch({ snapshotId: snapshotIdOf(fresh), fresh, now: NOW, prev: {} });
  assert.equal(d.action, "dispatch");
});

// ── The quiet alarm ──────────────────────────────────────────────────────

test("a feed that published today is quiet in the good sense", () => {
  const fresh = [feed({ mtime: NOW - DAY })];
  const d = decideWatch({ snapshotId: snapshotIdOf(fresh), fresh, now: NOW, prev: {} });
  assert.equal(d.alarm, null);
  assert.equal(describeAlarm(d.alarm, d.consecutiveQuietRuns), null);
});

test("past the quiet threshold it alarms, and names the number of days", () => {
  const fresh = [feed({ mtime: NOW - 5 * DAY })];
  const d = decideWatch({ snapshotId: snapshotIdOf(fresh), fresh, now: NOW, prev: {}, quietAlarmDays: 3 });
  assert.equal(d.alarm.level, "quiet");
  const text = describeAlarm(d.alarm, d.consecutiveQuietRuns, 3);
  assert.match(text, /5\.0 DAYS/);
  assert.match(text, /443 pending/, "the alarm must say what the silence is costing");
});

test("past the census ceiling the alarm escalates — deaths are now suppressed", () => {
  const fresh = [feed({ mtime: NOW - 20 * DAY })];
  const d = decideWatch({ snapshotId: snapshotIdOf(fresh), fresh, now: NOW, prev: {},
    quietAlarmDays: 3, censusCeilingDays: 14 });
  assert.equal(d.alarm.level, "suppressing");
  assert.match(describeAlarm(d.alarm, 0, 3, 14), /EXCLUDES it/);
});

test("staleness is measured from the feed's mtime, not from when we noticed it", () => {
  // A watcher that measured its own memory would call a three-year-old feed
  // fresh the moment its state artifact expired. Newegg's timestamp is the fact.
  const fresh = [feed({ mtime: NOW - 400 * DAY })];
  const d = decideWatch({ snapshotId: snapshotIdOf(fresh), fresh, now: NOW, prev: {} });
  assert.ok(d.quietDays > 399, "an empty prior state must not reset the clock");
  assert.equal(d.alarm.level, "suppressing");
});

test("the unchanged-run count climbs, so a long freeze cannot read as steady state", () => {
  const fresh = [feed({ mtime: NOW - 9 * DAY })];
  const id = snapshotIdOf(fresh);
  let prev = { snapshotId: id, lastDispatchedId: id };
  let d;
  for (let i = 0; i < 5; i++) { d = decideWatch({ snapshotId: id, fresh, now: NOW, prev }); prev = d.state; }
  assert.equal(d.consecutiveQuietRuns, 5);
  assert.match(describeAlarm(d.alarm, d.consecutiveQuietRuns), /across 5 consecutive checks/);
});

test("a publish resets the count", () => {
  const fresh = [feed()];
  const d = decideWatch({ snapshotId: snapshotIdOf(fresh), fresh, now: NOW,
    prev: { snapshotId: "old@1:1", lastDispatchedId: "old@1:1", consecutiveQuietRuns: 11 } });
  assert.equal(d.consecutiveQuietRuns, 0);
});

// ── No fresh feed at all ─────────────────────────────────────────────────

test("when every feed is over the ceiling the watcher alarms instead of dispatching", () => {
  // The census refuses to run with no current feed. Dispatching would produce a
  // red run that blames the census for a Newegg outage; the watcher names the
  // real cause instead.
  const stale = [feed({ mtime: NOW - 900 * DAY })];
  const d = decideWatch({ snapshotId: "", fresh: [], stale, now: NOW, prev: {} });
  assert.equal(d.action, "hold");
  assert.equal(d.alarm.level, "no-coverage");
  assert.match(describeAlarm(d.alarm, d.consecutiveQuietRuns), /suppressed indefinitely/);
});

test("an endpoint with no full-catalog feed at all is an alarm, never a dispatch", () => {
  const d = decideWatch({ snapshotId: "", fresh: [], stale: [], now: NOW, prev: {} });
  assert.equal(d.action, "hold");
  assert.equal(d.alarm.level, "no-coverage");
});

test("MKPL cannot resurrect itself into the snapshot id", () => {
  // discoverFeeds drops it via DISCOVERY_IGNORE, so it never reaches the
  // watcher's fresh list. If it ever did, its 2023 mtime would pin the id and
  // the watcher would go permanently silent through every real mp publish.
  const ignored = audit.DISCOVERY_IGNORE.some((r) => r.re.test("44583_4681679_mp_MKPL.txt.gz"));
  assert.ok(ignored, "MKPL must stay ignored at discovery for the watcher to work");
});

// ── The two rules do not trade off ───────────────────────────────────────

test("a quiet feed still dispatches if the census has never read it", () => {
  // These are independent questions: 'has it moved' and 'is it publishing'.
  // Letting the alarm swallow the dispatch would mean a feed that went quiet
  // for a week never gets censused even once.
  const fresh = [feed({ mtime: NOW - 6 * DAY })];
  const d = decideWatch({ snapshotId: snapshotIdOf(fresh), fresh, now: NOW, prev: {}, quietAlarmDays: 3 });
  assert.equal(d.action, "dispatch");
  assert.equal(d.alarm.level, "quiet");
});

// ── The exit-code contract ───────────────────────────────────────────────
// decideWatch keeps 'has it moved' and 'is it publishing' independent. That
// independence is worth nothing if it collapses when the script hands its
// answer to the workflow through a single integer.

test("dispatch and alarm each get their own code, and both together get a third", () => {
  const { exitCodeFor } = watch;
  assert.equal(exitCodeFor({ action: "hold", alarm: null }), 0);
  assert.equal(exitCodeFor({ action: "dispatch", alarm: null }), 10);
  assert.equal(exitCodeFor({ action: "hold", alarm: { level: "quiet" } }), 11);
  assert.equal(exitCodeFor({ action: "dispatch", alarm: { level: "quiet" } }), 12);
});

test("an alarm never suppresses a dispatch", () => {
  // The regression this exists for: the first version returned 1 whenever the
  // alarm fired, so the workflow saw a failed step, skipped the dispatch, and
  // the watcher stopped starting censuses the moment it began complaining that
  // no census could reach a verdict.
  const { exitCodeFor } = watch;
  for (const level of ["quiet", "suppressing", "no-coverage"]) {
    const code = exitCodeFor({ action: "dispatch", alarm: { level } });
    assert.ok(code === 10 || code === 12, `a ${level} alarm must not collapse a dispatch into a plain failure`);
    assert.notEqual(code, 1, "1 is reserved for the watcher itself being broken");
  }
});

test("no-coverage never dispatches, so it can only ever be code 11", () => {
  // The census refuses to run with no current feed; firing it would blame the
  // census for a Newegg outage.
  const { exitCodeFor } = watch;
  const d = decideWatch({ snapshotId: "", fresh: [], stale: [{ ...{ name: "x", kind: "mp", size: 1 }, mtime: NOW - 900 * DAY }], now: NOW, prev: {} });
  assert.equal(exitCodeFor(d), 11);
});

test("--dry-run suppresses the exit code, not just the bookkeeping", () => {
  // Suppressing only the state write would leave the code saying 'dispatch',
  // the workflow would start a 10-minute census, and the one switch whose whole
  // job is 'decide but do not act' would act.
  const { exitCodeFor } = watch;
  assert.equal(exitCodeFor({ action: "dispatch", alarm: null, dryRun: true }), 0);
  assert.equal(exitCodeFor({ action: "dispatch", alarm: { level: "quiet" }, dryRun: true }), 11,
    "a dry run still reports the alarm — only the dispatch is withheld");
});
