<#
.SYNOPSIS
  Run this machine as a *remote terminal machine* for another Web Terminal.

.DESCRIPTION
  Only the PTY host runs here - there is no web server and no port 8080 on this
  machine. The controlling machine connects straight to the PTY host on
  PTY_HOST_PORT (default 8777) and authenticates with the key printed below.

  Steps this script performs:
    1. binds the PTY host to 0.0.0.0 so the LAN can reach it
    2. starts it (or reports that it is already running)
    3. prints the key, the port and this machine's IP addresses
    4. offers the exact firewall rule to allow the port

.EXAMPLE
  .\scripts\start-remote-host.ps1
  .\scripts\start-remote-host.ps1 -Port 8777 -AllowFirewall -FromSubnet 192.168.192.0/24
#>
[CmdletBinding()]
param(
    [int]$Port = 0,
    [switch]$AllowFirewall,
    [string]$FromSubnet = "",
    [switch]$Foreground
)

. "$PSScriptRoot\common.ps1"

$installDir = Get-WtInstallDir
$node = Get-WtNodePath
if ($Port -le 0) {
    $configured = [Environment]::GetEnvironmentVariable("PTY_HOST_PORT", "Machine")
    $Port = if ($configured) { [int]$configured } else { 8777 }
}

$env:PTY_HOST_BIND = "0.0.0.0"
$env:PTY_HOST_PORT = "$Port"

Write-WtHeader "1/5 Dependencies"
if (-not (Test-WtDeps -InstallDir $installDir -Node $node)) { exit 1 }

Write-WtHeader "2/5 PTY host"
$listening = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listening) {
    $proc = Get-Process -Id $listening.OwningProcess -ErrorAction SilentlyContinue
    Write-WtOk "already listening on $($listening.LocalAddress):$Port (pid $($listening.OwningProcess) $($proc.ProcessName))"
    if ($listening.LocalAddress -eq "127.0.0.1") {
        Write-WtFail "It is bound to localhost only, so other machines cannot reach it."
        Write-WtInfo "Stop it first:  .\scripts\stop.ps1 -Port $Port"
        Write-WtInfo "then run this script again."
        exit 1
    }
} elseif ($Foreground) {
    Write-WtInfo "starting in this console (Ctrl+C stops it and kills every session)"
} else {
    Start-Process -FilePath $node -ArgumentList ('"' + (Join-Path $installDir "server\pty-host.js") + '"') `
        -WorkingDirectory $installDir -WindowStyle Hidden
    Start-Sleep -Seconds 2
    $listening = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listening) { Write-WtOk "started on 0.0.0.0:$Port" }
    else {
        Write-WtFail "did not come up - see .data\logs\pty-host-*.log"
        exit 1
    }
}

Write-WtHeader "3/5 Firewall"
$ruleName = "Web Terminal PTY host $Port"
$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
    Write-WtOk "rule already present: $ruleName"
} elseif ($AllowFirewall) {
    if (-not (Test-WtAdmin)) {
        Write-WtFail "-AllowFirewall needs an elevated PowerShell."
    } else {
        $params = @{
            DisplayName = $ruleName
            Direction   = "Inbound"
            Action      = "Allow"
            Protocol    = "TCP"
            LocalPort   = $Port
        }
        if ($FromSubnet) { $params.RemoteAddress = $FromSubnet }
        New-NetFirewallRule @params | Out-Null
        Write-WtOk "allowed TCP $Port$(if ($FromSubnet) { " from $FromSubnet" })"
    }
} else {
    Write-WtWarn "no firewall rule yet. To add one (elevated):"
    $scope = if ($FromSubnet) { " -RemoteAddress $FromSubnet" } else { " -RemoteAddress LocalSubnet" }
    Write-WtInfo "  New-NetFirewallRule -DisplayName '$ruleName' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port$scope"
}

Write-WtHeader "4/5 This machine"
$addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
    Where-Object { $_.IPAddress -ne "127.0.0.1" -and $_.PrefixOrigin -ne "WellKnown" }
foreach ($a in $addresses) {
    Write-WtInfo ("  {0}:{1}   ({2})" -f $a.IPAddress, $Port, $a.InterfaceAlias)
}

Write-WtHeader "5/5 Key"
$key = & $node (Join-Path $installDir "scripts\host-key.js")
Write-Host ""
Write-Host "  $key" -ForegroundColor Green
Write-Host ""
Write-WtInfo "On the controlling machine: sidebar -> Máy -> Thêm máy"
Write-WtInfo "  Địa chỉ: <one of the IPs above>    Cổng: $Port    Key: the value above"
Write-WtWarn "The link is authenticated but NOT encrypted. Keep it on a trusted LAN or a VPN."

if ($Foreground -and -not $listening) {
    & $node (Join-Path $installDir "server\pty-host.js")
}
