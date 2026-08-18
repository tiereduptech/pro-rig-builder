# Bug: `b` names a manufacturer the product does not come from

Found 2026-08-18 while testing why the ASIN identity audit over-reports.
Not a link defect and not a price defect — the catalog's own `b` field is wrong
on rows whose Amazon link is fine.

## What it looks like

| id | cat | `b` says | `n` says | reality |
|----|-----|----------|----------|---------|
| 100375 | CaseFan | `MSI` | NZXT F360 RGB Core | NZXT |
| 101143 | CaseFan | `MSI` | Thermalright TL-C12C-S | Thermalright |
| 100537 | Case | `MSI` | Fractal Design Core 1100 | Fractal Design |
| 100982 | CPUCooler | `MSI` | Cooler Master MasterLiquid ML240L V2 | Cooler Master |
| 103013 | Case | `Corsair` | Thermaltake View 370 TG ARGB | Thermaltake |
| 103211 | Case | `ASUS` | LIAN LI O11 Dynamic XL ROG | Lian Li |
| 101020 | Monitor | `AMD` | Acer Nitro 27" WQHD | Acer |
| 100905 | CPUCooler | `AMD` | ID-COOLING SE-214-XT V2 ARGB | ID-COOLING |
| 100933 | CPUCooler | `AMD` | PCCOOLER RC600-67 | PCCOOLER |
| 100091 | Webcam | `Microsoft` | Brio 4K Webcam | Logitech |
| 101128 | CaseFan | `MSI` | 7PCS ARGB Fan (UTLGAMENG on Amazon) | UTLGAMENG |
| 100013 | Keyboard | `Budget` | Gaming Keyboard (TECKNET on Amazon) | TECKNET |

`Budget` and `Misc` are not manufacturers at all.

## Extent

**135 of 6,938 rows** fail a strict test: `b` does not appear anywhere in `n`,
**and** `n` leads with a *different* brand that at least three other rows use as
their own `b`.

```
node -e '…'   # see "Reproducing" below
```

Concentration by the wrong value:

```
21  b="Micro Center"      14  b="MSI"        8  b="SanDisk"
18  b="SP Silicon Power"  11  b="Rode"       8  b="Western Digital"
15  b="Patriot Memory"     8  b="Corsair"    6  b="ASRock"
```

135 is a **floor, not a total**. The test only fires when the true brand is
already common enough elsewhere in the catalog to be recognised, so a wrong
brand on a product from a vendor we stock only once is invisible to it.

Two clusters inside the 135 are arguably *not* defects and should be triaged
before any bulk rewrite:

- **`Micro Center` (21 rows)** — CPU+motherboard bundle SKUs. The bundler is
  Micro Center; the name leads with `AMD` because the CPU does. Which one
  belongs in `b` is a product decision, not a data error.
- **`SP Silicon Power` (18 rows)** — a naming variant of `Silicon Power`, not a
  different company. This is a normalisation problem.

The unambiguous cross-brand contamination — `MSI` on NZXT/Thermalright/Fractal
Design/Cooler Master, `Corsair` on Thermaltake, `ASUS` on Lian Li, `AMD` on
Acer/ID-COOLING/PCCOOLER, `Microsoft` on Logitech — is the part to fix.

## Why it matters beyond the brand facet

It **poisons the ASIN identity audit in both directions**, which is how it was
found. `titleMatches()` reads the brand from the first token of the stored name;
the audit's classifier reads it from `b`. When the two disagree the gate is
comparing a model number against a manufacturer:

- a **correct** link scores as a defect (a row branded `AMD` whose Amazon title
  says `Acer` looks like a different-manufacturer mismatch), and
- a **genuinely wrong** link can be masked, because a wrong `b` that happens to
  match the wrong Amazon listing reads as agreement.

Of the 233 non-dead findings in the 2026-08-17 audit, **88 have a `b` that does
not appear in the Amazon title at all** — and a large share of those are this
bug, not a bad link.

It also makes the brand filter and brand facets quietly wrong: filtering to
`MSI` returns NZXT and Fractal Design cases.

## Status and sequencing

- **The relink review queue is on hold.** `relink-review-queue.json` (233 rows)
  must not be actioned until brand data can be trusted — triaging it today would
  relink products whose only defect is a wrong `b`.
- The gate fix landed separately (`titleMatches(..., brand)`, second-arm
  brand qualification) and clears 44 of the 233 on its own. It reads `b`, so it
  gets *more* accurate as this bug is fixed, and it cannot get worse: the brand
  arm is only consulted after the plain arm has already failed.
- No scheduled job consumes the queue today (`quarantine-wrong-product.mjs` is
  in no workflow), so the hold needs no code change to enforce — but it does
  need to be remembered before anyone wires one up.

## Suspected origin

Not established. Worth checking first: the discovery/apply path, where `b` is
set from a feed's `manufacturer` column rather than from the product title.
`apply-newegg-discoveries.cjs` and `case-ingest.mjs` are the two writers that
touch the affected id ranges (100000+ and 103000+), and the `MSI` cluster points
at rows ingested from an MSI-scoped sweep inheriting the sweep's brand rather
than the row's.

## Reproducing

```js
// node --input-type=module
import { readdirSync } from 'fs'; import { pathToFileURL } from 'url';
const dir='src/data/parts/';
const rows=[];
for (const f of readdirSync(dir).filter(f=>f.endsWith('.js')))
  for (const r of (await import(pathToFileURL(dir+f).href)).default) rows.push(r);

const norm = s => String(s||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
const freq = new Map();
for (const r of rows) { const b = norm(r.b); if (b) freq.set(b,(freq.get(b)||0)+1); }
const known = [...freq.keys()].filter(b => b.length>=3 && freq.get(b)>=3)
                              .sort((a,b)=>b.length-a.length);

const suspect = rows.filter(r => {
  const b = norm(r.b), n = norm(r.n);
  if (!b || !n || n.includes(b)) return false;
  return known.some(k => k!==b && (n===k || n.startsWith(k+' ')));
});
console.log(suspect.length, 'of', rows.length);
```
