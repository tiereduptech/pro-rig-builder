// =============================================================================
//  admin/public/cron.js
//  Copyright (c) 2026 TieredUp Tech, Inc.
//
//  Cron interval estimation for the workflows panel.
//
//  Lives in public/ rather than functions-lib/ for one reason: the browser loads
//  it as a static asset AND `node --test` imports it directly, so the "overdue"
//  badge is computed by code that is actually tested. It drives a claim the
//  dashboard makes about the pipeline — "this has stopped running" — and a wrong
//  interval means either a false alarm or, worse, a silent one.
//
//  DELIBERATELY APPROXIMATE. This estimates "how often should this fire", not
//  "when does it fire next". GitHub's scheduler is best-effort and drops runs
//  under load, so a precise next-fire time would be false precision. The UI
//  labels it as approximate and only flags a workflow after TWICE the estimated
//  interval has passed.
// =============================================================================

/**
 * Rough expected interval in hours for a 5-field cron, or null if unparseable.
 * Handles the shapes present in this repo: minute steps, hour lists,
 * day-of-month steps, and day-of-week pins.
 */
export function cronIntervalHours(expr) {
  const f = String(expr == null ? '' : expr).trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, , dow] = f;

  // */N * * * *  — every N minutes.
  const minStep = /^\*\/(\d+)$/.exec(min);
  if (minStep && hour === '*') {
    const n = Number(minStep[1]);
    return n > 0 ? n / 60 : null;
  }

  // A day-of-week pin fires on that many days per week, whatever the day-of-month
  // field says — GitHub, like cron, ORs dom and dow when both are restricted, but
  // every schedule in this repo restricts at most one, so the simple reading holds.
  if (dow !== '*') {
    const days = dow.split(',').filter(Boolean).length;
    return days > 0 ? (7 / days) * 24 : null;
  }

  // */N in day-of-month is NOT "every N days" — it is days 1, 1+N, 1+2N … which
  // resets at every month boundary. Close enough for "has this stopped running?",
  // and the discrepancy is smaller than the 2x threshold the UI applies.
  const domStep = /^\*\/(\d+)$/.exec(dom);
  const dayMultiple = domStep ? Number(domStep[1]) : 1;
  if (!(dayMultiple > 0)) return null;

  const hoursPerDay = hour === '*' ? 24 : hour.split(',').filter(Boolean).length;
  if (!(hoursPerDay > 0)) return null;

  return (24 / hoursPerDay) * dayMultiple;
}

/** Short human label for a cron, falling back to the raw expression. */
export function describeCron(expr) {
  const h = cronIntervalHours(expr);
  if (h == null) return String(expr);
  if (h < 1) return `every ${Math.round(h * 60)}m`;
  if (h < 24) return `every ${Math.round(h)}h`;
  const d = Math.round(h / 24);
  return d === 1 ? 'daily' : d === 7 ? 'weekly' : `every ${d}d`;
}
