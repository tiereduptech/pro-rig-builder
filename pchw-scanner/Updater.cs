// =============================================================================
//  Updater.cs  —  Auto-update for ProRigScanner
//
//  Copyright © 2026 TieredUp Tech, Inc. — All rights reserved.
//  Proprietary and confidential.
//
//  Flow on app start:
//    1. Query https://api.github.com/repos/tiereduptech/pro-rig-builder/releases/latest
//    2. Compare release tag (e.g. "scanner-v2.2.0") to running assembly version
//    3. If newer → download new exe to <currentExe>.new
//    4. Verify Authenticode signature (must be signed by SSL.com cert chain)
//    5. Spawn cleanup batch that waits 2s, swaps files, relaunches, deletes itself
//    6. Exit current process
//
//  Failure modes:
//    - No network            → continue silently (don't block scanner)
//    - GitHub API error      → continue silently
//    - Download corrupted    → abort update, continue with current version
//    - Signature mismatch    → ABORT update (security — never run unsigned binaries)
//    - Exe locked / no perms → fail gracefully, continue normally
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
using System.Windows;
using System.Windows.Controls;

namespace ProRigScanner
{
    public static class Updater
    {
        // Where to look for releases. Change "tiereduptech/pro-rig-builder" if the repo moves.
        const string GITHUB_RELEASES_API = "https://api.github.com/repos/tiereduptech/pro-rig-builder/releases/latest";

        // Tags must look like "scanner-v2.1.0" — the prefix lets us co-exist with
        // other release types (e.g. main app releases) in the same repo.
        const string TAG_PREFIX = "scanner-v";

        // Asset name we look for in the release. Must match exactly.
        const string ASSET_NAME = "ProRigScanner.exe";

        // Required publisher in the Authenticode signature. If anyone tries to
        // distribute a tampered exe, signature won't match this name and we abort.
        // Get the exact value from running `signtool verify /v ProRigScanner.exe`
        // on a known-good signed exe — it shows the "Signing Certificate Subject"
        // line. We match by substring to tolerate punctuation differences.
        const string EXPECTED_PUBLISHER_SUBSTR = "TieredUp Tech";

        public static async Task<bool> CheckAndApplyUpdate(MainWindow window)
        {
            if (Environment.GetCommandLineArgs().Contains("--no-update")) return false;

            ShowOverlay(window, "Checking for updates...", "");

            try
            {
                var (latestTag, downloadUrl) = await QueryLatestRelease();
                if (string.IsNullOrEmpty(latestTag) || string.IsNullOrEmpty(downloadUrl))
                {
                    HideOverlay(window);
                    return false;
                }

                var latestVer = ParseVersionFromTag(latestTag);
                var currentVer = Assembly.GetExecutingAssembly().GetName().Version;

                if (latestVer == null || currentVer == null) { HideOverlay(window); return false; }

                if (latestVer <= currentVer) { HideOverlay(window); return false; }

                // Newer version found. Download + apply.
                ShowOverlay(window, $"Updating Scanner to v{FormatVersion(latestVer)}", "Downloading...");
                ShowProgressBar(window);

                string currentExe = Process.GetCurrentProcess().MainModule.FileName;
                string newExe = currentExe + ".new";
                string oldExe = currentExe + ".old";

                if (File.Exists(newExe)) File.Delete(newExe);
                if (File.Exists(oldExe)) File.Delete(oldExe);

                bool downloadOk = await DownloadFile(downloadUrl, newExe, pct => UpdateProgress(window, pct));
                if (!downloadOk)
                {
                    HideOverlay(window);
                    return false;
                }

                ShowOverlay(window, "Verifying signature...", "Almost done");

                if (!VerifyAuthenticodeSignature(newExe, EXPECTED_PUBLISHER_SUBSTR))
                {
                    // Refuse to launch unverified binaries — security boundary.
                    try { File.Delete(newExe); } catch { }
                    HideOverlay(window);
                    MessageBox.Show(
                        "An update was downloaded but failed signature verification and will not be installed.\n\nThe scanner will continue with the current version.",
                        "Update aborted", MessageBoxButton.OK, MessageBoxImage.Warning);
                    return false;
                }

                ShowOverlay(window, "Restarting...", "");

                LaunchSwapHelper(currentExe, newExe, oldExe);

                // Tell caller we're exiting — don't show wizard.
                Application.Current.Shutdown();
                return true;
            }
            catch (Exception)
            {
                // ANY failure → silently fall back. Better to run an old scanner than crash on launch.
                HideOverlay(window);
                return false;
            }
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
            // "scanner-v2.1.0" → "2.1.0" → Version
            string vStr = tag.Substring(TAG_PREFIX.Length);
            if (Version.TryParse(vStr, out var v)) return v;
            return null;
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
            while ((n = await src.ReadAsync(buf, 0, buf.Length)) > 0)
            {
                await dst.WriteAsync(buf, 0, n);
                read += n;
                if (totalBytes.HasValue && totalBytes.Value > 0)
                {
                    int pct = (int)(read * 100 / totalBytes.Value);
                    onProgress?.Invoke(pct);
                }
            }
            return true;
        }

        // ─────────────────────────────────────────────────────────────────
        // Authenticode signature verification (Win32 WinVerifyTrust)
        // ─────────────────────────────────────────────────────────────────
        // Verifies the new exe is properly Authenticode-signed AND that the
        // signing publisher matches the expected substring. Refuse to run
        // anything that fails either check.
        static bool VerifyAuthenticodeSignature(string filePath, string requiredPublisherSubstring)
        {
            try
            {
                // Step 1: Win32 WinVerifyTrust call — checks chain validity
                if (!WinVerifyTrustOk(filePath)) return false;

                // Step 2: read X.509 cert subject and confirm publisher
                var cert = System.Security.Cryptography.X509Certificates.X509Certificate.CreateFromSignedFile(filePath);
                if (cert == null) return false;
                if (string.IsNullOrEmpty(cert.Subject)) return false;
                return cert.Subject.IndexOf(requiredPublisherSubstring, StringComparison.OrdinalIgnoreCase) >= 0;
            }
            catch
            {
                return false;
            }
        }

        static bool WinVerifyTrustOk(string filePath)
        {
            // Calls into wintrust.dll WinVerifyTrust to validate Authenticode signature.
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
                    dwUIChoice = 2,        // WTD_UI_NONE
                    fdwRevocationChecks = 0, // WTD_REVOKE_NONE
                    dwUnionChoice = 1,     // WTD_CHOICE_FILE
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
        // ─────────────────────────────────────────────────────────────────
        static void LaunchSwapHelper(string currentExe, string newExe, string oldExe)
        {
            // We can't replace ourselves while running. Spawn a tiny batch script
            // that waits for our process to exit, then swaps the files and relaunches.
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

        // ─────────────────────────────────────────────────────────────────
        // Overlay UI helpers — drive the existing UpdateOverlay panel in XAML
        // ─────────────────────────────────────────────────────────────────
        static void ShowOverlay(MainWindow w, string title, string subtitle)
        {
            w.Dispatcher.Invoke(() =>
            {
                var overlay = w.FindName("UpdateOverlay") as Border;
                var titleTb = w.FindName("UpdateTitle") as TextBlock;
                var subTb = w.FindName("UpdateSubtitle") as TextBlock;
                if (overlay != null) overlay.Visibility = Visibility.Visible;
                if (titleTb != null) titleTb.Text = title;
                if (subTb != null) subTb.Text = subtitle;
            });
        }

        static void HideOverlay(MainWindow w)
        {
            w.Dispatcher.Invoke(() =>
            {
                var overlay = w.FindName("UpdateOverlay") as Border;
                if (overlay != null) overlay.Visibility = Visibility.Collapsed;
            });
        }

        static void ShowProgressBar(MainWindow w)
        {
            w.Dispatcher.Invoke(() =>
            {
                var bar = w.FindName("UpdateProgressBar") as Border;
                if (bar != null) bar.Visibility = Visibility.Visible;
            });
        }

        static void UpdateProgress(MainWindow w, int pct)
        {
            w.Dispatcher.Invoke(() =>
            {
                var fill = w.FindName("UpdateProgressFill") as Border;
                var subTb = w.FindName("UpdateSubtitle") as TextBlock;
                if (fill != null) fill.Width = Math.Max(0, Math.Min(320, pct * 3.2));
                if (subTb != null) subTb.Text = $"Downloading... {pct}%";
            });
        }
    }
}
