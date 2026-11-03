$ErrorActionPreference = 'Stop'
# Check held prints in FoodSync Settings > Printers before removing the bridge:
# journal.json in this folder is what prevents a repeated slip.
$bridgeTask = 'FoodSync-PrintBridge'
if (Get-ScheduledTask -TaskName $bridgeTask -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $bridgeTask
  Unregister-ScheduledTask -TaskName $bridgeTask -Confirm:$false
}
Write-Host 'FoodSync print bridge stopped and removed from Windows sign-in. Its folder and journal.json were kept.'
