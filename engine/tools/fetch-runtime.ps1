# fetch-runtime.ps1 - download ONNX Runtime GPU 1.25.0 DLLs into engine\bin.
#
# The engine binding is built against ONNX Runtime C API v25 (1.25.0).
# The model itself is handled by fetch-model.ps1 and is NOT downloaded here.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File engine\tools\fetch-runtime.ps1
#   ... -Force       re-download even if files exist
#   ... -Version 1.25.0
#
# CUDA 12 / cuDNN 9 are not included. See docs/INSTALL.md.

param(
  [string]$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
  [string]$Version = '1.25.0',
  [switch]$Force
)

$ErrorActionPreference = 'Stop'

$bin = Join-Path $Root 'bin'
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("laya-ort-" + [guid]::NewGuid().ToString('N'))
$zip = Join-Path $tmp 'onnxruntime-gpu.zip'
$url = "https://github.com/microsoft/onnxruntime/releases/download/v$Version/onnxruntime-win-x64-gpu-$Version.zip"

New-Item -ItemType Directory -Force -Path $bin, $tmp | Out-Null

$wanted = @(
  'onnxruntime.dll',
  'onnxruntime_providers_cuda.dll',
  'onnxruntime_providers_shared.dll'
)

$missing = @($wanted | Where-Object { $Force -or -not (Test-Path (Join-Path $bin $_)) })
if ($missing.Count -eq 0) {
  Write-Host "[ORT] runtime DLLs already present in $bin" -ForegroundColor Green
  exit 0
}

Write-Host "[ORT] downloading ONNX Runtime $Version GPU build" -ForegroundColor Cyan
Write-Host "[ORT]   $url"
try {
  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    & curl.exe -L --fail --retry 3 --retry-delay 2 -o $zip $url
    if ($LASTEXITCODE -ne 0) { throw "curl exited with $LASTEXITCODE" }
  } else {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
  }
} catch {
  Write-Host "[ORT] download failed: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host "[ORT] Download manually: $url" -ForegroundColor Yellow
  Write-Host "[ORT] Extract onnxruntime.dll, onnxruntime_providers_cuda.dll and" -ForegroundColor Yellow
  Write-Host "[ORT] onnxruntime_providers_shared.dll into: $bin" -ForegroundColor Yellow
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  exit 1
}

try {
  Expand-Archive -LiteralPath $zip -DestinationPath $tmp -Force
} catch {
  Write-Host "[ORT] cannot extract archive: $($_.Exception.Message)" -ForegroundColor Red
  Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
  exit 1
}

foreach ($name in $wanted) {
  $src = Get-ChildItem -Path $tmp -Recurse -Filter $name -File | Select-Object -First 1
  if (-not $src) {
    Write-Host "[ORT] $name not found in the archive" -ForegroundColor Red
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    exit 1
  }
  Copy-Item -LiteralPath $src.FullName -Destination (Join-Path $bin $name) -Force
  $len = (Get-Item (Join-Path $bin $name)).Length
  Write-Host ("[ORT]   {0,-38} {1:N0} bytes" -f $name, $len) -ForegroundColor Green
}

Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "[ORT] done. CUDA 12 + cuDNN 9 are still required." -ForegroundColor Cyan
Write-Host "[ORT] Required DLLs: cudart64_12.dll, cublas64_12.dll, cublasLt64_12.dll,"
Write-Host "[ORT]                cudnn64_9.dll, cufft64_11.dll"
Write-Host "[ORT] Put them into engine\third_party\cuda12 (or install CUDA 12.6 + cuDNN 9)."
Write-Host "[ORT] Then run: engine\start-laya.cmd"
exit 0
