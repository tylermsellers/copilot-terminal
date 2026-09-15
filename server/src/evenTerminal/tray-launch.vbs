' Launches the tray icon PowerShell script with no visible console window.
' Path is resolved relative to this script's own location (not hardcoded),
' so it works unmodified on any machine/user account the repo is cloned to.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = scriptDir
objShell.Run "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & scriptDir & "\tray.ps1""", 0, False
