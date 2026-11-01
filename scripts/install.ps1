# install.ps1 - one-shot setup for the Laya x ZCode stack (Windows).
#
# What it does:
#   1. checks Node.js and repository layout;
#   2. downloads model files if missing (unless -SkipModel);
#   3. downloads ONNX Runtime GPU DLLs if missing (unless -SkipRuntime);
#   4. checks CUDA 12 / cuDNN 9 DLLs (warns, does not install NVIDIA drivers);
#   5. optionally rebuilds the engine (requires Go + gcc);
#   6. starts the local engine and waits for /ready;
#   7. prints the marketplace path and next steps.
#
# It does NOT add the plugin to ZCode automatically: plugin registration is a
# ZCode UI action. It does not install drivers or CUDA.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File scripts\install.ps1
#   ... -SkipModel -SkipRuntime -NoStart
#   ... -BuildEngine

[CmdletBinding()]
param(
  [switch]$SkipModel,
  [switch]$SkipRuntime,
  [switch]$BuildEngine,
  [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
$Engine = Join-Path $Root 'engine'
$Plugin = Join-Path $Root 'plugin'

function Fail([string]$Message) {
  Write-Host "[install] ERROR: $Message" -ForegroundColor Red
  exit 1
}

if (-not (Test-Path (Join-Path $Engine 'bin\laya-server.exe'))) {
  Fail "engine\bin\laya-server.exe is missing. Re-clone the repository."
}
if (-not (Test-Path (Join-Path $Plugin 'src\mcp-server.mjs'))) {
  Fail "plugin sources are missing. Re-clone the repository."
}

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Fail "Node.js 20+ is required (node not found in PATH)." }
$nodeVersion = (& node --version).TrimStart('v')
$nodeMajor = [int]($nodeVersion.Split('.')[0])
if ($nodeMajor -lt 20) { Fail "Node.js 20+ is required; found $nodeVersion." }
Write-Host "[install] Node.js $nodeVersion" -ForegroundColor Green

if (-not $SkipModel) {
  $model = Join-Path $Engine 'models\multilingual-fp16.onnx'
  $tok = Join-Path $Engine 'models\tokenizer.json'
  if (-not (Test-Path $model) -or -not (Test-Path $tok)) {
    Write-Host "[install] model files are missing; downloading from the public Laya sources..." -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File (Join-Path $Engine 'tools\fetch-model.ps1')
    if ($LASTEXITCODE -ne 0) { Fail "model download failed; see engine\models\README.md" }
  } else {
    Write-Host "[install] model files present" -ForegroundColor Green
  }
}

if (-not $SkipRuntime) {
  $ort = Join-Path $Engine 'bin\onnxruntime_providers_cuda.dll'
  if (-not (Test-Path $ort)) {
    Write-Host "[install] ONNX Runtime GPU DLLs are missing; downloading 1.25.0..." -ForegroundColor Cyan
    & powershell -ExecutionPolicy Bypass -File (Join-Path $Engine 'tools\fetch-runtime.ps1')
    if ($LASTEXITCODE -ne 0) { Fail "ONNX Runtime download failed; see docs\INSTALL.md" }
  } else {
    Write-Host "[install] ONNX Runtime GPU DLLs present" -ForegroundColor Green
  }
}

$cudaNames = @('cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll', 'cudnn64_9.dll', 'cufft64_11.dll')
$cudaDir = Join-Path $Engine 'third_party\cuda12'
$missingCuda = @()
foreach ($n in $cudaNames) {
  $inRepo = Test-Path (Join-Path $cudaDir $n)
  $onPath = $null -ne (Get-Command $n -ErrorAction SilentlyContinue)
  if (-not $inRepo -and -not $onPath) { $missingCuda += $n }
}
if ($missingCuda.Count -gt 0) {
  Write-Host "[install] WARNING: CUDA 12 / cuDNN 9 DLLs not found:" -ForegroundColor Yellow
  $missingCuda | ForEach-Object { Write-Host "          $_" -ForegroundColor Yellow }
  Write-Host "[install] Place them in engine\third_party\cuda12 or install CUDA 12.6 + cuDNN 9." -ForegroundColor Yellow
  Write-Host "[install] CPU debugging: engine\start-laya.cmd /cpu" -ForegroundColor Yellow
}

if ($BuildEngine) {
  $go = Get-Command go -ErrorAction SilentlyContinue
  $gcc = Get-Command gcc -ErrorAction SilentlyContinue
  if (-not $go -or -not $gcc) {
    Fail "Go and gcc (cgo) are required for -BuildEngine. Install Go 1.26+ and MSYS2 UCRT64 gcc."
  }
  Write-Host "[install] rebuilding engine..." -ForegroundColor Cyan
  & cmd.exe /c "`"$Engine\build.cmd`""
  if ($LASTEXITCODE -ne 0) { Fail "engine build failed" }
}

$launcher = Join-Path $Plugin 'bin\laya-hook.exe'
if (-not (Test-Path $launcher)) {
  $go = Get-Command go -ErrorAction SilentlyContinue
  if ($go) {
    Write-Host "[install] building plugin hook launcher..." -ForegroundColor Cyan
    & cmd.exe /c "`"$Plugin\build-launcher.cmd`""
    if ($LASTEXITCODE -ne 0) { Fail "plugin launcher build failed" }
  } else {
    Fail "plugin\bin\laya-hook.exe is missing and Go is not installed. Re-clone or install Go."
  }
}

if (-not $NoStart) {
  Write-Host "[install] starting Laya engine..." -ForegroundColor Cyan
  & cmd.exe /c "`"$Engine\start-laya.cmd`""
  if ($LASTEXITCODE -ne 0) { Fail "could not start the engine; see engine\logs\laya-server.log" }
  try {
    $ready = Invoke-RestMethod -Uri 'http://127.0.0.1:8095/ready' -TimeoutSec 5
    if (-not $ready.ready) { Fail "engine is running but /ready is false" }
    $info = Invoke-RestMethod -Uri 'http://127.0.0.1:8095/info' -TimeoutSec 5
    Write-Host "[install] engine ready; checkpoint: $($info.checkpoint.file) $($info.checkpoint.sha256.Substring(0,12))" -ForegroundColor Green
  } catch {
    Fail "engine did not answer /ready: $($_.Exception.Message)"
  }
}

Write-Host ""
Write-Host "Next steps in ZCode:" -ForegroundColor Cyan
Write-Host "  1. Settings -> Plugin Management -> Add marketplace"
Write-Host "     Path: $Root"
Write-Host "  2. Enable 'DaVinci x Laya: local decisions'."
Write-Host "  3. Start a NEW ZCode session (MCP tools are loaded at session start)."
Write-Host "  4. In the new session ask the agent to call laya_health."
Write-Host ""
Write-Host "Verify: powershell -ExecutionPolicy Bypass -File scripts\verify.ps1" -ForegroundColor Cyan
