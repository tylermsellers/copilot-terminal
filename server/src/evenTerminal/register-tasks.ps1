# Registers the two scheduled tasks that make the even-terminal adapter and
# its tray icon start automatically at logon, fully hidden (no console
# windows to accidentally close). Safe to re-run to update an existing
# registration (e.g. after moving the repo).
#
# Usage:
#   cd server/src/evenTerminal
#   ./register-tasks.ps1
#
# Requires: Windows, no admin elevation needed.

$here = $PSScriptRoot
$startVbs = Join-Path $here "start-hidden.vbs"
$trayVbs  = Join-Path $here "tray-launch.vbs"

function Register-HiddenTask($taskName, $vbsPath, $description) {
    $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "//B `"$vbsPath`""
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -Hidden
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description $description | Out-Null
    Write-Host "Registered task: $taskName -> $vbsPath"
}

Register-HiddenTask "CopilotGlassesEvenTerminal" $startVbs `
    "Runs the copilot-glasses-link even-terminal adapter at logon via a hidden-window VBS launcher."
Register-HiddenTask "CopilotGlassesEvenTerminalTray" $trayVbs `
    "Runs the tray icon for the copilot-glasses-link even-terminal adapter (status/start/stop/restart/logs)."

Write-Host ""
Write-Host "Starting both tasks now..."
Start-ScheduledTask -TaskName "CopilotGlassesEvenTerminal"
Start-Sleep -Seconds 2
Start-ScheduledTask -TaskName "CopilotGlassesEvenTerminalTray"

Write-Host "Done. Check the system tray for the glasses icon, and verify with:"
Write-Host '  Invoke-RestMethod "http://127.0.0.1:$env:TERMINAL_PORT/api/info?token=..."'
