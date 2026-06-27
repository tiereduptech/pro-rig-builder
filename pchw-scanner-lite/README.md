# Pro Rig Scanner Lite

Tiny portable console build of the Pro Rig scanner. No WPF, no GUI, no install,
no updater. It reads your hardware via WMI, builds the same handoff URL the full
WPF scanner produces, opens your default browser to `prorigbuilder.com/upgrade`,
and exits.

This is a **second, standalone** scanner. The full WPF scanner in `../pchw-scanner/`
is untouched and stays live.

## Differences from the WPF scanner

The hardware-detection logic (CPU/GPU/RAM/storage/motherboard, GPU scoring,
VRAM table) is copied **verbatim** so detection is byte-identical. The handoff
URL is identical too — same JSON keys, same base64+urlencode, same URL shape —
**except** the user-question fields are omitted, because those are now asked on
the web page instead of in the exe:

- `budget`
- `add_storage_gb`
- `add_storage_type`
- `cooler_type`

`use_case` is kept and defaults to `"gaming"`. The `#upgrade` page must treat the
four omitted params as optional/absent.

## Build

```
dotnet publish -c Release -r win-x64 -o ./publish
```

Output: `publish/ProRigScannerLite.exe` — self-contained, single-file, compressed.

> Trimming is intentionally **off**: `System.Management` (WMI) is not trim-safe —
> its static initializers reflect into types the trimmer removes, which makes
> every WMI query throw at runtime. Size is kept down with single-file compression.

## Flags

- `--dev`   — point at `http://localhost:3000` instead of production.
- `--print` — print the detected specs and the handoff URL instead of opening the
  browser (used to verify byte-compatibility).
- `--mock-gpu=<scenario>` — run GPU scoring against a hardcoded scenario.
