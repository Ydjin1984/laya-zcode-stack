# Third-party notices

This repository contains original integration code (engine wrapper, ZCode
plugin, hooks, MCP server, scripts and documentation) plus references to
external components.

## Laya model

The Laya model and tokenizer are **not included** in this repository.
They are distributed under Apache-2.0 by their authors and are downloaded by the
user from the public sources referenced in `engine/tools/fetch-model.ps1`.

- Upstream project page: https://huggingface.co/convaiinnovations/laya
- The script verifies SHA-256 against `engine/models/model-manifest.json`.

The running service never downloads anything; the fetch step is explicit and
one-time.

## ONNX Runtime

ONNX Runtime is distributed under the MIT License.
GPU builds are downloaded by `engine/tools/fetch-runtime.ps1` from the official
Microsoft ONNX Runtime GitHub releases (version 1.25.0 is expected by the engine
binding).

## CUDA / cuDNN

CUDA runtime and cuDNN are subject to NVIDIA's license terms. They are not
included in this repository. Install them from NVIDIA or another licensed
distribution and place the required DLLs under `engine/third_party/cuda12/`
(or make them available on `PATH`).

## Engine source

The original engine source is copyright DaVinci Cyber Engineering and is
included here for use with this stack under the repository MIT license, unless a
file states otherwise.

## Plugin

The `plugin/` directory is also available under MIT (see `plugin/LICENSE`).
