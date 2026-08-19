# Cloudflare Pages — cutover

Copyright © 2026 TieredUp Tech, Inc.

Status: **flipped. The apex serves from Pages, and automatic deploys are on.**
`prorigbuilder.com` is attached to the Pages project as a custom domain, §7 is
done, the canary hostname is gone, and `CF_PAGES_AUTO_DEPLOY` is set to `'true'`.
This document is now a record of how the flip was done, not a runbook for doing
it. The live checklist is the short list in §8.

Re-measured against the live apex on 2026-08-19, after the flip:

| check | result |
|---|---|
| apex is Pages, not Railway | `x-prerender: route-hit-noslash` on `/parts/cpu` — that header comes from the Function, so the resolver is live on the apex. No `x-railway-edge` on any response |
| §7 step 7 — unmatched product path | `410`, `x-prerender: gone-410`, `x-robots-tag: noindex` |
| §7 step 7 — unslashed category | `200`, `x-prerender: route-hit-noslash`, no `location` |
| §7 step 7 — unslashed product | `200`, `x-prerender: route-hit-noslash`, no 308 |
| §7 step 7 — `/search` (outside `/parts/`) | `200`, no 308 |
| **§7 step 7 — `X-Robots-Tag` on an apex product page** | **absent.** This is the check that matters most: a header here would mean `noindexOnPagesDev()` misfired and the live catalog was being de-indexed. It did not fire |
| §1 five response-header rules | all five present on the apex, unchanged |
| §3.3 stock cache behaviour | `cache-control: public, max-age=0, must-revalidate` + `cf-cache-status: DYNAMIC` on HTML — still no Cache Everything in front of it |
| §3.6 HSTS | `max-age=31536000; includeSubDomains; preload`, unchanged |
| §2 canary hostname | **deleted** — `pages-canary.prorigbuilder.com` does not resolve |

### The real harnesses, against the apex — first run ever, 2026-08-19

Everything above is header-level. `bytediff-pages.mjs` and `cp3-pages.mjs` are the
checks §7 step 7 actually names, and until now both had only ever run against the
canary and `pages.dev`. Both have now run against `prorigbuilder.com`:

| harness | result |
|---|---|
| `bytediff-pages.mjs`, `SAMPLE=12` | **exit 0** — 39/39 routes byte-identical to `dist/`: 26 tail routes exhaustively, the 404 probe, and 12 sampled products |
| `cp3-pages.mjs`, `SAMPLE=40`, no `ALLOW_NOINDEX_HEADER` | **exit 0** — 40/40 clean, 0 hard violations (offset 20) |
| CP-3 negative control, same host | **exit 1**, all seven violations — the harness has teeth against *this* host, not just against `pages.dev` |
| byte-diff negative control, same host | **exit 1** — a 15-byte edit to `dist/about/index.html` was located and named at byte 45714 |

Both negative controls were run deliberately: §4 argues that a harness grading
everything clean is indistinguishable from a healthy site, and that argument
applies to the apex too. A pass is only worth what its matching failure is.

**Two methodology notes, because the run is not reproducible without them.**

1. **Diff against the `dist/` that is actually deployed, not against `main`.**
   The live site is one build behind `main` (§8), so running `bytediff-pages.mjs`
   from a `main` checkout compares the served bytes against a build the world has
   never seen and reports the entire site as rewritten. The run above used a
   detached worktree at `eb2ae17c1d4`, the commit whose bundle the apex is
   actually serving. That isolates the question to the zone, which is the only
   question this harness is asking. Once auto-deploy has closed the gap, a plain
   `main` checkout is the right base again.
2. **`dist/404.html` is not committed.** `build-pages.cjs` generates it, along
   with `_headers`, `_redirects` and the trailing-slash siblings, at deploy time.
   A fresh checkout has none of them, and `bytediff-pages.mjs` crashes on the
   missing `dist/404.html` rather than skipping it. Run `node build-pages.cjs`
   first — exactly as the deploy workflow does.

```sh
git worktree add --detach /tmp/live-dist <sha-that-is-live>
cd /tmp/live-dist && node build-pages.cjs
HOST=https://prorigbuilder.com node deploy/bytediff-pages.mjs             # exit 0
HOST=https://prorigbuilder.com SAMPLE=40 node deploy/cp3-pages.mjs        # no ALLOW_NOINDEX_HEADER
```

**What this closes.** §1's whole argument was that `pages.dev` results do not
transfer to the apex because the zone sits in between, and §6 carried "byte
transparency on the apex" as unverified. That is now measured: no §3.4 feature is
rewriting HTML on `prorigbuilder.com`, and the resolver's output survives the zone
intact. **Crawler treatment (§6) remains the one genuinely unrun check** — every
request in this document, including these, was browser-shaped.

Verified 2026-08-15, pre-flip, post-deploy (deployment `cae214a0`, `main` @ `8ab9e40`):

| check | result |
|---|---|
| `bytediff-pages.mjs`, canary | exit 0 — 39/39 routes byte-identical to `dist/` |
| `bytediff-pages.mjs`, `pages.dev` control | exit 0 — 39/39 |
| CP-3, canary, `SAMPLE=40` | 40/40 clean, 0 hard violations |
| §4.3, all six checks | pass — including the 404 control, now byte-identical |
| redirect map, **all 12 entries** | 301 + relative `Location` + target 200 |
| R2 through the zone | 200, correct `content-type` + CORS, preflight 204, no `cf-mitigated`, byte-exact against disk for both data dirs |
| §3.7 `.pages.dev` noindex | live on the alias — see below |

**Email Obfuscation is off.** It was reported off twice on 2026-08-15 and measured
still on both times before it actually cleared. It is now off by positive evidence,
not merely by an absent diff: the raw `mailto:` survives in-zone on the canary
*and* on the live apex, with no `/cdn-cgi/l/email-protection` and no injected
`email-decode` script on any of the three hosts. If it ever reappears while the
Scrape Shield toggle reads off, check **Rules → Configuration Rules** for a rule
turning it back on for matching requests; that override is invisible from the
toggle, and it is what made the first two "it's off" reports wrong.

**§3 item 2 is closed.** The apex was enumerated by hand and carries **zero** Page
Rules (0 of 3 used), Redirect Rules, URL Rewrite Rules, Configuration Rules, Origin
Rules, Cache Rules and Request Header Transform Rules. The only rules on it are the
five Response Header Transform Rules assessed in §1. No leftover Railway forwarding
rule exists, so nothing will fight the resolver's own 301s. This was the one §6 gap
that could not be closed through the canary.

Sibling documents: `DESIGN-cloudflare-pages.md` for the stack itself,
`PHASE-B-INSTALL.md` for the Epik cutover this is mutually exclusive with.

---

## 0. The conflict to settle first

`PHASE-B-INSTALL.md` step 8 moves `prorigbuilder.com` to the **Epik** origin with
Full (Strict). This document moves it to **Pages**. Both target the same apex and
only one can hold it.

`DESIGN-cloudflare-pages.md` §1 is deliberate about keeping both fed from the same
committed `dist/` so either can serve production — but that is a property of the
*artifact*, not of DNS. Decide which stack owns the apex before running either
step 8, because the two cutovers have almost nothing in common: Epik's is an
origin-cert-and-SSL-mode problem, and Pages' is a zone-configuration problem.

**Settled 2026-08-15: the apex goes to Pages.** `PHASE-B-INSTALL.md` step 8 is
dead — do not run it.

Epik is **not** torn down. It stays fed from the same committed `dist/` and stays
serviceable as the fallback until Pages is proven live, which is the arrangement
`DESIGN-cloudflare-pages.md` §1 was built for. Nothing in this document removes an
Epik component, and the rollback in §5 is "point the apex back at Railway", not
"rebuild Epik". Revisit the teardown only after Pages has held the apex through at
least one nightly `prerender.yml` cycle and a clean Search Console read (§6).

---

## 1. What §4.3 proved, and exactly where the proof stops

Verified 2026-08-15 against `https://prorigbuilder.pages.dev`:

| | result |
|---|---|
| §4.1 — unmatched product path | `410`, `x-prerender: gone-410`, `x-robots-tag: noindex` |
| §4.1 control — unknown path outside `/parts/` | `404` (hard), body byte-identical to `dist/404.html` |
| §4.2 — unslashed category | `200`, `x-prerender: route-hit-noslash`, no `location` |
| §4.2 — unslashed product | `200`, canonical is the unslashed production URL |
| §4.2 outside `/parts/` — `/search` | `200`, no 308 |
| redirect map | `301` + relative `Location`, target resolves `200` |
| CP-3 over 20 sampled product pages | 20/20 clean, 0 hard violations, no `X-Robots-Tag` |

**The boundary: `pages.dev` is not your zone.** It is a domain shared across all
Cloudflare customers, so a request to `prorigbuilder.pages.dev` reaches the Pages
edge with *none* of `prorigbuilder.com`'s configuration in front of it. Every
result above was measured through an empty pipeline.

```
  what §4.3 measured                what production will actually be

  client                            client
    │                                 │
    │                            ┌────┴─────┐  zone prorigbuilder.com
    │                            │ SSL mode │  WAF / Bot Fight
    │                            │ Page Rules / Redirect Rules
    │                            │ Cache Rules / Edge TTL
    │                            │ Rocket Loader · Email Obfuscation
    │                            │ Polish · Managed Transforms
    │                            └────┬─────┘
    ▼                                 ▼
  Pages edge  ── same artifact ──  Pages edge
```

Half of that middle box **rewrites HTML at the edge**, and CP-3 is an assertion
about rendered HTML. So CP-3 passing at `pages.dev` says nothing about CP-3 on
`prorigbuilder.com`. It has to be re-run through the zone.

### What the canary then proved — 2026-08-15

Re-run against `https://pages-canary.prorigbuilder.com`, with the zone in front:

| | result |
|---|---|
| §4.3 — all six checks | pass, identical to `pages.dev` except the 404 control |
| §4.3 404 control | `404` correct, **body not byte-identical to `dist/404.html`** — see below. **Resolved once Email Obfuscation went off: re-measured byte-identical, 54,043 bytes, later the same day** |
| CP-3, `SAMPLE=40` | 40/40 clean, 0 hard violations (offset 130) |
| CP-3 negative control, same flags | exit 1, six violations — `ALLOW_NOINDEX_HEADER=1` suppresses that one line and nothing else |
| byte diff, `/parts/` sample | 12/12 identical |
| byte diff, everything else | **6 of 27 routes rewritten** |
| R2 through the zone | `200`, correct `content-type`, `access-control-allow-origin: https://prorigbuilder.com`, preflight `204`, no challenge, byte-length matches the same-origin copy |

**Email Obfuscation was on**, rewriting `mailto:` into `/cdn-cgi/l/email-protection`
on `/`, `/contact`, `/privacy`, `/terms`, `/affiliate` and `404.html`, and injecting
`email-decode.min.js`. Contained: 0 of 5,493 product pages contain a `mailto:`, and
all six JSON-LD blocks on the homepage still parse clean, so structured data was
never touched. The cost is that the support address is JS-only for a non-JS client.

**It is not a cutover regression.** `https://prorigbuilder.com/contact` shows the
same rewrite today, in front of Railway — the setting is zone-wide and has been
live on production all along. So it is not a new risk the flip introduces, and it
is not a reason to delay on correctness grounds. It still has to go off before the
flip for a different reason: while it is on, the byte diff can never be silent, and
a verification step that is expected to fail is one nobody reads.

Two things this run establishes beyond the immediate finding:

- **CP-3 cannot see this class of defect** and never could — it samples product
  pages, which is where the rewriting was not. Neither check subsumes the other.
- **A zone rule can overwrite a header the Function sets.** The canary's noindex
  Transform Rule replaced the resolver's `x-robots-tag: noindex` with
  `noindex, nofollow` on the 410 path, rather than appending to it. Harmless here —
  strictly stronger, on a throwaway hostname — but it is the mechanism behind the
  July incident, and worth knowing before adding any header rule to the apex.

### The zone's five response-header rules

`HSTS`, `nosniff`, `X-Frame-Options: SAMEORIGIN`,
`Referrer-Policy: strict-origin-when-cross-origin`,
`Permissions-Policy: geolocation=(), microphone=(), camera=()`.

**None interfere, and none are new at cutover — all five are already live on the
apex today**, in front of Railway. Two of them (`nosniff`, `Referrer-Policy`) also
appear on `pages.dev`, which is outside the zone, so Pages emits those itself with
identical values; the zone rules are redundant there rather than conflicting, and
no header is double-emitted (verified by header count). None touches
`X-Robots-Tag`, canonicals, or `cache-control`.

---

## 2. Make the untestable testable — the canary hostname

The apex flip on a proxied record is **effectively instantaneous and global**.
There is no TTL ramp and no canary population, so a defect found after the flip is
found by everyone at once.

The fix is to put the artifact behind the real zone config on a hostname that is
not the apex:

1. Workers & Pages → the project → **Custom domains** → **Set up a custom domain**
2. Enter `pages-canary.prorigbuilder.com`
3. Cloudflare creates the proxied CNAME in the zone automatically

That hostname is inside `prorigbuilder.com`, so **every zone-level feature in the
box above now applies to it** — SSL mode, WAF, Bot Fight, Rocket Loader, Email
Obfuscation, cache rules, transform rules. Re-run §4.3 and CP-3 against it and the
results transfer to the apex, minus only rules whose expression matches the apex
hostname or path specifically (§3, item 2).

Being in the zone also means the canary's own crawlability is trivially solved,
unlike `pages.dev` — a Transform Rule scoped to
`http.host eq "pages-canary.prorigbuilder.com"` adding `X-Robots-Tag: noindex,
nofollow` costs one rule and touches nothing in the artifact. Add it when you
create the hostname, and delete the hostname when the verification run is done.

**Both are gone.** `pages-canary.prorigbuilder.com` no longer resolves (checked
2026-08-19), so §7 step 8 ran. Confirm the Transform Rule went with it — a
`noindex, nofollow` rule left behind on a hostname that no longer exists is inert
today, but it is one dashboard edit away from matching something that does. This
section is retained because the technique is worth having: any future change to
zone config in front of the artifact can be tested this way instead of on the
apex, and it is what caught Email Obfuscation.

---

## 3. Clear these before DNS — in this order

Enumerate first, decide second. Read-only, with a `Zone:Read` token:

```sh
ZONE=<zone-id>; TOK=<api-token>
H="-H \"Authorization: Bearer $TOK\""
curl -s -H "Authorization: Bearer $TOK" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/settings" \
  | jq -r '.result[] | select(.value != "off" and .value != false) | "\(.id)=\(.value)"'
curl -s -H "Authorization: Bearer $TOK" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/pagerules" | jq -r '.result[]'
curl -s -H "Authorization: Bearer $TOK" \
  "https://api.cloudflare.com/client/v4/zones/$ZONE/rulesets" | jq -r '.result[] | "\(.phase)  \(.name)"'
```

**1. SSL/TLS encryption mode.** Pages has no origin — Cloudflare serves from its
own edge — so the Origin CA work in `PHASE-B-INSTALL.md` §6 is irrelevant to an
apex that points at Pages. What matters is that the mode is **not Flexible**:
Flexible in front of Pages is the documented cause of redirect loops. Full or Full
(Strict) both work and neither needs an origin cert. If the apex is already Full
(Strict) for the Epik plan, leave it.

**2. Page Rules and Redirect Rules on the apex.** These are the rules the canary
will *not* exercise, because their expressions name `prorigbuilder.com`. Read every
one by hand. The dangerous shapes:

- a forwarding rule on `prorigbuilder.com/*` — will fight the resolver's own 301s
- `www` → apex or apex → `www` — decide which is canonical and make it match the
  5,519 canonical tags in `public/sitemap.xml`, which are all apex
- anything left over from Railway

**CLEARED 2026-08-15, by hand.** The apex has **zero** rules in every one of these
families: Page Rules (0 of 3 used), Redirect Rules, URL Rewrite Rules,
Configuration Rules, Origin Rules, Cache Rules, Request Header Transform Rules.
The only rules on the apex are the five Response Header Transform Rules assessed
in §1. In particular there is **no leftover Railway forwarding rule**, so nothing
will fight the resolver's 301s after the flip. This closes the item the canary was
structurally unable to test.

**3. Cache Rules / Cache Everything.** Cloudflare sends
`public, max-age=0, must-revalidate` on Pages assets and HTML is not a default
cached type, so the stock behaviour is correct (`DESIGN-cloudflare-pages.md` §6).
A **Cache Everything** rule with an Edge TTL override breaks that, and the two
failure modes are both nasty:

- prerendered HTML caches at the edge, so a deploy is invisible until purge — the
  same class of stale-read defect as `DESIGN-pull-deploy.md` §11
- a **cached 301** is sticky, and a cached 410 outlives a product's restoration

The `/assets/*` immutable Cache Rule that §6 actually *wants* is a post-cutover
performance item. Add it after the flip is verified, not during.

**4. Content-modifying features — the ones that can break CP-3.** Each rewrites
HTML on the custom domain and on nothing you have tested:

| feature | what it does to a prerendered page |
|---|---|
| **Rocket Loader** | rewrites and defers `<script>` tags. Highest risk item on the list: this stack is a React SPA hydrating over prerendered HTML, and the Product JSON-LD CP-3 asserts on is itself a `<script>` tag |
| **Email Obfuscation** | rewrites email-shaped text and injects a script. Corrupts any address inside JSON-LD or a meta description. Was ON 2026-08-15 — zone-wide, six routes affected, no product page and no JSON-LD (§1). **Now OFF and confirmed by positive evidence** (raw `mailto:` survives in-zone on canary and apex), `bytediff-pages.mjs` exit 0 |
| **Auto Minify** | removed by Cloudflare in 2024, but old zones still show the toggle. Minifying HTML can alter the tags CP-3 counts |
| **Polish / Mirage** | rewrites `<img>`. Low correctness risk, but it is a rewrite |

Turn all four **off** before the flip. They can be reintroduced one at a time
afterwards, with CP-3 re-run between each.

**5. Bot Fight Mode / WAF / Managed Rules.** Two exposures:

- crawlers. Verified bots are allowlisted, but Bot Fight Mode is known to
  challenge legitimate non-browser traffic, and a challenge served to a crawler on
  5,484 product pages is a de-indexing event in slow motion
- **`data.prorigbuilder.com`**. The R2 data host is in the *same zone*, and the
  browser fetches price history and reviews from it as XHR. A WAF or bot rule that
  challenges those requests breaks charts on every product page while the HTML
  still looks perfect. Workstream 3 is live and was verified before these rules
  were in front of it.

**6. HSTS.** Not a blocker — Pages is HTTPS-only — but if it is on, browsers pin
HTTPS for `max-age`, which constrains any rollback that is not also HTTPS. Note it;
do not change it during cutover.

**7. `prorigbuilder.pages.dev` itself.** The alias is permanent — it keeps serving
after cutover, so it becomes a crawlable byte-for-byte duplicate of the live site
rather than of a pre-launch artifact. Cloudflare offers no way to disable it, and
`build-pages.cjs` cannot fix it: the `--staging` noindex guard is channel-scoped by
construction, and §7 of `DESIGN-cloudflare-pages.md` refuses a production artifact
that carries it, correctly — that header on the apex is the July incident.

Measured 2026-08-15, the exposure is currently held by the canonicals alone:

| | |
|---|---|
| in Certificate Transparency logs | **no** — `crt.sh` returns `[]`; `pages.dev` is served under a Cloudflare wildcard, so the project name is never published. Closes the main automated discovery vector |
| indexed today | no |
| listed in any sitemap | no — the sitemap served at `pages.dev` contains only `prorigbuilder.com` URLs, and its `robots.txt` points at `https://prorigbuilder.com/sitemap.xml` |
| inbound links | none known |
| per-page canonical | absolute, to a live and already-indexed target serving identical content |
| **internal links** | **relative** (74:2 on a sampled product page) — so one discovered page makes all 5,484 spiderable within the host |

Low discovery probability, high fan-out if it happens. **The permanent fix is a
host check in the resolver**, not Cloudflare Access. **Shipped 2026-08-15** as
`noindexOnPagesDev()` in `functions/parts/[[path]].js`:

```js
if (!new URL(request.url).hostname.endsWith('.pages.dev')) return response;
const tagged = new Response(response.body, response);
tagged.headers.set('X-Robots-Tag', 'noindex, nofollow');
```

`nofollow` as well as `noindex`, matching the canary's Transform Rule. `noindex`
alone would suffice if this Function saw the whole host, but `_routes.json` scopes
it to `/parts/*` while the prerendered internal links are relative — so a crawler
landing on a covered product page can walk straight out to the 35 uncovered
routes, which are then indexable duplicates of live production. `nofollow`
attenuates that hop. It does not close it (Google treats `nofollow` as a discovery
hint), so the gap below remains a gap.

It is applied at the Function's single exit, not inside a branch. `onRequest` has
seven return paths — asset hit, trailing-slash 200, non-404 passthrough, other
redirects, SPA fallback, 301, 410 — and tagging them one at a time means the next
branch anyone adds is silently untagged. Stamping on the way out is the only shape
where that cannot happen. `hostname` rather than `host` so a port can never
defeat the suffix match.

Verified with `wrangler pages dev`, 2026-08-15 — all seven paths, four hostnames:

| | `X-Robots-Tag` |
|---|---|
| `prorigbuilder.pages.dev`, all 7 paths | `noindex, nofollow` |
| `abc123.prorigbuilder.pages.dev` (preview), all 7 paths | `noindex, nofollow` |
| `prorigbuilder.com`, all 7 paths | none, except the 410's own (unchanged) |
| `pages-canary.prorigbuilder.com`, all 7 paths | none, except the 410's own (unchanged) |
| `notpages.dev`, `pages.dev.evil.com` | none — the leading dot prevents a suffix false positive |

Exactly one `X-Robots-Tag` on the 410, where the resolver already set its own —
`set` replaces rather than appending. The response body is byte-identical across
`pages.dev`, the apex and `dist/`, so the clone is header-only, and it happens
**only** on `.pages.dev`: the apex and canary return the asset service's own
Response object untouched.

This is a host-conditional branch in the serving path, which §5 of the design and
the rejected `robots.txt` variant both argue against — the distinction is the
failure direction. That option needed a *new* Function at `/robots.txt` (widening
`_routes.json`) and its misfire served `Disallow: /` on the live apex: silent and
catastrophic. This adds a header inside a Function that already runs on exactly the
5,484 paths that matter, changes no routing, and cannot fire on the apex because
`prorigbuilder.com` does not end in `.pages.dev`. Its misfire is a missing header
on `pages.dev` — today's state.

It does not cover the 35 non-`/parts/` pages; widening `_routes.json` to reach them
is what §5 refuses, and they carry canonicals. Accepted, and stated so it is not
mistaken for covered.

**Confirmed at the edge, 2026-08-15, deployment `cae214a0`.** The table above was
`wrangler pages dev`; this is the deployed artifact. The scoping gap is now
measured rather than inferred, and the split across the two columns is itself the
proof of *which* mechanism sets the header on each host:

| host | `/parts/<product>` | `/about` | source |
|---|---|---|---|
| `prorigbuilder.pages.dev` | `noindex, nofollow` | **none** | the resolver, scoped to `/parts/*` |
| `cae214a0.prorigbuilder.pages.dev` | `noindex, nofollow` | `noindex` | resolver, plus Cloudflare's own per-deployment noindex |
| `pages-canary.prorigbuilder.com` | `noindex, nofollow` | `noindex, nofollow` | the §2 Transform Rule, host-wide |
| `prorigbuilder.com` | none | none | Railway — untouched by any of this |

That last row is **2026-08-15 and historical**: the apex served from Railway when
this was measured. Re-measured on the apex post-flip, it still reads `none` /
`none` — now because the resolver's host check correctly declines to fire on a
host that does not end in `.pages.dev`, which is the §7 step 7 result in the
status block. Same values, entirely different mechanism, and the second one is
the one that had to be checked.

Read the rows against each other. A header that appears on `/parts/*` but *not* on
`/about` can only be the Function, since every other mechanism here is host-wide;
a header on both is the Transform Rule. That asymmetry is what distinguishes them,
and it is why the canary's `noindex, nofollow` must not be read as evidence the
resolver fired there — it did not, and the canary's headers are byte-for-byte what
they were before this deploy.

One unlooked-for benefit: Cloudflare already noindexes the per-deployment
`<hash>.pages.dev` aliases itself, across all routes. The permanent
`prorigbuilder.pages.dev` alias is the one that needed this code, which is exactly
the host §3.7 was written for.

### How much of §3 is actually verified — read this before trusting it

**Items 1, 3, 5 and 6 were verified by symptom through the canary, not by reading
zone config.** The enumeration curls at the top of §3 need a `Zone:Read` token and
have not been run. What that buys and what it leaves open, measured 2026-08-15:

| item | symptom observed on the canary | what it does **not** prove |
|---|---|---|
| **1** SSL mode | HTTPS `200` throughout, no redirect loop on any route | that the mode is Full vs Full (Strict). It rules out Flexible, which is the failure §3.1 names, and nothing more |
| **3** Cache Rules | `cache-control: public, max-age=0, must-revalidate` + `cf-cache-status: DYNAMIC` on HTML, on canary *and* apex — stock behaviour, so no Cache Everything with an Edge TTL override is in front of HTML | that no cache rule exists scoped to a path or hostname the canary never exercised — `/assets/*` included |
| **5** Bot Fight / WAF | no challenge on any canary route; `data.prorigbuilder.com` returns `200` with `access-control-allow-origin: https://prorigbuilder.com`, preflight `204`, no `cf-mitigated` | **the thing §3.5 actually worries about.** These were browser-UA requests from one datacenter IP. Bot Fight challenges *crawlers*, and nothing here sent a crawler-shaped request or measured what Googlebot receives |
| **6** HSTS | **on, and stronger than §3.6 assumed:** `max-age=31536000; includeSubDomains; preload` | nothing — this one is settled, and it tightens §5 (see below) |

Item **2** (Page Rules / Redirect Rules on the apex) is not verifiable this way by
construction — that is the §6 gap, unchanged. Item **4** *was* caught by symptom:
Email Obfuscation was found on and rewriting six routes.

The honest summary: the canary proves the zone is not breaking the artifact **for
a browser**. It does not prove the zone config is what you think it is, and for
item 5 the browser/crawler distinction is exactly the one that matters. Run the
enumeration curls before the flip if a token can be had.

`includeSubDomains; preload` also means §5's rollback caveat is understated: with
`preload`, the pin is not just cached in clients that visited — it ships in the
browser's built-in list, and removal is a months-long process through
`hstspreload.org`. Any rollback target must be HTTPS, permanently. Railway is, so
the §5 rollback stands; a rollback to anything else does not.

---

## 4. The sequence

```
settle apex ownership (§0)                                        [DONE 2026-08-15]
  -> enumerate zone config (§3)                                   [DONE 2026-08-15]
  -> attach pages-canary.prorigbuilder.com + noindex transform rule (§2)  [DONE]
  -> bytediff-pages.mjs + §4.3 + cp3-pages.mjs against the canary  [DONE — found
     Email Obfuscation; this is the run that earned the whole exercise]
  -> clear §3 items 1-6                                           [DONE 2026-08-15]
  -> re-run all three against the canary       <- confirms the clearing
     bytediff-pages.mjs must exit 0 here; that is what "cleared" means  [DONE, 0]
  -> ship the .pages.dev host check in the resolver (§3.7)         [DONE 2026-08-15]
  -> merge to main + deploy target=production                     [DONE — 8ab9e40,
     run 31905346482, deployment cae214a0, 16,406 files]
  -> verify at the edge: pages.dev noindex, canary unchanged, bytediff 0,
     CP-3 40/40, §4.3 six checks, R2                              [DONE 2026-08-15]
  -> attach prorigbuilder.com as a Pages custom domain             [DONE — §7]
  -> §4.3 + CP-3 against the apex, immediately                      [DONE — §7
     step 7's header checks re-measured clean 2026-08-19; the harnesses
     themselves ran the same day, two lines below]
  -> delete the canary hostname                                    [DONE — the
     hostname no longer resolves]
  -> set CF_PAGES_AUTO_DEPLOY=true                                 [DONE]
  -> give deploy-pages.yml an automatic trigger                    [DONE — see §8]
  -> a live-vs-committed deploy watcher (§8)                       [DONE —
     scripts/deploy-freshness-report.cjs, wired into ingest-outcome-watch.yml]
  -> run bytediff-pages.mjs + cp3-pages.mjs against the apex       [DONE — both
     exit 0, both negative controls exit 1; see the status block]
  ───────────────────────────────────────────────────────  everything above: DONE
  -> URL Inspection in Search Console — the crawler question (§6)  <- YOU ARE HERE
  -> zone Cache Rule for /assets/* (DESIGN §6)
  -> reintroduce any §3.4 feature you want back, one at a time, CP-3 between each
```

`CF_PAGES_AUTO_DEPLOY` was held back until **after** the flip was verified, for
the reason `deploy-pages.yml` states in its gating comment: while it was unset, no
commit to `main` could move a Cloudflare deployment. Setting it earlier would have
meant an ordinary commit shipping the apex as a side effect, which is the trap
`DESIGN-pull-deploy.md` records for `EPIK_PULL_AUTO_PUBLISH`. It is set now, and
the ordering it protected is spent — from here on, a merged commit that lands
before the nightly prerender **does** reach visitors, without anyone pressing
anything. That is the intended steady state; it is also a new way to ship a
mistake, so it is worth stating rather than discovering.

### The byte-transparency diff — run this one first

CP-3 asserts specific tags. The zone's HTML-rewriting features (§3.4) can alter
anything, including bytes no assertion names. The sharper test is to compare what
the host serves against what is on disk:

```sh
HOST=https://pages-canary.prorigbuilder.com node deploy/bytediff-pages.mjs
```

Exit 0 means the pipeline is byte-transparent. This has a known-good baseline:
the `pages.dev` alias is outside the zone, so it should always pass — run it
there first as a control, and any route that differs on the canary but not on
`pages.dev` is the zone. The script names the likely culprit itself from the
injected markup rather than leaving you to guess at §3.4.

**Do not go back to the `find dist/parts | shuf -n 12` loop this replaces.** It
returned 12/12 clean against the canary on 2026-08-15 while Email Obfuscation was
actively rewriting six routes, because not one of the 5,493 product pages contains
a `mailto:` and every affected route was outside `/parts/`. It passed because it
was not looking.

The fix is not "sample more" — it is that the two halves of `dist/` want opposite
strategies:

| | volume | variety | strategy |
|---|---|---|---|
| `/parts/` | 5,493 | one template | rotating sample (`SAMPLE=`, default 12) |
| everything else | 27 routes | each hand-built — the only `mailto:`, the only `<form>`, the only long-form prose | **exhaustive, every run** |

Sampling the tail is close to worthless: the defect lives in whichever route the
sample skipped. Checking it exhaustively costs 27 requests.

Two details the script handles that a shell loop got wrong: `dist/` emits every
static page twice (`about.html` *and* `about/index.html`, byte-identical — 25/25
pairs verified 2026-08-15), so routes are collapsed rather than fetched twice; and
`dist/404.html` is never served at `/404.html`, so it is probed via an unmatched
path outside `/parts/`, which is how a client actually reaches it (`DESIGN` §4.1).

When a route does differ, the script fetches it a second time. A body that differs
between two fetches is a per-request injection — Email Obfuscation randomises its
cipher byte on every response — which is a much stronger signal than one mismatch,
and it rules out a stale `dist/` as the explanation.

Not covered: this compares HTML only. Polish/Mirage rewrite `<img>` payloads
rather than markup, so a Polish-only regression passes this check. §3.4 says turn
it off; nothing here proves it is.

### Re-running the checks against a hostname

Everything in §4.3 takes a host. CP-3 keeps asserting canonicals against
`https://prorigbuilder.com` regardless of which host serves the bytes — that is
correct and deliberate, since the canonical is baked into `dist/`:

```sh
# canary — its noindex Transform Rule (§2) would otherwise report a failure
# that is not one, and an alarm that cries wolf in the confidence-building
# window is the defect PHASE-B-INSTALL.md §8 records for an unflipped cron
ALLOW_NOINDEX_HEADER=1 HOST=https://pages-canary.prorigbuilder.com SAMPLE=40 \
  node deploy/cp3-pages.mjs

# apex — no suppression here; the header line must be live for the real check
HOST=https://prorigbuilder.com SAMPLE=40 node deploy/cp3-pages.mjs
```

Also confirm the R2 data host still answers through the zone's WAF, since the
browser fetches it as XHR from every product page and a challenge there breaks
charts while the HTML still validates clean (§3.5):

```sh
curl -sI https://data.prorigbuilder.com/ -o /dev/null -w '%{http_code}\n'
```

`cp3-pages.mjs` samples `public/sitemap.xml` with a day-rotating offset rather
than a fixed head, so consecutive runs cover different pages — a fixed sample
cannot detect a defect correlated with category or age. Pin it with `OFFSET=` to
reproduce a specific run.

Confirm it still has teeth before trusting a pass — a harness that grades
everything clean is indistinguishable from a healthy site. Point it at a URL that
must fail and check it does:

```sh
echo '<loc>https://prorigbuilder.com/parts/ram/definitely-not-a-real-product-99999</loc>' > /tmp/neg.xml
SITEMAP=/tmp/neg.xml SAMPLE=1 HOST=https://prorigbuilder.pages.dev node deploy/cp3-pages.mjs
#   expect exit 1 and all seven violations: status 410, X-Robots-Tag noindex,
#   meta noindex, 0 canonicals, canonical missing, no Product JSON-LD, shell leak
```

---

## 5. Rollback

Better than Epik's, and worth knowing before the flip rather than during it: the
apex record is **proxied**, so reverting it propagates in seconds rather than over
a TTL. Rollback is "point the apex back at Railway" and it is effectively instant.

**Post-flip, this section rests on two things nobody has re-checked.** It was
written when Railway was serving the apex, so both were self-evidently true and
neither is any more:

1. **That the step-0 record exists.** The apex is proxied, so Pages overwriting
   the record destroyed the only readable copy of the Railway target. If it was
   not written down, the rollback below has no destination.
2. **That Railway is still up and still serving this app.** Nothing in this repo
   or in any check here would notice it being torn down or idled out. A rollback
   to an origin that no longer answers is not a rollback.

Confirm both while they are still cheap to confirm, rather than during the
incident that needs them.

What does *not* roll back with it:

- **anything cached at the edge** while a §3.3 rule was active — purge everything
- **HSTS.** Measured 2026-08-15 as `max-age=31536000; includeSubDomains; preload`.
  `preload` makes this stronger than a cached pin: the zone ships in the browsers'
  built-in list, so the constraint applies to clients that have never visited and
  cannot be lifted quickly. **Every rollback target must be HTTPS, permanently.**
  Railway is, so this rollback stands — but "point the apex at a plain-HTTP origin
  for ten minutes to debug" is not available and never will be
- **`VITE_DATA_BASE`**, if it has been set by then. `DESIGN-cloudflare-pages.md`
  §10 is explicit: the bundle is *committed*, so clearing the variable fixes
  nothing until another full prerender run rebuilds it. No redeploy undoes it

---

## 6. Still unknown after all of the above

Stated so it is not mistaken for covered:

- ~~**Apex-scoped rules.**~~ **CLOSED 2026-08-15.** Read by hand (§3.2): the apex
  carries zero rules in every family that could interfere. This was the gap that
  could not be closed through the canary, and it is now closed by enumeration
  rather than by symptom.
- **The zone config itself.** §3 items 1/3/5/6 are verified by *symptom* through the
  canary, not by reading configuration — the enumeration curls at the top of §3 have
  never been run. See the table at the end of §3 for what each symptom does and does
  not establish.
- **Crawler treatment.** Everything measured so far was a browser-shaped request
  from a datacenter IP. Bot Fight Mode challenges non-browser traffic, which is the
  §3.5 exposure, and no check in this document has ever sent a crawler-shaped
  request or observed what Googlebot receives. The URL Inspection tool in Search
  Console is the only instrument that answers this, and it only works post-flip.
  **It is post-flip now** — this stopped being a thing that had to wait and became
  a thing nobody has done. Run URL Inspection on one product page and one category
  page; it is the single highest-value unrun check left in this document.
- ~~**Byte transparency on the apex.**~~ **CLOSED 2026-08-19.** Both harnesses ran
  against `prorigbuilder.com` for the first time: `bytediff-pages.mjs` exit 0 on
  39/39 routes, `cp3-pages.mjs` 40/40 clean, and both negative controls exit 1 on
  the same host. See the status block. This was the last item that could be
  settled without a crawler.
- **Load.** All 5,484 product pages invoke the Function (`DESIGN` §5). The work is
  one `next()` and a status check, and nothing here has measured it at production
  request rates.
- **Search Console.** The 308-on-every-canonical failure §4.2 exists to prevent is
  visible in Search Console days *after* it would be visible in curl. Watch
  "Page with redirect" and "Crawled – currently not indexed" for two weeks past
  cutover; a clean §4.3 is a necessary and not a sufficient condition.

---

## 7. The flip — dashboard clicks, in order

**Done.** The apex is attached and the canary is removed; steps 0-8 below all ran.
Kept as the record of what was done and as the procedure to reverse it — the
Rollback block at the end of this section is still live, and it is the reason
step 0 mattered. If the rollback target from step 0 was never written down, that
is an open gap: the apex record is proxied, so the Railway target is not readable
from DNS or from this repo now that Pages has overwritten it.

**Record the rollback target BEFORE touching anything.** The apex is proxied, so
its origin is not readable from DNS or from this repo — once the record is
overwritten, the only copy of the Railway target is the one you wrote down.

```
 0. DNS -> Records -> prorigbuilder.com
      screenshot the record. Write down: type, name, target, proxy status.
      This is the rollback target. There is no other copy.

 1. Workers & Pages -> prorigbuilder -> Custom domains
 2. Set up a custom domain
 3. Enter: prorigbuilder.com          -> Continue
 4. Review the DNS change Cloudflare proposes  -> Activate domain
 5. Wait for Custom domains to show prorigbuilder.com = Active
 6. DNS -> Records -> confirm the apex record now points at the Pages project
      and Proxy status is still Proxied (orange cloud)

 7. VERIFY, in this order, before touching anything else:
      HOST=https://prorigbuilder.com node deploy/bytediff-pages.mjs      # exit 0
      HOST=https://prorigbuilder.com SAMPLE=40 node deploy/cp3-pages.mjs # no ALLOW_NOINDEX_HEADER
      curl -sI https://prorigbuilder.com/parts/ram/definitely-not-a-real-product-99999
        -> 410, x-prerender: gone-410, x-robots-tag: noindex
      curl -sI https://prorigbuilder.com/parts/cpu   -> 200, no location
      curl -s -o /dev/null -w '%{http_code}' https://data.prorigbuilder.com/<any object>  -> 200
      curl -sI https://prorigbuilder.com/parts/<product>  -> NO x-robots-tag

 8. Only after 7 is clean:
      Custom domains -> pages-canary.prorigbuilder.com -> Remove
      Rules -> Transform Rules -> delete the canary noindex rule
```

Step 7's last line is the one that matters most: an `X-Robots-Tag` on an apex
product page means the resolver's host check misfired and the live catalog is
being de-indexed. Roll back immediately.

### Rollback

```
 1. DNS -> Records -> prorigbuilder.com -> Edit
      restore type/target from step 0, Proxy status Proxied
      Save.  Propagation is seconds — the record is proxied, there is no TTL ramp.
 2. Workers & Pages -> prorigbuilder -> Custom domains
      -> prorigbuilder.com -> Remove      (or Pages re-asserts the record)
 3. Caching -> Configuration -> Purge Everything
 4. curl -sI https://prorigbuilder.com/  -> expect x-railway-edge again
```

The rollback target must be HTTPS and must stay HTTPS: HSTS on this zone is
`max-age=31536000; includeSubDomains; preload`, so the pin ships in the browsers'
built-in list and cannot be lifted quickly (§5). Railway is HTTPS, so this
rollback is sound; pointing the apex at a plain-HTTP origin to debug is not
available and never will be.

Do **not**, as part of a rollback, revert the `main` merge or redeploy Pages —
neither touches what serves the apex, and both cost you the verified artifact.

---

## 8. After the flip — how deploys work now

The flip changed what serves the apex. This changed how it gets updated.

### The trigger

`deploy-pages.yml` fires on `workflow_run` when **"Prerender SEO pages"**
completes on `main`, gated on `vars.CF_PAGES_AUTO_DEPLOY == 'true'` *and*
`github.event.workflow_run.conclusion == 'success'`. So the nightly prerender
builds `dist/`, commits it, and the deploy follows automatically. A
`workflow_dispatch` still runs unconditionally and still bypasses the gate,
which is the escape hatch for shipping out of band.

**It is not a `push` trigger, and it must not become one.** `prerender.yml` is
the only writer of `dist/` and it hardcodes `[skip ci]` into its commit message —
25 of the last 30 `dist/` commits carry the marker. GitHub Actions honours
`[skip ci]` by skipping push-triggered runs, so `push: paths: [dist/**]` would be
armed, green in the editor, and would never once fire. `workflow_run` keys off
the upstream workflow *completing* rather than off the push, so `[skip ci]` never
reaches it, and it fires exactly when `dist/` changed because prerender is the
thing that changes `dist/`.

### The failure mode this introduces

An automatic deploy that stops happening is **silent**. When
`CF_PAGES_AUTO_DEPLOY` is unset, or the upstream conclusion is not `success`, the
job is *skipped* — and a skipped job in the runs list is the same grey as a
deliberate no-op. Nothing goes red. The site simply stops receiving builds while
every workflow in the repo reports healthy.

That is the same shape as the 95-day Best Buy freeze, and the same rule applies:
a check that only watches run history cannot see it, because nothing failed.

**The watcher is `scripts/deploy-freshness-report.cjs`**, run as a step in
`ingest-outcome-watch.yml` alongside the two ingest watchers (18:00 UTC daily,
twelve hours after the 06:00 prerender, so there is no race with an in-flight
deploy). It ignores run history entirely and compares what the live host serves
against what `main` committed:

```sh
node scripts/deploy-freshness-report.cjs --url=https://prorigbuilder.com/ \
  --dist=dist/index.html --sitemap=dist/sitemap.xml
```

**Two signals, because each is blind where the other sees.** This is the part
worth understanding before trusting it:

| signal | catches | blind to |
|---|---|---|
| entry bundle `assets/index-<hash>.js` | any change to the built JS | a nightly that changed only catalog content — the hash **repeated on 6 of the last 25 builds**, so a freeze beginning on one of those nights reads as current. Aug 12 → Aug 13 is a real instance |
| `sitemap.xml` (content digest) | route additions and removals, and the build date it stamps into every `<lastmod>` | drift **inside a single day** — `<lastmod>` is day-granular, so two builds dated the same day are indistinguishable by it |

Either one disagreeing is red. The sitemap is compared by digest; `<lastmod>` and
the `<loc>` count are extracted only to say *how far* behind in the message,
because "4 days and 31 routes behind" is actionable and "digests differ" is not.

Verified against the live site in all three directions, 2026-08-19: red on the
real drift with both signals firing and both hashes named, green when pointed at
the commit whose build is actually live, and red — not quietly green — when the
host is unreachable or serving a shell. 16 tests.

Measured while writing this: `main` carried `index-C7Z5usPQ.js` and the apex
served `index-DXvLsYDC.js` — **one nightly behind**, and the sitemap showed the
live site with **5,099 URLs against main's 5,068**. Note the direction on that
second one: the live site has *more* routes than `main`, so the most recent
prerender dropped 31. That is worth a look on its own account and is not
something this watcher is trying to tell you.

### Verifying a deploy landed

The header checks in §7 step 7 are the fast ones and they are cheap enough to run
after any deploy that worries you. The real check is still the pair in the status
block at the top: `bytediff-pages.mjs` for byte transparency, `cp3-pages.mjs` for
the assertions. Neither is wired into the deploy path.

### What is still hand-pressed

- the zone Cache Rule for `/assets/*` (`DESIGN-cloudflare-pages.md` §6) — a
  post-cutover performance item, still not added
- reintroducing any §3.4 feature, one at a time with CP-3 between each — none has
  been reintroduced, which means Rocket Loader, Email Obfuscation, Auto Minify and
  Polish/Mirage are all still off. That is the safe state; it is also not
  necessarily the state anyone chose to keep
