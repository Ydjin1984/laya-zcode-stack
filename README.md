# Laya × ZCode — local typed decisions for coding agents

This repository contains a complete, self-hosted stack:

- **Laya engine** — a local Go service (ONNX Runtime, CUDA or CPU) that answers
  typed questions (`choice` / `score` / `noul`) about short text in tens of
  milliseconds. It does **not** generate code and does not send data to the cloud.
- **ZCode plugin `davinci-laya-decisions`** — hooks and MCP tools that put the
  engine at control points of a coding agent: risk gate, evidence ledger,
  completion check, context selection, and 13 MCP tools.
- **Documentation, tests, install scripts and benchmark reports.**

The model weights are **not included** in this repository. You download them
once with the provided script (see below); the model is Apache-2.0 and stays on
your machine. Nothing is downloaded by the running service.

---

## What you get

| Component | What it does |
|---|---|
| `engine/` | Local Laya service on `127.0.0.1:8095` (`/health`, `/ready`, `/info`, `/decide`, `/count`, `/benchmark`) |
| `plugin/` | ZCode plugin: hooks (`PreToolUse`, `PostToolUse`, `Stop`, `SessionStart`, `UserPromptSubmit`) + 13 MCP tools |
| `plugin` MCP tools | `laya_health`, `laya_decide`, `laya_classify`, `laya_score`, `laya_batch`, `laya_search`, `laya_read_relevant`, `laya_run_check`, `laya_log_triage`, `laya_search_relevant`, `laya_context_pick`, `laya_get_chunk`, `laya_rank_diff` |
| `marketplace.json` | Lets ZCode add this repository as a local plugin marketplace |
| `docs/` | Install, configuration, operations, security, benchmarks |
| `scripts/` | `install.ps1`, `verify.ps1` |

The plugin is fail-open: if Laya is unavailable, the agent continues to work,
and gates do not invent decisions. RiskGate never returns `allow`/`deny`; it can
only ask for confirmation or stay silent.

---

## Requirements

- **Windows 10/11 x64** (the hooks launcher and engine scripts are Windows-first;
  the plugin itself is Node.js and can be adapted).
- **ZCode** 3.17+ (desktop app).
- **Node.js 20+**.
- **Go 1.26+ and gcc (cgo)** only if you want to rebuild the engine or the hook
  launcher. Prebuilt binaries are included.
- **NVIDIA GPU** with CUDA 12 + cuDNN 9 for GPU inference. CPU mode is available
  with `start-laya.cmd /cpu` but is slow and intended for debugging.
- **~1.6 GB disk** for model files + ONNX Runtime + CUDA runtime DLLs.
- Model files are downloaded separately (not in git).

---

## Quick start (Windows)

```cmd
git clone https://github.com/Ydjin1984/laya-zcode-stack.git
cd laya-zcode-stack

:: 1. Download the model (weights + tokenizer) into engine\models
powershell -ExecutionPolicy Bypass -File engine\tools\fetch-model.ps1

:: 2. Download ONNX Runtime GPU 1.25.0 DLLs into engine\bin
powershell -ExecutionPolicy Bypass -File engine\tools\fetch-runtime.ps1

:: 3. CUDA 12 + cuDNN 9 must be available.
::    Put the required DLLs into engine\third_party\cuda12
::    (or install CUDA 12.6 + cuDNN 9 system-wide).
::    See docs/INSTALL.md for the exact file list.

:: 4. Start the local engine
engine\start-laya.cmd

:: 5. Open ZCode -> Settings -> Plugin Management -> Add marketplace
::    and select this repository folder (the one containing marketplace.json).
::    Enable "DaVinci x Laya: local decisions".
::    Start a NEW ZCode session.

:: 6. Verify
powershell -ExecutionPolicy Bypass -File scripts\verify.ps1
```

Manual check of the engine:

```cmd
curl http://127.0.0.1:8095/ready
curl http://127.0.0.1:8095/info
```

Expected: `{"ready":true}` and a checkpoint id (for example
`multilingual-fp16-0b095e005a4c`).

In a new ZCode session, ask the agent:

> Call `laya_health` and `laya_search` for the word "discount" in the current
> repository. Do not change files.

The agent should list/use the `laya_*` MCP tools.

---

## Install details

- [Windows installation](docs/INSTALL.md)
- [Краткая инструкция по-русски](docs/INSTALL.ru.md) — prerequisites, model files, CUDA,
  ONNX Runtime, plugin registration, verification, uninstall.
- [Configuration](docs/CONFIGURATION.md) — `config.json`, gates, modes,
  `activeModes`, budget, checks, context tools.
- [Operations](docs/OPERATIONS.md) — start/stop, health, logs, metrics,
  troubleshooting.
- [Security](docs/SECURITY.md) — localhost-only, secret masking, no telemetry,
  what is sent to Laya.
- [Benchmarks](docs/BENCHMARKS.md) — context economy and agent A/B/C results.
- [Architecture](docs/ARCHITECTURE.md) — how hooks, MCP and the engine fit
  together.

---

## Model files (not included)

The repository intentionally excludes the model weights. The fetch script uses
the public Hugging Face sources referenced by the Laya project and verifies
SHA-256 against `engine/models/model-manifest.json`:

| File | Size | SHA-256 |
|---|---:|---|
| `multilingual-fp16.onnx` | 646,870,871 | `0b095e005a4c295cae74d47b7eb6931c369d48f5b720b45278d774165798310c` |
| `tokenizer.json` | 34,363,188 | `609d8f4c067cd3950f88594c5a802616cea245823836ef5848ee4fc40aab5b6f` |

Run:

```cmd
powershell -ExecutionPolicy Bypass -File engine\tools\fetch-model.ps1
powershell -ExecutionPolicy Bypass -File engine\tools\verify-model.ps1
```

If you already have the files, place them into `engine\models\` and run the
verify script. Do **not** commit the weights.

The model is Apache-2.0 (see [NOTICE.md](NOTICE.md)). ONNX Runtime is MIT;
CUDA/cuDNN are subject to NVIDIA's terms.

---

## Configuration in one minute

After the first run ZCode creates:

```
%USERPROFILE%\.zcode\cli\plugins\data\davinci-laya-decisions@<marketplace>\config.json
```

Defaults are conservative:

```json
{
  "riskGate": { "mode": "shadow", "activeModes": ["guarded"] },
  "doneGate": { "mode": "report", "activeModes": ["guarded"], "notify": true },
  "router": { "mode": "log" },
  "sessionContext": false
}
```

- `shadow` / `report` / `log` — observe and log only.
- `ask` — RiskGate may ask for confirmation in Autonomous mode (`guarded`).
- `block` — DoneGate may return the task once when evidence is missing.
- `activeModes` limits interventions to named ZCode permission modes; `yolo`
  (Full access) never gets questions or blocks. Evidence and the DoneGate
  notification still work in yolo.
- See [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for all fields.

---

## Safety

- Engine listens on `127.0.0.1` only.
- Secrets are masked before text is sent to Laya; metric files store hashes, not
  prompt text.
- The service does not download anything at runtime.
- Plugin hooks fail open: a Laya error never blocks the agent.
- The plugin is a local advisor; it cannot grant permissions (`allow` does not
  exist in its policy).
- Model weights are excluded from git and are your responsibility to obtain and
  keep.

See [docs/SECURITY.md](docs/SECURITY.md).

---

## Tests

```cmd
cd plugin
node tests\run-all.mjs
```

The suite covers gates, fail-open, secret masking, launcher safety, MCP protocol,
chunk restoration, self-fetching tools and the DoneGate notification.

Engine tests (if Go is installed):

```cmd
cd engine
build.cmd
```

---

## Measured results

Short version (details and caveats in [docs/BENCHMARKS.md](docs/BENCHMARKS.md)):

- Context selection reduced tool output by **57–88%** in the original byte
  measurements.
- On an agent task with the same model and prompt (3 runs per variant):
  deterministic self-fetching reduced median input tokens by **~26.5%**;
  enabling Laya ranking reduced them by a further **~9.3%** (n=3, ranges
  overlap, so this is an observed effect, not a statistically proven constant).
- `/health` is not classification latency: on the test machine `/health` p50
  was ~1.5 ms while `/decide` p50 was ~26 ms.

---

## Uninstall / rollback

1. Disable/remove the plugin in ZCode Plugin Management.
2. Stop the engine: `engine\stop-laya.cmd`.
3. Delete `engine\models\*.onnx` and `engine\models\tokenizer.json` if you want
   to reclaim disk (they are not in git).
4. Remove the plugin data directory under
   `%USERPROFILE%\.zcode\cli\plugins\data\davinci-laya-decisions@*`.

The repository itself is disposable; no global ZCode settings are modified by
the install scripts.

---

## License

MIT for the integration code, plugin, documentation and scripts. See
[LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for third-party components and the
model license. The model weights are not distributed here.
