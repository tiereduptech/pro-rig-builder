$attempt = 1
$maxAttempts = 30
while ($attempt -le $maxAttempts) {
  Write-Host ""
  Write-Host "============================================" -ForegroundColor Cyan
  Write-Host " ATTEMPT $attempt of $maxAttempts" -ForegroundColor Cyan
  Write-Host "============================================" -ForegroundColor Cyan
  Write-Host ""
  
  $done = (Get-ChildItem -Path "dist/parts" -Recurse -Filter "*.html" -ErrorAction SilentlyContinue | Measure-Object).Count
  Write-Host "Pages already rendered: $done / 5290" -ForegroundColor Green
  
  if ($done -ge 5290) {
    Write-Host "ALL PAGES DONE!" -ForegroundColor Green
    break
  }
  
  node prerender.cjs --incremental --concurrency=2 2>&1 | Tee-Object -FilePath "prerender-attempt-$attempt.log"
  
  $exitCode = $LASTEXITCODE
  Write-Host "Exit code: $exitCode" -ForegroundColor Yellow
  
  Start-Sleep -Seconds 5
  $attempt++
}

$finalCount = (Get-ChildItem -Path "dist/parts" -Recurse -Filter "*.html" -ErrorAction SilentlyContinue | Measure-Object).Count
Write-Host ""
Write-Host "FINAL: $finalCount / 5290 pages rendered" -ForegroundColor Cyan
