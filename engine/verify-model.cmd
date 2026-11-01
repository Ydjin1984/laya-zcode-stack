@echo off
REM ===========================================================================
REM verify-model.cmd - check the LOCAL model files (size + SHA-256).
REM
REM Nothing is downloaded here. The point is to tell a missing, truncated or
REM substituted file apart from a working one before blaming the service.
REM The real work is in tools\verify-model.ps1.
REM
REM ASCII-only and CRLF line endings are required, see start-laya.cmd.
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

set "PS1=%~dp0tools\verify-model.ps1"
if not exist "%PS1%" (
  echo [MODEL] ERROR: %PS1% not found.
  exit /b 1
)

powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" %*
exit /b %errorlevel%
