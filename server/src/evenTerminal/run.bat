@echo off
rem Starts the even-terminal adapter, logging stdout/stderr to adapter.log.
rem Paths are resolved relative to this file's own location (%~dp0), so this
rem works unmodified on any machine/user account the repo is cloned to.
setlocal
cd /d "%~dp0..\.."

set "NODE_BIN=node"
where node >nul 2>&1
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" set "NODE_BIN=C:\Program Files\nodejs\node.exe"
)

"%NODE_BIN%" "%~dp0index.js" >> "%~dp0adapter.log" 2>&1
