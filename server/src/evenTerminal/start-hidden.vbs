' Launches the even-terminal adapter with a fully hidden window (style 0),
' so there's no console for anyone to accidentally close, unlike running
' node.exe directly from a scheduled task with an interactive logon.
' run.bat launches node and redirects its stdout/stderr to adapter.log, so
' the tray icon's "Open Logs" menu item has something to show.
' Path is resolved relative to this script's own location (not hardcoded),
' so it works unmodified on any machine/user account the repo is cloned to.
Set fso = CreateObject("Scripting.FileSystemObject")
scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
Set objShell = CreateObject("WScript.Shell")
objShell.CurrentDirectory = scriptDir
objShell.Run """" & scriptDir & "\run.bat""", 0, False
