@echo off
REM ===========================================================================
REM stop-laya.cmd - stop every Laya decision service process (all ports).
REM
REM ASCII-only and CRLF line endings are required, see start-laya.cmd.
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

set "FOUND="
taskkill /IM laya-server.exe /F >nul 2>nul
if errorlevel 1 (
  echo [LAYA] service is not running.
  exit /b 0
)

echo [LAYA] stopped every laya-server.exe process.
exit /b 0
