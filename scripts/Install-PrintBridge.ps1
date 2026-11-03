$ErrorActionPreference = 'Stop'
# Installs the FoodSync PC print bridge for the Windows user who runs the
# cashier browser. It starts at sign-in, listens on 127.0.0.1 only and needs
# no administrator rights, firewall rule or router port.
$bridgeNode = (Get-Command node -ErrorAction Stop).Source
if ([int](& $bridgeNode -p "process.versions.node.split('.')[0]") -lt 20) { throw 'Install Node.js 20 LTS or later before installing the print bridge.' }
$bridgeEntry = Join-Path $PSScriptRoot 'bridge.cjs'
$bridgeConfig = Join-Path $PSScriptRoot 'config.json'
$null = Get-Content -LiteralPath $bridgeConfig -Raw | ConvertFrom-Json
$bridgeTask = 'FoodSync-PrintBridge'
$bridgeUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$bridgeCommand = "& '" + $bridgeNode.Replace("'", "''") + "' '" + $bridgeEntry.Replace("'", "''") + "' '" + $bridgeConfig.Replace("'", "''") + "'"
$bridgeAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -Command "' + $bridgeCommand + '"') -WorkingDirectory $PSScriptRoot
$bridgeTrigger = New-ScheduledTaskTrigger -AtLogOn -User $bridgeUser
$bridgePrincipal = New-ScheduledTaskPrincipal -UserId $bridgeUser -LogonType Interactive -RunLevel Limited
$bridgeSettings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
if (Get-ScheduledTask -TaskName $bridgeTask -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $bridgeTask }
Register-ScheduledTask -TaskName $bridgeTask -Action $bridgeAction -Trigger $bridgeTrigger -Principal $bridgePrincipal -Settings $bridgeSettings -Description 'FoodSync PC print bridge (cashier receipts and kitchen slips to LAN printers)' -Force | Out-Null
Start-ScheduledTask -TaskName $bridgeTask
Start-Sleep -Seconds 2
try {
  $null = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:9147/' -TimeoutSec 5
  Write-Host 'FoodSync print bridge installed and running on http://127.0.0.1:9147.'
} catch {
  Write-Warning 'The bridge task was installed but did not answer yet. Run Run-PrintBridge.cmd to see its message.'
}
Write-Host 'Keep this folder where it is. Open FoodSync Settings > Printers and use "Test from this device".'
