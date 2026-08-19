/**
 * scripts/deploy-freshness-report.cjs — decide whether the LIVE site is serving
 * what main has committed, and fail loudly when it is not.
 *
 * WHY THIS IS NOT A RUN-HISTORY CHECK. ingest-outcome-report.cjs judges a
 * writer by its run list, and that rule would have reported this repo as
 * perfectly healthy while it was four builds stale: prerender.yml was green
 * every night, deploy-pages.yml had no failed runs, and nothing was deployed
 * because nothing ever triggered a deploy. Green runs are not a deployed site.
 * The only signal that catches this class is the artifact the world actually
 * receives, so this fetches what the live host serves and compares it against
 * what is committed in dist/ on main.
 *
 * WHY TWO SIGNALS, NOT ONE. Neither is sufficient alone, and the gap in each is
 * measured rather than assumed:
 *
 *   entry bundle (assets/index-<hash>.js)
 *     Vite's content hash. Changes whenever the built JS changes, is emitted by
 *     the build rather than by us, and the 5.5k prerendered pages reference it.
 *     BLIND when a nightly changes only catalog content: over the last 25
 *     builds the hash repeated 6 times, so a freeze beginning on one of those
 *     nights reads as current. Aug 12 -> Aug 13 is a real instance.
 *
 *   sitemap.xml
 *     Regenerated every build and carries a per-URL <lastmod> of the build
 *     date, so it moves on exactly the nights the bundle does not. BLIND to
 *     drift inside a single day, because <lastmod> is day-granular and two
 *     builds dated the same day carry the same value — which is the real state
 *     on 2026-08-19, where the bundle hash is the signal that fires.
 *
 * Each covers the other's blind spot, so both are compared and either one
 * disagreeing is red. The sitemap is compared by content hash; <lastmod> and
 * the <loc> count are pulled out of it only to say HOW far behind in the error
 * message, because "4 days and 31 routes behind" is actionable and "digests
 * differ" is not.
 */

const crypto = require('crypto');

/** Pull the entry-bundle reference out of an index.html. */
function entryBundle(html) {
  if (typeof html !== 'string' || !html) return null;
  const all = html.match(/assets\/index-[A-Za-z0-9._-]+\.js/g);
  if (all && all.length) return all[0];
  // No entry chunk is itself a finding: a shell with no JS is a broken deploy,
  // not a fresh one. Report it as unreadable rather than silently matching.
  return null;
}

/**
 * Reduce a sitemap to the three things worth comparing and reporting.
 * Returns null for anything that is not recognisably a sitemap, so an error
 * page fetched from /sitemap.xml cannot be compared as if it were one.
 */
function sitemapFacts(xml) {
  if (typeof xml !== 'string' || !xml) return null;
  const locs = xml.match(/<loc>/g);
  if (!locs || !locs.length) return null;
  const dates = (xml.match(/<lastmod>\s*(\d{4}-\d{2}-\d{2})/g) || [])
    .map((m) => m.slice(-10))
    .sort();
  return {
    digest: crypto.createHash('sha256').update(xml).digest('hex').slice(0, 12),
    urls: locs.length,
    // The newest date in the file is the build date: prerender stamps every
    // entry it regenerates, so the maximum is when the build ran.
    newest: dates.length ? dates[dates.length - 1] : null,
  };
}

/** Whole days between two YYYY-MM-DD strings, or null if either is missing. */
function daysBetween(a, b) {
  if (!a || !b) return null;
  const ms = Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  return Math.round(ms / 86400000);
}

/**
 * @param {object} o
 * @param {string} [o.liveHtml]         HTML fetched from the live site (null if unreachable)
 * @param {string} [o.committedHtml]    dist/index.html as committed on main
 * @param {string} [o.liveSitemap]      sitemap.xml fetched from the live site
 * @param {string} [o.committedSitemap] dist/sitemap.xml as committed on main
 * @param {string} [o.fetchError]       transport-level failure, if any
 * @param {string} [o.url]
 */
function judgeDeploy(o = {}) {
  const url = o.url || 'the live site';
  const reasons = [];
  const live = entryBundle(o.liveHtml);
  const committed = entryBundle(o.committedHtml);
  const deployCmd =
    'Deploy with: gh workflow run deploy-pages.yml --ref main -f target=production -f ref=main';

  // A watcher that cannot see is not a watcher that is happy — the same rule
  // epik-watchdog.yml applies to an unreachable status file.
  if (o.fetchError) {
    reasons.push(`${url} could not be read (${o.fetchError}). A site that does not answer is not a site that is current.`);
    return { red: true, reasons, live: null, committed };
  }
  if (!committed) {
    reasons.push('dist/index.html on main has no assets/index-*.js reference — the committed build is unreadable, so freshness cannot be judged.');
    return { red: true, reasons, live, committed: null };
  }
  if (!live) {
    reasons.push(`${url} returned no assets/index-*.js reference — it is serving a shell, an error page, or something that is not this site.`);
    return { red: true, reasons, live: null, committed };
  }
  if (live !== committed) {
    reasons.push(
      `${url} is serving ${live} but main has ${committed} committed in dist/. ` +
      `The live site is BEHIND main — every change merged since that bundle was built is invisible to visitors. ` +
      deployCmd
    );
  }

  // ── Second signal ─────────────────────────────────────────────────────────
  // Only judged when both sides were supplied. Absent inputs mean "not asked",
  // not "passed": a caller that cannot read a sitemap gets the bundle verdict
  // alone rather than a silent green on a comparison that never happened.
  const liveMap = sitemapFacts(o.liveSitemap);
  const mainMap = sitemapFacts(o.committedSitemap);
  const askedForSitemap = o.liveSitemap != null || o.committedSitemap != null;

  if (askedForSitemap && !mainMap) {
    reasons.push('dist/sitemap.xml on main is missing or has no <loc> entries — the committed sitemap is unreadable, so the second freshness signal could not be checked. The bundle-hash result above stands alone, and it is blind on builds where the JS did not change.');
  } else if (askedForSitemap && !liveMap) {
    reasons.push(`${url}sitemap.xml returned nothing that looks like a sitemap — no <loc> entries. Either the deploy is broken or that path is being served something else.`);
  } else if (liveMap && mainMap && liveMap.digest !== mainMap.digest) {
    const behind = daysBetween(liveMap.newest, mainMap.newest);
    const parts = [];
    if (behind != null && behind > 0) parts.push(`${behind} day(s) behind`);
    if (liveMap.urls !== mainMap.urls) {
      const d = mainMap.urls - liveMap.urls;
      parts.push(`${Math.abs(d)} route(s) ${d > 0 ? 'missing from' : 'extra on'} the live site`);
    }
    const how = parts.length ? ` (${parts.join(', ')})` : '';
    reasons.push(
      `sitemap.xml differs${how}: live is ${liveMap.newest || 'undated'} with ${liveMap.urls} URLs, ` +
      `main has ${mainMap.newest || 'undated'} with ${mainMap.urls}. ` +
      `The sitemap is regenerated every build, so this moves on the nights the bundle hash does not. ` +
      deployCmd
    );
  }

  return { red: reasons.length > 0, reasons, live, committed, liveMap, mainMap };
}

module.exports = { judgeDeploy, entryBundle, sitemapFacts, daysBetween };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const one = (n, d) => {
      const hit = args.find((a) => a.startsWith(`--${n}=`));
      return hit ? hit.slice(n.length + 3) : d;
    };
    const url = one('url', 'https://prorigbuilder.com/');
    const distPath = one('dist', 'dist/index.html');
    const sitemapPath = one('sitemap', 'dist/sitemap.xml');
    const timeoutMs = Number(one('timeout-ms', '20000'));

    const fs = require('fs');
    let committedHtml = null;
    try {
      committedHtml = fs.readFileSync(distPath, 'utf8');
    } catch (e) {
      console.error(`::error::could not read ${distPath}: ${e.message}`);
      process.exit(2);
    }
    // A missing committed sitemap is reported by judgeDeploy rather than
    // thrown, so the bundle signal still gets to speak.
    let committedSitemap = null;
    try { committedSitemap = fs.readFileSync(sitemapPath, 'utf8'); } catch {}

    // Cache-bust and forbid a revalidated copy: the question is what the
    // ORIGIN serves, not what an edge remembers.
    const bust = (u) => {
      const tag = `deploy-freshness=${process.env.GITHUB_RUN_ID || 'local'}`;
      return `${u}${u.includes('?') ? '&' : '?'}${tag}`;
    };
    const get = async (u) => {
      const res = await fetch(bust(u), {
        headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.text();
    };

    let liveHtml = null;
    let liveSitemap = null;
    let fetchError = null;
    try {
      liveHtml = await get(url);
    } catch (e) {
      fetchError = e.message;
    }
    if (!fetchError && committedSitemap != null) {
      // Failing to reach the sitemap is a finding, not a crash — but it must
      // not masquerade as the homepage being unreachable, so it is reported
      // through the sitemap branch by leaving liveSitemap empty.
      try {
        liveSitemap = await get(new URL('sitemap.xml', url).toString());
      } catch (e) {
        liveSitemap = '';
        console.error(`::warning::could not fetch sitemap.xml (${e.message})`);
      }
    }

    const verdict = judgeDeploy({ liveHtml, committedHtml, liveSitemap, committedSitemap, fetchError, url });

    const lines = [`### Live site — ${verdict.red ? 'BEHIND MAIN' : 'current with main'}`];
    lines.push(`Bundle live:      ${verdict.live || '(unreadable)'}`);
    lines.push(`Bundle committed: ${verdict.committed || '(unreadable)'}`);
    if (verdict.liveMap || verdict.mainMap) {
      const f = (m) => (m ? `${m.newest || 'undated'}, ${m.urls} URLs` : '(unreadable)');
      lines.push(`Sitemap live:      ${f(verdict.liveMap)}`);
      lines.push(`Sitemap committed: ${f(verdict.mainMap)}`);
    }
    verdict.reasons.forEach((r) => lines.push(`- ✗ ${r}`));
    const out = lines.join('\n');
    if (process.env.GITHUB_STEP_SUMMARY) {
      try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, out + '\n'); } catch {}
    }
    if (verdict.red) verdict.reasons.forEach((r) => console.error(`::error::${r}`));
    console.log(out);
    process.exit(verdict.red ? 1 : 0);
  })();
}
