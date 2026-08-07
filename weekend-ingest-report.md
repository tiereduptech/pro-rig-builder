# Weekend Amazon ingest — APPLY — 2026-08-07T22:45:56.550Z

Branch: `weekend-ingest-2026-08-08`  |  everything QUARANTINED (needsReview:true)  |  no deploy

## Deferred (not run)
- **Newegg**: RAKUTEN_FTP_PASSWORD absent (local + Railway) — auth hard-stop; the only fully-validated path could not run.
- **BestBuy**: bestbuy-discover-v2.js writes staging JSON via writeFileSync (NOT writeCatalog); 2-step discover→merge with an unvalidated merge write-path. Violates writeCatalog-only.
- **AmazonOtherCats**: No calibrated price ceiling and no per-category query plan beyond RAM/PSU/Storage/Case — running unattended = the stale-ceiling/null-classifier risk.

## Per category

### RAM
candidates 481 · deduped 88 · accepted 227 (rate 57.8%) · written 227 (all quarantined)
price ceiling: 215 priced, 0 over ceiling (0.0%), calibrated 2026-07-27
wrong-ASIN detector: 0/227 new rows flagged (0.0%)

rejected by gate (first gate that fired; up to 5 examples):
- **categoryReject:laptop_sodimm** — 85
    - Crucial 32GB DDR5 RAM Kit (2x16GB), 5600MHz (or 5200MHz or 4800MHz) Laptop Memory 262-Pin SO
    - CORSAIR Vengeance SODIMM DDR5 RAM 16GB (1x16GB) Up to 5600MHz CL48 Intel XMP 3.0 Desktop Com
    - CORSAIR Vengeance SODIMM DDR5 RAM 32GB (1x32GB) Up to 5600MHz CL48 Intel XMP 3.0 Desktop Com
    - A-Tech DDR4 RAM 32GB Kit (2x16GB) 2666MHz PC4-21300 SODIMM Laptop Memory
    - Crucial 16GB DDR4 RAM Kit (2x8GB), 3200MHz (PC4-25600), Downclockable to 2933/2666MHz Laptop
- **prebuilt:re** — 42
    - A-Tech 8GB DDR5 4800MHz PC5-38400 CL40 UDIMM 1.1V Non-ECC Unbuffered DIMM 288-Pin Desktop PC
    - A-Tech 16GB DDR5 4800MHz PC5-38400 CL40 UDIMM 1.1V Non-ECC Unbuffered DIMM 288-Pin Desktop P
    - Samsung 16GB DDR5 5600MHz PC5-44800 CL46 UDIMM 1Rx8 Single Rank 1.1V Non-ECC DIMM 288-Pin De
    - GMKtec Gaming PC, K11 AMD Ryzen 9 8945HS(8C/16T, Up to 5.2GHz), 32GB DDR5 RAM 1TB Mini PC De
    - SK Hyn(Hynix) Original 8GB (1x8GB) DDR5 5600MHz (or 4800MHz PC5-38400) High-Performance Gami
- **prebuilt:prebuilt_system** — 18
    - Dell Pro Tower Plus Desktop, Intel 14-Core Ultra 5 235, 32GB DDR5 RAM, 1TB PCIe SSD, Windows
    - HP OmniDesk Desktop Computer PC, AMD Ryzen 7 8700G, 32GB DDR5 Memory, 1TB NVMe SSD, Radeon 7
    - Dell Pro Business Desktop, New OptiPlex Version, Intel I7-12700K(25MB Cache, 12 Core, 20Thre
    - Dell Pro Slim QCS1250 SFF Desktop, New OptiPlex Version Intel Ultra 5-235 (Beats i7-14700), 
    - Dell Pro Tower Desktop PC 2026, Intel i3-14100, 16GB DDR5 RAM, 1TB SSD
- **unclassified** — 6
    - Motoeagle16GB Kit (4 X4GB) PC3-10600U DDR3 1333MHz UDIMM RAM, 4GB DDR3 DIMM Memory, CL9 1.5V
    - OWC 32GB Memory RAM Kit Compatible with Synology DiskStation DS723+ DS923+
    - G.Skill D532GB 6000-30 Flare X5 K2 GSK F5-6000J3038F16GX2-FX5
    - G Skill F5-6000J3636F16GX2-RS5K Memor Gskilf5-6000j3636f16gx2-rs5k R
    - Netac DDR4 DRAM 32GB Kit16GBx2 C16 3200MHz XMP 2.0 Dual Channel RAM (PC4-25600) 1.35V 288-Pi
- **miscategorized:CPU** — 4
    - GMKtec M6 Ultra Gaming Mini PC Ryzen 7640HS (Upgraded 6600H/ 6800H), 32GB RAM DDR5 512GB SSD
    - Dell Tower Desktop for Business & Home, Intel Core i5-14500 (14-Core)
    - Lexar 32GB (2x16GB) THOR DDR4 RAM 3200MT/s CL16 1.35V Desktop Memory with Heatsink, AMD Ryze
    - Kingston FURY Beast 32GB (2x16GB) 3200MT/s DDR4 CL16 Desktop Memory Kit of 2 | Intel XMP | A
- **miscategorized:Storage** — 3
    - Dell Desktop Computers 32GB DDR5 RAM, 1TB PCIe SSD, 14th Gen Intel CPU
    - HP OmniStudio 24" Full HD All-in-OneDesktop Computer, 16GB DDR5 RAM, Intel Quad-Cores, 128GB
    - HP Pro 400 G9 Mini PC Desktop Computer, Intel CPU, 16GB DDR5 RAM, 512GB PCIe SSD, Triple 4K 
- **prebuilt:prebuilt_brand** — 3
    - Dell Pro Micro Business Desktop (OptiPlex MFF Next-Gen), Intel Core ultra5 235T, up to 5GHz,
    - Dell Pro Slim Plus QBS1250 SFF AI Desktop (Replaces OptiPlex), Ultra 7 265
    - A-Tech 32GB Kit (2x16GB) RAM for Dell OptiPlex 7070, 7060, 5070, 5060, 3070, 3060 Micro Desk
- **specBar** — 2
    - G.SKILL Trident Z5 Neo RGB 64GB [2 x 32GB] DDR5 SDRAM Memory Kit
    - TEAMGROUP DDR5 Memory
- **categoryReject:server_registered_ram** — 2
    - Kingston FURY Renegade Pro EXPO 64GB 5600MT/s DDR5 ECC Reg CL28 DIMM (Kit of 4) Memory Overc
    - NEMIX RAM 64GB (2X32GB) DDR5 4800MHz PC5-38400 2Rx8 1.1V CL40 288-PIN ECC RDIMM Registered S
- **categoryReject:ecc_ram** — 1
    - 64GB 2X32GB DDR5 4800MHZ PC5-38400 1.1V 2Rx8 CL40 288-PIN ECC UDIMM KIT Designed for Motherb

### PSU
candidates 446 · deduped 135 · accepted 242 (rate 77.8%) · written 242 (all quarantined)
price ceiling: 225 priced, 0 over ceiling (0.0%), calibrated 2026-07-27
wrong-ASIN detector: 0/242 new rows flagged (0.0%)

rejected by gate (first gate that fired; up to 5 examples):
- **specBar** — 31
    - Cooler Master MWE Gold 850 V2 Power Supply, Fully Modular
    - CORSAIR RMX Series, RM850x, 850 Watt, 80+ Gold Certified, Fully Modular Power Supply
    - CORSAIR RM1000x Fully Modular ATX Power Supply - 80 Plus Gold - Low-Noise Fan - Zero RPM - B
    - RAIDMAX RX-AESD Series Power Supply, ATX 3.1 & PCIe Gen 5 Ready, SI OEM Direct Cable Version
    - darkFlash PMT Fully Modular Power Supply ATX 3.1& PCIe 5.1 Ready, 2 x 12VHPWR Cable Included
- **renewed_condition** — 18
    - MSI MAG A750GL PCIE 5 & ATX 3.0 80 Plus Gold Gaming Power Supply – Full Modular (Renewed)
    - CORSAIR RM850x Shift Fully Modular ATX Power Supply - 80 Plus Gold - ATX 3.1 - PCIe 5.1 - Ze
    - CORSAIR RM750x Shift Fully Modular ATX Power Supply - 80 Plus Gold - ATX 3.1 - PCIe 5.1 - Ze
    - Corsair RM750e (2023) Fully Modular Low-Noise Power Supply - ATX 3.1 & PCIe 5.1 Compliant - 
    - CORSAIR RM850x Fully Modular Low-Noise ATX Power Supply – ATX 3.1 Compliant – PCIe 5.1 Suppo
- **prebuilt:re** — 5
    - 750W Power Supply, 80 Plus Gold Certified Non-Modular PSU with Active PFC, Quiet 120mm Cooli
    - GAMDIAS ATX 3.1 & PCIe 5.1 850W Bronze PSU, 850W Gaming Power Supply, 80+ Bronze ATX Gold 12
    - 800W 80+ Bronze Certified ATX Power Supply, Gaming PSU with Active PFC, High Performance Des
    - SHARK TECHNOLOGY® ATX-1000-LED Silent 1000W 120mm Blue LED Fan Active PFC Dual PCI-E Gaming 
    - SHARK TECHNOLOGY® 1000W Black ATX12V EPS12 Silent 120mm Fan Gaming PC 2X PCI-E Power Supply 
- **accessory:fan hub/splitter** — 4
    - Lian Li EDGE850W Fully Modular Low-Noise ATX Power Supply - ATX 3.1 & PCIE 5.1 Compliant - C
    - Lian Li EDGE750W Fully Modular Low-Noise ATX Power Supply - ATX 3.1 & PCIE 5.1 Compliant - C
    - Lian Li RS1000G 1000W ATX Power Supply w/o USB Fan Hub - Black (RS1000G.B)
    - Lian Li RS1000G 1000W ATX Power Supply w/o USB Fan Hub - White (RS1000G.W)
- **accessory:power cable** — 3
    - ASUS ROG Strix 1000W Platinum White Edition (80 Plus & Cybenetics Platinum, Fully Modular AT
    - ASUS ROG Strix 1200W Platinum (80 Plus and Cybenetics Platinum, Fully Modular ATX, ATX 3.1, 
    - ASUS ROG Strix 1000W Platinum (80 Plus and Cybenetics Platinum, Fully Modular ATX, ATX 3.1, 
- **unclassified** — 2
    - CORSAIR RM Series
    - FSP FSP450-50ASC
- **bundle:gpu+psu** — 1
    - Apevia Galaxy 850W 80+ Gold ATX 3.1 Fully Modular Gaming PSU, PCIe 5.1 600W 12VHPWR, Japanes
- **miscategorized:Motherboard** — 1
    - GAMEMAX 850W 80 Plus Gold Power Supply, ATX 3.0 & PCIE 5.0 Ready, 100% Japanese Capacitors, 
- **accessory:cable accessory** — 1
    - Lian Li RB 650W Power Supply, 80 Plus Bronze, ATX 3.1, PCIe 5.1 Ready, 135mm Low-Noise Fan, 
- **prebuilt:prebuilt_brand** — 1
    - Wisoqu 650W Semi Fanless Modular Power Supply, 80 Plus Bronze Certified for Computers, Compa
- **prebuilt:prebuilt_gaming** — 1
    - MLOONG Prebuilt Gaming PC AMD Ryzen 5 5500 GeForce RTX 5060 8GB GDDR6
- **bundle:mobo+psu** — 1
    - GAMEMAX 1300W Power Supply, ATX 3.0 & PCIE 5.0 Ready, 80+ Platinum Certified, Addressable RG

### Storage
candidates 472 · deduped 210 · accepted 200 (rate 76.3%) · written 200 (all quarantined)
price ceiling: 197 priced, 8 over ceiling (4.1%), calibrated 2026-07-27
wrong-ASIN detector: 0/200 new rows flagged (0.0%)

rejected by gate (first gate that fired; up to 5 examples):
- **miscategorized:CPUCooler** — 20
    - Silicon Power 2TB US75 Nvme PCIe Gen4 M.2 2280 SSD R/W Up to 7,000/6,500 MB/s with Heatsink 
    - WD_BLACK 2TB SN850P NVMe M.2 SSD Officially Licensed Storage Expansion for PS5 Consoles, up 
    - Crucial P310 2280 2TB PCIe Gen4 NVMe Gaming PS5 SSD with Heatsink, Up to 7,100MB/s, PlayStat
    - Bestoss 2TB PCIe4.0 NVMe M.2 2280 SSD with Heatsink, PS5 Storage, 7350MB/s
    - Samsung SSD 9100 PRO w/Heatsink 2TB, PCIe 5.0x4 M.2 2280, Up to 14,700MB/s
- **prebuilt:re** — 19
    - KingSpec 2TB M.2 NVMe PCIe Gen4 SSD - Up to 7400MB/s Read, Championship Edition, 3D NAND Fla
    - KingSpec 1TB M.2 NVMe PCIe Gen4 SSD - Up to 7400MB/s Read, Championship Edition, 3D NAND Fla
    - Lufasnd 1TB M.2 NVMe SSD 2280, PCIe Gen3 x4 Internal Solid State Drive, Up to 3200MB/s, 3D N
    - KingSpec 1TB 2.5 SSD SATA III Internal - 550MB/s Read, 520MB/s Write with 3D NAND Flash, for
    - Lufasnd Internal 1TB SATA SSD, 2.5 Inch SSD SATA III 6Gb/s, Solid State Drive, Up to 520MB/s
- **renewed_condition** — 6
    - SanDisk Ultra 3D NAND 1TB Internal SSD - SATA III 6 Gb/s, 2.5 Inch /7 mm, Up to 560 MB/s - ‎
    - Seagate 1TB Laptop HDD SATA 6Gb/s 128MB Cache 2.5-Inch Internal Hard Drive (ST1000LM035) (Op
    - Western Digital 1TB WD Blue SA510 SATA Internal Solid State Drive SSD - SATA III 6 Gb/s, 2.5
    - Seagate Exos 7E8 4TB 512n SATA 128MB Cache 3.5-Inch Enterprise Hard Drive (ST4000NM0035) (Re
    - Hitachi 2022 HGST WD Ultrastar HUS726T4TALE6L4 4TB 7200 RPM 512e SATA 6Gb/s 3.5-inch Interna
- **accessory:drive enclosure** — 5
    - SABRENT USB-C NVMe Enclosure & Reader, M.2 PCIe SSD, 10Gbps (EC-PNVO)
    - UGREEN SSD Enclosure Tool-Free USB C External 10Gbps M.2 NVMe to USB
    - SABRENT 2.5in SATA to USB 3.0 Tool-Free SSD/HDD Enclosure (EC-UASP)
    - BENFEI 2.5 Inch SATA to USB Tool Free External Hard Drive Enclosure, USB Type-C/Type-A to Sa
    - UGREEN USB C Hard Drive Enclosure for 2.5" SATA SSD HDD,Aluminum
- **unclassified** — 4
    - ADATA Legend 860, PCIe Gen4 Solid State Drive, 2TB, 1 Count
    - Western Digital WD Green SATA 1TB, Up to 545MB/s, 2.5"/7mm, 3Y Warranty, Internal Solid Stat
    - 1TB WD Blue SATA 2.5
    - (Old Model) Seagate 1TB Gaming SSHD SATA 8GB NAND SATA 6Gb/s 2.5-Inch Internal Bare Drive (S
- **categoryReject:external_usb** — 4
    - msi SPATIUM M470 PRO PCIe 4.0 NVMe M.2 2TB Portable SSD, 2TB External Solid State Drive, Spe
    - ORICO 1TB SATA SSD 2.5 Inch Internal Solid State Drive, Read Speed up to 500MB/s, SATA III 6
    - SANDISK 4TB Extreme PRO Portable SSD - Up to 2000MB/s - USB-C, USB 3.2 Gen 2x2, IP65 Water a
    - ORICO 128GB SATA SSD 2.5 Inch Internal Solid State Drive, Read Speed up to 500MB/s, SATA III
- **specBar** — 2
    - Lexar 256B NS100 Internal SSD 2.5" SATA III, 520MB/s Read, Gray
    - TAIMI 2.5-Inch SATA III Internal Solid State Drive (SSD) - Up to 550MB/s, 3D NAND TLC, High-
- **accessory:cooler mount bracket** — 1
    - ORICO 2.5 SSD SATA to 3.5 Hard Drive Adapter Internal Drive Bay Converter Mounting Bracket C
- **accessory:adapter cable** — 1
    - SABRENT USB 3.0 to 2.5in SATA Adapter Cable for SSD & HDD, UASP (EC-SSHD)

## Totals
- candidates 1399 · accepted 669 · **written 669 (all quarantined)**

## Release recommendation
- Every row is quarantined pending your Monday review. Release guidance per batch is added after writes complete.
- RAM batch amazon-ram-2026-08-07: 227 rows — looks clean; spot-check a sample then release
- PSU batch amazon-psu-2026-08-07: 242 rows — looks clean; spot-check a sample then release
- Storage batch amazon-storage-2026-08-07: 200 rows — looks clean; spot-check a sample then release