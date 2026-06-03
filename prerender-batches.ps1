# =============================================================================
#  prerender-batches.ps1
#  Copyright (c) 2026 TieredUp Tech, Inc.
#
#  Runs prerender.cjs in fixed-size windows, each as a FRESH node process that
#  fully exits between windows. Process death = guaranteed OS-level cleanup of
#  leaked chrome.exe state, which is the root cause of the cascade failure that
#  killed the single-process full prerender around page ~60.
#
#  Static routes render in the first batch only (prerender.cjs gates them on
#  start === 0). The sitemap is written ONCE at the very end via --sitemap-only.
#
#  Usage:
#    powershell -ExecutionPolicy Bypass -File prerender-batches.ps1
#    powershell -ExecutionPolicy Bypass -File prerender-batches.ps1 -BatchSize 200 -Concurrency 6
#    powershell -ExecutionPolicy Bypass -File prerender-batches.ps1 -StartAt 800   # resume from a window
#
#  Notes:
#    * Run `npm run build` (or at least `vite build`) first so dist/ exists.
#    * -StartAt lets you resume after an interrupted run; combine with the
#      -Incremental switch to skip pages already on disk.
# =============================================================================

param(
  [int]    $BatchSize   = 200,
  [int]    $Concurrency = 6,
  [int]    $StartAt     = 0,      # product index to begin at (for resume)
  [switch] $Incremental,          # pass --incremental to each batch
  [switch] $Verbose               # pass --verbose to each batch
)

$ErrorActionPreference = "Stop"

# --- Resolve total product count by asking prerender's own loader ------------
# We reuse scripts/url-slugs.cjs so the count can NEVER drift from what
# prerender.cjs itself will slice.
Write-Host "Counting indexable products..." -ForegroundColor Cyan
$countJs = @'
(async () => {
  const { isIndexable, loadParts, productPath } = require(require("path").join(process.cwd(), "scripts", "url-slugs.cjs"));
  const parts = (await loadParts()).filter(isIndexable);
  const routes = parts.map(p => productPath(p)).filter(Boolean);
  process.stdout.write(String(routes.length));
})();
'@
$countFile = Join-Path $env:TEMP "prb-count.cjs"
$utf8NoBom = New-Object System.Text.UTF8Encoding $false
[System.IO.File]::WriteAllText($countFile, $countJs, $utf8NoBom)

$total = [int](& node $countFile)
Remove-Item $countFile -ErrorAction SilentlyContinue

if ($total -le 0) {
  Write-Host "  X Could not determine product count (got '$total'). Aborting." -ForegroundColor Red
  exit 1
}
Write-Host "  Total product routes: $total" -ForegroundColor Green

# --- Clean stale per-range failure files from a previous run -----------------
Get-ChildItem -Path . -Filter "prerender-failures-*.json" -ErrorAction SilentlyContinue | Remove-Item -Force

# --- Batch loop --------------------------------------------------------------
$incFlag = if ($Incremental) { "--incremental" } else { $null }
$verFlag = if ($Verbose)     { "--verbose" }     else { $null }

$runStart = Get-Date
$batchNum = 0
$anyFailures = $false

for ($start = $StartAt; $start -lt $total; $start += $BatchSize) {
  $end = [Math]::Min($start + $BatchSize, $total)
  $batchNum++

  Write-Host ""
  Write-Host "=== Batch $batchNum : products [$start, $end) of $total ===" -ForegroundColor Cyan

  $args = @(
    "prerender.cjs",
    "--start=$start",
    "--end=$end",
    "--concurrency=$Concurrency"
  )
  if ($start -gt 0) { $args += "--no-static" }
  if ($incFlag) { $args += $incFlag }
  if ($verFlag) { $args += $verFlag }

  # Each batch is its own node process. When it exits, Windows reclaims every
  # chrome.exe it spawned -- no leaked state carries into the next window.
  & node @args
  $code = $LASTEXITCODE

  if ($code -ne 0) {
    $anyFailures = $true
    Write-Host "  ! Batch $batchNum exited with code $code (some pages failed; see prerender-failures-$start-$end.json)" -ForegroundColor Yellow
  }
}

# --- Write sitemap once, from the full product list --------------------------
Write-Host ""
Write-Host "=== Writing sitemap (full product list) ===" -ForegroundColor Cyan
& node prerender.cjs --sitemap-only
if ($LASTEXITCODE -ne 0) {
  Write-Host "  X Sitemap write failed (exit $LASTEXITCODE)." -ForegroundColor Red
}

# --- Aggregate per-range failure files into one ------------------------------
$failFiles = Get-ChildItem -Path . -Filter "prerender-failures-*.json" -ErrorAction SilentlyContinue
if ($failFiles) {
  $allFailures = @()
  foreach ($f in $failFiles) {
    try { $allFailures += (Get-Content $f.FullName -Raw | ConvertFrom-Json) } catch {}
  }
  $json = $allFailures | ConvertTo-Json -Depth 6
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) "prerender-failures.json"), $json, $utf8NoBom)
  Write-Host ""
  Write-Host "  Aggregated $($allFailures.Count) total failures -> prerender-failures.json" -ForegroundColor Yellow
}

# --- Summary -----------------------------------------------------------------
$elapsed = ((Get-Date) - $runStart).ToString("hh\:mm\:ss")
Write-Host ""
Write-Host "============================" -ForegroundColor Green
Write-Host "  Done. $batchNum batches in $elapsed" -ForegroundColor Green
if ($anyFailures) {
  Write-Host "  Some pages failed -- inspect prerender-failures.json, then re-run with:" -ForegroundColor Yellow
  Write-Host "    powershell -ExecutionPolicy Bypass -File prerender-batches.ps1 -Incremental" -ForegroundColor Yellow
  Write-Host "  (Incremental skips pages already on disk, retrying only the gaps.)" -ForegroundColor Yellow
} else {
  Write-Host "  No failures. All product pages prerendered." -ForegroundColor Green
}
Write-Host "============================" -ForegroundColor Green
