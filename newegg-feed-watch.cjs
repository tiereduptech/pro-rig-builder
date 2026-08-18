#!/usr/bin/env node
/**
 * newegg-feed-watch.cjs — does the Newegg mp feed have a NEW snapshot? Stat only.
 *
 * WHY THIS EXISTS
 * The census refuses to advance a strike against a byte-identical feed, which is
 * correct and which means a death verdict is gated on Newegg publishing a new
 * snapshot. Run 32078178352 proved the mechanism works and produced nothing: it
 * spent 556s downloading the same 150MB file run 32067140458 had already read,
 * then abstained. The missing piece was never the census — it was knowing WHEN
 * to run it, and the answer was "a human remembers to check".
 *
 * That is the bestbuy-dead-sku-audit failure verbatim. It sat frozen for 95 days
 * with its suppression mechanism working perfectly the whole time, because the
 * signal was passive and nobody looked. A feed that stops publishing is the same
 * class of failure as MKPL: not a crash, an absence. Absences have to be
 * announced or they are discovered late, by accident, in an audit.
 *
 * SO THIS IS A CHEAP POLL WITH A LOUD MOUTH
 *   - It stats. `sftp.list()` over three directories, no get(), no download.
 *     Seconds and a few KB against the census's ~10 minutes and 150MB.
 *   - It fires the census only when the snapshot id MOVES, and records what it
 *     fired for, so the same snapshot cannot trigger twice.
 *   - It goes RED when the feed stops moving, because a quiet alarm is a muted
 *     alarm (epik-watchdog.yml makes the same argument at more length).
 *
 * THE SNAPSHOT ID IS THE CENSUS'S, NOT A SECOND OPINION
 * `snapshotIdOf()` reproduces newegg-dead-sku-audit.cjs's id byte for byte, from
 * the same discovery call on the same fields. If the two ever disagreed the
 * watcher would fire on snapshots the census then calls identical (churning
 * 10-minute runs that abstain) or, worse, sit still through a real publish. It
 * imports discoverFeeds and partitionFeedsByFreshness from the census rather
 * than reimplementing them, for the same reason the census imports streamTxtFeed
 * from the ingest instead of copying it.
 *
 * Read-only by construction: one SFTP list, one state file under catalog-build/.
 *
 * Run (Actions only — RAKUTEN_FTP_PASSWORD is a repo secret):
 *   node newegg-feed-watch.cjs [--prev <state.json>] [--seed-from <census-state.json>]
 *                              [--quiet-alarm-days N] [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const SftpClient = require('ssh2-sftp-client');
const audit = require('./newegg-dead-sku-audit.cjs');
const { discoverFeeds, partitionFeedsByFreshness, feedAgeDays } = audit;

const ROOT = __dirname;
const STATE_OUT = path.join(ROOT, 'catalog-build', 'newegg-feed-watch-state.json');

const FTP_HOST = process.env.RAKUTEN_FTP_HOST || 'aftp.linksynergy.com';
const FTP_USER = process.env.RAKUTEN_FTP_USER || 'rkp_4681679';
const FTP_PASS = process.env.RAKUTEN_FTP_PASSWORD;

const argv = process.argv.slice(2);
const argOf = (flag) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : null; };
const PREV_PATH = argOf('--prev');
const SEED_PATH = argOf('--seed-from');
const DRY_RUN = argv.includes('--dry-run');

// The census excludes a feed over 14 days old, so at 14 days the alarm is
// already too late to be news — that is the point where deaths get suppressed,
// not the point where something went wrong. The mp feed regenerates DAILY
// (measured: mtime moved 2026-08-16 -> 2026-08-17 across runs 32057560889 and
// 32067140458). Three missed days is not a holiday gap, it is a story.
const QUIET_ALARM_DAYS = Number(argOf('--quiet-alarm-days') || process.env.NEWEGG_FEED_QUIET_DAYS || 3);
// Kept in step with the census's own ceiling; crossing it is a second, worse
// alarm because from here the census cannot condemn anything at all.
const CENSUS_CEILING_DAYS = Number(argOf('--census-ceiling-days') || process.env.NEWEGG_FEED_MAX_AGE_DAYS || 14);

const log = (m) => console.log(`[${new Date().toISOString().substring(11, 19)}] ${m}`);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/**
 * The census's snapshot id, reproduced exactly.
 *
 * newegg-dead-sku-audit.cjs builds it as:
 *   feedStats.filter(f => f.ok).map(f => `${f.name}@${f.mtime}:${f.size}`).sort().join('|')
 * where feedStats spreads the DISCOVERED entry (SFTP name/mtime/size, not the
 * downloaded file's local stat), and only feeds that passed the freshness gate
 * are ever downloaded. So discovery + the same freshness gate is enough to
 * predict it without pulling a byte.
 *
 * `.ok` is the one thing a stat cannot know — it means the feed later streamed
 * to completion. A feed that fails mid-stream drops out of the census's id and
 * the two diverge; that run also exits 1 with UNKNOWNs and is not a basis for
 * anything, and the NEXT publish moves the id for both of us. Predicting a
 * clean stream is the right default: the failure case self-corrects, and the
 * alternative is never firing at all.
 */
function snapshotIdOf(feeds = []) {
  return feeds.map((f) => `${f.name}@${f.mtime}:${f.size}`).sort().join('|');
}

/**
 * The whole decision, as a pure function of (what the endpoint has, what we last
 * did about it, what time it is). No socket, no filesystem — so the rules below
 * are testable without an SFTP secret, which is the only reason they can be
 * trusted to be right the first time they matter.
 *
 * FIRE RULE: dispatch when the snapshot id differs from the one we last
 * DISPATCHED for — not from the one we last SAW. The difference matters twice:
 *   - a dispatch that failed to submit leaves lastDispatchedId behind, so the
 *     next tick retries instead of waiting a day for the next publish;
 *   - a snapshot seen many times between publishes still fires exactly once.
 *
 * QUIET RULE: staleness is measured from the FEED'S OWN mtime, never from when
 * this watcher first noticed it. State can be lost — an artifact expires, a
 * first run has none — and a watcher that measured its own memory would report
 * a three-year-old feed as fresh the moment it forgot. Newegg's timestamp is the
 * fact; our record of it is not.
 */
function decideWatch({ snapshotId, fresh = [], stale = [], prev = {}, now = Date.now(),
                       quietAlarmDays = QUIET_ALARM_DAYS, censusCeilingDays = CENSUS_CEILING_DAYS } = {}) {
  const all = [...fresh, ...stale];
  const newestMtime = all.length ? Math.max(...all.map((f) => new Date(f.mtime).getTime())) : null;
  const quietDays = newestMtime == null ? null : feedAgeDays(newestMtime, now);

  const moved = !!prev.snapshotId && prev.snapshotId !== snapshotId;
  const consecutiveQuietRuns = moved || !prev.snapshotId ? 0 : (prev.consecutiveQuietRuns || 0) + 1;

  const reasons = [];
  let action = 'hold';
  let alarm = null;

  if (!fresh.length) {
    // Every discovered feed is past the census's freshness ceiling. Dispatching
    // now would just make the census refuse to run ("refusing to run a census
    // with no current feed") — a red run that blames the census for a Newegg
    // problem. Alarm on the real cause instead.
    reasons.push(all.length
      ? `every discovered feed is over the ${censusCeilingDays}-day ceiling — the census cannot run at all`
      : 'no full-catalog feed found on the endpoint');
    alarm = { level: 'no-coverage', quietDays };
  } else if (snapshotId === prev.lastDispatchedId) {
    reasons.push('snapshot unchanged since the census was last dispatched for it — a re-read is not a second opinion');
  } else {
    action = 'dispatch';
    reasons.push(prev.lastDispatchedId
      ? 'snapshot moved off the one the census last read'
      : 'no record of a census dispatch for this snapshot');
  }

  // The alarm is independent of the fire decision: a feed can be quiet for a
  // week AND have never been censused. Report both, never let one mask the other.
  if (!alarm && quietDays != null && quietDays > censusCeilingDays) {
    alarm = { level: 'suppressing', quietDays };
  } else if (!alarm && quietDays != null && quietDays > quietAlarmDays) {
    alarm = { level: 'quiet', quietDays };
  }

  return {
    action, reasons, alarm, quietDays, consecutiveQuietRuns, moved,
    state: {
      updatedAt: new Date(now).toISOString(),
      snapshotId,
      newestFeedMtime: newestMtime == null ? null : new Date(newestMtime).toISOString(),
      quietDays: quietDays == null ? null : Number(quietDays.toFixed(3)),
      consecutiveQuietRuns,
      // Set by the caller once the dispatch actually lands. Writing it here
      // would record an intention as an event, and a dispatch that never
      // submitted would then block its own retry forever.
      lastDispatchedId: prev.lastDispatchedId || null,
      lastDispatchedAt: prev.lastDispatchedAt || null,
      feeds: fresh.map((f) => ({ name: f.name, kind: f.kind, size: f.size, mtime: f.mtime, ageDays: Number(feedAgeDays(f.mtime, now).toFixed(2)) })),
      staleFeeds: stale.map((f) => ({ name: f.name, kind: f.kind, ageDays: Number(feedAgeDays(f.mtime, now).toFixed(2)) })),
    },
  };
}

/**
 * What a quiet feed should say, in one line, loudly.
 *
 * Deliberately names the consecutive-run count: describeSuppression() in the
 * census makes the same argument — a guard that reports the same sentence every
 * run for a month reads as steady state, and a climbing number does not.
 */
function describeAlarm(alarm, consecutiveQuietRuns, quietAlarmDays = QUIET_ALARM_DAYS, censusCeilingDays = CENSUS_CEILING_DAYS) {
  if (!alarm) return null;
  const d = alarm.quietDays == null ? '?' : alarm.quietDays.toFixed(1);
  const seen = `Unchanged across ${consecutiveQuietRuns} consecutive checks.`;
  if (alarm.level === 'no-coverage') {
    return `NEWEGG FEED HAS NO CURRENT SNAPSHOT — newest is ${d} days old, past the ${censusCeilingDays}-day ceiling. ` +
      `The census cannot run, so every Newegg death verdict is suppressed indefinitely. ${seen} ` +
      `This is the MKPL failure shape: not an error, an absence. Check the Rakuten endpoint before assuming the catalog is healthy.`;
  }
  if (alarm.level === 'suppressing') {
    return `NEWEGG FEED STOPPED PUBLISHING ${d} DAYS AGO — past the ${censusCeilingDays}-day ceiling, so the census now EXCLUDES it ` +
      `and withholds every death verdict. ${seen} Dead Newegg links are accumulating unmeasured.`;
  }
  return `NEWEGG FEED HAS NOT MOVED IN ${d} DAYS (alarm at ${quietAlarmDays}). The mp feed regenerates daily, so this is ` +
    `already abnormal. ${seen} No census can advance a strike until it publishes — the 443 pending rows stay pending.`;
}

/**
 * Prove the imports before the socket. Trivially cheap here, and it exists
 * because the census learned it the expensive way: run 32057560889 spent 58
 * minutes and ~1.3GB discovering that streamTxtFeed had never been exported.
 * A watcher that cannot discover feeds must say so in milliseconds, not after
 * it has authenticated.
 */
function preflight() {
  const need = (name, val) => {
    if (typeof val !== 'function') {
      throw new Error(`preflight: ${name} is ${val === undefined ? 'missing' : typeof val} — expected a function. ` +
        `newegg-dead-sku-audit.cjs must keep exporting it, or the watcher and the census stop agreeing on what a snapshot is.`);
    }
    return name;
  };
  return [
    need('audit.discoverFeeds', discoverFeeds),
    need('audit.partitionFeedsByFreshness', partitionFeedsByFreshness),
    need('audit.feedAgeDays', feedAgeDays),
  ];
}

/**
 * Exit code as a pure function of the two INDEPENDENT outcomes.
 *
 * WHY THIS IS NOT `alarm ? 1 : dispatch ? 10 : 0`
 * That was the first version and it was broken in the one case that matters
 * most: a feed that has gone quiet AND has never been censused. It exited 1,
 * the workflow read "failure", and the dispatch step never ran — so the moment
 * the watcher started complaining it also stopped doing its job, and the 443
 * pending rows would have waited on a census that was never started. The alarm
 * would have looked like it was working the whole time. That is the
 * bestbuy-95-day shape wearing a red badge instead of a green one.
 *
 * decideWatch() keeps "has it moved" and "is it publishing" separate on
 * purpose. This keeps them separate across the process boundary too.
 *   0  hold,     quiet feed in the good sense
 *   10 DISPATCH, no alarm
 *   11 hold,     ALARM
 *   12 DISPATCH, ALARM        <- both, and the workflow must honour both
 *   1  the watcher itself failed (preflight, missing secret, fatal)
 */
function exitCodeFor({ action, alarm, dryRun = false } = {}) {
  // --dry-run has to suppress the CODE, not just the bookkeeping. Suppressing
  // only the state write would leave the exit code saying "dispatch", the
  // workflow would start a 10-minute census, and the one switch whose entire
  // job is "decide but do not act" would act. A dry run that fires the thing it
  // is dry-running is worse than not having the flag.
  const dispatching = action === 'dispatch' && !dryRun;
  if (dispatching && alarm) return 12;
  if (dispatching) return 10;
  if (alarm) return 11;
  return 0;
}

module.exports = { snapshotIdOf, decideWatch, describeAlarm, preflight, exitCodeFor };

if (require.main === module) (async () => {
  try {
    log(`Preflight OK — ${preflight().join(', ')}`);
  } catch (e) {
    console.error(`\n✗ PREFLIGHT FAILED: ${e.message}`);
    process.exit(1);
  }

  if (!FTP_PASS) {
    console.error('ERROR: RAKUTEN_FTP_PASSWORD required (repo secret; Actions only).');
    process.exit(1);
  }

  let prev = (PREV_PATH && readJson(PREV_PATH)) || {};
  if (!prev.snapshotId && SEED_PATH) {
    // First watcher run. The census has already read SOME snapshot; adopting it
    // as "already dispatched" stops the watcher opening with a 10-minute run
    // against a feed the census just abstained on (which is exactly what run
    // 32078178352 was). Seeding is not a shortcut past the fire rule — it is
    // telling the watcher a true fact it otherwise has no way to know.
    const seed = readJson(SEED_PATH);
    if (seed && seed.snapshotId) {
      prev = { snapshotId: seed.snapshotId, lastDispatchedId: seed.snapshotId, lastDispatchedAt: seed.updatedAt || null, seededFromCensus: true };
      log(`Seeded from the census's own state: ${seed.snapshotId}`);
    }
  }

  const sftp = new SftpClient();
  let discovered = [], ignored = [];
  try {
    await sftp.connect({ host: FTP_HOST, port: 22, username: FTP_USER, password: FTP_PASS });
    log(`Connected to ${FTP_HOST} as ${FTP_USER} — LIST ONLY, nothing is downloaded`);
    discovered = await discoverFeeds(sftp, ignored);
  } finally {
    try { await sftp.end(); } catch { /* the stat is done; the socket's manner of death is not news */ }
  }

  for (const f of ignored) log(`  ⊘  ignoring ${f.name} — ${f.why}`);
  for (const f of discovered) {
    log(`  found ${f.kind.padEnd(4)} ${f.name} (${(f.size / 1048576).toFixed(0)}MB, mtime ${new Date(f.mtime).toISOString()})`);
  }

  const { fresh, stale } = partitionFeedsByFreshness(discovered, { maxAgeDays: CENSUS_CEILING_DAYS });
  const snapshotId = snapshotIdOf(fresh);
  const d = decideWatch({ snapshotId, fresh, stale, prev });

  console.log(`\n  snapshot now  ${snapshotId || '(none)'}`);
  console.log(`  census read   ${prev.lastDispatchedId || '(never)'}`);
  console.log(`  newest feed   ${d.quietDays == null ? '—' : d.quietDays.toFixed(2)} days old`);
  console.log(`  decision      ${d.action.toUpperCase()}`);
  for (const r of d.reasons) console.log(`                · ${r}`);

  const alarmText = describeAlarm(d.alarm, d.consecutiveQuietRuns);

  // The dispatch is the workflow's job, not this script's: it holds the token
  // and `gh` is already there. Exit code 10 is the signal, chosen so it cannot
  // be confused with a crash (1) or a clean hold (0).
  const state = d.state;
  if (d.action === 'dispatch' && !DRY_RUN) {
    state.lastDispatchedId = snapshotId;
    state.lastDispatchedAt = new Date().toISOString();
  }
  fs.mkdirSync(path.dirname(STATE_OUT), { recursive: true });
  fs.writeFileSync(STATE_OUT, JSON.stringify(state, null, 2));
  log(`State -> ${path.relative(ROOT, STATE_OUT)}`);

  const code = exitCodeFor({ ...d, dryRun: DRY_RUN });
  if (process.env.GITHUB_OUTPUT) {
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `dispatch=${d.action === 'dispatch' ? 'true' : 'false'}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `alarm=${d.alarm ? 'true' : 'false'}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `snapshot_id=${snapshotId}\n`);
    fs.appendFileSync(process.env.GITHUB_OUTPUT, `code=${code}\n`);
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    const md = [`### Newegg feed watch`, '',
      `| | |`, `|---|---|`,
      `| decision | **${d.action}** |`,
      `| newest feed | ${d.quietDays == null ? '—' : d.quietDays.toFixed(2)} days old |`,
      `| unchanged for | ${d.consecutiveQuietRuns} consecutive checks |`,
      `| snapshot | \`${snapshotId || '(none)'}\` |`, ''];
    if (alarmText) md.push(`> **${alarmText}**`, '');
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md.join('\n') + '\n');
  }

  if (alarmText) {
    // The annotation is what a human reads. The RED RUN is what GitHub notifies
    // on, and it is raised by a later workflow step so that it lands AFTER the
    // dispatch rather than instead of it — bestbuy-dead-sku-audit had the
    // annotation without the notification for 95 days, and an alarm that
    // cancels the work it is warning about is worse than either.
    console.error(`\n::error::${alarmText}`);
    console.error(`\n✗ ${alarmText}`);
  }
  if (d.action === 'dispatch' && DRY_RUN) console.log('\n→ New snapshot. --dry-run: the census is NOT dispatched and no dispatch is recorded.');
  else if (d.action === 'dispatch') console.log('\n→ New snapshot. The census will be dispatched.');
  else console.log('\n✓ Nothing to do — the census has already read this snapshot.');
  process.exit(code);
})().catch((e) => { console.error('\n✗ FATAL:', e.stack || e.message); process.exit(1); });
