[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

# Admin Check
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "ERROR: Please run this script as Administrator!" -ForegroundColor Red
    exit
}

Write-Host "`n=== QEMU EVASION SCRIPT - Fix Remaining BAD Items ===" -ForegroundColor Cyan
Write-Host "This script will try to fix the detections from your report.`n" -ForegroundColor Yellow

function Get-YesNo {
    param([string]$Question)
    $choice = Read-Host "$Question (Y/N)"
    return $choice.ToUpper() -eq "Y"
}

$successCount = 0
$failCount = 0

# ================== SECTION 1: QEMU Guest Agent ==================
if (Get-YesNo "`n[1] Remove QEMU Guest Agent (service + registry)?") {
    Write-Host "`n[1] Removing QEMU Guest Agent..." -ForegroundColor Magenta

    # Remove services
    $services = @("QEMU-GA", "qemu-ga")
    foreach ($svc in $services) {
        if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
            try {
                Stop-Service -Name $svc -Force -ErrorAction SilentlyContinue
                sc.exe delete $svc | Out-Null
                Write-Host "  [OK] Removed service: $svc" -ForegroundColor Green
                $successCount++
            } catch {
                Write-Host "  [FAIL] Could not remove service: $svc" -ForegroundColor Red
                $failCount++
            }
        } else {
            Write-Host "  [INFO] Service $svc not found" -ForegroundColor Cyan
        }
    }

    # Remove from registry
    $uninstallPaths = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
    )
    foreach ($path in $uninstallPaths) {
        Get-ChildItem $path -ErrorAction SilentlyContinue | ForEach-Object {
            $name = (Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue).DisplayName
            if ($name -match "QEMU.*Guest|QEMU-GA") {
                try {
                    Remove-Item $_.PSPath -Recurse -Force -ErrorAction SilentlyContinue
                    Write-Host "  [OK] Removed from Add/Remove Programs" -ForegroundColor Green
                    $successCount++
                } catch {
                    Write-Host "  [FAIL] Could not remove from registry" -ForegroundColor Red
                    $failCount++
                }
            }
        }
    }
}

# ================== SECTION 2: QEMU / Red Hat / VirtIO Cleanup ==================
if (Get-YesNo "`n[2] Clean QEMU/Red Hat/VirtIO registry and devices?") {
    Write-Host "`n[2] Cleaning QEMU/Red Hat/VirtIO artifacts..." -ForegroundColor Magenta

    $paths = @(
        "HKLM:\SYSTEM\CurrentControlSet\Services\QEMU-GA",
        "HKLM:\SYSTEM\CurrentControlSet\Services\qemu-ga",
        "HKLM:\HARDWARE\DEVICEMAP\Scsi\*QEMU*",
        "HKLM:\SYSTEM\CurrentControlSet\Enum\PCI\*QEMU*",
        "HKLM:\SYSTEM\CurrentControlSet\Enum\PCI\*Red Hat*",
        "HKLM:\SYSTEM\CurrentControlSet\Enum\PCI\*VirtIO*"
    )

    foreach ($path in $paths) {
        if (Test-Path $path) {
            try {
                Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
                Write-Host "  [OK] Cleaned: $path" -ForegroundColor Green
                $successCount++
            } catch {
                Write-Host "  [FAIL] Could not clean: $path" -ForegroundColor Red
                $failCount++
            }
        }
    }

    # Rename QEMU disk
    Get-WmiObject Win32_DiskDrive | Where-Object { $_.Model -match "QEMU" } | ForEach-Object {
        try {
            $deviceID = $_.DeviceID -replace '\\', '\\'
            $regPath = "HKLM:\SYSTEM\CurrentControlSet\Enum\$deviceID"
            if (Test-Path $regPath) {
                Set-ItemProperty -Path $regPath -Name "FriendlyName" -Value "Samsung SSD 980 PRO 1TB" -Force
                Write-Host "  [OK] Renamed QEMU disk device" -ForegroundColor Green
                $successCount++
            }
        } catch {
            Write-Host "  [FAIL] Could not rename disk device" -ForegroundColor Red
            $failCount++
        }
    }
}

# ================== SECTION 3: Hyper-V / Related Services ==================
if (Get-YesNo "`n[3] Disable Hyper-V and related services?") {
    Write-Host "`n[3] Disabling Hyper-V / QEMU related services..." -ForegroundColor Magenta

    $services = @("hvhost", "vmicguestinterface", "vmicheartbeat", "vmickvpexchange")
    foreach ($svc in $services) {
        if (Get-Service -Name $svc -ErrorAction SilentlyContinue) {
            try {
                Set-Service -Name $svc -StartupType Disabled -ErrorAction SilentlyContinue
                Write-Host "  [OK] Disabled service: $svc" -ForegroundColor Green
                $successCount++
            } catch {
                Write-Host "  [FAIL] Could not disable: $svc" -ForegroundColor Red
                $failCount++
            }
        } else {
            Write-Host "  [INFO] Service $svc not present" -ForegroundColor Cyan
        }
    }
}

# ================== SECTION 4: Extra Registry Cleanup ==================
if (Get-YesNo "`n[4] Perform extra registry cleanup for QEMU artifacts?") {
    Write-Host "`n[4] Extra registry cleanup..." -ForegroundColor Magenta

    $extraPaths = @(
        "HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4D36E967-E325-11CE-BFC1-08002BE10318}\*\*QEMU*",
        "HKLM:\SYSTEM\CurrentControlSet\Services\Disk\Enum\*QEMU*"
    )

    foreach ($path in $extraPaths) {
        if (Test-Path $path) {
            try {
                Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
                Write-Host "  [OK] Cleaned extra path" -ForegroundColor Green
                $successCount++
            } catch {
                Write-Host "  [FAIL] Could not clean extra path" -ForegroundColor Red
                $failCount++
            }
        }
    }
}

# ================== FINAL SUMMARY ==================
Write-Host "`n=== SCRIPT COMPLETED ===" -ForegroundColor Cyan
Write-Host "Successful actions: $successCount" -ForegroundColor Green
Write-Host "Failed actions:     $failCount" -ForegroundColor $(if ($failCount -gt 0) { "Red" } else { "Green" })

Write-Host "`nWhat this script can fix:" -ForegroundColor Yellow
Write-Host "  - QEMU Guest Agent (service + registry)" -ForegroundColor White
Write-Host "  - QEMU NVMe Ctrl device name" -ForegroundColor White
Write-Host "  - QEMU / Red Hat / VirtIO registry entries" -ForegroundColor White
Write-Host "  - Hyper-V related services" -ForegroundColor White

Write-Host "`nWhat still cannot be fixed from inside Windows:" -ForegroundColor Yellow
Write-Host "  - Hypervisor bit (WMI)" -ForegroundColor White
Write-Host "  - Missing CPU features (SSE2, SSE3, RDTSC)" -ForegroundColor White
Write-Host "  - ACPI BOCHS_ tables" -ForegroundColor White
Write-Host "  - No battery / temperature sensors" -ForegroundColor White
Write-Host "  - GPU reports 0 VRAM" -ForegroundColor White
Write-Host "  - CPU Cache Topology" -ForegroundColor White

Write-Host "`n=== IMPORTANT MANUAL STEPS (Do These in UTM) ===" -ForegroundColor Cyan
Write-Host "1. Shut down the VM" -ForegroundColor White
Write-Host "2. Increase RAM to at least 8-12 GB" -ForegroundColor White
Write-Host "3. Increase disk size to at least 128 GB" -ForegroundColor White
Write-Host "4. Change MAC address in Network settings" -ForegroundColor White
Write-Host "5. Start the VM and use it normally for 30-60 mins before testing again" -ForegroundColor White

Write-Host "`nPress any key to exit..." -ForegroundColor Gray
$Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown") | Out-Null