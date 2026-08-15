# Cloudflare Pages — cutover

Copyright © 2026 TieredUp Tech, Inc.

Status: **not started.** The artifact is deployed and verified on
`prorigbuilder.pages.dev` (production channel, 2026-08-15). No custom domain is
attached, so nothing here has touched `prorigbuilder.com` yet.

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
| **Email Obfuscation** | rewrites email-shaped text and injects a script. Corrupts any address inside JSON-LD or a meta description |
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
host check in the resolver**, not Cloudflare Access:

```js
if (new URL(request.url).host.endsWith('.pages.dev')) headers.set('X-Robots-Tag', 'noindex');
```

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

---

## 4. The sequence

```
settle apex ownership (§0)
  -> enumerate zone config (§3)
  -> attach pages-canary.prorigbuilder.com + noindex transform rule (§2)
  -> byte-transparency diff + §4.3 + CP-3 against the canary   <- the real verification
  -> clear §3 items 1-6
  -> re-run all three against the canary       <- confirms the clearing
  -> ship the .pages.dev host check in the resolver (§3.7)
  -> attach prorigbuilder.com as a Pages custom domain
  -> §4.3 + CP-3 against the apex, immediately
  -> delete the canary hostname
  -> set CF_PAGES_AUTO_DEPLOY=true
  -> zone Cache Rule for /assets/* (DESIGN §6)
  -> reintroduce any §3.4 feature you want back, one at a time, CP-3 between each
```

`CF_PAGES_AUTO_DEPLOY` comes **after** the flip is verified, for the reason
`deploy-pages.yml` states in its gating comment: until it is set, no commit to
`main` can move a Cloudflare deployment. Setting it earlier means an ordinary
commit ships the apex as a side effect, which is the trap
`DESIGN-pull-deploy.md` records for `EPIK_PULL_AUTO_PUBLISH`.

### The byte-transparency diff — run this one first

CP-3 asserts specific tags. The zone's HTML-rewriting features (§3.4) can alter
anything, including bytes no assertion names. The sharper test is to compare what
the host serves against what is on disk:

```sh
HOST=https://pages-canary.prorigbuilder.com
for f in $(find dist/parts -name index.html | shuf -n 12); do
  u="${f#dist}"; u="${u%/index.html}"
  curl -s "$HOST$u" | diff -q - "$f" >/dev/null || echo "REWRITTEN: $u"
done
```

Silence means the pipeline is byte-transparent. This has a known-good baseline:
on 2026-08-15 the `pages.dev` alias returned `dist/404.html` with a matching
sha256 (`1f9b9cc2…`), so the Pages edge itself alters nothing. Any diff that
appears on the canary and not on `pages.dev` is the zone, and §3.4 names the
likely culprit — Rocket Loader first.

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

What does *not* roll back with it:

- **anything cached at the edge** while a §3.3 rule was active — purge everything
- **HSTS** pins, if §3.6 is on
- **`VITE_DATA_BASE`**, if it has been set by then. `DESIGN-cloudflare-pages.md`
  §10 is explicit: the bundle is *committed*, so clearing the variable fixes
  nothing until another full prerender run rebuilds it. No redeploy undoes it

---

## 6. Still unknown after all of the above

Stated so it is not mistaken for covered:

- **Apex-scoped rules.** The canary exercises everything except rules whose
  expression names the apex host or an apex path. Those are read by hand (§3.2) and
  are the one place where the first real measurement happens on live traffic.
- **Load.** All 5,484 product pages invoke the Function (`DESIGN` §5). The work is
  one `next()` and a status check, and nothing here has measured it at production
  request rates.
- **Search Console.** The 308-on-every-canonical failure §4.2 exists to prevent is
  visible in Search Console days *after* it would be visible in curl. Watch
  "Page with redirect" and "Crawled – currently not indexed" for two weeks past
  cutover; a clean §4.3 is a necessary and not a sufficient condition.
