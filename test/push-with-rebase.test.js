/**
 * test/push-with-rebase.test.js
 *
 * Reproduces the race that destroyed run 32136198527 against real git repos: a
 * long-running job commits, someone merges to main in the meantime, and the
 * job's push is rejected. The fix must replay the commit rather than lose it.
 *
 * These build actual repositories in a temp dir — no mocks — because the thing
 * being tested IS git's behaviour, and a stubbed `git push` would prove nothing.
 */

import test from "node:test";
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SCRIPT = path.resolve("scripts/push-with-rebase.sh");

const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e",
      GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e",
    },
  });

/**
 * A bare "origin", plus a clone standing in for the runner's checkout.
 * `shallow` mirrors actions/checkout's default fetch-depth of 1.
 */
function scaffold({ shallow = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "push-rebase-"));
  const origin = path.join(root, "origin.git");
  const seed = path.join(root, "seed");
  const runner = path.join(root, "runner");

  git(root, "init", "--bare", "-b", "main", origin);
  git(root, "init", "-b", "main", seed);
  fs.writeFileSync(path.join(seed, "parts.js"), "v0\n");
  fs.writeFileSync(path.join(seed, "README.md"), "readme v0\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "seed");
  // A little history, so a depth-1 clone is genuinely shallow.
  for (const i of [1, 2, 3]) {
    fs.writeFileSync(path.join(seed, "README.md"), `readme v${i}\n`);
    git(seed, "commit", "-am", `readme ${i}`);
  }
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-u", "origin", "main");

  const cloneArgs = ["clone"];
  if (shallow) cloneArgs.push("--depth=1");
  cloneArgs.push(`file://${origin}`, runner);
  git(root, ...cloneArgs);

  // The identity the script's `git rebase` will commit under. The helper above
  // passes GIT_AUTHOR_*/GIT_COMMITTER_* into ITS OWN git calls, but the script
  // runs as a separate process against this repo, so it sees only what is
  // configured here. Without it these tests pass on any dev box with a global
  // git identity and fail on a bare CI runner with "empty ident name" — which
  // is a property of the machine, not of the code under test.
  //
  // Set it the same way the real callers do: sftp-ingest.yml,
  // refresh-bestbuy-prices.yml and relink-bestbuy-mismatches.yml all run
  // `git config user.name/user.email` on the checkout before invoking the
  // script, so configuring it on the repo is what production actually looks
  // like.
  git(runner, "config", "user.name", "github-actions[bot]");
  git(runner, "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");

  return { root, origin, seed, runner };
}

/** Someone merges a PR while the job is running. */
function concurrentMerge(seed, text = "readme merged\n") {
  fs.writeFileSync(path.join(seed, "README.md"), text);
  git(seed, "commit", "-am", "a PR merged mid-run");
  git(seed, "push", "origin", "main");
}

/** The ingest's own commit, on the runner's checkout. */
function ingestCommit(runner, body = "v1-ingested\n") {
  fs.writeFileSync(path.join(runner, "parts.js"), body);
  git(runner, "commit", "-am", "chore(sftp): newegg catalog ingest - 16935 updated");
}

function runScript(cwd, args = []) {
  try {
    const stdout = execFileSync("bash", [SCRIPT, ...args], {
      cwd,
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, PUSH_RETRY_SLEEP: "0" },
    });
    return { code: 0, out: stdout };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
}

test("the uncontended push still just works", () => {
  const { runner, origin } = scaffold();
  ingestCommit(runner);
  const r = runScript(runner);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /Pushed on attempt 1/);
  assert.strictEqual(git(origin, "show", "main:parts.js"), "v1-ingested\n");
});

test("a merge landing mid-run no longer destroys the commit", () => {
  const { runner, seed, origin } = scaffold();
  ingestCommit(runner);
  concurrentMerge(seed); // the exact shape of run 32136198527

  const r = runScript(runner);
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /rejected \(attempt 1\/5\)/);
  assert.match(r.out, /Pushed on attempt 2 — recovered/);

  // Both survive: the ingest's output AND the merge it raced.
  assert.strictEqual(git(origin, "show", "main:parts.js"), "v1-ingested\n");
  assert.strictEqual(git(origin, "show", "main:README.md"), "readme merged\n");
});

test("it recovers from a shallow checkout, which is what actions/checkout gives us", () => {
  const { runner, seed, origin } = scaffold({ shallow: true });
  assert.strictEqual(git(runner, "rev-parse", "--is-shallow-repository").trim(), "true");
  ingestCommit(runner);
  concurrentMerge(seed);

  const r = runScript(runner);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(git(origin, "show", "main:parts.js"), "v1-ingested\n");
  assert.strictEqual(git(origin, "show", "main:README.md"), "readme merged\n");
});

test("it survives several consecutive merges, not just one", () => {
  const { runner, seed, origin } = scaffold();
  ingestCommit(runner);
  concurrentMerge(seed, "merge one\n");

  // A second writer lands between our fetch and our retry.
  const r = runScript(runner);
  assert.strictEqual(r.code, 0, r.out);
  assert.strictEqual(git(origin, "show", "main:parts.js"), "v1-ingested\n");
  assert.strictEqual(git(origin, "show", "main:README.md"), "merge one\n");
});

test("a genuine conflict fails loudly instead of auto-resolving", () => {
  const { runner, seed, origin } = scaffold();
  ingestCommit(runner, "ours\n");
  // Another writer changes the SAME generated file.
  fs.writeFileSync(path.join(seed, "parts.js"), "theirs\n");
  git(seed, "commit", "-am", "another writer touched parts.js");
  git(seed, "push", "origin", "main");

  const r = runScript(runner);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /conflicted/);
  assert.match(r.out, /Not resolving automatically/);
  // The other writer's work is intact — we did not clobber it.
  assert.strictEqual(git(origin, "show", "main:parts.js"), "theirs\n");
  // And no rebase is left half-applied on the runner.
  assert.strictEqual(fs.existsSync(path.join(runner, ".git", "rebase-merge")), false);
  assert.strictEqual(fs.existsSync(path.join(runner, ".git", "rebase-apply")), false);
});

test("it gives up loudly rather than looping forever when the remote is gone", () => {
  const { runner, origin } = scaffold();
  ingestCommit(runner);
  fs.rmSync(origin, { recursive: true, force: true });

  const r = runScript(runner, ["main", "2"]);
  assert.notStrictEqual(r.code, 0);
  assert.match(r.out, /::error::/);
});
