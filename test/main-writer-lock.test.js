// Proves the main-writer lock gate actually FIRES on each defect class, and that
// the real .github/workflows tree passes it. A green run here means "every
// workflow that can push main is serialized", not "gate broken".
//
// The gate's own first draft misclassified five workflows in BOTH directions
// (missed `if git push origin main` behind a shell prefix; invented a main-push
// for publish-epik out of a line-continued URL). Those two shapes are pinned
// below as regression tests.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const gate = require("./verify-main-writer-lock.cjs");

const LOCK = "concurrency:\n  group: main-writer\n  cancel-in-progress: false\n";

/** Write a throwaway workflow dir and audit it. */
function auditOf(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mwl-"));
  try {
    for (const [name, body] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), body);
    }
    return gate.audit(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const scheduled = (steps, lock = "") =>
  `name: W\non:\n  schedule:\n    - cron: "0 5 * * *"\n${lock}jobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n${steps}\n`;

const hasFailure = (a, sub) => a.failures.some((f) => f.includes(sub));

// ── the real tree ──────────────────────────────────────────────────────────
test("the live .github/workflows tree passes the gate", () => {
  const a = gate.audit(gate.WF_DIR);
  assert.deepEqual(a.failures, [], a.failures.join(" | "));
  assert.ok(a.mustLock.length >= 7, `expected >=7 main-capable writers, saw ${a.mustLock.length}`);
  assert.equal(a.unlocked.length, 0);
});

// ── classification: the two shapes the first draft got wrong ───────────────
test("a push behind a shell prefix (`if git push origin main; then`) counts as a main-write", () => {
  const a = auditOf({ "w.yml": scheduled('      - run: |\n          if git push origin main; then\n            echo ok\n          fi') });
  assert.equal(a.mustLock.length, 1, "shell-prefixed push must still be seen");
  assert.ok(hasFailure(a, "can push to main but is not in the main-writer group"));
});

test("a line-continued push to a non-main branch is NOT a main-write", () => {
  const run =
    '      - run: |\n' +
    '          git push --force -q \\\n' +
    '            "https://x-access-token:${{ github.token }}@github.com/${GITHUB_REPOSITORY}" "$BRANCH"\n' +
    '        env:\n' +
    '          BRANCH: epik-release\n';
  const a = auditOf({ "w.yml": scheduled(run) });
  assert.equal(a.mustLock.length, 0, "must not invent a main-push from the remote URL");
  assert.deepEqual(a.failures, []);
});

test("the token inside a `${{ }}` remote never becomes a refspec", () => {
  const run =
    '      - run: |\n' +
    '          git push -q \\\n' +
    '            "https://x:${{ secrets.T }}@github.com/o/r" \\\n' +
    '            HEAD:release\n';
  const a = auditOf({ "w.yml": scheduled(run) });
  const kinds = a.rows[0].pushes.map((p) => p.kind);
  assert.deepEqual(kinds, ["other"], `expected one 'other' push, saw ${JSON.stringify(a.rows[0].pushes)}`);
});

// ── the four defect classes the gate must catch ────────────────────────────
test("DEFECT a main-writer with no lock fails", () => {
  const a = auditOf({ "w.yml": scheduled("      - run: git push origin main") });
  assert.ok(hasFailure(a, "can push to main but is not in the main-writer group"));
});

test("DEFECT a bare `git push` on a default-branch checkout counts as a main-writer", () => {
  const a = auditOf({ "w.yml": scheduled("      - run: git push") });
  assert.equal(a.definite.length, 1);
  assert.ok(hasFailure(a, "can push to main"));
});

test("DEFECT cancel-in-progress:true on the lock fails", () => {
  const bad = "concurrency:\n  group: main-writer\n  cancel-in-progress: true\n";
  const a = auditOf({ "w.yml": scheduled("      - run: git push origin main", bad) });
  assert.ok(hasFailure(a, "cancel-in-progress:true"));
});

test("DEFECT a non-writer joining the group fails (it would block real writers)", () => {
  const a = auditOf({ "w.yml": scheduled("      - run: node audit.cjs", LOCK) });
  assert.ok(hasFailure(a, "pushes nothing to main"));
});

test("DEFECT unparseable YAML fails rather than being skipped", () => {
  const a = auditOf({ "w.yml": "name: [unclosed\n  bad: : :\n" });
  assert.ok(hasFailure(a, "YAML did not parse"));
});

// ── conservative handling of run-time-resolved refspecs ────────────────────
test("an unresolvable refspec must hold the lock, and passes once it does", () => {
  const step = "      - run: git push origin HEAD:${{ github.ref_name }}";
  const without = auditOf({ "w.yml": scheduled(step) });
  assert.equal(without.maybe.length, 1, "dispatchable variable refspec must be treated as main-capable");
  assert.ok(hasFailure(without, "can push to main"));

  const with_ = auditOf({ "w.yml": scheduled(step, LOCK) });
  assert.deepEqual(with_.failures, []);
});

test("a push-triggered workflow pinned to a feature branch is not a main-writer", () => {
  const wf =
    'name: W\non:\n  push:\n    branches: [feat/x]\njobs:\n  j:\n    runs-on: ubuntu-latest\n    steps:\n      - run: git push\n';
  const a = auditOf({ "w.yml": wf });
  assert.equal(a.mustLock.length, 0);
  assert.deepEqual(a.failures, []);
});

// ── the lock is only useful if the writers are actually all in one group ───
test("every main-capable writer shares one group name, not per-workflow groups", () => {
  const a = gate.audit(gate.WF_DIR);
  const groups = new Set(a.mustLock.map((r) => gate.GROUP));
  assert.equal(groups.size, 1);
  for (const r of a.mustLock) {
    assert.ok(r.groups.includes(gate.GROUP), `${r.file} groups: ${r.groups.join(", ")}`);
  }
});
