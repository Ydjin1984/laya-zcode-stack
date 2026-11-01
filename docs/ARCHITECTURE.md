# Architecture

```
ZCode agent
  │
  ├─ SessionStart ──────► status line (optional)
  ├─ UserPromptSubmit ──► task class → metrics (router=log by default)
  ├─ PreToolUse ────────► RiskGate: 42 deterministic rules → Laya → ask/silence
  ├─ PostToolUse ───────► EvidenceLedger: files, checks, exit codes, errors
  ├─ Stop ──────────────► DoneGate: change type + available checks
  │                        notify (continue:true, once) or block in explicit mode
  └─ MCP (stdio, 13 tools)
        self-fetching search/read/check + typed decisions
        state budget checked via /count; sources stored in chunks
                              │
                              ▼
                 laya-server.exe 127.0.0.1:8095
                 [CLS] head [SEP] options [SEP] state [SEP]
```

## RiskGate

Three layers, in order:

1. **Deterministic rules** (42): destructive deletes, force pushes, disk/system
   operations, secret reads, writes outside the workspace, secret-over-network.
   This layer can escalate.
2. **Combined checks**: network tool + secret in arguments, write outside the
   workspace, secret file write.
3. **Laya**: `risk_class` + `data_loss` + `exfiltration`. It can escalate only
   with a calibrated `answer_confidence` above the threshold and a trustworthy
   answer. It never cancels a rule hit.

The final action is `ask` or `log`; `allow`/`deny` do not exist.

## Evidence and DoneGate

`PostToolUse`/`PostToolUseFailure` record facts: changed files, checks and exit
codes, unresolved errors, last `git status`. Checks run via `laya_run_check` are
merged from a project-scoped file so they are visible to `Stop`.

`DoneGate` classifies changed paths (`code`, `test`, `docs`, `config`, `data`),
discovers available project checks, and reports only concrete gaps:

- code changed + an available test/check was not run → high;
- code changed + only lint/typecheck/build available → medium;
- docs-only → no test gap;
- no checks discoverable → informational, not a failure.

Default delivery is one short notification with `continue:true` (once per
session), so the agent actually sees it. `decision:"block"` is used only when
`doneGate.mode="block"` and the current permission mode is explicitly listed in
`doneGate.activeModes`.

## Budget

`max_len` covers the whole sequence; `head_max_len` covers the instruction plus
all options. The client calls `/count` with the same `questions` before
`/decide`. If the state does not fit, it is shortened with an explicit marker and
re-counted; if the question does not fit (head truncated or options collapsed),
`/decide` is not called. Character caps are safety limits only.

## Context tools

- `laya_search` runs `rg` (or a Node walk), deduplicates/merges hits, ranks short
  candidates with Laya, returns excerpts with paths/lines. Full hits are a chunk.
- `laya_read_relevant` reads a file, returns blocks around matches with context,
  marks omitted ranges, and stores the full file as a chunk. It refuses secret
  paths and binary files.
- `laya_run_check` runs a configured/discovered command, streams full output to
  a chunk, and returns exit code, unique errors, summary and chunk id. Failures
  and timeouts are never hidden.
- `laya_get_chunk` returns a page by default (`offset`, `limit`, `has_more`,
  `next_offset`); `full:true` returns the entire stored source.

## Fail-open

| Failure | Behavior |
|---|---|
| engine stopped / port closed | rules only; metric `inference_error`; agent continues |
| timeout | same; hook timeout is bounded |
| bad schema | response discarded; no invented verdict |
| 5 consecutive failures | circuit breaker pauses calls for 30 s |
| state/head truncation | marked untrustworthy; escalation disabled |
| hook exception | stderr diagnostic, empty stdout, exit 0 |

## Data directory

```
config.json
state/ledger-<session>.json
state/chunks/*.txt
state/circuit-breaker.json
state/project-checks-<hash>.json
metrics/decisions-YYYY-MM-DD.jsonl
```
