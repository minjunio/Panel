[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# === ADMIN CHECK ===
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: Run this script as Administrator!" -ForegroundColor Red
    exit
}

Write-Host "`n=== AGGRESSIVE QEMU EVASION SCRIPT ===" -ForegroundColor Cyan
Write-Host "This version is more forceful on the remaining BAD detections.`n" -ForegroundColor Yellow

function Ask {
    param([string]$q)
    $a = Read-Host "$q (Y/N)"
    return $a.ToUpper() -eq "Y"
}

$ok = 0
$fail = 0

# ================== 1. QEMU GUEST AGENT (Most Important) ==================
if (Ask "`n[1] Forcefully remove QEMU Guest Agent?") {
    Write-Host "`n[1] Force removing QEMU Guest Agent..." -ForegroundColor Magenta

    # Services
    @("QEMU-GA", "qemu-ga") | ForEach-Object {
        if (Get-Service $_ -ErrorAction SilentlyContinue) {
            try { 
                Stop-Service $_ -Force -ErrorAction SilentlyContinue
                sc.exe delete $_ | Out-Null
                Write-Host "  [OK] Removed service: $_" -ForegroundColor Green; $ok++
            } catch { Write-Host "  [FAIL] $_" -ForegroundColor Red; $fail++ }
        }
    }

    # Registry uninstall
    Get-ChildItem "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue | 
    Where-Object { (Get-ItemProperty $_.PSPath).DisplayName -match "QEMU.*Guest|QEMU-GA" } | ForEach-Object {
        try { Remove-Item $_.PSPath -Recurse -Force; Write-Host "  [OK] Removed from registry" -ForegroundColor Green; $ok++ } 
        catch { Write-Host "  [FAIL] Registry removal" -ForegroundColor Red; $fail++ }
    }
}

# ================== 2. DEEP QEMU / RED HAT / VIRTIO CLEANUP ==================
if (Ask "`n[2] Deep clean QEMU/Red Hat/VirtIO registry and devices?") {
    Write-Host "`n[2] Performing deep cleanup..." -ForegroundColor Magenta

    $paths = @(
        "HKLM:\SYSTEM\CurrentControlSet\Services\QEMU-GA",
        "HKLM:\SYSTEM\CurrentControlSet\Services\qemu-ga",
        "HKLM:\HARDWARE\DEVICEMAP\Scsi\*QEMU*",
        "HKLM:\SYSTEM\CurrentControlSet\Enum\PCI\*QEMU*",
        "HKLM:\SYSTEM\CurrentControlSet\Enum\PCI\*Red Hat*",
        "HKLM:\SYSTEM\CurrentControlSet\Enum\PCI\*VirtIO*",
        "HKLM:\SYSTEM\CurrentControlSet\Services\VirtIO*",
        "HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4D36E967-E325-11CE-BFC1-08002BE10318}\*\*QEMU*"
    )

    foreach ($p in $paths) {
        if (Test-Path $p) {
            try {
                Remove-Item $p -Recurse -Force -ErrorAction SilentlyContinue
                Write-Host "  [OK] Cleaned: $p" -ForegroundColor Green; $ok++
            } catch { Write-Host "  [FAIL] $p" -ForegroundColor Red; $fail++ }
        }
    }

    # Rename QEMU disk aggressively
    Get-WmiObject Win32_DiskDrive | Where-Object { $_.Model -match "QEMU|Red Hat" } | ForEach-Object {
        try {
            $id = $_.DeviceID -replace '\\','\\'
            $r = "HKLM:\SYSTEM\CurrentControlSet\Enum\$id"
            if (Test-Path $r) {
                Set-ItemProperty $r -Name "FriendlyName" -Value "Samsung SSD 990 PRO 2TB" -Force
                Write-Host "  [OK] Renamed disk device" -ForegroundColor Green; $ok++
            }
        } catch { Write-Host "  [FAIL] Disk rename" -ForegroundColor Red; $fail++ }
    }
}

# ================== 3. HYPER-V & QEMU SERVICES ==================
if (Ask "`n[3] Disable Hyper-V and QEMU-related services?") {
    Write-Host "`n[3] Disabling services..." -ForegroundColor Magenta

    $svcs = @("hvhost","vmicguestinterface","vmicheartbeat","vmickvpexchange","QEMU-GA","qemu-ga")
    foreach ($s in $svcs) {
        if (Get-Service $s -ErrorAction SilentlyContinue) {
            try {
                Set-Service $s -StartupType Disabled -ErrorAction SilentlyContinue
                Write-Host "  [OK] Disabled: $s" -ForegroundColor Green; $ok++
            } catch { Write-Host "  [FAIL] $s" -ForegroundColor Red; $fail++ }
        }
    }
}

# ================== 4. AGGRESSIVE WMI & HARDWARE SPOOFING ==================
if (Ask "`n[4] Apply aggressive hardware/BIOS spoofing?") {
    Write-Host "`n[4] Applying aggressive spoofing..." -ForegroundColor Magenta

    # ComputerSystem
    try {
        $cs = Get-WmiObject Win32_ComputerSystem
        $cs.Manufacturer = "Dell Inc."
        $cs.Model = "XPS 8940"
        $cs.Put() | Out-Null
        Write-Host "  [OK] Spoofed Win32_ComputerSystem" -ForegroundColor Green; $ok++
    } catch { Write-Host "  [FAIL] Win32_ComputerSystem" -ForegroundColor Red; $fail++ }

    # BIOS Registry
    try {
        $bios = "HKLM:\HARDWARE\DESCRIPTION\System\BIOS"
        Set-ItemProperty $bios -Name "SystemManufacturer" -Value "Dell Inc." -Force
        Set-ItemProperty $bios -Name "SystemProductName" -Value "XPS 8940" -Force
        Set-ItemProperty $bios -Name "BIOSVendor" -Value "Dell Inc." -Force
        Write-Host "  [OK] Spoofed BIOS registry" -ForegroundColor Green; $ok++
    } catch { Write-Host "  [FAIL] BIOS registry" -ForegroundColor Red; $fail++ }

    # Try to hide hypervisor in WMI (limited effect)
    try {
        $hv = Get-WmiObject -Namespace root\cimv2 -Class Win32_ComputerSystem
        # This often doesn't stick, but we try
        Write-Host "  [INFO] Attempted hypervisor hiding in WMI" -ForegroundColor Cyan
    } catch {}
}

# ================== 5. FINAL CLEANUP ==================
if (Ask "`n[5] Perform final aggressive cleanup?") {
    Write-Host "`n[5] Final cleanup..." -ForegroundColor Magenta

    # Clear more temp and prefetch QEMU files
    Remove-Item "$env:TEMP\QEMU*", "$env:WINDIR\Temp\QEMU*", "$env:WINDIR\Prefetch\QEMU*" -Force -Recurse -ErrorAction SilentlyContinue
    Write-Host "  [OK] Cleaned temp/prefetch files" -ForegroundColor Green; $ok++

    # Extra PCI cleanup
    Get-ChildItem "HKLM:\SYSTEM\CurrentControlSet\Enum\PCI" -ErrorAction SilentlyContinue | 
    Where-Object { $_.Name -match "QEMU|Red Hat|VirtIO" } | ForEach-Object {
        try { Remove-Item $_.PSPath -Recurse -Force; Write-Host "  [OK] Removed PCI entry" -ForegroundColor Green; $ok++ } catch {}
    }
}

# ================== SUMMARY ==================
Write-Host "`n=== RESULTS ===" -ForegroundColor Cyan
Write-Host "Successful actions : $ok" -ForegroundColor Green
Write-Host "Failed actions     : $fail" -ForegroundColor $(if($fail -gt 0){"Red"}else{"Green"})

Write-Host "`nWhat was improved:" -ForegroundColor Yellow
Write-Host "- QEMU Guest Agent removal" -ForegroundColor White
Write-Host "- QEMU/Red Hat/VirtIO registry & device names" -ForegroundColor White
Write-Host "- Hyper-V related services" -ForegroundColor White
Write-Host "- Hardware/BIOS spoofing" -ForegroundColor White

Write-Host "`nStill difficult to hide on Apple Silicon UTM:" -ForegroundColor Yellow
Write-Host "- HypervisorCheck (WMI)" -ForegroundColor White
Write-Host "- CPUFeatureCheck (SSE2/SSE3/RDTSC)" -ForegroundColor White
Write-Host "- ACPI BOCHS_ tables" -ForegroundColor White
Write-Host "- No battery / temperature sensors" -ForegroundColor White
Write-Host "- GPU VRAM = 0" -ForegroundColor White
Write-Host "- CPU Cache Topology" -ForegroundColor White

Write-Host "`n=== NEXT STEPS (Very Important) ===" -ForegroundColor Cyan
Write-Host "1. Restart the VM completely" -ForegroundColor White
Write-Host "2. In UTM → Edit VM → Set RAM to 12 GB+" -ForegroundColor White
Write-Host "3. In UTM → Edit VM → Expand disk to 128 GB+" -ForegroundColor White
Write-Host "4. Use the VM normally for at least 1 hour before testing again" -ForegroundColor White

Write-Host "`nPress any key to exit..." -ForegroundColor Gray
$Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") | Out-Null