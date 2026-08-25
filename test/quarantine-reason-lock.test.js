// =============================================================================
//  test/quarantine-reason-lock.test.js
//
//  Assert that every site which quarantines a row also records WHY.
//
//  Why this exists: quarantining wrote only `needsReview = true` and
//  `quarantinedAt`. The cause lived solely in the run report — a CI artifact with
//  90-day retention — never on the row. Measured on the 2026-08-25 tier-1 run,
//  66% of no_new_offer rows and 77% of the healthy-but-quarantined rows carried
//  no recorded cause at all.
//
//  That is not cosmetic. A quarantine with no recorded cause cannot be safely
//  lifted by anything: a good price does not resolve a wrong-ASIN hold or a
//  manual flag, and with no cause stored you cannot tell which you are looking
//  at. It is the direct mechanism behind 385 rows that price fine today and are
//  still hidden from the site.
//
//  Nine writers across five files funnelled into the same undifferentiated
//  boolean. A rule enforced by convention rots the moment someone adds the
//  tenth, so this is a source scan, in the same shape as
//  verify-main-writer-lock.cjs — and for the same reason.
//
//  Output is a TALLY, not a boolean. A gate that only says FAIL cannot be
//  sanity-checked.
// =============================================================================

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

// Files that may quarantine a row. Adding a quarantine elsewhere should ALSO fail
// the repo-wide scan below, which is what stops this list from going stale.
const WRITER_FILES = [
  'drift-gate.js',
  'verify-catalog-asins.js',
  'verify-new-products.js',
  'bestbuy-merge.js',
];

// A line that SETS needsReview truthy. Excludes reads (`!p.needsReview`), deletes
// (`delete p.needsReview`) and prose — the first draft of the repo-wide scan below
// flagged normalize-product-name.js and repair-broken-asins.js, and both were
// false positives: one only mentions the field in comments, the other reads and
// DELETES it. Allowlisting them would have silently accepted a real writer added
// to those files later, so the detector is precise instead.
const SETS_QUARANTINE = /needsReview\s*[=:]\s*true/;
const RECORDS_REASON = /quarantineReason/;
const IS_COMMENT = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

/** Lines that set needsReview, with a small window of following context. */
function quarantineSites(src) {
  const lines = src.split('\n');
  const sites = [];
  for (let i = 0; i < lines.length; i++) {
    if (IS_COMMENT(lines[i]) || !SETS_QUARANTINE.test(lines[i])) continue;
    // The reason may be on the same line (object literal) or within the next few
    // statements (sequential assignment). Six lines covers both shapes here.
    const window = lines.slice(i, i + 6).join('\n');
    sites.push({ line: i + 1, text: lines[i].trim(), hasReason: RECORDS_REASON.test(window) });
  }
  return sites;
}

test('every quarantine writer records a cause', () => {
  const tally = [];
  let total = 0;
  let missing = 0;

  for (const file of WRITER_FILES) {
    const sites = quarantineSites(readFileSync(file, 'utf8'));
    for (const s of sites) {
      total++;
      if (!s.hasReason) missing++;
      tally.push(`  ${s.hasReason ? 'ok  ' : 'MISS'}  ${file}:${s.line}  ${s.text.slice(0, 62)}`);
    }
  }

  console.log(`\nquarantine writers: ${total}, recording a cause: ${total - missing}, missing: ${missing}`);
  tally.forEach((l) => console.log(l));

  assert.ok(total >= 9, `expected at least 9 quarantine sites, found ${total} — did a file get renamed?`);
  assert.equal(missing, 0, `${missing} quarantine site(s) set needsReview without recording quarantineReason`);
});

test('no quarantine writer hides outside the known files', () => {
  // WRITER_FILES can go stale. This catches a quarantine added somewhere new, using
  // the SAME comment-aware detector as above so prose and deletes do not trip it.
  const ALLOW = new Set([...WRITER_FILES,
    // patch-* are one-shot migration scripts, not live writers.
    'patch-verifier-strategy2.js',
    'patch-frontend-quarantine-filter.js',
  ]);
  const candidates = execSync(
    "grep -rl 'needsReview' --include='*.js' . " +
    "--exclude-dir=node_modules --exclude-dir=.git --exclude-dir=test --exclude-dir=dist || true",
    { encoding: 'utf8' },
  ).split('\n').map((f) => f.replace(/^\.\//, '')).filter(Boolean);

  const writers = candidates.filter((f) => quarantineSites(readFileSync(f, 'utf8')).length > 0);
  const unexpected = writers.filter((f) => !ALLOW.has(f));
  console.log(`\nfiles mentioning needsReview: ${candidates.length}, of which actually quarantine: ${writers.length}`);
  assert.deepEqual(unexpected, [],
    `quarantine written in unlisted file(s) — add to WRITER_FILES and record a reason: ${unexpected.join(', ')}`);
});

test('every lifter clears the reason along with the flag', () => {
  // A stale quarantineReason on an un-quarantined row is worse than none: it reads
  // as a live hold to anything inspecting the row later, which is exactly the
  // confusion this field exists to remove.
  const LIFTERS = ['repair-broken-asins.js'];
  for (const file of LIFTERS) {
    const src = readFileSync(file, 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (IS_COMMENT(lines[i]) || !/delete\s+[\w.[\]]*\.needsReview/.test(lines[i])) continue;
      const window = lines.slice(Math.max(0, i - 2), i + 4).join('\n');
      assert.match(window, /delete\s+[\w.[\]]*\.quarantinedAt/,
        `${file}:${i + 1} clears needsReview without clearing quarantinedAt`);
      assert.match(window, /delete\s+[\w.[\]]*\.quarantineReason/,
        `${file}:${i + 1} clears needsReview without clearing quarantineReason`);
    }
  }
});
