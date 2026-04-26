// =============================================================================
//  Pro Rig Scanner  —  MainWindow
//  Part of the Pro Rig Builder ecosystem (https://prorigbuilder.com)
//
//  Copyright © 2026 TieredUp Tech, Inc. — All rights reserved.
//  Author:   Coby / TieredUp Tech, Inc.
//  Created:  2026
//
//  PROPRIETARY AND CONFIDENTIAL
//  This source file and the ideas, designs, and implementation details it
//  contains are the exclusive intellectual property of TieredUp Tech, Inc.
//  No portion of this file may be reproduced, distributed, modified,
//  reverse-engineered, decompiled, or used to create derivative works —
//  in whole or in part — without prior written permission from the author.
// =============================================================================

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Management;
using System.Net;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;

namespace ProRigScanner
{
    public partial class MainWindow : Window
    {
        const string PROD_URL = "https://prorigbuilder.com";
        const string DEV_URL  = "http://localhost:3000";

        string _baseUrl = PROD_URL;
        int    _budget = 1000;
        string _storageChoice = "no";
        string _storageType   = "";
        int    _extraStorageGB = 0;
        string _coolerType    = "";   // stock | budget_air | aio_120 | aio_240 | aio_360 | unknown
        Button _selectedYesNo = null;
        Button _selectedType  = null;
        Button _selectedSize  = null;
        Button _selectedCooler = null;
        string _finalUrl = "";

        int _currentPage = 1;      // 1=budget, 2=storage, 3=cooler, 4=review

        public MainWindow()
        {
            InitializeComponent();
            if (Environment.GetCommandLineArgs().Contains("--dev")) _baseUrl = DEV_URL;

            Loaded += async (s, e) => {
                SelectButton(StorageNoBtn, ref _selectedYesNo);
                _storageChoice = "no";
                UpdateBudgetLabelFromSlider();
                UpdateVersionLabel();

                // Run update check before showing the wizard. If a mandatory update
                // exists, it'll download, verify signature, relaunch, and we exit.
                bool willRelaunch = await Updater.CheckAndApplyUpdate(this);
                if (willRelaunch) return;  // don't continue — process is exiting

                ShowPage(1);
            };
        }

        // Reads version from the assembly so it always matches what's in the .csproj.
        // Displays as "Scanner v2.1.0" in the title bar.
        void UpdateVersionLabel()
        {
            try
            {
                var ver = System.Reflection.Assembly.GetExecutingAssembly().GetName().Version;
                if (ver != null)
                {
                    string v = ver.Build > 0 || ver.Revision > 0
                        ? $"{ver.Major}.{ver.Minor}.{ver.Build}"
                        : $"{ver.Major}.{ver.Minor}";
                    VersionLabel.Text = $"Scanner v{v}";
                }
            }
            catch { }
        }

        // ============================================================
        // PAGE NAVIGATION
        // ============================================================
        void ShowPage(int page)
        {
            _currentPage = page;

            Page1_Budget.Visibility  = page == 1 ? Visibility.Visible : Visibility.Collapsed;
            Page2_Storage.Visibility = page == 2 ? Visibility.Visible : Visibility.Collapsed;
            Page3_Cooler.Visibility  = page == 3 ? Visibility.Visible : Visibility.Collapsed;
            Page4_Review.Visibility  = page == 4 ? Visibility.Visible : Visibility.Collapsed;

            Step1Dot.Fill = (SolidColorBrush)FindResource(page >= 1 ? "Accent" : "Border");
            Step2Dot.Fill = (SolidColorBrush)FindResource(page >= 2 ? "Accent" : "Border");
            Step3Dot.Fill = (SolidColorBrush)FindResource(page >= 3 ? "Accent" : "Border");
            Step4Dot.Fill = (SolidColorBrush)FindResource(page >= 4 ? "Accent" : "Border");

            BackButton.Visibility = page > 1 ? Visibility.Visible : Visibility.Collapsed;
            NextButton.Content = page == 4 ? "Start Scan  →" : "Next  →";
            NextButton.IsEnabled = CanAdvance(page);

            if (page == 4) BuildReviewPanel();
        }

        bool CanAdvance(int page)
        {
            switch (page)
            {
                case 1: return _budget > 0;
                case 2:
                    if (_storageChoice == "no") return true;
                    if (_storageChoice == "yes" && !string.IsNullOrEmpty(_storageType) && _extraStorageGB > 0) return true;
                    return false;
                case 3: return !string.IsNullOrEmpty(_coolerType);
                case 4: return true;
                default: return false;
            }
        }

        void BackButton_Click(object sender, RoutedEventArgs e)
        {
            if (_currentPage > 1) ShowPage(_currentPage - 1);
        }

        void NextButton_Click(object sender, RoutedEventArgs e)
        {
            if (_currentPage < 4)
            {
                if (CanAdvance(_currentPage)) ShowPage(_currentPage + 1);
            }
            else
            {
                ScanButton_Click(sender, e);
            }
        }

        // ============================================================
        // PAGE 1 — BUDGET
        // ============================================================
        void BudgetSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        {
            UpdateBudgetLabelFromSlider();
        }
        void UpdateBudgetLabelFromSlider()
        {
            double t = BudgetSlider.Value / 100.0;
            double curved = Math.Pow(t, 2.5);
            double raw = 300 + curved * (8000 - 300);
            int snapped = (int)(Math.Round(raw / 25.0) * 25);
            _budget = snapped;
            BudgetLabel.Text = "$" + _budget.ToString("N0");
            if (NextButton != null) NextButton.IsEnabled = CanAdvance(_currentPage);
        }

        // ============================================================
        // PAGE 2 — STORAGE
        // ============================================================
        void StorageYesNo_Click(object sender, RoutedEventArgs e)
        {
            var btn = (Button)sender;
            SelectButton(btn, ref _selectedYesNo);
            _storageChoice = (string)btn.Tag;

            if (_storageChoice == "yes")
            {
                StorageTypePanel.Visibility = Visibility.Visible;
                _storageType = "";
                _extraStorageGB = 0;
                if (_selectedType != null) { _selectedType.BorderBrush = (SolidColorBrush)FindResource("Border"); _selectedType.Background = (SolidColorBrush)FindResource("Bg3"); _selectedType = null; }
                StorageSizePanel.Visibility = Visibility.Collapsed;
            }
            else
            {
                StorageTypePanel.Visibility = Visibility.Collapsed;
                StorageSizePanel.Visibility = Visibility.Collapsed;
                _storageType = "";
                _extraStorageGB = 0;
            }
            NextButton.IsEnabled = CanAdvance(_currentPage);
        }

        void StorageType_Click(object sender, RoutedEventArgs e)
        {
            var btn = (Button)sender;
            SelectButton(btn, ref _selectedType);
            _storageType = (string)btn.Tag;

            StorageSizes.Children.Clear();
            // HDD: 1TB/2TB/4TB/8TB (HDDs start at 1TB to be worth buying)
            // SSD: 500GB/1TB/2TB/4TB
            // ANY: 1TB/2TB/4TB/8TB (inclusive range - website will pick best value type)
            (int gb, string label)[] sizes;
            if (_storageType == "HDD")
                sizes = new[] { (1000, "1 TB"), (2000, "2 TB"), (4000, "4 TB"), (8000, "8 TB") };
            else if (_storageType == "SSD")
                sizes = new[] { (500, "500 GB"), (1000, "1 TB"), (2000, "2 TB"), (4000, "4 TB") };
            else // ANY
                sizes = new[] { (1000, "1 TB"), (2000, "2 TB"), (4000, "4 TB"), (8000, "8 TB") };

            // Subtitle shown under the size label
            string subtitle = _storageType == "ANY" ? "any type" : _storageType;

            foreach (var (gb, label) in sizes)
            {
                var sizeBtn = new Button
                {
                    Tag = gb,
                    Style = (Style)FindResource("OptionCard"),
                    Margin = new Thickness(4, 0, 4, 0),
                };
                var stack = new StackPanel();
                stack.Children.Add(new TextBlock { Text = label, FontSize = 15, FontWeight = FontWeights.Bold, HorizontalAlignment = HorizontalAlignment.Center });
                stack.Children.Add(new TextBlock { Text = subtitle, FontSize = 10, Foreground = (SolidColorBrush)FindResource("Dim"), HorizontalAlignment = HorizontalAlignment.Center });
                sizeBtn.Content = stack;
                sizeBtn.Click += StorageSize_Click;
                StorageSizes.Children.Add(sizeBtn);
            }

            StorageSizePanel.Visibility = Visibility.Visible;
            _selectedSize = null;
            _extraStorageGB = 0;
            NextButton.IsEnabled = CanAdvance(_currentPage);
        }

        void StorageSize_Click(object sender, RoutedEventArgs e)
        {
            var btn = (Button)sender;
            SelectButton(btn, ref _selectedSize);
            _extraStorageGB = (int)btn.Tag;
            NextButton.IsEnabled = CanAdvance(_currentPage);
        }

        // ============================================================
        // PAGE 3 — CPU COOLER
        // ============================================================
        void Cooler_Click(object sender, RoutedEventArgs e)
        {
            var btn = (Button)sender;
            SelectButton(btn, ref _selectedCooler);
            _coolerType = (string)btn.Tag;
            NextButton.IsEnabled = CanAdvance(_currentPage);
        }

        // ============================================================
        // PAGE 4 — REVIEW
        // ============================================================
        void BuildReviewPanel()
        {
            ReviewPanel.Children.Clear();

            AddReviewRow("Budget", $"${_budget:N0}", "");
            if (_storageChoice == "yes")
            {
                string sizeLabel = _extraStorageGB >= 1000 ? $"{_extraStorageGB / 1000} TB" : $"{_extraStorageGB} GB";
                string typeLabel = _storageType == "ANY" ? "(any type)" : _storageType;
                AddReviewRow("Extra storage", $"{sizeLabel} {typeLabel}", "");
            }
            else
            {
                AddReviewRow("Extra storage", "Skipped", "keeping current drives only");
            }
            AddReviewRow("CPU cooler", CoolerLabel(_coolerType), CoolerTDPNote(_coolerType));
        }

        string CoolerLabel(string key) => key switch
        {
            "stock"       => "Stock Cooler",
            "budget_air"  => "Budget Air Cooler",
            "aio_120"     => "120mm AIO",
            "aio_240"     => "240mm AIO",
            "aio_360"     => "360mm AIO",
            "unknown"     => "Not sure",
            _             => "—"
        };
        string CoolerTDPNote(string key) => key switch
        {
            "stock"       => "~65W TDP capacity",
            "budget_air"  => "~120W TDP capacity",
            "aio_120"     => "~150W TDP capacity",
            "aio_240"     => "~220W TDP capacity",
            "aio_360"     => "~300W TDP capacity",
            "unknown"     => "We'll recommend options based on your new CPU",
            _             => ""
        };

        void AddReviewRow(string label, string value, string note)
        {
            var row = new DockPanel { Margin = new Thickness(0, 6, 0, 6) };
            var labelTB = new TextBlock
            {
                Text = label.ToUpper(),
                Width = 120,
                FontSize = 11,
                FontWeight = FontWeights.Bold,
                Foreground = (SolidColorBrush)FindResource("Dim"),
                VerticalAlignment = VerticalAlignment.Center
            };
            DockPanel.SetDock(labelTB, Dock.Left);

            var stack = new StackPanel();
            stack.Children.Add(new TextBlock
            {
                Text = value,
                FontSize = 14,
                FontWeight = FontWeights.Bold,
                Foreground = (SolidColorBrush)FindResource("Text")
            });
            if (!string.IsNullOrEmpty(note))
            {
                stack.Children.Add(new TextBlock
                {
                    Text = note,
                    FontSize = 11,
                    Foreground = (SolidColorBrush)FindResource("Mute"),
                    Margin = new Thickness(0, 2, 0, 0)
                });
            }
            row.Children.Add(labelTB);
            row.Children.Add(stack);
            ReviewPanel.Children.Add(row);
        }

        // ============================================================
        // SCAN
        // ============================================================
        async void ScanButton_Click(object sender, RoutedEventArgs e)
        {
            Page1_Budget.Visibility = Visibility.Collapsed;
            Page2_Storage.Visibility = Visibility.Collapsed;
            Page3_Cooler.Visibility = Visibility.Collapsed;
            Page4_Review.Visibility = Visibility.Collapsed;
            NavBar.Visibility = Visibility.Collapsed;
            StepIndicator.Visibility = Visibility.Collapsed;

            ScanView.Visibility = Visibility.Visible;
            ScanSteps.Children.Clear();

            var steps = new (string label, Func<SystemSpecs, Task<string>> action)[]
            {
                ("Analyzing processor architecture", async s => { s.CPU = await Task.Run(() => GetCPU()); return s.CPU.Name; }),
                ("Detecting graphics card",          async s => { s.GPU = await Task.Run(() => GetGPU()); return s.GPU.Name; }),
                ("Reading memory configuration",     async s => { s.RAM = await Task.Run(() => GetRAM()); return $"{s.RAM.TotalGB}GB {s.RAM.Type} · {s.RAM.UsedSlots}/{s.RAM.TotalSlots} slots"; }),
                ("Enumerating storage devices",      async s => { s.Storage = await Task.Run(() => GetStorage()); return $"{s.Storage.Count} drive(s) detected"; }),
                ("Querying motherboard BIOS",        async s => { s.Motherboard = await Task.Run(() => GetMotherboard()); return s.Motherboard.Product; }),
                ("Calculating upgrade paths",        async s => { await Task.Delay(1500); return "Recommendations ready"; }),
            };

            var specs = new SystemSpecs();
            var rows = new List<(Border iconContainer, TextBlock icon, TextBlock text, TextBlock detail)>();

            foreach (var (label, _) in steps)
            {
                var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 6, 0, 6) };
                var iconContainer = new Border { Width = 24, Height = 24, CornerRadius = new CornerRadius(12), Background = (SolidColorBrush)FindResource("Bg3"), Margin = new Thickness(0, 0, 14, 0), VerticalAlignment = VerticalAlignment.Center };
                var icon = new TextBlock { Text = "○", FontSize = 14, Foreground = (SolidColorBrush)FindResource("Mute"), HorizontalAlignment = HorizontalAlignment.Center, VerticalAlignment = VerticalAlignment.Center };
                iconContainer.Child = icon;
                var textStack = new StackPanel { VerticalAlignment = VerticalAlignment.Center };
                var text = new TextBlock { Text = label, FontSize = 14, Foreground = (SolidColorBrush)FindResource("Dim") };
                var detail = new TextBlock { Text = "", FontSize = 12, Foreground = (SolidColorBrush)FindResource("Dim"), FontFamily = new FontFamily("Consolas"), Visibility = Visibility.Collapsed, Margin = new Thickness(0, 2, 0, 0) };
                textStack.Children.Add(text);
                textStack.Children.Add(detail);
                row.Children.Add(iconContainer);
                row.Children.Add(textStack);
                ScanSteps.Children.Add(row);
                rows.Add((iconContainer, icon, text, detail));
            }

            for (int i = 0; i < steps.Length; i++)
            {
                var (_, action) = steps[i];
                var (iconContainer, icon, text, detail) = rows[i];

                icon.Text = "◉";
                icon.Foreground = (SolidColorBrush)FindResource("Accent");
                text.Foreground = (SolidColorBrush)FindResource("Text");
                text.FontWeight = FontWeights.SemiBold;

                var startedAt = DateTime.Now;
                var minWait = TimeSpan.FromMilliseconds(1400);
                var actionTask = action(specs);

                var spinTask = Task.Run(async () => {
                    var frames = new[] { "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" };
                    int frame = 0;
                    while (!actionTask.IsCompleted || (DateTime.Now - startedAt) < minWait)
                    {
                        var f = frames[frame % frames.Length];
                        await Dispatcher.InvokeAsync(() => icon.Text = f);
                        await Task.Delay(80);
                        frame++;
                    }
                });
                await actionTask;
                await spinTask;

                var resultText = actionTask.Result;
                icon.Text = "✓";
                icon.Foreground = (SolidColorBrush)FindResource("Green");
                detail.Text = Truncate(resultText, 60);
                detail.Visibility = Visibility.Visible;
            }

            await Task.Delay(400);
            ScanView.Visibility = Visibility.Collapsed;
            DoneView.Visibility = Visibility.Visible;
            BuildSummary(specs);
            _finalUrl = BuildURL(specs, _budget, _extraStorageGB, _storageType, _coolerType, _baseUrl);
        }

        // ============================================================
        // SUMMARY
        // ============================================================
        void BuildSummary(SystemSpecs specs)
        {
            SummaryPanel.Children.Clear();
            // User-selected build context (budget) shown first — distinct from detected hardware
            AddSummaryRow("BUDGET", $"${_budget:N0}", "your upgrade target", "#FF8A3D");
            AddSummaryRow("CPU", specs.CPU.Name, $"{specs.CPU.Cores} cores / {specs.CPU.Threads} threads · {specs.CPU.MaxClockGHz:F1} GHz", "#38BDF8");
            AddSummaryRow("GPU", specs.GPU.Name, $"{specs.GPU.VRAM_MB / 1024} GB VRAM", "#4ADE80");
            string ramDetail = $"{specs.RAM.Sticks}× {specs.RAM.StickSizeGB}GB · {specs.RAM.UsedSlots}/{specs.RAM.TotalSlots} slots used";
            if (!string.IsNullOrEmpty(specs.RAM.SlotLabels)) ramDetail += $" ({specs.RAM.SlotLabels})";
            AddSummaryRow("RAM", $"{specs.RAM.TotalGB}GB {specs.RAM.Type} @ {specs.RAM.SpeedMHz}MHz", ramDetail, "#FFB020");
            foreach (var d in specs.Storage.Take(3))
            {
                AddSummaryRow("Disk", d.Model, $"{d.SizeGB}GB · {d.Type}", "#C084FC");
            }
            AddSummaryRow("MOBO", specs.Motherboard.Product, specs.Motherboard.Manufacturer, "#9090A0");
        }

        void AddSummaryRow(string label, string name, string detail, string colorHex)
        {
            var row = new DockPanel { Margin = new Thickness(0, 8, 0, 8) };
            var labelTB = new TextBlock
            {
                Text = label,
                Width = 60,
                FontSize = 12,
                FontWeight = FontWeights.Bold,
                Foreground = (SolidColorBrush)(new BrushConverter().ConvertFrom(colorHex)),
                VerticalAlignment = VerticalAlignment.Center
            };
            var stack = new StackPanel();
            stack.Children.Add(new TextBlock
            {
                Text = Truncate(name, 65),
                FontSize = 15,
                FontWeight = FontWeights.SemiBold,
                Foreground = (SolidColorBrush)FindResource("Text"),
                TextWrapping = TextWrapping.NoWrap,
            });
            stack.Children.Add(new TextBlock
            {
                Text = detail,
                FontSize = 12,
                Foreground = (SolidColorBrush)FindResource("Dim"),
                FontFamily = new FontFamily("Consolas"),
                Margin = new Thickness(0, 2, 0, 0),
            });
            DockPanel.SetDock(labelTB, Dock.Left);
            row.Children.Add(labelTB);
            row.Children.Add(stack);
            SummaryPanel.Children.Add(row);
        }

        void OpenBrowser_Click(object sender, RoutedEventArgs e)
        {
            try { Process.Start(new ProcessStartInfo { FileName = _finalUrl, UseShellExecute = true }); Close(); }
            catch (Exception ex) { MessageBox.Show("Could not open browser:\n" + ex.Message + "\n\nURL:\n" + _finalUrl, "Error"); }
        }

        void TitleBar_MouseDown(object sender, MouseButtonEventArgs e)
        {
            if (e.LeftButton == MouseButtonState.Pressed) this.DragMove();
        }
        void CloseButton_Click(object sender, RoutedEventArgs e) => Close();

        void SelectButton(Button btn, ref Button selectedRef)
        {
            if (selectedRef != null)
            {
                selectedRef.BorderBrush = (SolidColorBrush)FindResource("Border");
                selectedRef.Background = (SolidColorBrush)FindResource("Bg3");
            }
            btn.BorderBrush = (SolidColorBrush)FindResource("Accent");
            btn.Background = new SolidColorBrush(Color.FromRgb(0x28, 0x1C, 0x14));
            selectedRef = btn;
        }

        // ============================================================
        // URL BUILDER — now includes cooler_type
        // ============================================================
        string BuildURL(SystemSpecs specs, int budget, int extraStorageGB, string extraStorageType, string coolerType, string baseUrl)
        {
            var data = new Dictionary<string, string>
            {
                ["cpu"] = specs.CPU.Name,
                ["cpu_cores"] = specs.CPU.Cores.ToString(),
                ["cpu_threads"] = specs.CPU.Threads.ToString(),
                ["cpu_clock"] = specs.CPU.MaxClockGHz.ToString("F1"),
                ["cpu_socket"] = specs.CPU.Socket,
                ["gpu"] = specs.GPU.Name,
                ["gpu_vram"] = (specs.GPU.VRAM_MB / 1024).ToString(),
                ["ram_total"] = specs.RAM.TotalGB.ToString(),
                ["ram_type"] = specs.RAM.Type,
                ["ram_speed"] = specs.RAM.SpeedMHz.ToString(),
                ["ram_sticks"] = specs.RAM.Sticks.ToString(),
                ["ram_total_slots"] = specs.RAM.TotalSlots.ToString(),
                ["ram_used_slots"] = specs.RAM.UsedSlots.ToString(),
                ["ram_slot_labels"] = specs.RAM.SlotLabels ?? "",
                ["mobo"] = specs.Motherboard.Product,
                ["mobo_mfr"] = specs.Motherboard.Manufacturer,
                ["budget"] = budget.ToString(),
                ["add_storage_gb"] = extraStorageGB.ToString(),
                ["add_storage_type"] = extraStorageType ?? "",
                ["cooler_type"] = coolerType ?? "",
            };
            for (int i = 0; i < Math.Min(specs.Storage.Count, 4); i++)
            {
                data[$"disk{i}_model"] = specs.Storage[i].Model;
                data[$"disk{i}_size"] = specs.Storage[i].SizeGB.ToString();
                data[$"disk{i}_type"] = specs.Storage[i].Type;
            }
            var jsonPairs = data.Select(kv => $"\"{Escape(kv.Key)}\":\"{Escape(kv.Value)}\"");
            string json = "{" + string.Join(",", jsonPairs) + "}";
            string encoded = Convert.ToBase64String(System.Text.Encoding.UTF8.GetBytes(json));
            return $"{baseUrl}/#upgrade?specs={WebUtility.UrlEncode(encoded)}";
        }

        string Clean(string s) => s.Trim().Replace("  ", " ").Replace("(R)", "").Replace("(TM)", "").Replace("(tm)", "");
        string Truncate(string s, int max) => s.Length > max ? s[..(max - 2)] + ".." : s;
        string Escape(string s) => s.Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "").Replace("\r", "");

        // ============================================================
        // HARDWARE DETECTION — unchanged
        // ============================================================
        CPUInfo GetCPU()
        {
            var info = new CPUInfo();
            try
            {
                using var searcher = new ManagementObjectSearcher("SELECT * FROM Win32_Processor");
                foreach (ManagementObject obj in searcher.Get())
                {
                    info.Name = Clean(obj["Name"]?.ToString() ?? "Unknown");
                    info.Cores = Convert.ToInt32(obj["NumberOfCores"] ?? 0);
                    info.Threads = Convert.ToInt32(obj["NumberOfLogicalProcessors"] ?? 0);
                    info.MaxClockGHz = Convert.ToDouble(obj["MaxClockSpeed"] ?? 0) / 1000.0;
                    info.Socket = obj["SocketDesignation"]?.ToString() ?? "";
                    info.Manufacturer = obj["Manufacturer"]?.ToString() ?? "";
                    break;
                }
            }
            catch (Exception ex) { info.Name = "Detection failed: " + ex.Message; }
            return info;
        }

        GPUInfo GetGPU()
        {
            var info = new GPUInfo();
            var candidates = new List<(string name, long wmiVram, string driver, string pnp, int score)>();
            var args = Environment.GetCommandLineArgs();

            // ==== MOCK MODE: --mock-gpu=scenario ====
            // Lets us test GPU detection locally without real hardware.
            // Scenarios: ryzen7800x3d, intel_igpu_only, nvidia_rtx, amd_apu_dgpu, laptop_optimus
            string mockArg = args.FirstOrDefault(a => a.StartsWith("--mock-gpu="));
            if (mockArg != null)
            {
                var scenario = mockArg.Substring("--mock-gpu=".Length);
                return MockGPUDetection(scenario);
            }

            try
            {
                using var searcher = new ManagementObjectSearcher("SELECT * FROM Win32_VideoController");
                foreach (ManagementObject obj in searcher.Get())
                {
                    string rawName = obj["Name"]?.ToString() ?? "";
                    if (string.IsNullOrWhiteSpace(rawName)) continue;
                    if (rawName.Contains("Microsoft Basic")) continue;
                    if (rawName.Contains("Remote Display")) continue;
                    if (rawName.Contains("DisplayLink")) continue;
                    if (rawName.Contains("Virtual")) continue;

                    long wmiVram = 0;
                    try { wmiVram = Convert.ToInt64(obj["AdapterRAM"] ?? 0) / (1024 * 1024); } catch { }
                    string driver = obj["DriverVersion"]?.ToString() ?? "";
                    string pnp = obj["PNPDeviceID"]?.ToString() ?? "";

                    int score = ScoreGPU(rawName, wmiVram, pnp);
                    candidates.Add((Clean(rawName), wmiVram, driver, pnp, score));
                }
            }
            catch (Exception ex) { info.Name = "Detection failed: " + ex.Message; return info; }

            // Write diagnostic log so we can see exactly what was detected on end-user machines.
            // Users can find this file and send it back to us if detection is wrong.
            try
            {
                var logPath = Path.Combine(Path.GetTempPath(), "prorigscanner-gpu-log.txt");
                var sb = new System.Text.StringBuilder();
                sb.AppendLine($"=== GPU enumeration at {DateTime.Now:yyyy-MM-dd HH:mm:ss} ===");
                sb.AppendLine($"Candidates: {candidates.Count}");
                foreach (var c in candidates)
                {
                    sb.AppendLine($"  NAME: {c.name}");
                    sb.AppendLine($"  VRAM: {c.wmiVram} MB");
                    sb.AppendLine($"  PNP:  {c.pnp}");
                    sb.AppendLine($"  DRV:  {c.driver}");
                    sb.AppendLine($"  SCORE: {c.score}");
                    sb.AppendLine();
                }
                File.WriteAllText(logPath, sb.ToString());
            }
            catch { }  // logging failures shouldn't break scanning

            if (candidates.Count == 0) { info.Name = "No GPU detected"; return info; }

            candidates.Sort((a, b) => b.score.CompareTo(a.score));
            var best = candidates[0];

            info.Name = best.name;
            info.DriverVersion = best.driver;
            long namedVram = GuessVRAM(info.Name);
            info.VRAM_MB = namedVram > 0 ? namedVram : best.wmiVram;
            if (info.VRAM_MB <= 0 || info.VRAM_MB > 65536) info.VRAM_MB = 8 * 1024;
            return info;
        }

        // Runs the same scoring logic against hardcoded test scenarios so we can
        // verify fixes locally before pushing. Launch with --mock-gpu=<scenario>.
        GPUInfo MockGPUDetection(string scenario)
        {
            // Each scenario is a list of (name, vram_mb, pnp_id) tuples representing
            // what WMI would return on that hardware.
            (string name, long vram, string pnp)[] adapters;
            switch (scenario.ToLower())
            {
                case "ryzen7800x3d":
                    // Ryzen 7 7800X3D (Raphael desktop APU) + hypothetical RX 7800 XT dGPU
                    adapters = new[] {
                        ("AMD Radeon(TM) Graphics",    512L, @"PCI\VEN_1002&DEV_1638&SUBSYS_00000000&REV_CA\6&12345678&0&00000008"),
                        ("AMD Radeon RX 7800 XT",      16384L, @"PCI\VEN_1002&DEV_747E&SUBSYS_E392174B&REV_C8\6&87654321&0&00000000"),
                    };
                    break;
                case "ryzen7800x3d_igpu_only":
                    // Same APU but no dGPU installed — scanner must return iGPU
                    adapters = new[] {
                        ("AMD Radeon(TM) Graphics",    512L, @"PCI\VEN_1002&DEV_1638&SUBSYS_00000000&REV_CA\6&12345678&0&00000008"),
                    };
                    break;
                case "intel_igpu_only":
                    adapters = new[] {
                        ("Intel(R) UHD Graphics 770", 128L, @"PCI\VEN_8086&DEV_4680&SUBSYS_87231043&REV_04\3&11583659&0&10"),
                    };
                    break;
                case "nvidia_rtx":
                    // Intel 10th gen + RTX 3070 (typical desktop)
                    adapters = new[] {
                        ("Intel(R) UHD Graphics 630",  128L,  @"PCI\VEN_8086&DEV_9BC8"),
                        ("NVIDIA GeForce RTX 3070",    8192L, @"PCI\VEN_10DE&DEV_2484"),
                    };
                    break;
                case "laptop_optimus":
                    // Laptop with Intel iGPU + NVIDIA dGPU (Optimus)
                    adapters = new[] {
                        ("Intel(R) Iris(R) Xe Graphics", 128L,  @"PCI\VEN_8086&DEV_9A49"),
                        ("NVIDIA GeForce RTX 4060 Laptop GPU", 8192L, @"PCI\VEN_10DE&DEV_28E0"),
                    };
                    break;
                case "amd_apu_plus_dgpu":
                    // Mobile Ryzen APU (890M) + dGPU
                    adapters = new[] {
                        ("AMD Radeon 890M Graphics", 512L, @"PCI\VEN_1002&DEV_150E"),
                        ("AMD Radeon RX 7900 XTX",   24576L, @"PCI\VEN_1002&DEV_744C"),
                    };
                    break;
                default:
                    return new GPUInfo { Name = $"Mock scenario '{scenario}' unknown" };
            }

            var scored = adapters.Select(a => new {
                Name = Clean(a.name),
                Vram = a.vram,
                Pnp = a.pnp,
                Score = ScoreGPU(a.name, a.vram, a.pnp),
            }).OrderByDescending(x => x.Score).ToList();

            var best = scored[0];
            long namedVram = GuessVRAM(best.Name);
            return new GPUInfo {
                Name = $"[MOCK:{scenario}] {best.Name}",
                VRAM_MB = namedVram > 0 ? namedVram : best.Vram,
                DriverVersion = "mocked",
            };
        }

        // Returns a relevance score — higher = more likely to be the user's gaming GPU.
        // Uses THREE independent signals: name pattern, VRAM size, and PCI device ID.
        //
        // Signal 1 (name): brand/model strings in the adapter name
        // Signal 2 (VRAM):  dedicated GPUs report multi-GB VRAM; integrated often <1GB
        // Signal 3 (PNP ID): integrated GPU PCI IDs have specific patterns we can match
        //
        // Scores are additive where signals agree. Any one strong signal wins.
        int ScoreGPU(string name, long vramMB, string pnp)
        {
            var n = name.ToUpper();
            var pnpU = (pnp ?? "").ToUpper();
            int score = 0;

            // ===== NAME SIGNALS =====

            // Strongly-dedicated NVIDIA
            if (n.Contains("RTX ") || n.Contains("GTX ")) return 2000;
            if (n.Contains("GEFORCE")) return 1800;
            if (n.Contains("QUADRO") || n.Contains("TESLA") || n.Contains("NVIDIA TITAN")) return 1700;

            // Strongly-dedicated AMD Radeon RX/Pro
            if (System.Text.RegularExpressions.Regex.IsMatch(n, @"\bRX\s*[4-9]\d{3}")) return 2000;
            if (System.Text.RegularExpressions.Regex.IsMatch(n, @"\bRX\s*[4-6]\d{2}\b")) return 1900;
            if (n.Contains("RADEON PRO W") || n.Contains("FIREPRO")) return 1700;

            // Intel Arc dGPU
            if (n.Contains("INTEL ARC") || System.Text.RegularExpressions.Regex.IsMatch(n, @"\bARC\s+[AB]\d{3}")) return 1800;

            // ===== KNOWN INTEGRATED PATTERNS =====
            bool nameSaysIntegrated = false;
            if (n.Contains("UHD GRAPHICS")) { score = 50; nameSaysIntegrated = true; }
            else if (n.Contains("IRIS XE")) { score = 60; nameSaysIntegrated = true; }
            else if (n.Contains("IRIS")) { score = 55; nameSaysIntegrated = true; }
            else if (n.Contains("HD GRAPHICS")) { score = 40; nameSaysIntegrated = true; }
            else if (n.Contains("INTEL") && n.Contains("GRAPHICS") && !n.Contains("ARC")) { score = 40; nameSaysIntegrated = true; }
            // AMD integrated — "Radeon Graphics" without a model number typically means iGPU on Ryzen APUs
            else if (n.Contains("RADEON") && n.Contains("GRAPHICS") && !n.Contains("PRO")
                     && !System.Text.RegularExpressions.Regex.IsMatch(n, @"\bRX\s*\d")) { score = 50; nameSaysIntegrated = true; }
            // Named APU graphics (Vega iGPU, Ryzen 680M/780M/890M, etc.)
            else if (System.Text.RegularExpressions.Regex.IsMatch(n, @"RADEON\s+(VEGA|\d{3}M)\b")) { score = 60; nameSaysIntegrated = true; }
            // Apple M-series integrated
            else if (n.Contains("APPLE M") && n.Contains("GPU")) { score = 500; nameSaysIntegrated = true; }

            if (nameSaysIntegrated) {
                // VRAM cross-check: if adapter reports a suspiciously large VRAM (>2GB),
                // it's probably NOT actually integrated — name could be misleading.
                // (iGPUs virtually never report more than 2GB via WMI.)
                if (vramMB > 2048) score += 500;
                return score;
            }

            // ===== UNKNOWN NAME — use VRAM + PNP as tiebreakers =====

            // Integrated APU PCI signatures (AMD Ryzen family)
            // AMD APU iGPUs commonly have PCI device IDs like:
            //   VEN_1002&DEV_1681 (Ryzen 5 APUs)
            //   VEN_1002&DEV_15BF / 15C8 / 164E / 1900 (Phoenix/Hawk Point APUs: 780M/880M/890M)
            //   VEN_1002&DEV_1638 (Raphael iGPU — 7000-series desktop APUs like 7800X3D)
            if (System.Text.RegularExpressions.Regex.IsMatch(pnpU, @"VEN_1002&DEV_(1638|164E|1900|15BF|15C8|1681|13FE|1506)")) return 60;
            // Intel iGPU PCI IDs — VEN_8086 + specific device IDs used only for integrated chips
            if (pnpU.Contains("VEN_8086") && !n.Contains("ARC")) return 50;

            // Low VRAM is a reliable integrated signal (iGPUs typically report <1GB via WMI)
            if (vramMB > 0 && vramMB < 1024) return 60;

            // Unknown but high VRAM — likely a newer dGPU we don't pattern-match
            if (vramMB >= 4096) return 1500;
            if (vramMB >= 2048) return 1200;

            // Default fallback for unknown with unreadable VRAM — treat as dGPU to be safe
            // (better to suggest GPU upgrades for a real dGPU than mis-classify it as iGPU)
            return 1000;
        }

        RAMInfo GetRAM()
        {
            var info = new RAMInfo();
            try
            {
                int totalSlots = 0;
                try
                {
                    using var arrSearcher = new ManagementObjectSearcher("SELECT * FROM Win32_PhysicalMemoryArray");
                    foreach (ManagementObject arr in arrSearcher.Get())
                    {
                        totalSlots = Convert.ToInt32(arr["MemoryDevices"] ?? 0);
                        break;
                    }
                }
                catch { }

                using var searcher = new ManagementObjectSearcher("SELECT * FROM Win32_PhysicalMemory");
                long totalBytes = 0; int stickCount = 0; int maxSpeed = 0; int memType = 0; long firstStickSize = 0;
                var slotLabels = new List<string>();

                foreach (ManagementObject obj in searcher.Get())
                {
                    long cap = Convert.ToInt64(obj["Capacity"] ?? 0);
                    totalBytes += cap; stickCount++;
                    if (stickCount == 1) firstStickSize = cap;

                    string locator = obj["DeviceLocator"]?.ToString()?.Trim() ?? "";
                    string bank = obj["BankLabel"]?.ToString()?.Trim() ?? "";
                    string niceLabel = !string.IsNullOrEmpty(locator) ? locator : bank;
                    if (!string.IsNullOrEmpty(niceLabel)) slotLabels.Add(niceLabel);

                    int speed = Convert.ToInt32(obj["ConfiguredClockSpeed"] ?? obj["Speed"] ?? 0);
                    if (speed > maxSpeed) maxSpeed = speed;
                    int smbiosType = Convert.ToInt32(obj["SMBIOSMemoryType"] ?? 0);
                    if (smbiosType > memType) memType = smbiosType;
                }

                info.TotalGB = (int)(totalBytes / (1024L * 1024 * 1024));
                info.Sticks = stickCount;
                info.StickSizeGB = stickCount > 0 ? (int)(firstStickSize / (1024L * 1024 * 1024)) : 0;
                info.SpeedMHz = maxSpeed;
                info.Type = memType >= 34 ? "DDR5" : memType >= 26 ? "DDR4" : memType >= 24 ? "DDR3" : "DDR";
                info.UsedSlots = stickCount;
                info.TotalSlots = totalSlots > 0 ? totalSlots : stickCount;
                info.SlotLabels = string.Join(", ", slotLabels);
            }
            catch (Exception ex) { info.TotalGB = 0; info.Type = "Unknown: " + ex.Message; }
            return info;
        }

        List<StorageInfo> GetStorage()
        {
            var drives = new List<StorageInfo>();
            try
            {
                using var searcher = new ManagementObjectSearcher("SELECT * FROM Win32_DiskDrive");
                foreach (ManagementObject obj in searcher.Get())
                {
                    var d = new StorageInfo();
                    d.Model = Clean(obj["Model"]?.ToString() ?? "Unknown");
                    d.SizeGB = (int)(Convert.ToInt64(obj["Size"] ?? 0) / (1024L * 1024 * 1024));
                    d.Interface = obj["InterfaceType"]?.ToString() ?? "";
                    string mediaType = obj["MediaType"]?.ToString() ?? "";
                    if (d.Model.Contains("NVMe", StringComparison.OrdinalIgnoreCase) ||
                        d.Interface.Contains("NVMe", StringComparison.OrdinalIgnoreCase) ||
                        d.Interface.Contains("SCSI", StringComparison.OrdinalIgnoreCase))
                        d.Type = "NVMe SSD";
                    else if (mediaType.Contains("SSD", StringComparison.OrdinalIgnoreCase) ||
                             d.Model.Contains("SSD", StringComparison.OrdinalIgnoreCase))
                        d.Type = "SATA SSD";
                    else if (d.SizeGB > 0) d.Type = "HDD";
                    else d.Type = "Unknown";
                    if (d.SizeGB > 0) drives.Add(d);
                }
            }
            catch { }
            return drives;
        }

        MotherboardInfo GetMotherboard()
        {
            var info = new MotherboardInfo();
            try
            {
                using var searcher = new ManagementObjectSearcher("SELECT * FROM Win32_BaseBoard");
                foreach (ManagementObject obj in searcher.Get())
                {
                    info.Manufacturer = obj["Manufacturer"]?.ToString() ?? "Unknown";
                    info.Product = obj["Product"]?.ToString() ?? "Unknown";
                    info.SerialNumber = obj["SerialNumber"]?.ToString() ?? "";
                    break;
                }
            }
            catch { }
            return info;
        }

        long GuessVRAM(string n)
        {
            if (string.IsNullOrEmpty(n)) return 0;
            var u = n.ToUpper();
            if (u.Contains("5090")) return 32 * 1024;
            if (u.Contains("5080 SUPER")) return 24 * 1024;
            if (u.Contains("5080")) return 16 * 1024;
            if (u.Contains("5070 TI SUPER")) return 24 * 1024;
            if (u.Contains("5070 TI")) return 16 * 1024;
            if (u.Contains("5070")) return 12 * 1024;
            if (u.Contains("5060 TI")) return 16 * 1024;
            if (u.Contains("5060")) return 8 * 1024;
            if (u.Contains("4090")) return 24 * 1024;
            if (u.Contains("4080 SUPER")) return 16 * 1024;
            if (u.Contains("4080")) return 16 * 1024;
            if (u.Contains("4070 TI SUPER")) return 16 * 1024;
            if (u.Contains("4070 TI")) return 12 * 1024;
            if (u.Contains("4070 SUPER")) return 12 * 1024;
            if (u.Contains("4070")) return 12 * 1024;
            if (u.Contains("4060 TI")) return 8 * 1024;
            if (u.Contains("4060")) return 8 * 1024;
            if (u.Contains("3090 TI")) return 24 * 1024;
            if (u.Contains("3090")) return 24 * 1024;
            if (u.Contains("3080 TI")) return 12 * 1024;
            if (u.Contains("3080")) return 10 * 1024;
            if (u.Contains("3070 TI")) return 8 * 1024;
            if (u.Contains("3070")) return 8 * 1024;
            if (u.Contains("3060 TI")) return 8 * 1024;
            if (u.Contains("3060")) return 12 * 1024;
            if (u.Contains("3050")) return 8 * 1024;
            if (u.Contains("2080 TI")) return 11 * 1024;
            if (u.Contains("2080")) return 8 * 1024;
            if (u.Contains("2070")) return 8 * 1024;
            if (u.Contains("2060")) return 6 * 1024;
            if (u.Contains("1660 TI")) return 6 * 1024;
            if (u.Contains("1660")) return 6 * 1024;
            if (u.Contains("1650")) return 4 * 1024;
            if (u.Contains("7900 XTX")) return 24 * 1024;
            if (u.Contains("7900 XT")) return 20 * 1024;
            if (u.Contains("7800 XT")) return 16 * 1024;
            if (u.Contains("7700 XT")) return 12 * 1024;
            if (u.Contains("7600 XT")) return 16 * 1024;
            if (u.Contains("7600")) return 8 * 1024;
            if (u.Contains("6950 XT")) return 16 * 1024;
            if (u.Contains("6900 XT")) return 16 * 1024;
            if (u.Contains("6800 XT")) return 16 * 1024;
            if (u.Contains("6800")) return 16 * 1024;
            if (u.Contains("6750 XT")) return 12 * 1024;
            if (u.Contains("6700 XT")) return 12 * 1024;
            if (u.Contains("6700")) return 10 * 1024;
            if (u.Contains("6650 XT")) return 8 * 1024;
            if (u.Contains("6600 XT")) return 8 * 1024;
            if (u.Contains("6600")) return 8 * 1024;
            if (u.Contains("ARC A770")) return 16 * 1024;
            if (u.Contains("ARC A750")) return 8 * 1024;
            if (u.Contains("ARC A580")) return 8 * 1024;
            if (u.Contains("ARC B580")) return 12 * 1024;
            if (u.Contains("ARC B570")) return 10 * 1024;
            return 0;
        }
    }

    public class SystemSpecs { public CPUInfo CPU { get; set; } = new(); public GPUInfo GPU { get; set; } = new(); public RAMInfo RAM { get; set; } = new(); public List<StorageInfo> Storage { get; set; } = new(); public MotherboardInfo Motherboard { get; set; } = new(); }
    public class CPUInfo { public string Name { get; set; } = "Unknown"; public int Cores { get; set; } public int Threads { get; set; } public double MaxClockGHz { get; set; } public string Socket { get; set; } = ""; public string Manufacturer { get; set; } = ""; }
    public class GPUInfo { public string Name { get; set; } = "Unknown"; public long VRAM_MB { get; set; } public string DriverVersion { get; set; } = ""; public string DriverDate { get; set; } = ""; }
    public class RAMInfo { public int TotalGB { get; set; } public string Type { get; set; } = "DDR4"; public int SpeedMHz { get; set; } public int Sticks { get; set; } public int StickSizeGB { get; set; } public int TotalSlots { get; set; } public int UsedSlots { get; set; } public string SlotLabels { get; set; } = ""; }
    public class StorageInfo { public string Model { get; set; } = "Unknown"; public int SizeGB { get; set; } public string Type { get; set; } = "Unknown"; public string Interface { get; set; } = ""; }
    public class MotherboardInfo { public string Manufacturer { get; set; } = "Unknown"; public string Product { get; set; } = "Unknown"; public string SerialNumber { get; set; } = ""; }
}
