# Engine tools

- `fetch-model.ps1` — one-time download of model weights + tokenizer from the
  public Laya sources, with SHA-256 verification.
- `verify-model.ps1` — checks local model/runtime files against
  `models/model-manifest.json`.
- `fetch-runtime.ps1` — downloads ONNX Runtime 1.25.0 GPU DLLs into `bin/`.

The engine source, build scripts and runtime are in the parent directories.
