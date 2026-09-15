// =============================================================================
//  test/helpers/live-code.js — which code in this repo actually RUNS.
//
//  The quarantine locks used to scan `*.js` only, from a hand-kept list. Most of
//  the code that hides and un-hides catalog rows is `.cjs` and `.mjs`: the
//  nightly sftp ingest, the twice-daily Newegg re-pricer, the ASIN identity
//  audit. A lock that cannot see the scheduled writers is a lock on nothing.
//
//  "Live" is DERIVED, never listed: a file a workflow names, plus every file a
//  live file loads by name (import, require, or a dynamic import of a path).
//  Name-matching over-reaches rather than under-reaches: a file merely named
//  in a live file's source counts as live. That is the safe direction, since a
//  false "live" can only make a lock stricter.
// =============================================================================

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export const IS_COMMENT = (line) => /^\s*(\/\/|\*|\/\*)/.test(line);

// A line that HIDES a row / a line that UN-HIDES one.
export const HIDES = /needsReview\s*[=:]\s*true/;
export const UNHIDES = /delete\s+[\w.[\]'"]*\.needsReview\b|needsReview\s*[=:]\s*(false|undefined|null)\b/;

const read = (f) => readFileSync(f, 'utf8');

/** Every tracked source file, any JS extension, outside tests, build output and data. */
export function codeFiles() {
  return execSync("git ls-files -- '*.js' '*.cjs' '*.mjs'", { encoding: 'utf8' })
    .split('\n').filter(Boolean)
    .filter((f) => !/^(test|dist|public|node_modules|src\/data)\//.test(f));
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Files a workflow names, closed over "a live file loads it by name". */
export function liveFiles(files = codeFiles()) {
  const workflows = execSync("git ls-files -- '.github/workflows/*.yml' '.github/workflows/*.yaml'", { encoding: 'utf8' })
    .split('\n').filter(Boolean).map(read).join('\n');
  const named = new Map(files.map((f) => {
    const base = path.basename(f);
    const stem = base.replace(/\.(c|m)?js$/, '');
    // './drift-gate.js', '/newegg-match.js', require('./scripts/write-catalog.cjs'), import('./x')
    return [f, new RegExp(`[/'"\`]${escape(stem)}(\\.(c|m)?js)?['"\`]`)];
  }));

  const live = new Set(files.filter((f) => workflows.includes(path.basename(f))));
  const queue = [...live];
  while (queue.length) {
    const src = read(queue.shift());
    for (const [f, re] of named) {
      if (live.has(f) || !re.test(src)) continue;
      live.add(f);
      queue.push(f);
    }
  }
  return live;
}

/** Non-comment lines matching `re`, with a window of context around each. */
export function sitesIn(src, re, { before = 3, after = 5 } = {}) {
  const lines = src.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (IS_COMMENT(lines[i]) || !re.test(lines[i])) continue;
    out.push({ line: i + 1, text: lines[i].trim(), window: lines.slice(Math.max(0, i - before), i + after + 1).join('\n') });
  }
  return out;
}

/** file -> sites, for every code file with at least one match. */
export function scan(re, files = codeFiles()) {
  const found = new Map();
  for (const f of files) {
    const s = sitesIn(read(f), re);
    if (s.length) found.set(f, s);
  }
  return found;
}
