# Case dimensions: the coverage ceiling

**Status as of 2026-08-19.** Read this before assuming the Case filters work.

`maxGPU`, `maxCooler` and `rads` are the specs people actually pick a case by,
and they are the emptiest filters on the site: **974 of 1,221 visible cases are
missing at least one of the three.** The important part is not the size of the
gap, it is that most of it cannot currently be closed at all.

## The number that matters

| | rows |
|---|---|
| Visible cases | 1,221 |
| Missing ≥1 of maxGPU / maxCooler / rads | 974 |
| Reachable today (Amazon spec table, ~$0.0015/row) | **91** |
| **No dimension source of any kind** | **883** |

Even after spending everything there is to spend, the three filters top out at
roughly **28% coverage**. The remaining 883 rows are not waiting on a budget or
a backfill run; there is nowhere to get the numbers from.

## Why the 883 are stranded

All but three came in through `newegg-case-discovery`, and 880 of them are
Newegg-only listings:

```
by retailer         newegg 880 · newegg_marketplace 37 · newegg_openbox 24 · bestbuy 7
by ingest source    newegg-case-discovery 880 · bestbuy-case-discovery 2 · amazon-discovery 1
```

The Newegg SFTP feed carries no dimensions — no GPU clearance, no cooler height,
no radiator support. The rows are otherwise fine (name, price, image, stock all
current), so nothing looks broken about them; they are simply invisible to three
filters. Brands hit hardest: Thermaltake (85), ASUS (45), Fractal Design (41),
SilverStone (38), Cougar (36), Montech (34), Lian Li (31), Zalman (26).

## What has already been ruled out

Do not re-derive these. `audit-case-spec-sources.cjs` scores every available
source against the rows enriched from Amazon spec tables, which is where every
value we trust came from:

| source | maxGPU | maxCooler | rads |
|---|---|---|---|
| product titles | 25% | unverifiable | **0%** |
| `backfill-case-specs.js` dictionary | 38% | 38% | **4%** |
| `enrich-case-specs.cjs` KNOWN_SPECS | 32% | 54% | 60% |

Also measured and rejected: `mobo` from the title's stated form factor (31%),
and the same with form factors expanded down the ATX nesting (43%) — the stored
`mobo` values are not internally consistent enough to validate against.

Two failure modes recur, and neither is a tighter regex away from working:

- **The dictionaries are prefix-loose.** `/Fractal.*Meshify 2/` also matches
  "Meshify 2 Compact" and hands the smaller case the full-size model's 491mm.
- **Titles answer a different question.** `rads` is the *list* of radiator sizes
  a case supports; a title states only the largest. "Up to 420mm" becomes
  `[420]`, which does not merely lose 240/280/360 — it asserts they do not fit.

A missing `maxGPU` means a case is absent from a filter someone is using. A
wrong one means a case that cannot fit their card is shown to them as fitting
it, and they find out after it ships. That asymmetry is why the gap stays open.

## What would actually close it

A vendor spec table for Newegg listings — the Newegg equivalent of what
`dataforseo-enrich-cases.js` does against Amazon ASINs. Until that exists:

- `node audit-case-spec-sources.cjs` re-runs the measurement and rewrites
  `verify-reports/case-spec-sources-<date>.json`. Run it before trusting any new
  idea for filling these fields, including your own.
- `backfill-case-specs.js` has its dictionary pass disabled in place, with the
  accuracy numbers attached. It is left readable because the shape of it is
  exactly what makes it tempting — 175 tidy patterns that fill 550 rows and
  print a satisfying `+550`.
