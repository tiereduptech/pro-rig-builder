#!/usr/bin/env node
/**
 * audit-case-spec-sources.cjs — score every available source for the three
 * case specs people actually shop on (maxGPU, maxCooler, rads) against the
 * values we already trust, so the next person to see "Case filters at 20%"
 * does not fill them from a source that is confidently wrong.
 *
 * WHY THIS EXISTS
 * 1,221 visible cases, and only ~20% carry maxGPU / maxCooler / rads. The gap
 * is one ingest path: 880 of the 972 blank rows came in via
 * newegg-case-discovery, which never captured dimensions. The rows that DO
 * have the specs were enriched from Amazon's spec tables via DataForSEO
 * (dataforseo-enrich-cases.js) — vendor data, not inference.
 *
 * Three cheap-looking ways to close the gap are available in this repo, and
 * this script measures each one against the DataForSEO-sourced rows rather
 * than trusting that it looks reasonable. Run it before believing any of them.
 *
 * WHAT IT MEASURED (2026-08-19, 1,221 visible cases)
 *   - product titles:        maxGPU 1 agree / 3 disagree; rads 0 / 14.
 *     Titles quote marketing numbers ("365mm GPU Max" on a case whose spec
 *     sheet says 380), and for rads they quote only the maximum while the
 *     stored field is the LIST of supported sizes — different questions.
 *   - backfill-case-specs.js's DB dictionary (175 patterns): would fill 549
 *     blank rows, and disagrees with the trusted rows 153 times out of 192.
 *     The patterns are prefix-loose: /Fractal.*Meshify 2/ matches "Meshify 2
 *     Compact" and hands it the full-size Meshify 2's 491mm.
 *   - enrich-case-specs.cjs's KNOWN_SPECS (79 patterns): overlaps the DB
 *     dictionary on 63 rows and disagrees with it on 24 of them.
 *
 * THE CONCLUSION THIS RECORDS
 * A wrong maxGPU is worse than a missing one. Missing means the case is absent
 * from a filter someone is using; wrong means a case that cannot fit their card
 * is shown as fitting it. Every source above is wrong more often than right
 * where it can be checked, so none of them gets to write these fields. The only
 * source that has ever been right here is a vendor spec table, and reaching the
 * remaining rows needs one for Newegg — 896 of the 972 blank rows are
 * Newegg-only listings, and the Newegg SFTP feed carries no dimensions.
 *
 * Run: node audit-case-spec-sources.cjs
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const FIELDS = ['maxGPU', 'maxCooler', 'rads'];
const REPORT = path.join(ROOT, 'verify-reports', `case-spec-sources-${new Date().toISOString().slice(0, 10)}.json`);

// Lift the two dictionaries out of their scripts WITHOUT executing them: both
// self-execute on import and write src/data/parts.js as a side effect.
function liftArray(file, startRe) {
  const s = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const i = s.search(startRe);
  if (i < 0) throw new Error(`${file}: table not found — did it get renamed?`);
  let j = s.indexOf('[', i), d = 0, end = -1;
  for (let k = j; k < s.length; k++) {
    if (s[k] === '[') d++;
    else if (s[k] === ']') { d--; if (!d) { end = k; break; } }
  }
  return eval('(' + s.slice(j, end + 1) + ')');
}

const norm = (v) => Array.isArray(v) ? [...v].map(Number).sort((a, b) => a - b).join(',')
  : (typeof v === 'string' && v.includes(',')) ? v.split(',').map(x => parseInt(x)).sort((a, b) => a - b).join(',')
  : String(v);

// ── source 1: the product title ──────────────────────────────────────────────
const fromTitle = {
  maxGPU: (t) => {
    let m;
    // "GPU up to 400mm" / "Max GPU Length 400mm" — but never a radiator number.
    if ((m = t.match(/(?:gpu|graphics?\s*card|vga|video\s*card)[^.,;()\[\]]{0,24}?(\d{3})\s*mm/i))
      && !/rad|aio|liquid/i.test(m[0])) return +m[1];
    if ((m = t.match(/(\d{3})\s*mm[^.,;()\[\]]{0,16}?(?:gpu|graphics?\s*card|vga)/i))) return +m[1];
    return null;
  },
  maxCooler: (t) => {
    const m = t.match(/(?:cpu\s*)?(?:cooler|heatsink)[^.,;()\[\]]{0,24}?(\d{2,3})\s*mm/i)
      || t.match(/(\d{2,3})\s*mm[^.,;()\[\]]{0,16}?(?:cpu\s*)?(?:cooler|heatsink)/i);
    return m ? +m[1] : null;
  },
  rads: (t) => {
    const out = new Set();
    for (const re of [/(\d{3})\s*mm[^.,;()\[\]]{0,20}?(?:rad(?:iator)?|aio|liquid)/ig,
                      /(?:rad(?:iator)?|aio|liquid\s*cool(?:ing|er)?)[^.,;()\[\]]{0,20}?(\d{3})\s*mm/ig]) {
      let m; while ((m = re.exec(t))) { const n = +m[1]; if ([120,140,240,280,360,420,480].includes(n)) out.add(n); }
    }
    return out.size ? [...out].sort((a, b) => a - b) : null;
  },
};

(async () => {
  const mod = await import('file://' + path.join(ROOT, 'src/data/parts.js').replace(/\\/g, '/') + '?t=' + Date.now());
  const parts = mod.PARTS || mod.default;
  const vis = parts.filter(p => p.c === 'Case' && !p.needsReview && !p.bundle);
  const has = (p, k) => { const v = p[k]; return !(v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)); };

  const DB = liftArray('backfill-case-specs.js', /const DB = \[/);
  const KNOWN = liftArray('enrich-case-specs.cjs', /KNOWN_SPECS = \[/);

  const SOURCES = {
    title:      { get: (p, f) => fromTitle[f](`${p.b || ''} ${p.n || ''}`) },
    dbDict:     { get: (p, f) => { const e = DB.find(x => x.pat.test(`${p.b || ''} ${p.n || ''}`)); return e && e[f] !== undefined ? e[f] : null; } },
    knownSpecs: { get: (p, f) => { const e = KNOWN.find(x => x.pattern.test(`${p.b || ''} ${p.n || ''}`)); return e && e.specs[f] !== undefined ? e.specs[f] : null; } },
  };

  console.log(`\n  Case spec sources — ${vis.length} visible cases\n`);
  const results = {};

  for (const f of FIELDS) {
    const trusted = vis.filter(p => has(p, f));
    const blank = vis.filter(p => !has(p, f));
    console.log(`  ${f}  —  ${trusted.length} trusted / ${blank.length} blank (${Math.round(trusted.length / vis.length * 100)}% coverage)`);
    results[f] = { coverage: trusted.length, blank: blank.length, sources: {} };

    for (const [name, src] of Object.entries(SOURCES)) {
      let agree = 0, disagree = 0; const examples = [];
      for (const p of trusted) {
        const v = src.get(p, f);
        if (v == null) continue;
        if (norm(v) === norm(p[f])) agree++;
        else { disagree++; if (examples.length < 4) examples.push({ id: p.id, name: p.n.slice(0, 80), says: norm(v), trusted: norm(p[f]) }); }
      }
      const wouldFill = blank.filter(p => src.get(p, f) != null).length;
      const checked = agree + disagree;
      const acc = checked ? Math.round(agree / checked * 100) : null;
      results[f].sources[name] = { wouldFill, agree, disagree, accuracyPct: acc, examples };
      const verdict = acc == null ? 'UNVERIFIABLE (no overlap with trusted rows)'
        : acc >= 95 ? 'usable' : `REJECT — right ${acc}% of the time where checkable`;
      console.log(`      ${name.padEnd(11)} would fill ${String(wouldFill).padStart(4)}   checked ${String(checked).padStart(3)}: ${agree} agree / ${disagree} disagree   ${verdict}`);
      for (const e of examples.slice(0, 2)) console.log(`          ✗ says ${e.says}, trusted ${e.trusted} — ${e.name}`);
    }
    console.log('');
  }

  // How many blank rows could a vendor spec table actually reach?
  const asin = (u) => { const m = /\/dp\/([A-Z0-9]{10})/.exec(u || ''); return m ? m[1] : null; };
  const blankGPU = vis.filter(p => !has(p, 'maxGPU'));
  const reachable = blankGPU.filter(p => p.deals && p.deals.amazon && asin(p.deals.amazon.url));
  console.log(`  Reachable by the only source that has ever been right (Amazon spec tables via DataForSEO):`);
  console.log(`      ${reachable.length} of ${blankGPU.length} blank rows carry an Amazon ASIN  (~$${(reachable.length * 0.0015).toFixed(2)})`);
  console.log(`      the other ${blankGPU.length - reachable.length} are Newegg-only, and the Newegg feed carries no dimensions.\n`);
  results._reachable = { amazonAsin: reachable.length, blank: blankGPU.length, estCostUsd: +(reachable.length * 0.0015).toFixed(2) };

  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify({ measuredAt: new Date().toISOString(), visibleCases: vis.length, results }, null, 2), 'utf8');
  console.log(`  Report: ${path.relative(ROOT, REPORT)}\n`);
})().catch((e) => { console.error(e); process.exit(1); });
