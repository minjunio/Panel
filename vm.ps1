[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Host "Restarting as Administrator..." -ForegroundColor Yellow
    Start-Process powershell.exe -ArgumentList "& '$($MyInvocation.MyCommand.Path)'" -Verb RunAs
    Exit
}

Write-Host "Starting QEMU VM Spoofing & Hardening Script..." -ForegroundColor Cyan

$Global:restartRequired = $false

function New-RestorePoint {
    Write-Host "`nCreating System Restore Point..." -ForegroundColor Yellow
    try {
        Enable-ComputerRestore -Drive $env:SystemDrive -ErrorAction SilentlyContinue
        Checkpoint-Computer -Description "Before QEMU Spoofing Script" -RestorePointType "APPLICATION_INSTALL" -ErrorAction Stop
        Write-Host "System Restore Point created successfully." -ForegroundColor Green
    } catch {
        Write-Host "Could not create restore point." -ForegroundColor Yellow
    }
}

function Set-HardwareBiosSpoofing {
    Write-Host "`nSpoofing Hardware and BIOS Information..." -ForegroundColor Cyan

    $biosPath = "HKLM:\HARDWARE\DESCRIPTION\System\BIOS"
    Set-ItemProperty -Path $biosPath -Name "SystemManufacturer" -Value "Dell Inc." -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $biosPath -Name "SystemProductName" -Value "XPS 8940" -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $biosPath -Name "SystemFamily" -Value "XPS" -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $biosPath -Name "BIOSVendor" -Value "Dell Inc." -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $biosPath -Name "BIOSVersion" -Value "2.12.0" -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $biosPath -Name "BIOSReleaseDate" -Value "05/15/2024" -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $biosPath -Name "BaseBoardManufacturer" -Value "Dell Inc." -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $biosPath -Name "BaseBoardProduct" -Value "0XPS8940" -Force -ErrorAction SilentlyContinue

    $sysInfoPath = "HKLM:\SYSTEM\CurrentControlSet\Control\SystemInformation"
    Set-ItemProperty -Path $sysInfoPath -Name "SystemManufacturer" -Value "Dell Inc." -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $sysInfoPath -Name "SystemProductName" -Value "XPS 8940" -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $sysInfoPath -Name "BIOSVersion" -Value "2.12.0" -Force -ErrorAction SilentlyContinue

    Write-Host "Hardware and BIOS spoofing completed." -ForegroundColor Green
}

function Set-CPUSpoofing {
    Write-Host "`nSpoofing CPU Information..." -ForegroundColor Cyan

    $cpuPath = "HKLM:\HARDWARE\DESCRIPTION\System\CentralProcessor\0"
    Set-ItemProperty -Path $cpuPath -Name "ProcessorNameString" -Value "Intel(R) Core(TM) i7-11700K CPU @ 3.60GHz" -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path $cpuPath -Name "\~MHz" -Value 3600 -Force -ErrorAction SilentlyContinue

    [System.Environment]::SetEnvironmentVariable("NUMBER_OF_PROCESSORS", "8", "Machine")

    Write-Host "CPU spoofing completed." -ForegroundColor Green
}

function Set-DiskStorageSpoofing {
    Write-Host "`nSpoofing Disk and Storage Information..." -ForegroundColor Cyan

    foreach ($port in 0..5) {
        foreach ($bus in 0..3) {
            $path = "HKLM:\HARDWARE\DEVICEMAP\Scsi\Scsi Port $port\Scsi Bus $bus\Target Id 0\Logical Unit Id 0"
            if (Test-Path $path) {
                Set-ItemProperty -Path $path -Name "Identifier" -Value "NVMe Samsung SSD 980 PRO" -Force -ErrorAction SilentlyContinue
                Set-ItemProperty -Path $path -Name "SerialNumber" -Value ((Get-Random -Minimum 100000000000 -Maximum 999999999999).ToString()) -Force -ErrorAction SilentlyContinue
            }
        }
    }

    Write-Host "Disk and storage spoofing completed." -ForegroundColor Green
}

function Set-GPUSpoofing {
    Write-Host "`nSpoofing GPU Information..." -ForegroundColor Cyan

    $gpuPath = "HKLM:\SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}\0000"
    if (Test-Path $gpuPath) {
        Set-ItemProperty -Path $gpuPath -Name "DriverDesc" -Value "NVIDIA GeForce RTX 3070" -Force -ErrorAction SilentlyContinue
        Set-ItemProperty -Path $gpuPath -Name "HardwareInformation.AdapterString" -Value "NVIDIA GeForce RTX 3070" -Force -ErrorAction SilentlyContinue
    }

    Write-Host "GPU spoofing completed." -ForegroundColor Green
}

function Set-AdvancedVMEvasion {
    Write-Host "`nApplying Advanced VM Evasion..." -ForegroundColor Cyan

    $vmRegistryPaths = @(
        "HKLM:\SYSTEM\CurrentControlSet\Services\vmdebug",
        "HKLM:\SYSTEM\CurrentControlSet\Services\vmmouse",
        "HKLM:\SYSTEM\CurrentControlSet\Services\VMTools",
        "HKLM:\SYSTEM\CurrentControlSet\Services\VMMEMCTL",
        "HKLM:\SYSTEM\CurrentControlSet\Services\vmware",
        "HKLM:\SYSTEM\CurrentControlSet\Services\vmci",
        "HKLM:\SYSTEM\CurrentControlSet\Services\QEMU-GA"
    )

    foreach ($path in $vmRegistryPaths) {
        if (Test-Path $path) {
            Remove-Item -Path $path -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    # Clean VM-related environment variables
    $envVars = Get-ChildItem Env: | Where-Object { $_.Name -match "QEMU|VM|Virtual" -or $_.Value -match "QEMU|VM|Virtual" }
    foreach ($var in $envVars) {
        [System.Environment]::SetEnvironmentVariable($var.Name, $null, "Machine")
        [System.Environment]::SetEnvironmentVariable($var.Name, $null, "User")
    }

    Write-Host "Advanced VM evasion completed." -ForegroundColor Green
}

function Set-TimingPerformanceMasking {
    Write-Host "`nApplying Timing and Performance Masking..." -ForegroundColor Cyan

    Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\TimeZoneInformation" -Name "RealTimeIsUniversal" -Value 0 -Force -ErrorAction SilentlyContinue

    New-Item -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Perflib" -Force -ErrorAction SilentlyContinue | Out-Null
    Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Perflib" -Name "Disable Performance Counters" -Value 1 -Force -ErrorAction SilentlyContinue

    Write-Host "Timing and performance masking completed." -ForegroundColor Green
}

function Set-MachineGuidSpoofing {
    Write-Host "`nSpoofing Machine GUID..." -ForegroundColor Cyan
    try {
        $newGuid = [guid]::NewGuid().ToString()
        Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Cryptography" -Name "MachineGuid" -Value $newGuid -Force
        Write-Host "Machine GUID changed successfully." -ForegroundColor Green
    } catch {
        Write-Host "Failed to change Machine GUID." -ForegroundColor Yellow
    }
}

function Set-InstallDateSpoofing {
    Write-Host "`nSpoofing Install Date..." -ForegroundColor Cyan
    try {
        $randomDate = Get-Random -Minimum ([datetime]'2019-01-01').Ticks -Maximum (([datetime]'2024-12-31').Ticks) | ForEach-Object { [datetime]$_ }
        $unixTimestamp = [int]($randomDate.ToUniversalTime() - [datetime]'1970-01-01').TotalSeconds

        Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion" -Name "InstallDate" -Value $unixTimestamp -Force
        Write-Host "Install date spoofed." -ForegroundColor Green
    } catch {
        Write-Host "Failed to spoof install date." -ForegroundColor Yellow
    }
}

function Set-AntiAnalysisTechniques {
    Write-Host "`nApplying Anti-Analysis Techniques..." -ForegroundColor Cyan

    Set-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\Windows Error Reporting" -Name "Disabled" -Value 1 -Force -ErrorAction SilentlyContinue
    Set-ItemProperty -Path "HKLM:\SYSTEM\CurrentControlSet\Control\CrashControl" -Name "AutoReboot" -Value 0 -Force -ErrorAction SilentlyContinue

    Write-Host "Anti-analysis techniques applied." -ForegroundColor Green
}

function Set-MemoryProcessCleanup {
    Write-Host "`nPerforming Memory and Process Cleanup..." -ForegroundColor Cyan

    try {
        $signature = @"
        [DllImport("psapi.dll")]
        public static extern int EmptyWorkingSet(IntPtr hProcess);
"@
        Add-Type -MemberDefinition $signature -Name MemoryUtils -Namespace Cleanup -ErrorAction SilentlyContinue
        [Cleanup.MemoryUtils]::EmptyWorkingSet([System.Diagnostics.Process]::GetCurrentProcess().Handle) | Out-Null
    } catch {}

    Remove-Item "$env:TEMP\*qemu*", "$env:TEMP\*vm*" -Force -Recurse -ErrorAction SilentlyContinue

    Write-Host "Memory and process cleanup completed." -ForegroundColor Green
}

function Set-AdditionalSpoofing {
    Write-Host "`nApplying Additional Spoofing Techniques..." -ForegroundColor Cyan

    # Fake desktop shortcuts for realism
    $desktopPath = [System.Environment]::GetFolderPath("Desktop")
    $shortcuts = @(
        @{ Name = "Google Chrome.lnk"; Target = "C:\Program Files\Google\Chrome\Application\chrome.exe" },
        @{ Name = "Microsoft Word.lnk"; Target = "C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE" }
    )

    foreach ($shortcut in $shortcuts) {
        $shortcutPath = Join-Path $desktopPath $shortcut.Name
        if (!(Test-Path $shortcutPath)) {
            try {
                $WshShell = New-Object -ComObject WScript.Shell
                $lnk = $WshShell.CreateShortcut($shortcutPath)
                $lnk.TargetPath = $shortcut.Target
                $lnk.Save()
            } catch {}
        }
    }

    # Clear DNS cache
    Clear-DnsClientCache -ErrorAction SilentlyContinue

    Write-Host "Additional spoofing techniques applied." -ForegroundColor Green
}

# ==================== EXECUTE EVERYTHING ====================

New-RestorePoint
Set-HardwareBiosSpoofing
Set-CPUSpoofing
Set-DiskStorageSpoofing
Set-GPUSpoofing
Set-AdvancedVMEvasion
Set-TimingPerformanceMasking
Set-MachineGuidSpoofing
Set-InstallDateSpoofing
Set-AntiAnalysisTechniques
Set-MemoryProcessCleanup
Set-AdditionalSpoofing

Write-Host "`nAll spoofing and hardening operations completed successfully." -ForegroundColor Green

if ($Global:restartRequired) {
    Write-Host "Restarting computer to apply changes..." -ForegroundColor Yellow
    Restart-Computer -Force
} else {
    Write-Host "Script finished. A restart is recommended for full effect." -ForegroundColor Yellow
}