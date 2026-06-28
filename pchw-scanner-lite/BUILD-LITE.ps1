# =============================================================================
#  BUILD-LITE.ps1  -  publish + sign + HARD-verify + release the LITE scanner
#  ---
#  Mirrors pchw-scanner/BUILD.ps1 (same SSL.com eSigner CodeSignTool flow, same
#  credentials) minus the WPF-only obfuscation step, plus a HARD signature gate
#  that aborts BEFORE any upload unless the signature is Valid and the cert
#  subject contains "TieredUp Tech". Release/upload is delegated to the existing
#  publish-scanner-release.ps1 (tag scanner-v<ver>, asset ProRigScanner.exe).
#
#  Run from pchw-scanner-lite/:
#      .\BUILD-LITE.ps1                 (build + sign + verify, stop before upload)
#      .\BUILD-LITE.ps1 -Publish        (... then create GitHub release + upload)
#      .\BUILD-LITE.ps1 -Publish -CSPassword '<eSigner pw>'   (non-interactive)
#
#  Runtime secrets:
#      - eSigner PASSWORD  -> prompted (Read-Host) unless -CSPassword is passed.
#        username/credential_id/totp_secret are stored below (same as BUILD.ps1);
#        totp_secret is the SEED, so CodeSignTool derives the OTP itself - there
#        is NO interactive 6-digit TOTP prompt in stored-secret mode.
#      - GitHub PAT        -> read by publish-scanner-release.ps1 from
#        %USERPROFILE%\.prorig-github-token (no runtime entry).
# =============================================================================
[CmdletBinding()]
param(
    [switch]$Publish,
    [string]$CSPassword = ""
)
$ErrorActionPreference = "Stop"

# ---------- CONFIG ----------
$AppName     = "ProRigScanner"                       # output MUST be ProRigScanner.exe
$ProjectDir  = $PSScriptRoot
$Csproj      = Join-Path $ProjectDir "ProRigScannerLite.csproj"
$PublishDir  = Join-Path $ProjectDir "bin\Release\net8.0-windows\win-x64\publish"
$BuildOutput = Join-Path $PublishDir "$AppName.exe"

$CodesignDir = "C:\CodeSignTool"
$CodesignBat = Join-Path $CodesignDir "CodeSignTool.bat"
$StagingExe  = Join-Path $CodesignDir "$AppName.exe"
$SignedDir   = "C:\SignedOutput"
$SignedExe   = Join-Path $SignedDir "$AppName.exe"
$PublishScript = Join-Path $ProjectDir "..\publish-scanner-release.ps1"

# eSigner credentials - identical to pchw-scanner/BUILD.ps1.
# totp_secret is the SEED (CodeSignTool derives the OTP itself -> no manual TOTP).
$CsUsername     = "tiereduptech"
$CsCredentialId = "13b6d98a-579d-44a3-b9ca-6f891b7839f9"
$CsTotp         = "8JiV0YtB7t7QfP5ffjqIi7sj9AKcawZDp3D8FTVo0rM="

# ---------- read version from csproj (expect 2.3.0) ----------
$csprojText = Get-Content $Csproj -Raw
if ($csprojText -notmatch '<Version>([\d\.]+)</Version>') { throw "No <Version> in $Csproj" }
$AppVersion = $Matches[1]
Write-Host "Building LITE $AppName v$AppVersion (single-file, no obfuscation)"

# ---------- [1/5] publish single-file self-contained ----------
Get-Process -Name $AppName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if (Test-Path $PublishDir) { Remove-Item -Recurse -Force $PublishDir -ErrorAction SilentlyContinue }
Push-Location $ProjectDir
try {
    & dotnet publish -c Release -r win-x64 --self-contained true   # NO /p:Obfuscate (lite has none)
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed" }
} finally { Pop-Location }
if (-not (Test-Path $BuildOutput)) { throw "Published exe not found: $BuildOutput" }
Write-Host "  Published: $BuildOutput ($([math]::Round((Get-Item $BuildOutput).Length/1MB,1)) MB)"

# ---------- [2/5] eSigner password (ONLY interactive secret) ----------
if (-not (Test-Path $CodesignBat)) { throw "CodeSignTool not found at $CodesignBat" }
if ([string]::IsNullOrEmpty($CSPassword)) {
    $secure = Read-Host "Enter eSigner password" -AsSecureString
    $CSPassword = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
}
if ([string]::IsNullOrEmpty($CSPassword)) { throw "Password is required." }

# ---------- [3/5] stage + sign (same CodeSignTool invocation as BUILD.ps1) ----------
if (-not (Test-Path $SignedDir)) { New-Item -ItemType Directory -Path $SignedDir | Out-Null }
if (Test-Path $SignedExe) { Remove-Item -Force $SignedExe }
Copy-Item $BuildOutput $StagingExe -Force
Write-Host "Signing with CodeSignTool (SSL.com eSigner)..."
Push-Location $CodesignDir
try {
    $signOut = & cmd.exe /c "CodeSignTool.bat sign -username=`"$CsUsername`" -password=`"$CSPassword`" -credential_id=`"$CsCredentialId`" -totp_secret=`"$CsTotp`" -input_file_path=`"$StagingExe`" -output_dir_path=`"$SignedDir`" 2>&1"
    $signExit = $LASTEXITCODE
    $signOut | ForEach-Object { Write-Host "  $_" }
} finally { Pop-Location }
if ($signExit -ne 0) { throw "CodeSignTool exited $signExit" }
if (-not (Test-Path $SignedExe)) { throw "Signed exe not created at $SignedExe" }

# ---------- [4/5] HARD verification gate (BEFORE any upload) ----------
$sig = Get-AuthenticodeSignature $SignedExe
if ($sig.Status -ne 'Valid') {
    throw "ABORT: Authenticode status is '$($sig.Status)' (need 'Valid'). Not uploading."
}
$subject = $sig.SignerCertificate.Subject
if ($subject -notmatch 'TieredUp Tech') {
    throw "ABORT: cert subject does not contain 'TieredUp Tech': $subject. Not uploading."
}
Write-Host "  Signature: Valid | Subject: $subject" -ForegroundColor Green

# ---------- [5/5] release (tag scanner-v$AppVersion, asset ProRigScanner.exe) ----------
if ($Publish) {
    & $PublishScript -Version $AppVersion       # creates scanner-v<ver>, uploads ProRigScanner.exe
} else {
    Write-Host "`nVerified & ready. To release:" -ForegroundColor Cyan
    Write-Host "  .\BUILD-LITE.ps1 -Publish"
    Write-Host "  -- or --  powershell -File `"$PublishScript`" -Version $AppVersion"
}
