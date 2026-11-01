@echo off
REM ===========================================================================
REM build-launcher.cmd - build bin\laya-hook.exe (Go launcher for hooks).
REM
REM The launcher skips the Node process for clearly read-only commands
REM (ls/cat/git log/rg...) saving ~0.2 s per event; anything uncertain is
REM passed through to Node unchanged. Needs Go 1.21+; no cgo, no dependencies.
REM
REM ASCII-only and CRLF line endings are required.
REM ===========================================================================
setlocal EnableExtensions
cd /d "%~dp0"

where go >nul 2>nul
if errorlevel 1 (
  echo [ERROR] go not found in PATH.
  exit /b 1
)

if not exist "bin" mkdir "bin" >nul 2>nul

cd tools\hook-launcher
gofmt -l . > "%TEMP%\laya-launcher-gofmt.txt" 2>nul
for /f "usebackq delims=" %%i in ("%TEMP%\laya-launcher-gofmt.txt") do (
  if not "%%i"=="" (
    echo       formatting %%i
    gofmt -w .
  )
)
go vet ./... || exit /b 1
go build -o "..\..\bin\laya-hook.exe" . || exit /b 1
cd ..\..

echo [BUILD] done: %~dp0bin\laya-hook.exe
echo [BUILD] hooks.json already points at this launcher; rebuild is needed only
echo [BUILD] after changes in tools\hook-launcher.
endlocal
exit /b 0
