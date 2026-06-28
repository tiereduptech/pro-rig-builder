// =============================================================================
//  Updater.cs  —  Auto-update for ProRigScanner (Lite / console build)
//
//  Copyright © 2026 TieredUp Tech, Inc. — All rights reserved.
//  Proprietary and confidential.
//
//  Ported from pchw-scanner/Updater.cs. SAME release contract so the lite exe
//  keeps the existing auto-update path alive after it replaces the WPF scanner:
//    1. Query https://api.github.com/repos/tiereduptech/pro-rig-builder/releases/latest
//    2. Require tag prefix "scanner-v" + asset "ProRigScanner.exe"
//    3. Compare release version to the running assembly version
//    4. If newer → download to <currentExe>.new
//    5. Verify Authenticode (WinVerifyTrust) AND cert subject contains "TieredUp Tech"
//    6. Spawn a temp .bat that waits 2s, swaps files, relaunches, deletes itself
//    7. Return true so Main exits and lets the swap helper take over
//
//  Difference from the WPF original: NO WPF. No MainWindow, no overlay, no
//  Dispatcher, no MessageBox. The lite exe is a windows-subsystem (WinExe) app
//  with no console on double-click, so the normal fast path (no update) runs
//  completely silently — no window flashes. ONLY when a newer release is found
//  do we lazily AllocConsole() and show a one-line status + a download progress
//  bar, so the one-time ~35MB update doesn't look like a hang.
//
//  Failure modes (all → silently continue with the current version):
//    - No network / GitHub error / corrupted download / locked exe
//    - Signature mismatch → ABORT (security — never run an unsigned/forged binary)
// =============================================================================

using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Threading.Tasks;

namespace ProRigScanner
{
    public static class Updater
    {
        // Where to look for releases. Change "tiereduptech/pro-rig-builder" if the repo moves.
        const string GITHUB_RELEASES_API = "https://api.github.com/repos/tiereduptech/pro-rig-builder/releases/latest";

        // Tags must look like "scanner-v2.3.0" — the prefix lets the scanner releases
        // co-exist with other release types in the same repo.
        const string TAG_PREFIX = "scanner-v";

        // Asset name we look for in the release. Must match exactly. The lite exe
        // publishes AS ProRigScanner.exe (not ...Lite.exe) precisely so it satisfies
        // this contract and can replace the WPF scanner in-place.
        const string ASSET_NAME = "ProRigScanner.exe";

        // Required publisher in the Authenticode signature. A tampered exe won't
        // match this subject, so we abort rather than run it.
        const string EXPECTED_PUBLISHER_SUBSTR = "TieredUp Tech";

        // ─────────────────────────────────────────────────────────────────
        // Win32 console allocation — used LAZILY, only when an update is being
        // applied, so the normal silent fast path never pops a window.
        // ─────────────────────────────────────────────────────────────────
        [DllImport("kernel32.dll")] static extern bool AllocConsole();

        /// <summary>
        /// Checks for a newer signed release and, if found, downloads + verifies +
        /// stages a swap. Returns true when a relaunch is pending — the caller MUST
        /// exit immediately so the swap helper can replace this exe.
        /// </summary>
        public static async Task<bool> CheckAndApplyUpdate()
        {
            if (Environment.GetCommandLineArgs().Contains("--no-update")) return false;

            try
            {
                var (latestTag, downloadUrl) = await QueryLatestRelease();
                if (string.IsNullOrEmpty(latestTag) || string.IsNullOrEmpty(downloadUrl)) return false;

                var latestVer = ParseVersionFromTag(latestTag);
                var currentVer = Assembly.GetExecutingAssembly().GetName().Version;
                if (latestVer == null || currentVer == null) return false;

                // Up to date (or local build is newer) → fast path, stay silent.
                if (latestVer <= currentVer) return false;

                // ── A newer version exists. From here on we show UI. ──
                ShowConsole();
                Console.WriteLine($"A new version is available (v{FormatVersion(latestVer)}).");
                Console.WriteLine("Updating...\n");

                string currentExe = Process.GetCurrentProcess().MainModule.FileName;
                string newExe = currentExe + ".new";
                string oldExe = currentExe + ".old";

                if (File.Exists(newExe)) File.Delete(newExe);
                if (File.Exists(oldExe)) File.Delete(oldExe);

                if (!await DownloadFile(downloadUrl, newExe, OnProgress))
                {
                    Console.WriteLine("\nDownload failed — continuing with the current version.");
                    return false;
                }

                Console.WriteLine("Verifying signature...");
                if (!VerifyAuthenticodeSignature(newExe, EXPECTED_PUBLISHER_SUBSTR))
                {
                    // Refuse to launch unverified binaries — security boundary.
                    try { File.Delete(newExe); } catch { }
                    Console.WriteLine("Signature check failed — update aborted. Continuing with the current version.");
                    return false;
                }

                Console.WriteLine("Restarting...");
                LaunchSwapHelper(currentExe, newExe, oldExe);
                return true; // caller exits; swap .bat relaunches the updated exe
            }
            catch
            {
                // ANY failure → silently fall back. Better to run the old scanner than crash on launch.
                return false;
            }
        }

        // ─────────────────────────────────────────────────────────────────
        // Lazy console: allocate a console and rebind Console.Out to it. Called
        // only on the update path, so double-click launches with no update stay
        // window-free. Rebinding stdout guarantees writes land in the new console
        // regardless of how the runtime initialized it under the windows subsystem.
        // ─────────────────────────────────────────────────────────────────
        static void ShowConsole()
        {
            try
            {
                AllocConsole();
                var stdout = new StreamWriter(Console.OpenStandardOutput()) { AutoFlush = true };
                Console.SetOut(stdout);
                Console.Title = "Pro Rig Scanner";
            }
            catch { /* if we can't show a console, fall through and update silently */ }
        }

        // ─────────────────────────────────────────────────────────────────
        // GitHub release query
        // ─────────────────────────────────────────────────────────────────
        static async Task<(string tag, string downloadUrl)> QueryLatestRelease()
        {
            using var http = new HttpClient();
            http.DefaultRequestHeaders.UserAgent.ParseAdd("ProRigScanner-Updater/1.0");
            http.DefaultRequestHeaders.Accept.ParseAdd("application/vnd.github+json");
            http.Timeout = TimeSpan.FromSeconds(10);

            var resp = await http.GetAsync(GITHUB_RELEASES_API);
            if (!resp.IsSuccessStatusCode) return (null, null);

            using var stream = await resp.Content.ReadAsStreamAsync();
            using var doc = await JsonDocument.ParseAsync(stream);
            var root = doc.RootElement;

            string tag = root.TryGetProperty("tag_name", out var t) ? t.GetString() : null;
            if (string.IsNullOrEmpty(tag)) return (null, null);
            if (!tag.StartsWith(TAG_PREFIX, StringComparison.OrdinalIgnoreCase)) return (null, null);

            // Find the asset called ProRigScanner.exe
            if (!root.TryGetProperty("assets", out var assets)) return (null, null);
            foreach (var asset in assets.EnumerateArray())
            {
                string name = asset.TryGetProperty("name", out var n) ? n.GetString() : null;
                string url  = asset.TryGetProperty("browser_download_url", out var u) ? u.GetString() : null;
                if (string.Equals(name, ASSET_NAME, StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(url))
                    return (tag, url);
            }
            return (null, null);
        }

        static Version ParseVersionFromTag(string tag)
        {
            // "scanner-v2.3.0" → "2.3.0" → Version
            string vStr = tag.Substring(TAG_PREFIX.Length);
            return Version.TryParse(vStr, out var v) ? v : null;
        }

        static string FormatVersion(Version v) =>
            v.Build > 0 || v.Revision > 0 ? $"{v.Major}.{v.Minor}.{v.Build}" : $"{v.Major}.{v.Minor}";

        // ─────────────────────────────────────────────────────────────────
        // Download with progress
        // ─────────────────────────────────────────────────────────────────
        static async Task<bool> DownloadFile(string url, string destPath, Action<int> onProgress)
        {
            using var http = new HttpClient();
            http.DefaultRequestHeaders.UserAgent.ParseAdd("ProRigScanner-Updater/1.0");
            http.Timeout = TimeSpan.FromMinutes(5);

            using var resp = await http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
            if (!resp.IsSuccessStatusCode) return false;

            long? totalBytes = resp.Content.Headers.ContentLength;
            using var src = await resp.Content.ReadAsStreamAsync();
            using var dst = new FileStream(destPath, FileMode.Create, FileAccess.Write, FileShare.None);

            var buf = new byte[81920];
            long read = 0;
            int n;
            int lastPct = -1;
            while ((n = await src.ReadAsync(buf, 0, buf.Length)) > 0)
            {
                await dst.WriteAsync(buf, 0, n);
                read += n;
                if (totalBytes.HasValue && totalBytes.Value > 0)
                {
                    int pct = (int)(read * 100 / totalBytes.Value);
                    if (pct != lastPct) { onProgress?.Invoke(pct); lastPct = pct; }
                }
            }
            return true;
        }

        // Single-line, redrawing progress bar (\r returns to column 0).
        static void OnProgress(int pct)
        {
            const int cells = 25;
            int filled = pct * cells / 100;
            string bar = new string('█', filled) + new string('░', cells - filled);
            Console.Write($"\rUpdating... {pct,3}%  [{bar}]");
            if (pct >= 100) Console.WriteLine();
        }

        // ─────────────────────────────────────────────────────────────────
        // Authenticode signature verification (Win32 WinVerifyTrust)
        // Verifies the new exe is Authenticode-signed AND that the signing
        // publisher matches the expected substring. Refuse to run otherwise.
        // ─────────────────────────────────────────────────────────────────
        static bool VerifyAuthenticodeSignature(string filePath, string requiredPublisherSubstring)
        {
            try
            {
                // Step 1: WinVerifyTrust — checks the signature/chain validity.
                if (!WinVerifyTrustOk(filePath)) return false;

                // Step 2: read X.509 cert subject and confirm the publisher.
                var cert = System.Security.Cryptography.X509Certificates.X509Certificate.CreateFromSignedFile(filePath);
                if (cert == null || string.IsNullOrEmpty(cert.Subject)) return false;
                return cert.Subject.IndexOf(requiredPublisherSubstring, StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch
            {
                return false;
            }
        }

        static bool WinVerifyTrustOk(string filePath)
        {
            var fileInfo = new WINTRUST_FILE_INFO
            {
                cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_FILE_INFO)),
                pcwszFilePath = filePath,
                hFile = IntPtr.Zero,
                pgKnownSubject = IntPtr.Zero,
            };
            IntPtr fileInfoPtr = Marshal.AllocHGlobal(Marshal.SizeOf(fileInfo));
            try
            {
                Marshal.StructureToPtr(fileInfo, fileInfoPtr, false);
                var trustData = new WINTRUST_DATA
                {
                    cbStruct = (uint)Marshal.SizeOf(typeof(WINTRUST_DATA)),
                    pPolicyCallbackData = IntPtr.Zero,
                    pSIPClientData = IntPtr.Zero,
                    dwUIChoice = 2,          // WTD_UI_NONE
                    fdwRevocationChecks = 0, // WTD_REVOKE_NONE
                    dwUnionChoice = 1,       // WTD_CHOICE_FILE
                    pFile = fileInfoPtr,
                    dwStateAction = 0,
                    hWVTStateData = IntPtr.Zero,
                    pwszURLReference = null,
                    dwProvFlags = 0x00000010, // WTD_REVOCATION_CHECK_NONE
                    dwUIContext = 0,
                };

                var policyGuid = new Guid("00AAC56B-CD44-11d0-8CC2-00C04FC295EE"); // WINTRUST_ACTION_GENERIC_VERIFY_V2
                int result = WinVerifyTrust(IntPtr.Zero, ref policyGuid, ref trustData);
                return result == 0;
            }
            finally
            {
                Marshal.FreeHGlobal(fileInfoPtr);
            }
        }

        [StructLayout(LayoutKind.Sequential)]
        struct WINTRUST_FILE_INFO
        {
            public uint cbStruct;
            [MarshalAs(UnmanagedType.LPWStr)] public string pcwszFilePath;
            public IntPtr hFile;
            public IntPtr pgKnownSubject;
        }

        [StructLayout(LayoutKind.Sequential)]
        struct WINTRUST_DATA
        {
            public uint cbStruct;
            public IntPtr pPolicyCallbackData;
            public IntPtr pSIPClientData;
            public uint dwUIChoice;
            public uint fdwRevocationChecks;
            public uint dwUnionChoice;
            public IntPtr pFile;
            public uint dwStateAction;
            public IntPtr hWVTStateData;
            [MarshalAs(UnmanagedType.LPWStr)] public string pwszURLReference;
            public uint dwProvFlags;
            public uint dwUIContext;
        }

        [DllImport("wintrust.dll", CharSet = CharSet.Unicode, SetLastError = false)]
        static extern int WinVerifyTrust(IntPtr hWnd, ref Guid pgActionID, ref WINTRUST_DATA pWVTData);

        // ─────────────────────────────────────────────────────────────────
        // Hot-swap via cmd.exe helper
        // We can't replace ourselves while running, so spawn a tiny batch that
        // waits for this process to exit, swaps the files, relaunches, self-deletes.
        // ─────────────────────────────────────────────────────────────────
        static void LaunchSwapHelper(string currentExe, string newExe, string oldExe)
        {
            string swapBat = Path.Combine(Path.GetTempPath(), "prorigscanner-swap.bat");

            string script = $@"@echo off
:: ProRigScanner self-update helper — waits for old exe to release, swaps, relaunches.
timeout /t 2 /nobreak >nul
move /Y ""{currentExe}"" ""{oldExe}"" >nul 2>&1
move /Y ""{newExe}"" ""{currentExe}"" >nul 2>&1
del ""{oldExe}"" >nul 2>&1
start """" ""{currentExe}""
:: clean up this script
(goto) 2>nul & del ""%~f0""
";
            File.WriteAllText(swapBat, script);

            var psi = new ProcessStartInfo
            {
                FileName = "cmd.exe",
                Arguments = $"/c \"{swapBat}\"",
                CreateNoWindow = true,
                UseShellExecute = false,
                WindowStyle = ProcessWindowStyle.Hidden,
            };
            Process.Start(psi);
        }
    }
}
