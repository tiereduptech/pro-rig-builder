// =============================================================================
//  admin/public/app.js — the Phase 0 view and the Phase 1 button.
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  Three sources, deliberately kept distinct rather than merged server-side:
//    /constants.generated.json  static, matches THIS deployment's commit
//    /api/stats                 live, matches the DEFAULT BRANCH's catalog
//    /api/runs                  live, GitHub Actions
//
//  They can legitimately disagree — the deployed dashboard may be older than the
//  catalog it reports on — so each panel shows its own provenance instead of one
//  combined "as of" that would be wrong for two of the three.
// =============================================================================

import { cronIntervalHours, describeCron } from '/cron.js';

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n).toLocaleString('en-US');

function ago(iso) {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function hoursSince(iso) {
  const ms = Date.now() - Date.parse(iso);
  return Number.isFinite(ms) ? ms / 3600000 : null;
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { throw new Error(`${url}: ${res.status} — ${text.slice(0, 200)}`); }
  if (!res.ok) throw new Error(body.error || `${url}: ${res.status}`);
  return body;
}

function fail(el, e) {
  el.className = '';
  el.innerHTML = `<div class="error">${esc(e.message || e)}</div>`;
}

// ── Catalog ────────────────────────────────────────────────────────────────
function deltaCell(n) {
  if (n == null) return '';
  const cls = n > 0 ? 'up' : n < 0 ? 'down' : 'flat';
  return `<div class="d ${cls}">${n > 0 ? '+' : ''}${num(n)} since last</div>`;
}

function renderCatalog(s) {
  const el = $('catalog-body');
  const t = s.totals;
  const a = s.attribution;
  const d = s.delta;

  // The quarantine delta is the number that prompted this dashboard, so it is
  // rendered as an inverted signal: a RISE is the bad direction, unlike total.
  const tiles = `
    <div class="tiles">
      <div class="tile"><div class="k">Total</div><div class="v">${num(t.total)}</div>${deltaCell(d && d.total)}
        <div class="rule">${esc(s.definitions.total)}</div></div>
      <div class="tile"><div class="k">Live</div><div class="v">${num(t.live)}</div>${deltaCell(d && d.live)}
        <div class="rule">${esc(s.definitions.live)}</div></div>
      <div class="tile"><div class="k">Quarantined</div><div class="v">${num(t.quarantined)}</div>${deltaCell(d && d.quarantined)}
        <div class="rule">${esc(s.definitions.quarantined)}</div></div>
    </div>`;

  const maxRows = Math.max(1, ...s.byReason.map((r) => r.rows), a.withoutReason);
  const bar = (n, cls = '') => `<span class="bar-fill ${cls}" style="width:${Math.max(2, (n / maxRows) * 160)}px"></span>`;

  const reasonRows = s.byReason
    .map((r) => `<tr><td class="mono">${esc(r.reason)}</td><td class="num">${num(r.rows)}</td>
       <td><div class="bar-cell">${bar(r.rows)}</div></td></tr>`)
    .join('');

  // The unattributed row is FIRST and styled as data, not as a footnote. It is
  // the largest bucket by a wide margin, and a breakdown that quietly omitted it
  // would not reconcile with the headline above.
  const unattributed = `<tr><td class="mono muted">(no reason recorded)</td><td class="num">${num(a.withoutReason)}</td>
      <td><div class="bar-cell">${bar(a.withoutReason, 'unattributed')}</div></td></tr>`;

  const pct = t.quarantined ? Math.round((a.withoutReason / t.quarantined) * 100) : 0;

  const catRows = s.byCategory
    .map(
      (c) => `<tr><td>${esc(c.category)}</td><td class="num">${num(c.total)}</td>
        <td class="num">${num(c.live)}</td><td class="num">${num(c.quarantined)}</td>
        <td class="num muted">${c.total ? Math.round((c.quarantined / c.total) * 100) : 0}%</td></tr>`,
    )
    .join('');

  el.className = '';
  el.innerHTML = `
    ${tiles}
    <h3>Quarantine by reason</h3>
    <p class="note">
      ${esc(s.definitions.byReason)}.
      ${num(a.withoutReason)} of ${num(t.quarantined)} quarantined rows (${pct}%) carry no reason at all — only
      <code>needsReview</code> and <code>quarantinedAt</code>. They are shown rather than dropped so this
      panel reconciles with the headline. That gap is itself worth fixing: the ingests that quarantine
      without stamping a flag should stamp one.
    </p>
    <div class="scroll"><table>
      <thead><tr><th>Reason</th><th class="num">Rows</th><th></th></tr></thead>
      <tbody>${unattributed}${reasonRows}</tbody>
    </table></div>

    <h3>By category</h3>
    <div class="scroll"><table>
      <thead><tr><th>Category</th><th class="num">Total</th><th class="num">Live</th><th class="num">Quar.</th><th class="num">%</th></tr></thead>
      <tbody>${catRows}</tbody>
    </table></div>

    <p class="note">
      Computed at <code>${esc((s.commit || '').slice(0, 8))}</code>, ${esc(ago(s.generatedAt))}
      (${esc(s.generatedAt)}) by <code>scripts/catalog-stats.cjs</code>.
      ${d ? `Delta is against <code>${esc(d.sinceCommit)}</code>, ${esc(ago(d.since))}.` : 'No prior snapshot yet, so no delta.'}
    </p>`;
}

// ── Workflows ──────────────────────────────────────────────────────────────
function renderWorkflows(runs, constants) {
  const el = $('workflows-body');
  const schedules = new Map((constants.schedules || []).map((s) => [s.file, s]));

  const rows = runs.workflows
    .slice()
    .sort((a, b) => {
      const at = a.run ? Date.parse(a.run.startedAt) : 0;
      const bt = b.run ? Date.parse(b.run.startedAt) : 0;
      return bt - at;
    })
    .map((w) => {
      const sch = schedules.get(w.file) || { crons: [], disabledCrons: [] };
      const run = w.run;

      let status;
      if (!run) status = '<span class="badge">no runs</span>';
      else if (run.status !== 'completed') status = `<span class="badge warn">${esc(run.status)}</span>`;
      else if (run.conclusion === 'success') status = '<span class="badge ok">success</span>';
      else if (run.conclusion === 'skipped' || run.conclusion === 'cancelled') status = `<span class="badge">${esc(run.conclusion)}</span>`;
      else status = `<span class="badge bad">${esc(run.conclusion || 'failed')}</span>`;

      // Overdue = more than 2x the expected interval since the last run. Flagged
      // only for workflows that actually carry an ACTIVE cron; a dispatch-only
      // workflow is not late, it is just idle.
      let schedText = '<span class="muted">dispatch only</span>';
      let overdue = '';
      const activeCrons = sch.crons || [];
      if (activeCrons.length) {
        const intervals = activeCrons.map(cronIntervalHours).filter((h) => h != null);
        const shortest = intervals.length ? Math.min(...intervals) : null;
        schedText = activeCrons.map((c) => `<span title="${esc(c)}">${esc(describeCron(c))}</span>`).join(', ');
        const age = run ? hoursSince(run.startedAt) : null;
        if (shortest != null && (age == null || age > shortest * 2))
          overdue = ` <span class="badge bad" title="expected roughly every ${Math.round(shortest)}h">overdue</span>`;
      } else if ((sch.disabledCrons || []).length) {
        schedText = `<span class="muted">schedule commented out</span>`;
      }

      const stateBadge =
        w.state && w.state !== 'active'
          ? ` <span class="badge bad" title="GitHub disables scheduled workflows after 60 days of repository inactivity">${esc(w.state)}</span>`
          : '';

      return `<tr>
        <td>${esc(w.name)}${stateBadge}<div class="src">${esc(w.file)}${w.pushesMain ? '' : ''}</div></td>
        <td>${status}${overdue}</td>
        <td class="mono">${run ? `<a href="${esc(run.url)}" target="_blank" rel="noopener">${esc(ago(run.startedAt))}</a>` : '—'}
            ${run ? `<div class="src">${esc(run.event)} · #${esc(run.number)}</div>` : ''}</td>
        <td class="mono">${schedText}</td>
      </tr>`;
    })
    .join('');

  const vc = (constants.schedules || []).find((s) => s.file === 'verify-catalog.yml');
  const tierNote = vc && vc.tierMap
    ? `<p class="note">
        <code>verify-catalog.yml</code> runs four schedules mapped to tiers:
        ${Object.entries(vc.tierMap).map(([c, t]) => `tier ${t} — <code>${esc(c)}</code>`).join(', ')}.
        The runs API reports the workflow, not which tier a given run was, so the row above is the
        most recent run of <em>any</em> tier — not per-tier coverage.
      </p>`
    : '';

  el.className = '';
  el.innerHTML = `
    <div class="scroll"><table>
      <thead><tr><th>Workflow</th><th>Last result</th><th>Last run</th><th>Schedule</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    ${tierNote}
    <p class="note">
      Schedules are read from the workflow YAML by <code>scripts/derive-constants.cjs</code>; intervals
      are approximate and exist to answer “has this stopped running?”, not to predict a fire time.
      <strong>Overdue</strong> means no run in more than twice the expected interval.
    </p>`;
}

// ── Dispatch ───────────────────────────────────────────────────────────────
function renderDispatch(options) {
  const el = $('dispatch-body');

  el.className = '';
  el.innerHTML = options.options
    .map((o, i) => {
      const inputs = Object.entries(o.inputs)
        .map(([name, spec]) => {
          const id = `in-${i}-${name}`;
          if (spec.values && spec.values.length > 1)
            return `<label for="${id}">${esc(name)}</label><select id="${id}" data-input="${esc(name)}">
              ${spec.values.map((v) => `<option${v === spec.default ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`;
          if (spec.values && spec.values.length === 1)
            return `<label for="${id}">${esc(name)}</label>
              <select id="${id}" data-input="${esc(name)}" title="the allowlist permits only this value"><option>${esc(spec.values[0])}</option></select>`;
          return `<label for="${id}">${esc(name)}</label>
            <input type="text" id="${id}" data-input="${esc(name)}" value="${esc(spec.default ?? '')}" size="6">`;
        })
        .join('');

      return `<div class="dispatch-row" data-workflow="${esc(o.workflow)}" data-writes="${o.writes}" data-label="${esc(o.label)}">
        <div>
          <strong>${esc(o.label)}</strong>
          ${o.writes ? '<span class="badge warn">writes</span>' : '<span class="badge ok">read-only</span>'}
          <span class="badge">${esc(o.cost)}</span>
          <div class="desc">${esc(o.description)}</div>
          <div class="src">${esc(o.workflow)}</div>
          ${inputs ? `<div class="dispatch-inputs">${inputs}</div>` : ''}
        </div>
        <button type="button" class="run">Run</button>
      </div>`;
    })
    .join('');

  el.querySelectorAll('button.run').forEach((btn) => btn.addEventListener('click', () => runDispatch(btn)));
}

async function runDispatch(btn) {
  const row = btn.closest('.dispatch-row');
  const workflow = row.dataset.workflow;
  const label = row.dataset.label;
  const writes = row.dataset.writes === 'true';

  const inputs = {};
  row.querySelectorAll('[data-input]').forEach((f) => { inputs[f.dataset.input] = f.value; });

  // A typed confirmation for anything that commits. A one-click "are you sure"
  // is trained away in a week; typing the word is a beat of attention on the
  // only actions here that change the repository.
  if (writes) {
    const typed = window.prompt(`"${label}" commits to the repository.\n\nType RUN to confirm.`);
    if (typed !== 'RUN') return;
  }

  const out = $('dispatch-result');
  btn.disabled = true;
  btn.textContent = 'Starting…';
  try {
    const res = await fetch('/api/dispatch', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workflow, inputs }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    out.hidden = false;
    out.className = 'ok';
    out.textContent = `Dispatched ${body.label} (${Object.entries(body.inputs).map(([k, v]) => `${k}=${v}`).join(' ') || 'no inputs'}) on ${body.ref}. ${body.note}`;
    // Re-read the runs panel shortly after, since a dispatch returns no run id.
    setTimeout(loadWorkflows, 4000);
  } catch (e) {
    out.hidden = false;
    out.className = 'err';
    out.textContent = `Dispatch failed: ${e.message}`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run';
  }
}

// ── Calibration ────────────────────────────────────────────────────────────
function renderCalibration(constants) {
  const el = $('calibration-body');
  const today = Date.now();
  const rows = constants.calibration
    .map((c) => {
      const age = Math.round((today - Date.parse(c.calibratedAt + 'T00:00:00Z')) / 86400000);
      const stale = age > c.maxAgeDays;
      const near = !stale && age > c.maxAgeDays * 0.8;
      const badge = stale
        ? '<span class="badge bad">stale</span>'
        : near
          ? '<span class="badge warn">due soon</span>'
          : '<span class="badge ok">current</span>';
      return `<tr><td>${esc(c.label)}</td><td class="mono">${esc(c.calibratedAt)}</td>
        <td class="num">${age}d</td><td class="num muted">${c.maxAgeDays}d</td><td>${badge}</td>
        <td class="src">${esc(c.file)}</td></tr>`;
    })
    .join('');
  el.className = '';
  el.innerHTML = `<div class="scroll"><table>
    <thead><tr><th>Gate</th><th>Calibrated</th><th class="num">Age</th><th class="num">Max</th><th>State</th><th>Source</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}

// ── Constants ──────────────────────────────────────────────────────────────
function renderConstants(constants) {
  const el = $('constants-body');
  const fmt = (v) =>
    typeof v === 'object' && v !== null ? JSON.stringify(v, null, 1) : String(v);

  el.className = '';
  el.innerHTML = constants.groups
    .map(
      (g) => `<details class="group">
        <summary><span>${esc(g.title)}</span>
          <span class="badge ${esc(g.exposure)}">${esc(g.exposure)}</span>
          <span class="muted" style="margin-left:auto;font-size:11px">${g.entries.length}</span>
        </summary>
        <div class="inner">
          ${g.note ? `<p class="group-note">${esc(g.note)}</p>` : ''}
          <div class="scroll"><table>
            <thead><tr><th>Name</th><th>Value</th><th>Source</th></tr></thead>
            <tbody>${g.entries
              .map(
                (e) => `<tr><td class="mono">${esc(e.name)}</td>
                  <td><pre class="value">${esc(fmt(e.value))}</pre></td>
                  <td class="src">${esc(e.file)}:${e.line}</td></tr>`,
              )
              .join('')}</tbody>
          </table></div>
        </div>
      </details>`,
    )
    .join('');
}

// ── Boot ───────────────────────────────────────────────────────────────────
let CONSTANTS = null;

async function loadWorkflows() {
  try {
    const runs = await getJson('/api/runs');
    renderWorkflows(runs, CONSTANTS || { schedules: [] });
  } catch (e) {
    fail($('workflows-body'), e);
  }
}

async function boot() {
  for (const id of ['catalog-body', 'workflows-body', 'dispatch-body', 'calibration-body', 'constants-body']) {
    $(id).className = 'loading';
    $(id).textContent = 'Loading…';
  }

  // Constants first: the workflow panel needs the schedules to say "overdue".
  try {
    CONSTANTS = await getJson('/constants.generated.json');
    $('build-meta').textContent = `build ${CONSTANTS.commit.slice(0, 8)} · ${ago(CONSTANTS.generatedAt)}`;
    renderCalibration(CONSTANTS);
    renderConstants(CONSTANTS);
  } catch (e) {
    fail($('calibration-body'), e);
    fail($('constants-body'), e);
  }

  // The three remaining panels fail independently — a GitHub outage must not
  // take the catalog numbers down with it, and vice versa.
  await Promise.all([
    getJson('/api/stats').then(renderCatalog).catch((e) => fail($('catalog-body'), e)),
    loadWorkflows(),
    getJson('/api/dispatch').then(renderDispatch).catch((e) => fail($('dispatch-body'), e)),
  ]);
}

$('refresh').addEventListener('click', boot);
boot();
