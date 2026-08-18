# Newegg census — where it stands

Written 2026-08-18. Everything below is from run artifacts, not memory.

## The verdict: there isn't one yet, and that is correct

Latest census — **run [32078178352](https://github.com/tiereduptech/pro-rig-builder/actions/runs/32078178352)**, 2026-08-17 23:05Z, red:

```
dead 0 · pending 443 · unbuyable 0 · orphaned 0 · alive 2320 · unknown 0
```

`dead`, `unbuyable` and `unknown` are zero **because the census abstained**, not
because they were measured empty. `orphaned` is a true zero (`orphanRows: []`,
none quarantined). Nothing here is a basis for quarantine.

**The MKPL suppression did lift.** PR #8 worked: `coverageComplete: true`,
`suppression: null`, `excludedFeeds: []`. MKPL is now *ignored at discovery*
rather than *excluded as unread coverage*, so it no longer withholds anything.

Verdicts were withheld for a **different** rule: `sameSnapshotAsLastRun: true`.
The run re-read the byte-identical feed run 32067140458 had already streamed —
`44583_4681679_mp.txt.gz@1786997275000:157027503`, mtime 2026-08-17T20:07:55Z.
A re-read of one file is one observation, not a confirmation, so no strike advanced.

**The 443 are at strike one, not strike two.** The prior run's 430 strikes were
earned while MKPL went unread and were discarded on arrival; run 32078178352 is
the first *complete* census. Every entry in its state is `n: 1`.

Three numbers, all consistent, different key spaces: **443 pending deal-rows →
438 distinct products → 430 Newegg feed keys carrying strikes** (a product's
open-box and main rows share one key).

## What runs now, unattended

`newegg-feed-watch.yml` — every 30 min at **:07 and :37** (PRs #9, #10).

One `sftp.list()` over three directories. No download, no parse, seconds. It
rebuilds the census's own snapshot id (`name@mtime:size`, sorted, joined) from
discovery alone and **dispatches the census only when that id moves** off the
one the census last read. It records what it fired for, so a snapshot cannot
trigger twice.

Exit codes: `0` hold · `10` dispatch · `11` alarm · `12` dispatch **and** alarm ·
`1` the watcher itself is broken. Dispatch and alarm are deliberately
independent — an alarm must never cancel the census it is warning about.

**The alarm.** Red at **3 days** without a new mtime; escalated past **14 days**,
where the census excludes the feed and suppresses every death verdict. Measured
from Newegg's timestamp, never from when the watcher noticed — state expires,
and a watcher measuring its own memory would call a 2023 feed fresh once it forgot.

A red `newegg-feed-watch` run means **Newegg stopped publishing**. It is not a
bug in the watcher. Check the Rakuten endpoint before assuming the catalog is healthy.

## What you should see when it fires

1. A green `Newegg feed watch` run whose summary says **Census dispatched**.
2. `Newegg dead-SKU audit` starts within a minute, runs ~10 min (~4 min download,
   ~9 min stream of ~1.03M records).
3. If it condemns: **green**, header reads `RESULT — Newegg link census` rather
   than `CENSUS ONLY — NOT A VERDICT`, and `dead` is non-zero. Report and state
   land as artifacts `newegg-dead-sku-audit` / `-state`.

**Expect fewer than 443 deaths.** Only skus absent in *both* snapshots convert;
anything that reappears resets. That is the two-strike rule working — the same
discipline that stopped the Best Buy bulk pass falsely condemning 1,039 SKUs.

If it comes back red, open it and read the `✗ VERDICTS WITHHELD` reasons. The
census states its own grounds for abstaining; it does not fail silently.

## One trap, already fixed — do not reintroduce it

The census fetched prior strikes with `gh run list --status success`. **A census
that cannot condemn exits 1 by design**, so that filter discarded exactly the
runs whose state mattered, and the strike chain could never advance past one.
Both lookups now go **by artifact name**, newest non-expired first, regardless
of conclusion. `priorStreakIsBlind()` still discards blind strikes independently,
so a failed run's state is safe to carry.

## Open threads

- The 443 pending need **one** more feed publish (~1 day) to reach a verdict.
- 1,725 Newegg rows have no other priced retailer, so whatever this reports is
  the difference between a link cleanup and a catalog shrink.
- `probe-bestbuy-price-truth.mjs` against live PDPs is still what settles whether
  the Best Buy price disagreement is drift or the comp-value bug. Unrelated to this.
