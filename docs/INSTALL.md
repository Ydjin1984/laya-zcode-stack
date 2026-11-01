# Windows installation

This guide installs the local Laya engine and the ZCode plugin. The model weights
are **not** in this repository; they are downloaded once into
`engine\models\` and stay local.

## 1. Prerequisites

| Requirement | Notes |
|---|---|
| Windows 10/11 x64 | script and prebuilt binaries target Windows |
| ZCode 3.17+ | desktop app |
| Node.js 20+ | `node --version` |
| NVIDIA GPU + CUDA 12 + cuDNN 9 | for GPU; `start-laya.cmd /cpu` for CPU debugging |
| ~1.6 GB free disk | model + tokenizer + ONNX Runtime + CUDA DLLs |
| Go 1.26+ and gcc (cgo) | only for rebuilding from source; prebuilt binaries included |

The prebuilt `engine\bin\laya-server.exe` and `plugin\bin\laya-hook.exe` are
included. They are unsigned; Windows SmartScreen may warn on first execution.

## 2. Get the repository

```cmd
git clone https://github.com/Ydjin1984/laya-zcode-stack.git
cd laya-zcode-stack
```

## 3. Download the model

```cmd
powershell -ExecutionPolicy Bypass -File engine\tools\fetch-model.ps1
powershell -ExecutionPolicy Bypass -File engine\tools\verify-model.ps1
```

The script downloads:

| File | Bytes | SHA-256 |
|---|---:|---|
| `engine\models\multilingual-fp16.onnx` | 646,870,871 | `0b095e005a4c295cae74d47b7eb6931c369d48f5b720b45278d774165798310c` |
| `engine\models\tokenizer.json` | 34,363,188 | `609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f` |

If Hugging Face is unavailable, obtain the same Apache-2.0 Laya multilingual
checkpoint from another source and place both files manually. Do not commit
them.

## 4. Download ONNX Runtime

The binding expects ONNX Runtime **1.25.0** (C API v25):

```cmd
powershell -ExecutionPolicy Bypass -File engine\tools\fetch-runtime.ps1
```

The script copies `onnxruntime.dll`, `onnxruntime_providers_cuda.dll` and
`onnxruntime_providers_shared.dll` into `engine\bin\`.

Manual alternative: download
`onnxruntime-win-x64-gpu-1.25.0.zip` from the official Microsoft ONNX Runtime
GitHub releases and copy those three DLLs from its `lib\` directory into
`engine\bin\`.

## 5. CUDA 12 + cuDNN 9

The engine needs these DLLs (names must match exactly):

```
cudart64_12.dll
cublas64_12.dll
cublasLt64_12.dll
cudnn64_9.dll
cufft64_11.dll
```

Options:

1. Install **CUDA 12.6** and **cuDNN 9** for Windows from NVIDIA, then copy the
   DLLs into `engine\third_party\cuda12\` (recommended; this directory is
   prepended to `PATH` by `start-laya.cmd`).
2. Or make them available on the system `PATH`.

If the DLLs are missing, the engine exits with an ONNX Runtime provider error.
For a CPU-only smoke test:

```cmd
engine\start-laya.cmd /cpu
```

CPU mode is very slow and only proves that the model and service work.

## 6. Start the engine

```cmd
engine\start-laya.cmd
```

The script starts `engine\bin\laya-server.exe` on `127.0.0.1:8095`, waits for
`/ready`, and exits. Check:

```cmd
curl.exe http://127.0.0.1:8095/ready
curl.exe http://127.0.0.1:8095/info
```

Expected: `{"ready":true}` and a checkpoint with `sha256` starting with
`0b095e005a4c`.

Stop it with:

```cmd
engine\stop-laya.cmd
```

Logs: `engine\logs\laya-server.log`.

## 7. Register the plugin in ZCode

1. Open **Settings → Plugin Management**.
2. Add a marketplace: choose the repository root (the directory containing
   `marketplace.json`). Wait for the marketplace to refresh.
3. Enable **DaVinci x Laya: local decisions**.
4. **Start a new ZCode session.** Hooks, commands and MCP tools are loaded at
   session start; an already open session will not see the new MCP tools.

The plugin itself is in `plugin/`; the marketplace file points to it.

## 8. Verify

```cmd
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
```

In the new ZCode session, ask the agent:

> Call `laya_health` and then `laya_search` for the word "discount" in this
> repository. Do not modify files.

The agent should list the 13 `laya_*` tools and use them. `/laya-status` shows
the engine, modes and metrics.

## 9. Optional: rebuild from source

Engine (requires Go 1.26+, gcc from MSYS2 UCRT64, ONNX Runtime DLL in `bin\`):

```cmd
engine\build.cmd
```

Plugin hook launcher (Go):

```cmd
plugin\build-launcher.cmd
```

Plugin tests:

```cmd
cd plugin
node tests\run-all.mjs
```

## 10. Uninstall

1. Disable/remove the plugin in ZCode Plugin Management.
2. Stop the engine: `engine\stop-laya.cmd`.
3. Delete the plugin data directory:
   `%USERPROFILE%\.zcode\cli\plugins\data\davinci-laya-decisions@*`.
4. Optionally delete `engine\models\*.onnx` and
   `engine\models\tokenizer.json` to reclaim ~680 MB.
5. The repository can be deleted; the install scripts do not modify global
   settings outside the plugin data directory.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `port 8095 is busy but /ready does not answer` | stop the old process: `engine\stop-laya.cmd`, then start again |
| `onnxruntime_providers_cuda.dll` missing | run `engine\tools\fetch-runtime.ps1` |
| CUDA DLL missing | install CUDA 12.6 + cuDNN 9; copy DLLs to `engine\third_party\cuda12` |
| Model SHA-256 mismatch | Hugging Face source changed or file corrupted; re-download or update `model-manifest.json` only after verifying the source |
| ZCode does not show the tools | start a **new** session; check Plugin Management shows the plugin enabled |
| Plugin hooks slow on first call | Windows process start + model warm-up; subsequent calls are faster |
| No GPU / wrong CUDA version | use `engine\start-laya.cmd /cpu` to confirm the rest of the stack |
