# verify.ps1 - check the local Laya engine and the plugin test suite.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
#   ... -SkipTests

[CmdletBinding()]
param([switch]$SkipTests)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Engine = Join-Path $Root 'engine'
$Plugin = Join-Path $Root 'plugin'

Write-Host "== Laya engine ==" -ForegroundColor Cyan
try {
  $ready = Invoke-RestMethod -Uri 'http://127.0.0.1:8095/ready' -TimeoutSec 5
  if (-not $ready.ready) { throw "/ready returned ready=false" }
  $info = Invoke-RestMethod -Uri 'http://127.0.0.1:8095/info' -TimeoutSec 5
  Write-Host "  ready:      true"
  Write-Host "  device:     $($info.device)"
  Write-Host "  checkpoint: $($info.checkpoint.file)"
  Write-Host "  sha256:     $($info.checkpoint.sha256)"
  Write-Host "  max_len:    $($info.model.max_len), head_max_len: $($info.model.head_max_len)"
} catch {
  Write-Host "  ERROR: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "  Start: engine\start-laya.cmd" -ForegroundColor Yellow
  exit 1
}

Write-Host ""
Write-Host "== Model files ==" -ForegroundColor Cyan
& powershell -ExecutionPolicy Bypass -File (Join-Path $Engine 'tools\verify-model.ps1') -SkipHash
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

if (-not $SkipTests) {
  Write-Host ""
  Write-Host "== Plugin tests ==" -ForegroundColor Cyan
  Push-Location $Plugin
  try {
    & node tests\run-all.mjs
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  } finally {
    Pop-Location
  }
}

Write-Host ""
Write-Host "OK. Open a NEW ZCode session and call laya_health." -ForegroundColor Green
