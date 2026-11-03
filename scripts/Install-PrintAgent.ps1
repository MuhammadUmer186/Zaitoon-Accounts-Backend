$ErrorActionPreference = 'Stop'
$agentNode = (Get-Command node -ErrorAction Stop).Source
if ([int](& $agentNode -p "process.versions.node.split('.')[0]") -lt 20) { throw 'Install Node.js 20 or later before installing the print agent.' }
$agentRunner = Join-Path $PSScriptRoot 'Run-PrintAgent.ps1'
$agentConfig = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'config.json') -Raw | ConvertFrom-Json
$agentTaskName = 'FoodSync-Print-' + $agentConfig.printerId
$agentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
$agentEntry = Join-Path $PSScriptRoot 'agent.cjs'
$agentConfigPath = Join-Path $PSScriptRoot 'config.json'
$agentCommand = "& '" + $agentNode.Replace("'", "''") + "' '" + $agentEntry.Replace("'", "''") + "' '" + $agentConfigPath.Replace("'", "''") + "'"
$agentAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -WindowStyle Hidden -Command "' + $agentCommand + '"') -WorkingDirectory $PSScriptRoot
$agentTrigger = New-ScheduledTaskTrigger -AtLogOn -User $agentUser
$agentPrincipal = New-ScheduledTaskPrincipal -UserId $agentUser -LogonType Interactive -RunLevel Limited
$agentSettings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
if (Get-ScheduledTask -TaskName $agentTaskName -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $agentTaskName }
Register-ScheduledTask -TaskName $agentTaskName -Action $agentAction -Trigger $agentTrigger -Principal $agentPrincipal -Settings $agentSettings -Description 'FoodSync local kitchen IP printer agent' -Force | Out-Null
Start-ScheduledTask -TaskName $agentTaskName
Write-Host 'FoodSync print agent installed for this Windows user and started.'
Write-Host 'Keep this folder in its current location. Manage printer IP addresses in FoodSync Settings.'
