# Security and privacy

## Trust model

Laya is a **local probabilistic classifier**, not a security boundary. Its
answers are attention signals, not proof. Deterministic rules, file-system facts,
exit codes and tests always take precedence.

The plugin cannot grant permissions:

- RiskGate can only ask for confirmation (`ask`) or stay silent;
- there is no `allow` or `deny` decision in its policy;
- a low Laya risk score never expands permissions;
- DoneGate can only notify or, in an explicitly enabled mode, request one
  additional verification turn.

## Network

- The engine listens on `127.0.0.1:8095` only.
- Do not expose the port to a LAN or the internet. The service has no
  authentication and is intended for the local user.
- The plugin talks to it over loopback HTTP.
- No cloud calls are made by the engine or the plugin.
- Model files are read locally; the only network step is the explicit
  `fetch-model.ps1` / `fetch-runtime.ps1` run by the user.

## What is sent to Laya

- Short, masked state strings (tool name, command/path, rule hits, short code
  excerpts).
- Secrets are masked before sending: bearer tokens, `sk-`/`ghp_`/AKIA keys,
  URL credentials, `password=`, PEM blocks, cookies, `.env` lines.
- `.env`, private keys, `credentials`, `.ssh`, `.aws` and similar paths are not
  read by `laya_search`/`laya_read_relevant`.
- Full file contents and full prompts are not stored in metrics; metrics store
  `state_hash`, not text.

## Local files

- `engine\models\*.onnx` and `tokenizer.json` are not in git and must be obtained
  separately.
- Plugin metrics and ledgers live in the plugin data directory. They contain
  command/path facts and hashes, not secret values.
- Chunks may contain code excerpts or command output from your repository. Keep
  the plugin data directory private.

## Third-party components

- Laya model: Apache-2.0, not distributed here.
- ONNX Runtime: MIT, downloaded from Microsoft releases.
- CUDA/cuDNN: NVIDIA license, installed by the user.
- See [NOTICE.md](../NOTICE.md).

## Reporting

If you find a security issue in the integration code, do not open a public issue
with a working exploit. Use the repository's private security advisory or the
maintainer contact listed in `marketplace.json`.
