# Operations

## Start / stop / status

```cmd
engine\start-laya.cmd
engine\stop-laya.cmd
curl.exe http://127.0.0.1:8095/ready
curl.exe http://127.0.0.1:8095/info
```

`start-laya.cmd` starts one local instance and waits until weights are loaded.
It is safe to call repeatedly: if the port is already ready, it does nothing.

CPU debug mode:

```cmd
engine\start-laya.cmd /cpu
```

## Health, status, tests

```cmd
plugin\scripts\laya-admin.mjs status
plugin\scripts\laya-admin.mjs doctor
plugin\scripts\laya-admin.mjs bench
plugin\scripts\laya-admin.mjs review
cd plugin && node tests\run-all.mjs
```

- `/laya-status` in ZCode prints the active data directory, modes, checkpoint
  and metrics.
- `doctor` checks the integration: config, data directory, launcher, ledger,
  health.
- `bench` measures `/decide` / `/benchmark`, not `/health`.

## Logs and metrics

| Path | Contents |
|---|---|
| `engine\logs\laya-server.log` | engine stdout/stderr |
| `<plugin-data>\metrics\decisions-YYYY-MM-DD.jsonl` | gate/MCP decisions, latency, hashes, no prompt text |
| `<plugin-data>\state\ledger-<session>.json` | per-session evidence: changed files, checks, errors |
| `<plugin-data>\state\chunks\*.txt` | displaced fragments, retrievable via `laya_get_chunk` |
| `<plugin-data>\state\circuit-breaker.json` | Laya failure cooldown |

The plugin data directory is printed by `/laya-status`; typically
`%USERPROFILE%\.zcode\cli\plugins\data\davinci-laya-decisions@<marketplace>`.

## Circuit breaker

After 5 consecutive Laya failures the client stops calling it for 30 seconds.
The state is a file so all hook processes share it. No manual action is needed;
the next successful call resets it. To reset immediately, stop the engine, delete
`state\circuit-breaker.json`, and restart.

## Model and runtime updates

1. Stop the engine.
2. Replace `engine\models\multilingual-fp16.onnx` / `tokenizer.json`.
3. Update `engine\models\model-manifest.json` only if you intentionally use a
   different checkpoint; otherwise keep the published hashes.
4. Run `engine\tools\verify-model.ps1`.
5. Start the engine and check `/info`.

The service never downloads model files at runtime.

## Long requests / slow mode

The model accepts requests up to 8192 tokens, but the default service budget is
1024. A single very long request can put the ONNX runtime into a slow mode for
subsequent calls (seconds instead of tens of milliseconds). If that happens:

```cmd
engine\stop-laya.cmd
engine\start-laya.cmd
```

The plugin keeps tool states short; `laya_get_chunk` pages large sources instead
of sending everything to the model.

## Upgrades

1. Back up the plugin data directory and `config.json`.
2. Pull the new repository version.
3. Run `scripts\verify.ps1`.
4. Start a new ZCode session so MCP tools are reloaded.

## Uninstall

See [INSTALL.md](INSTALL.md#10-uninstall).
