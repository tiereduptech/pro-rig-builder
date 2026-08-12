#!/usr/bin/env node
/**
 * verify-main-writer-lock.cjs — assert that every workflow which pushes to main
 * carries the shared `main-writer` concurrency group.
 *
 * Why this exists: before 2026-08-12 the ONLY thing keeping the main-writing
 * workflows off each other was their cron schedule. That degrades on any slow
 * run, retry, manual dispatch, or new workflow — all normal events. The lock is
 * the fix; this script is what stops the lock from silently rotting when someone
 * adds the next workflow.
 *
 * Output is a TALLY, not a boolean: it prints every workflow, the push line that
 * classified it, and the counts. A gate that only says FAIL cannot be
 * sanity-checked — and the first draft of this script misclassified five
 * workflows in both directions, which only the tally made visible.
 *
 * Classification of each `git push`:
 *   main          — literal `main` refspec, or a bare push in a workflow whose
 *                   checkout lands on the default branch
 *   other         — literal non-main refspec (orphan release branch, feature branch)
 *   indeterminate — refspec is an expression/variable that could not be resolved.
 *                   Never guessed: an indeterminate pusher must hold the lock.
 *
 * Exit 0 = every workflow that can push main is locked, and nothing else is.
 */
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

// WF_DIR is overridable so the gate can be proven to FAIL on a doctored copy
// without touching the real workflows. A gate only ever seen passing is not
// known to be discriminating.
const WF_DIR = process.env.WF_DIR || path.join(__dirname, '..', '.github', 'workflows');
const GROUP = 'main-writer';
const EXPR_TOKEN = '$__EXPR__';

/**
 * Every step with a `run:`, carrying the env visible to it
 * (workflow env < job env < step env).
 */
function runSteps(doc) {
  const out = [];
  const wfEnv = doc.env || {};
  for (const [jobName, job] of Object.entries(doc.jobs || {})) {
    if (!job || !Array.isArray(job.steps)) continue;
    const jobEnv = Object.assign({}, wfEnv, job.env || {});
    for (const step of job.steps) {
      if (step && typeof step.run === 'string') {
        out.push({ jobName, run: step.run, env: Object.assign({}, jobEnv, step.env || {}) });
      }
    }
  }
  return out;
}

/**
 * Join backslash line-continuations so a multi-line command is one logical line.
 * publish-epik.yml puts the remote URL and the refspec on continuation lines;
 * reading physical lines classifies it as an unqualified bare push.
 */
function logicalLines(script) {
  const lines = [];
  let buf = '';
  for (const raw of script.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (/\\$/.test(line)) {
      buf += line.slice(0, -1).trim() + ' ';
    } else {
      lines.push((buf + line.trim()).trim());
      buf = '';
    }
  }
  if (buf) lines.push(buf.trim());
  return lines.filter(Boolean);
}

/** Resolve `$VAR` / `${VAR}` against the step's visible env, if it is a literal. */
function resolveRef(ref, env) {
  const m = ref.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
  if (!m) return null;
  const val = env[m[1]];
  if (typeof val !== 'string') return null;
  // A GitHub expression may still be a choice between constants — resolve only
  // by asking whether ANY branch of it can be main.
  if (/\$\{\{/.test(val)) {
    const literals = Array.from(val.matchAll(/'([^']*)'/g)).map((x) => x[1]);
    if (!literals.length) return null;
    return literals.some((l) => /(^|\/)main$/.test(l)) ? 'main' : literals.join(' | ');
  }
  return val;
}

/** True if every trigger pins this workflow to a non-main branch. */
function onlyFeatureBranchTriggers(doc) {
  const on = doc.on !== undefined ? doc.on : doc.true; // YAML 1.1 reads bare `on:` as boolean true
  if (!on || typeof on !== 'object') return false;
  const keys = Object.keys(on);
  // schedule / dispatch / call run against the default branch = main.
  if (keys.some((k) => k === 'schedule' || k === 'workflow_dispatch' || k === 'workflow_call')) return false;
  const branches = [];
  for (const k of ['push', 'pull_request']) {
    const t = on[k];
    if (t && Array.isArray(t.branches)) branches.push.apply(branches, t.branches);
  }
  return branches.length > 0 && branches.indexOf('main') === -1;
}

/** Classify every `git push` in a workflow. */
function classifyPushes(doc) {
  const found = [];
  const bareGoesToMain = !onlyFeatureBranchTriggers(doc);

  for (const step of runSteps(doc)) {
    for (const line of logicalLines(step.run)) {
      if (!/\bgit\s+(?:-\S+\s+)*push\b/.test(line)) continue;

      // Collapse every `${{ ... }}` to ONE space-free, deliberately unresolvable
      // token before splitting. An inline `${{ github.token }}@github.com/...`
      // remote otherwise splits on its internal spaces and manufactures refspecs
      // that were never in the file — and a fabricated refspec containing "main"
      // would be a false alarm of exactly the shape this gate exists to prevent.
      const exprs = [];
      const after = line
        .replace(/^.*?\bgit\s+(?:-\S+\s+)*push\b/, '')
        .replace(/\$\{\{.*?\}\}/g, function (m) {
          exprs.push(m.replace(/\s+/g, ' '));
          return EXPR_TOKEN;
        });

      const args = after
        .replace(/[;&|].*$/, '')
        .split(/\s+/)
        .filter(Boolean)
        .filter(function (a) { return !/^-/.test(a); });

      // Drop the remote (origin, or a URL in any quoting/expression form).
      const isRemote = function (a) {
        return a === 'origin' || /github\.com/.test(a) || /:\/\//.test(a) || /@/.test(a);
      };
      const remoteIdx = args.findIndex(isRemote);
      const refs = (remoteIdx >= 0 ? args.slice(remoteIdx + 1) : args).filter(function (a) {
        return !isRemote(a);
      });
      const describe = function (t) {
        return t === EXPR_TOKEN ? exprs.join(' / ') || t : t;
      };

      if (!refs.length) {
        found.push({
          line: line,
          kind: bareGoesToMain ? 'main' : 'other',
          note: bareGoesToMain
            ? 'bare push, and the checkout lands on the default branch'
            : 'bare push, but the workflow is pinned to a feature branch',
        });
        continue;
      }

      for (const raw of refs) {
        const ref = raw.replace(/^["']|["']$/g, '');
        const target = ref.indexOf(':') >= 0 ? ref.split(':').pop() : ref;

        if (target === EXPR_TOKEN) {
          found.push({
            line: line,
            kind: 'indeterminate',
            note: 'refspec is the expression ' + describe(target) + ', resolved only at run time',
          });
        } else if (/^\$/.test(target)) {
          const resolved = resolveRef(target, step.env);
          if (resolved === null) {
            found.push({ line: line, kind: 'indeterminate', note: 'refspec ' + target + ' not resolvable from env' });
          } else if (/(^|\/)main$/.test(resolved)) {
            found.push({ line: line, kind: 'main', note: target + ' resolves to ' + resolved });
          } else {
            found.push({ line: line, kind: 'other', note: target + ' resolves to ' + resolved });
          }
        } else if (/(^|\/)main$/.test(target)) {
          found.push({ line: line, kind: 'main', note: 'literal refspec ' + target });
        } else {
          found.push({ line: line, kind: 'other', note: 'literal refspec ' + target });
        }
      }
    }
  }
  return found;
}

function lockGroups(doc) {
  const groups = [];
  const grab = function (c) {
    if (!c) return;
    groups.push(typeof c === 'string' ? c : c.group);
  };
  grab(doc.concurrency);
  for (const job of Object.values(doc.jobs || {})) grab(job && job.concurrency);
  return groups.filter(Boolean);
}

function cancelInProgress(doc) {
  const check = function (c) {
    return c && typeof c === 'object' && c.group === GROUP ? c['cancel-in-progress'] : undefined;
  };
  const wf = check(doc.concurrency);
  if (wf !== undefined) return wf;
  for (const job of Object.values(doc.jobs || {})) {
    const v = check(job && job.concurrency);
    if (v !== undefined) return v;
  }
  return undefined;
}

/** Audit one workflow directory. Pure: returns the tally, prints nothing. */
function audit(dir) {
  const rows = [];
  for (const file of fs.readdirSync(dir).filter(function (f) { return /.ya?ml$/.test(f); }).sort()) {
    let doc;
    try {
      doc = yaml.load(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (err) {
      rows.push({ file: file, parseError: err.message, groups: [], pushes: [], indeterminate: [] });
      continue;
    }
    const pushes = classifyPushes(doc);
    const groups = lockGroups(doc);
    rows.push({
      file: file,
      pushes: pushes,
      writesMain: pushes.some(function (p) { return p.kind === 'main'; }),
      indeterminate: pushes.filter(function (p) { return p.kind === 'indeterminate'; }),
      groups: groups,
      locked: groups.indexOf(GROUP) >= 0,
      cancel: cancelInProgress(doc),
    });
  }

  const parseErrors = rows.filter(function (r) { return r.parseError; });
  const definite = rows.filter(function (r) { return r.writesMain; });
  const maybe = rows.filter(function (r) { return !r.writesMain && r.indeterminate.length; });
  const mustLock = definite.concat(maybe);
  const others = rows.filter(function (r) { return !r.parseError && !r.writesMain && !r.indeterminate.length; });
  const locked = mustLock.filter(function (r) { return r.locked; });
  const unlocked = mustLock.filter(function (r) { return !r.locked; });
  const badCancel = locked.filter(function (r) { return r.cancel === true; });
  const strayLocks = others.filter(function (r) { return r.groups.indexOf(GROUP) >= 0; });

  const failures = [];
  for (const r of parseErrors) failures.push(r.file + ': YAML did not parse — ' + r.parseError);
  for (const r of unlocked) failures.push(r.file + ': can push to main but is not in the ' + GROUP + ' group');
  for (const r of badCancel) failures.push(r.file + ': ' + GROUP + ' with cancel-in-progress:true — a writer must never be killed mid-push');
  for (const r of strayLocks) failures.push(r.file + ': joins ' + GROUP + ' but pushes nothing to main — it would block real writers for nothing');

  return { rows, parseErrors, definite, maybe, mustLock, others, locked, unlocked, badCancel, strayLocks, failures };
}

function report(a) {
  console.log('main-writer concurrency audit');
  console.log('='.repeat(74));
  console.log('workflows parsed   : ' + (a.rows.length - a.parseErrors.length) + '/' + a.rows.length);
  console.log('can push to main   : ' + a.mustLock.length + '   (definite ' + a.definite.length + ', run-time-conditional ' + a.maybe.length + ')');
  console.log('  locked           : ' + a.locked.length);
  console.log('  UNLOCKED         : ' + a.unlocked.length);
  console.log('cannot push to main: ' + a.others.length);
  console.log('');

  console.log('MUST HOLD THE LOCK');
  for (const r of a.mustLock) {
    console.log('  [' + (r.locked ? 'LOCKED  ' : 'UNLOCKED') + '] ' + r.file);
    console.log('               groups: ' + (r.groups.join(', ') || '(none)') + '   cancel-in-progress: ' + r.cancel);
    for (const p of r.pushes) {
      if (p.kind === 'other') continue;
      console.log('               push:   ' + p.line);
      console.log('                       ^ [' + p.kind + '] ' + p.note);
    }
  }

  console.log('');
  console.log('CANNOT PUSH TO MAIN');
  for (const r of a.others) {
    const elsewhere = r.pushes.length
      ? '   (pushes elsewhere: ' + r.pushes.map(function (p) { return p.note; }).join('; ') + ')'
      : '';
    console.log('  ' + r.file + (r.groups.length ? '   groups: ' + r.groups.join(', ') : '') + elsewhere);
  }

  console.log('');
  if (a.failures.length) {
    console.log('FAIL — ' + a.failures.length + ' problem(s):');
    a.failures.forEach(function (f) { console.log('  - ' + f); });
    return 1;
  }
  console.log(
    'PASS — ' + a.locked.length + '/' + a.mustLock.length + ' main-capable writers carry ' + GROUP +
    ', all cancel-in-progress:false; ' + a.others.length + ' workflows correctly outside the group.'
  );
  return 0;
}

module.exports = { audit, report, classifyPushes, lockGroups, cancelInProgress, logicalLines, GROUP, WF_DIR };

if (require.main === module) {
  process.exit(report(audit(WF_DIR)));
}
