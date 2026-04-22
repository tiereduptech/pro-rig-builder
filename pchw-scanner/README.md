# Pro Rig Builder — System Scanner

A lightweight Windows utility that scans your PC hardware and opens prorigbuilder.com with personalized upgrade recommendations.

## What It Detects

| Component | Method | Details |
|-----------|--------|---------|
| **CPU** | WMI `Win32_Processor` | Name, cores, threads, clock speed, socket |
| **GPU** | WMI `Win32_VideoController` | Name, VRAM, driver version (skips integrated graphics) |
| **RAM** | WMI `Win32_PhysicalMemory` | Total capacity, DDR type, speed, stick count/size |
| **Storage** | WMI `Win32_DiskDrive` | Model, capacity, NVMe/SATA SSD/HDD detection |
| **Motherboard** | WMI `Win32_BaseBoard` | Manufacturer, model |

## How It Works

1. User downloads and runs `ProRigScanner.exe` (no install needed)
2. App scans hardware via Windows Management Instrumentation (WMI)
3. Displays detected specs in the console with a formatted summary
4. Opens the user's default browser to `prorigbuilder.com/upgrade?specs=<encoded_data>`
5. The website decodes the specs and shows:
   - Current system overview
   - Compatible upgrade options with affiliate links
   - Bottleneck analysis
   - PSU warning (check your PSU label before upgrading)
   - Performance gain estimates

## Building

### Prerequisites
- [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0) installed

### Build Commands

```powershell
# Development build
dotnet build

# Run directly
dotnet run

# Publish single-file .exe (~2MB, requires .NET runtime installed)
dotnet publish -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true

# Publish self-contained .exe (~15MB, no .NET required)
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:PublishTrimmed=true

# Output will be in: bin/Release/net8.0-windows/win-x64/publish/ProRigScanner.exe
```

### For maximum portability (recommended for distribution):
```powershell
dotnet publish -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:PublishTrimmed=true -p:IncludeNativeLibrariesForSelfExtract=true
```

This produces a single .exe that runs on any Windows 10/11 machine without needing .NET installed.

## URL Format

The scanner encodes specs as base64 JSON in the URL:

```
https://prorigbuilder.com/upgrade?specs=eyJjcHUiOiJBTUQgUnl6ZW4g...
```

Decoded JSON structure:
```json
{
  "cpu": "AMD Ryzen 7 7800X3D",
  "cpu_cores": "8",
  "cpu_threads": "16",
  "cpu_clock": "5.0",
  "cpu_socket": "AM5",
  "gpu": "NVIDIA GeForce RTX 4070",
  "gpu_vram": "12",
  "ram_total": "32",
  "ram_type": "DDR5",
  "ram_speed": "5600",
  "ram_sticks": "2",
  "mobo": "ASUS ROG STRIX B650E-F",
  "mobo_mfr": "ASUSTeK COMPUTER INC.",
  "disk0_model": "Samsung SSD 980 PRO 1TB",
  "disk0_size": "953",
  "disk0_type": "NVMe SSD"
}
```

## Compatibility

- Windows 10 (1903+)
- Windows 11
- x64 only (x86 is deprecated for modern hardware)

## Privacy

- **No data is sent to any server** — specs are encoded in the URL locally
- **No telemetry** — the app has no network calls except opening the browser
- **No installation** — runs as a portable .exe, writes nothing to disk
