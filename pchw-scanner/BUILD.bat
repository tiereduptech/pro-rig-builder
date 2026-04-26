@echo off
setlocal

REM ============================================================
REM  ProRigScanner - Publish, Sign, Package
REM
REM  USAGE:
REM    BUILD.bat          (regular dev build - keeps current version)
REM    BUILD.bat /bump    (bumps patch version in csproj first, then builds)
REM
REM  Outputs:
REM    C:\SignedOutput\ProRigScanner.exe                (always-latest)
REM    C:\SignedOutput\archive\ProRigScanner-X.Y.Z.exe  (versioned snapshot)
REM
REM  Run from cmd.exe (NOT PowerShell).
REM ============================================================

REM ---------- TOGGLES ----------
set "OBFUSCATE=true"

REM ---------- CONFIG ----------
set "APP_NAME=ProRigScanner"
set "PROJECT_DIR=%~dp0"
set "CSPROJ=%PROJECT_DIR%%APP_NAME%.csproj"
set "PUBLISH_DIR=%PROJECT_DIR%bin\Release\net8.0-windows\win-x64\publish"
set "BUILD_OUTPUT=%PUBLISH_DIR%\%APP_NAME%.exe"

set "CODESIGN_DIR=C:\CodeSignTool"
set "CODESIGN_BAT=%CODESIGN_DIR%\CodeSignTool.bat"
set "STAGING_EXE=%CODESIGN_DIR%\%APP_NAME%.exe"

set "SIGNED_DIR=C:\SignedOutput"
set "SIGNED_ARCHIVE_DIR=%SIGNED_DIR%\archive"
set "SIGNED_EXE=%SIGNED_DIR%\%APP_NAME%.exe"
set "SHORTCUT=%SIGNED_DIR%\%APP_NAME%.lnk"

set "CS_USERNAME=tiereduptech"
set "CS_CREDENTIAL_ID=13b6d98a-579d-44a3-b9ca-6f891b7839f9"
set "CS_TOTP=8JiV0YtB7t7QfP5ffjqIi7sj9AKcawZDp3D8FTVo0rM="

REM ---------- FLAG: /bump ----------
set "BUMP_VERSION=false"
if /I "%~1"=="/bump" set "BUMP_VERSION=true"

REM ---------- STEP 0a: Bump version in csproj if requested ----------
REM Reads <Version>X.Y.Z</Version>, increments Z, then writes all four version
REM tags (Version, AssemblyVersion, FileVersion, InformationalVersion) so the
REM exe metadata + auto-updater + .NET assembly all stay in sync.
if /I "%BUMP_VERSION%"=="true" (
    echo Bumping patch version...
    powershell -NoProfile -ExecutionPolicy Bypass -Command ^
        "$path='%CSPROJ%'; $text=[IO.File]::ReadAllText($path);" ^
        "if ($text -notmatch '<Version>(\d+)\.(\d+)\.(\d+)</Version>') { Write-Error 'Could not find <Version> tag'; exit 1 }" ^
        "$maj=[int]$Matches[1]; $min=[int]$Matches[2]; $pat=[int]$Matches[3]+1; $newVer=\"$maj.$min.$pat\"; $newVerFull=\"$newVer.0\";" ^
        "$text = $text -replace '<Version>\d+\.\d+\.\d+</Version>', \"<Version>$newVer</Version>\";" ^
        "$text = $text -replace '<AssemblyVersion>\d+\.\d+\.\d+\.\d+</AssemblyVersion>', \"<AssemblyVersion>$newVerFull</AssemblyVersion>\";" ^
        "$text = $text -replace '<FileVersion>\d+\.\d+\.\d+\.\d+</FileVersion>', \"<FileVersion>$newVerFull</FileVersion>\";" ^
        "$text = $text -replace '<InformationalVersion>\d+\.\d+\.\d+</InformationalVersion>', \"<InformationalVersion>$newVer</InformationalVersion>\";" ^
        "[IO.File]::WriteAllText($path, $text);" ^
        "Write-Host \"  Bumped to v$newVer\""
    if errorlevel 1 (
        echo ERROR: Version bump failed.
        exit /b 1
    )
)

REM ---------- STEP 0b: Read version from .csproj ----------
for /f "delims=" %%v in ('powershell -NoProfile -ExecutionPolicy Bypass -Command "(Select-String -Path '%CSPROJ%' -Pattern '<Version>(.*?)</Version>' | Select-Object -First 1).Matches.Groups[1].Value"') do set "APP_VERSION=%%v"

if "%APP_VERSION%"=="" (
    echo ERROR: Could not read ^<Version^> from %APP_NAME%.csproj
    exit /b 1
)

set "VERSIONED_EXE=%SIGNED_ARCHIVE_DIR%\%APP_NAME%-%APP_VERSION%.exe"

echo Building %APP_NAME% v%APP_VERSION%
echo.

REM ---------- STEP 1: Kill running instance ----------
echo [1/8] Stopping any running %APP_NAME%...
taskkill /F /IM %APP_NAME%.exe >nul 2>&1

REM ---------- STEP 2: Clean old publish folder ----------
echo [2/8] Cleaning old publish output...
if exist "%PUBLISH_DIR%" rmdir /S /Q "%PUBLISH_DIR%" 2>nul

REM ---------- STEP 3: Publish ----------
if /I "%OBFUSCATE%"=="true" goto PUB_OBFUSCATED
goto PUB_NORMAL

:PUB_OBFUSCATED
echo [3/8] Publishing %APP_NAME% v%APP_VERSION% - single-file with obfuscation ON...
set "PUB_ARGS=-c Release -r win-x64 --self-contained true /p:Obfuscate=true"
goto DO_PUBLISH

:PUB_NORMAL
echo [3/8] Publishing %APP_NAME% v%APP_VERSION% - single-file self-contained...
set "PUB_ARGS=-c Release -r win-x64 --self-contained true"
goto DO_PUBLISH

:DO_PUBLISH
pushd "%PROJECT_DIR%"
dotnet publish %PUB_ARGS%
if errorlevel 1 (
    echo.
    echo PUBLISH FAILED
    popd
    exit /b 1
)
popd

if not exist "%BUILD_OUTPUT%" (
    echo.
    echo ERROR: Published exe not found:
    echo   %BUILD_OUTPUT%
    exit /b 1
)

echo   Published exe: %BUILD_OUTPUT%

REM ---------- STEP 4: Check CodeSignTool ----------
if not exist "%CODESIGN_BAT%" (
    echo.
    echo =========================================
    echo  WARNING: CodeSignTool not found
    echo  Expected: %CODESIGN_BAT%
    echo  Skipping signing. Unsigned exe:
    echo    %BUILD_OUTPUT%
    echo =========================================
    exit /b 0
)

REM ---------- STEP 5: Get password ----------
if "%CS_PASSWORD%"=="" set /p "CS_PASSWORD=Enter eSigner password: "
if "%CS_PASSWORD%"=="" (
    echo ERROR: Password is required.
    exit /b 1
)

REM ---------- STEP 6: Stage + prep signed output folders ----------
echo [4/8] Preparing signed output folders...
if not exist "%SIGNED_DIR%" mkdir "%SIGNED_DIR%"
if not exist "%SIGNED_ARCHIVE_DIR%" mkdir "%SIGNED_ARCHIVE_DIR%"
if exist "%SIGNED_EXE%" del /F /Q "%SIGNED_EXE%"

echo   Staging exe to %STAGING_EXE%
copy /Y "%BUILD_OUTPUT%" "%STAGING_EXE%" >nul
if errorlevel 1 (
    echo ERROR: Could not copy published exe to staging.
    exit /b 1
)

REM ---------- STEP 7: Sign ----------
echo [5/8] Signing with CodeSignTool SSL.com eSigner - this may take 30-60 sec...
pushd "%CODESIGN_DIR%"
call CodeSignTool.bat sign -username="%CS_USERNAME%" -password="%CS_PASSWORD%" -credential_id="%CS_CREDENTIAL_ID%" -totp_secret="%CS_TOTP%" -input_file_path="%STAGING_EXE%" -output_dir_path="%SIGNED_DIR%"
set "SIGN_EXIT=%errorlevel%"
popd

if not "%SIGN_EXIT%"=="0" (
    echo.
    echo ERROR: CodeSignTool exited with code %SIGN_EXIT%
    exit /b 1
)
if not exist "%SIGNED_EXE%" (
    echo ERROR: Signed exe not created at %SIGNED_EXE%
    exit /b 1
)

REM ---------- STEP 8: Archive versioned copy ----------
echo [6/8] Archiving versioned copy...
copy /Y "%SIGNED_EXE%" "%VERSIONED_EXE%" >nul

REM ---------- STEP 9: Copy signed back to publish folder ----------
echo [7/8] Copying signed exe back to publish folder...
copy /Y "%SIGNED_EXE%" "%BUILD_OUTPUT%" >nul

REM ---------- STEP 10: Shortcut with Run-as-Admin bit ----------
echo [8/8] Creating Run-as-Administrator shortcut...
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut('%SHORTCUT%'); $s.TargetPath='%SIGNED_EXE%'; $s.WorkingDirectory='%SIGNED_DIR%'; $s.IconLocation='%SIGNED_EXE%'; $s.Save(); $b=[IO.File]::ReadAllBytes('%SHORTCUT%'); $b[0x15]=$b[0x15] -bor 0x20; [IO.File]::WriteAllBytes('%SHORTCUT%',$b)"

echo.
echo =========================================
echo  DONE
echo =========================================
echo  Version:        %APP_VERSION%
if /I "%OBFUSCATE%"=="true"      echo  Obfuscation:    ON
if /I not "%OBFUSCATE%"=="true"  echo  Obfuscation:    OFF
if /I "%BUMP_VERSION%"=="true"   echo  Version bumped: YES
echo  Signed exe:     %SIGNED_EXE%
echo  Versioned copy: %VERSIONED_EXE%
echo  Shortcut:       %SHORTCUT%
echo =========================================
echo.
echo  Test the build, then publish to GitHub:
echo    powershell -File "%PROJECT_DIR%..\publish-scanner-release.ps1" -Version %APP_VERSION%
echo =========================================

endlocal
exit /b 0
