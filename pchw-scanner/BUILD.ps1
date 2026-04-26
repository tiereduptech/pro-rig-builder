# =============================================================================
#  BUILD.ps1  -  ProRigScanner build, sign, archive, optionally publish
#
#  Run from cmd.exe or PowerShell:
#      .\BUILD.ps1                       (dev build at current version)
#      .\BUILD.ps1 -Bump                 (patch-bump version, then build)
#      .\BUILD.ps1 -Bump -Publish        (bump + build + publish to GitHub)
#      .\BUILD.ps1 -Publish              (build at current version, publish to GitHub)
#
#  Outputs:
#      C:\SignedOutput\ProRigScanner.exe                 (always-latest, what users get)
#      C:\SignedOutput\archive\ProRigScanner-X.Y.Z.exe   (versioned snapshot)
#
#  This script replaces BUILD.bat. Native PowerShell is cleaner for the version
#  bump + flag handling, and avoids cmd's '!' escape headaches.
# =============================================================================

[CmdletBinding()]
param(
    [switch]$Bump,
    [switch]$Publish,
    [string]$CSPassword = ""
)

$ErrorActionPreference = "Stop"

# ---------- TOGGLES ----------
$OBFUSCATE = $true

# ---------- CONFIG ----------
$AppName       = "ProRigScanner"
$ProjectDir    = $PSScriptRoot
$Csproj        = Join-Path $ProjectDir "$AppName.csproj"
$PublishDir    = Join-Path $ProjectDir "bin\Release\net8.0-windows\win-x64\publish"
$BuildOutput   = Join-Path $PublishDir "$AppName.exe"

$CodesignDir   = "C:\CodeSignTool"
$CodesignBat   = Join-Path $CodesignDir "CodeSignTool.bat"
$StagingExe    = Join-Path $CodesignDir "$AppName.exe"

$SignedDir     = "C:\SignedOutput"
$SignedArchive = Join-Path $SignedDir "archive"
$SignedExe     = Join-Path $SignedDir "$AppName.exe"
$Shortcut      = Join-Path $SignedDir "$AppName.lnk"

$PublishScript = Join-Path $ProjectDir "..\publish-scanner-release.ps1"

# eSigner credentials
$CsUsername     = "tiereduptech"
$CsCredentialId = "13b6d98a-579d-44a3-b9ca-6f891b7839f9"
$CsTotp         = "8JiV0YtB7t7QfP5ffjqIi7sj9AKcawZDp3D8FTVo0rM="

# =============================================================================
#  STEP 0a: bump patch version in csproj if requested
# =============================================================================
if ($Bump) {
    Write-Host "Bumping patch version..."
    if (-not (Test-Path $Csproj)) { throw "csproj not found at $Csproj" }
    $text = [IO.File]::ReadAllText($Csproj)
    if ($text -notmatch '<Version>(\d+)\.(\d+)\.(\d+)</Version>') {
        throw "Could not find <Version>X.Y.Z</Version> in $Csproj"
    }
    $maj = [int]$Matches[1]
    $min = [int]$Matches[2]
    $pat = [int]$Matches[3] + 1
    $newVer     = "$maj.$min.$pat"
    $newVerFull = "$newVer.0"
    $text = $text -replace '<Version>\d+\.\d+\.\d+</Version>',                       "<Version>$newVer</Version>"
    $text = $text -replace '<AssemblyVersion>\d+\.\d+\.\d+\.\d+</AssemblyVersion>',  "<AssemblyVersion>$newVerFull</AssemblyVersion>"
    $text = $text -replace '<FileVersion>\d+\.\d+\.\d+\.\d+</FileVersion>',          "<FileVersion>$newVerFull</FileVersion>"
    $text = $text -replace '<InformationalVersion>\d+\.\d+\.\d+</InformationalVersion>', "<InformationalVersion>$newVer</InformationalVersion>"
    [IO.File]::WriteAllText($Csproj, $text)
    Write-Host "  Bumped to v$newVer"
}

# =============================================================================
#  STEP 0b: read current version from csproj
# =============================================================================
$csprojText = Get-Content $Csproj -Raw
if ($csprojText -notmatch '<Version>([\d\.]+)</Version>') {
    throw "Could not read <Version> from $Csproj"
}
$AppVersion   = $Matches[1]
$VersionedExe = Join-Path $SignedArchive "$AppName-$AppVersion.exe"

Write-Host ""
Write-Host "Building $AppName v$AppVersion"
Write-Host ""

# =============================================================================
#  STEP 1: kill running instance
# =============================================================================
Write-Host "[1/8] Stopping any running $AppName..."
Get-Process -Name $AppName -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue

# =============================================================================
#  STEP 2: clean publish folder
# =============================================================================
Write-Host "[2/8] Cleaning old publish output..."
if (Test-Path $PublishDir) { Remove-Item -Recurse -Force $PublishDir -ErrorAction SilentlyContinue }

# =============================================================================
#  STEP 3: dotnet publish
# =============================================================================
$obfTag = if ($OBFUSCATE) { "with obfuscation ON" } else { "single-file self-contained" }
Write-Host "[3/8] Publishing $AppName v$AppVersion - $obfTag..."
$pubArgs = @("publish", "-c", "Release", "-r", "win-x64", "--self-contained", "true")
if ($OBFUSCATE) { $pubArgs += "/p:Obfuscate=true" }

Push-Location $ProjectDir
try {
    & dotnet @pubArgs
    if ($LASTEXITCODE -ne 0) {
        Write-Host ""
        Write-Host "PUBLISH FAILED" -ForegroundColor Red
        exit 1
    }
} finally {
    Pop-Location
}

if (-not (Test-Path $BuildOutput)) {
    throw "Published exe not found: $BuildOutput"
}
Write-Host "  Published exe: $BuildOutput"

# =============================================================================
#  STEP 4: check CodeSignTool exists
# =============================================================================
if (-not (Test-Path $CodesignBat)) {
    Write-Host ""
    Write-Host "========================================="
    Write-Host " WARNING: CodeSignTool not found at:"
    Write-Host "   $CodesignBat"
    Write-Host " Skipping signing. Unsigned exe at:"
    Write-Host "   $BuildOutput"
    Write-Host "========================================="
    exit 0
}

# =============================================================================
#  STEP 5: get password
# =============================================================================
if ([string]::IsNullOrEmpty($CSPassword)) {
    $secure = Read-Host "Enter eSigner password" -AsSecureString
    $CSPassword = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    )
}
if ([string]::IsNullOrEmpty($CSPassword)) {
    throw "Password is required."
}

# =============================================================================
#  STEP 6: stage exe + ensure output folders exist
# =============================================================================
Write-Host "[4/8] Preparing signed output folders..."
if (-not (Test-Path $SignedDir))     { New-Item -ItemType Directory -Path $SignedDir     | Out-Null }
if (-not (Test-Path $SignedArchive)) { New-Item -ItemType Directory -Path $SignedArchive | Out-Null }
if (Test-Path $SignedExe) { Remove-Item -Force $SignedExe }

Write-Host "  Staging exe to $StagingExe"
Copy-Item -Path $BuildOutput -Destination $StagingExe -Force

# =============================================================================
#  STEP 7: sign with CodeSignTool
# =============================================================================
Write-Host "[5/8] Signing with CodeSignTool SSL.com eSigner - this may take 30-60 sec..."
Push-Location $CodesignDir
try {
    # Note: passing password as a plain arg is required by CodeSignTool. Powershell
    # passes args without backslash-eating, so '!!' survives intact unlike cmd.exe.
    $signOutput = & cmd.exe /c "CodeSignTool.bat sign -username=`"$CsUsername`" -password=`"$CSPassword`" -credential_id=`"$CsCredentialId`" -totp_secret=`"$CsTotp`" -input_file_path=`"$StagingExe`" -output_dir_path=`"$SignedDir`" 2>&1"
    $signExit = $LASTEXITCODE
    $signOutput | ForEach-Object { Write-Host "  $_" }
} finally {
    Pop-Location
}

if ($signExit -ne 0) {
    Write-Host ""
    Write-Host "ERROR: CodeSignTool exited with code $signExit" -ForegroundColor Red
    exit 1
}
if (-not (Test-Path $SignedExe)) {
    throw "Signed exe not created at $SignedExe"
}

# =============================================================================
#  STEP 8: archive versioned copy
# =============================================================================
Write-Host "[6/8] Archiving versioned copy..."
Copy-Item -Path $SignedExe -Destination $VersionedExe -Force

# =============================================================================
#  STEP 9: copy signed back to publish folder (so dev runs use signed binary)
# =============================================================================
Write-Host "[7/8] Copying signed exe back to publish folder..."
Copy-Item -Path $SignedExe -Destination $BuildOutput -Force

# =============================================================================
#  STEP 10: shortcut with Run-as-Admin bit
# =============================================================================
Write-Host "[8/8] Creating Run-as-Administrator shortcut..."
$wsh = New-Object -ComObject WScript.Shell
$lnk = $wsh.CreateShortcut($Shortcut)
$lnk.TargetPath       = $SignedExe
$lnk.WorkingDirectory = $SignedDir
$lnk.IconLocation     = $SignedExe
$lnk.Save()
# Set the "Run as administrator" bit (byte 0x15 of the .lnk file)
$bytes = [IO.File]::ReadAllBytes($Shortcut)
$bytes[0x15] = $bytes[0x15] -bor 0x20
[IO.File]::WriteAllBytes($Shortcut, $bytes)

# =============================================================================
#  Done summary
# =============================================================================
Write-Host ""
Write-Host "========================================="
Write-Host " DONE"
Write-Host "========================================="
Write-Host " Version:        $AppVersion"
Write-Host " Obfuscation:    $(if ($OBFUSCATE) { 'ON' } else { 'OFF' })"
Write-Host " Version bumped: $(if ($Bump) { 'YES' } else { 'no' })"
Write-Host " Signed exe:     $SignedExe"
Write-Host " Versioned copy: $VersionedExe"
Write-Host " Shortcut:       $Shortcut"
Write-Host "========================================="

# =============================================================================
#  Optional: publish to GitHub
# =============================================================================
if ($Publish) {
    if (-not (Test-Path $PublishScript)) {
        Write-Host ""
        Write-Host "WARNING: publish script not found at $PublishScript - skipping upload" -ForegroundColor Yellow
        exit 0
    }
    Write-Host ""
    Write-Host "Publishing to GitHub..."
    & $PublishScript -Version $AppVersion
} else {
    Write-Host ""
    Write-Host " Test the build, then publish to GitHub:"
    Write-Host "   .\BUILD.ps1 -Publish        (publishes current version)"
    Write-Host "   powershell -File `"$PublishScript`" -Version $AppVersion"
    Write-Host "========================================="
}
