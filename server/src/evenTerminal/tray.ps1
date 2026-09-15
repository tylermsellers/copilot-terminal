# Tray icon for the copilot-glasses-link even-terminal adapter.
# Shows a glasses-shaped icon (green = adapter reachable, red = not),
# with a right-click menu to start/stop/restart it and view logs.

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# Resolved relative to this script's own location so the repo can be cloned
# to any machine/user account without editing hardcoded paths.
$ServerDir = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$EnvFile   = Join-Path $ServerDir ".env"
$LogFile   = Join-Path $PSScriptRoot "adapter.log"
$TaskName  = "CopilotGlassesEvenTerminal"

function Get-EnvValue($name) {
    if (Test-Path $EnvFile) {
        $line = Get-Content $EnvFile | Where-Object { $_ -match "^\s*$name\s*=" } | Select-Object -Last 1
        if ($line) { return ($line -split '=', 2)[1].Trim() }
    }
    return $null
}

$Port  = Get-EnvValue "TERMINAL_PORT"
if (-not $Port) { $Port = 3456 }
$Token = Get-EnvValue "TERMINAL_TOKEN"

function New-GlassesIcon([System.Drawing.Color]$color) {
    $bmp = New-Object System.Drawing.Bitmap 32, 32
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $pen = New-Object System.Drawing.Pen($color, 3)
    $g.DrawEllipse($pen, 2, 12, 11, 10)     # left lens
    $g.DrawEllipse($pen, 19, 12, 11, 10)    # right lens
    $g.DrawLine($pen, 13, 16, 19, 16)       # bridge
    $g.DrawLine($pen, 2, 14, 0, 9)          # left temple
    $g.DrawLine($pen, 30, 14, 32, 9)        # right temple
    $g.Dispose()
    $hIcon = $bmp.GetHicon()
    return [System.Drawing.Icon]::FromHandle($hIcon)
}

$greenIcon = New-GlassesIcon ([System.Drawing.Color]::FromArgb(30, 180, 90))
$redIcon   = New-GlassesIcon ([System.Drawing.Color]::FromArgb(210, 50, 50))

function Test-Adapter {
    try {
        $req = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/api/info?token=$Token")
        $req.Timeout = 2000
        $resp = $req.GetResponse()
        $resp.Close()
        return $true
    } catch {
        return $false
    }
}

function Get-AdapterProcess {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*evenTerminal*index.js*" }
}

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = $redIcon
$notifyIcon.Text = "Copilot Glasses Terminal"
$notifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$statusItem = $menu.Items.Add("Status: checking...")
$statusItem.Enabled = $false
$menu.Items.Add("-") | Out-Null

$startItem   = $menu.Items.Add("Start")
$stopItem    = $menu.Items.Add("Stop")
$restartItem = $menu.Items.Add("Restart")
$menu.Items.Add("-") | Out-Null
$logsItem    = $menu.Items.Add("Open Logs")
$menu.Items.Add("-") | Out-Null
$exitItem    = $menu.Items.Add("Exit Tray Icon")

$notifyIcon.ContextMenuStrip = $menu

$startItem.Add_Click({
    Start-ScheduledTask -TaskName $TaskName
})

$stopItem.Add_Click({
    Get-AdapterProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
})

$restartItem.Add_Click({
    Get-AdapterProcess | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 800
    Start-ScheduledTask -TaskName $TaskName
})

$logsItem.Add_Click({
    if (Test-Path $LogFile) { Start-Process notepad.exe $LogFile }
    else { [System.Windows.Forms.MessageBox]::Show("No log file yet at:`n$LogFile") | Out-Null }
})

$exitItem.Add_Click({
    $notifyIcon.Visible = $false
    [System.Windows.Forms.Application]::Exit()
})

function Update-Status {
    if (Test-Adapter) {
        $notifyIcon.Icon = $greenIcon
        $statusItem.Text = "Status: Running (port $Port)"
    } else {
        $notifyIcon.Icon = $redIcon
        $statusItem.Text = "Status: Not reachable"
    }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 10000
$timer.Add_Tick({ Update-Status })
$timer.Start()
Update-Status   # check immediately instead of waiting for the first tick

[System.Windows.Forms.Application]::Run()
