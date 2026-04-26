# ================================================================================
#  publish-scanner-release.ps1
#  ---
#  Publishes a new GitHub release for ProRigScanner.exe so the in-app auto-updater
#  can find and download it. Uses the GitHub REST API directly - no `gh` CLI needed.
#
#  USAGE (from cmd.exe or PowerShell, run from anywhere):
#      powershell -File publish-scanner-release.ps1 -Version 2.1.0
#
#  REQUIREMENTS:
#      1. C:\SignedOutput\ProRigScanner.exe must exist (run BUILD.bat first).
#      2. A GitHub Personal Access Token with `repo` scope must be saved in:
#         %USERPROFILE%\.prorig-github-token
#         (Generate at https://github.com/settings/tokens - classic token, repo scope.)
#      3. The version you pass must be NEWER than the latest release tag.
# ================================================================================

param(
    [Parameter(Mandatory=$true)]
    [string]$Version,

    [string]$ExePath = "C:\SignedOutput\ProRigScanner.exe",

    [string]$Repo = "tiereduptech/pro-rig-builder",

    [string]$ReleaseNotes = ""
)

$ErrorActionPreference = "Stop"

# -- Validate version format (must be x.y.z) --
if ($Version -notmatch '^\d+\.\d+\.\d+$') {
    Write-Error "Version must be in format X.Y.Z (e.g., 2.1.0)"; exit 1
}
$Tag = "scanner-v$Version"

# -- Load PAT --
$tokenFile = Join-Path $env:USERPROFILE ".prorig-github-token"
if (-not (Test-Path $tokenFile)) {
    Write-Error "GitHub token not found at: $tokenFile`n`nCreate it once:`n  1. Go to https://github.com/settings/tokens`n  2. Click 'Generate new token (classic)' - give it the 'repo' scope`n  3. Save the token text into: $tokenFile  (one line, no quotes)"
    exit 1
}
$token = (Get-Content $tokenFile -Raw).Trim()
if ([string]::IsNullOrWhiteSpace($token)) { Write-Error "Token file is empty"; exit 1 }

# -- Validate exe exists --
if (-not (Test-Path $ExePath)) {
    Write-Error "Signed exe not found at: $ExePath`nRun BUILD.bat in pchw-scanner first."; exit 1
}
$exeFile = Get-Item $ExePath
$exeSizeMB = [math]::Round($exeFile.Length / 1MB, 1)
Write-Host "Found exe: $ExePath ($exeSizeMB MB)"

# -- Verify the exe is signed (basic safety check) --
$sig = Get-AuthenticodeSignature $ExePath
if ($sig.Status -ne 'Valid') {
    Write-Warning "WARNING: exe Authenticode status is '$($sig.Status)' - auto-updater will REJECT it on user machines!"
    $ans = Read-Host "Continue anyway? (y/N)"
    if ($ans -ne 'y') { exit 1 }
}

# -- Check tag doesn't already exist --
$headers = @{
    "Authorization" = "Bearer $token"
    "Accept"        = "application/vnd.github+json"
    "User-Agent"    = "ProRigScanner-Release-Script"
}
try {
    $existing = Invoke-RestMethod -Uri "https://api.github.com/repos/$Repo/releases/tags/$Tag" -Headers $headers -ErrorAction Stop
    Write-Error "Release '$Tag' already exists (id: $($existing.id)). Bump the version or delete the existing release on GitHub first."
    exit 1
} catch {
    if ($_.Exception.Response.StatusCode -ne 404) {
        Write-Error "Unexpected error checking existing tag: $($_.Exception.Message)"; exit 1
    }
    # 404 = tag does not exist -> good, we can proceed
}

# -- Auto-generate release notes if none provided --
if ([string]::IsNullOrWhiteSpace($ReleaseNotes)) {
    $ReleaseNotes = "Pro Rig Scanner v$Version`n`nAuto-update release. The scanner will download this automatically on next launch."
}

# -- Create the release --
Write-Host "Creating release '$Tag'..."
$createBody = @{
    tag_name = $Tag
    name     = "Pro Rig Scanner v$Version"
    body     = $ReleaseNotes
    draft    = $false
    prerelease = $false
} | ConvertTo-Json

$release = Invoke-RestMethod -Method POST -Uri "https://api.github.com/repos/$Repo/releases" -Headers $headers -Body $createBody -ContentType "application/json"
Write-Host "  Release id: $($release.id)"
Write-Host "  URL: $($release.html_url)"

# -- Upload the exe as an asset --
$uploadUrl = $release.upload_url -replace '\{[^\}]+\}', ''
$uploadUrl = "$uploadUrl" + "?name=ProRigScanner.exe"

Write-Host "Uploading exe ($exeSizeMB MB) - this can take a minute or two..."
$uploadHeaders = @{
    "Authorization" = "Bearer $token"
    "Content-Type"  = "application/octet-stream"
    "User-Agent"    = "ProRigScanner-Release-Script"
}
$asset = Invoke-RestMethod -Method POST -Uri $uploadUrl -Headers $uploadHeaders -InFile $ExePath
Write-Host "  Asset uploaded. Download URL:"
Write-Host "  $($asset.browser_download_url)"

Write-Host ""
Write-Host "================================================================"
Write-Host " Release published successfully."
Write-Host " Tag:       $Tag"
Write-Host " Page:      $($release.html_url)"
Write-Host " Asset:     ProRigScanner.exe ($exeSizeMB MB)"
Write-Host ""
Write-Host " The scanner's auto-updater will pick this up on the next launch."
Write-Host "================================================================"
