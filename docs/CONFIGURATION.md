# Configuration

The plugin creates a JSON config in its data directory on first run:

```
%USERPROFILE%\.zcode\cli\plugins\data\davinci-laya-decisions@<marketplace>\config.json
```

The exact `<marketplace>` suffix depends on how ZCode registered the local
marketplace. Use `/laya-status` or `node plugin/scripts/laya-admin.mjs status` to
print the active path.

## Conservative defaults

```json
{
  "layaUrl": "http://127.0.0.1:8095",
  "timeoutMs": 1500,
  "riskGate": {
    "mode": "shadow",
    "activeModes": ["guarded"],
    "askMinConfidence": 0.7,
    "stateCharBudget": 20000,
    "layaPolicy": "smart",
    "warnHighRisk": true
  },
  "doneGate": {
    "mode": "report",
    "activeModes": ["guarded"],
    "maxBlocksPerSession": 1,
    "notify": true
  },
  "router": { "mode": "log" },
  "sessionContext": false,
  "layaAll": false,
  "budget": { "maxLen": 1024, "hardStateChars": 20000, "marginTokens": 12 },
  "runChecks": { "autoDiscover": true, "commands": {}, "timeoutMs": 180000 },
  "search": { "maxHits": 200, "contextLines": 2, "timeoutMs": 15000 },
  "readRelevant": { "maxBytes": 2097152, "budget": 8000, "contextLines": 6, "maxBlocks": 8 }
}
```

## Gates

### RiskGate (`PreToolUse`: Bash/Write/Edit/MultiEdit/ApplyPatch)

- `off` — disabled.
- `shadow` — evaluate and log only (default).
- `ask` — may return `permissionDecision:"ask"` for a confirmed high risk.
  Never returns `allow` or `deny`.

`activeModes` is the list of ZCode permission modes where asking is allowed.
Default `["guarded"]` means Autonomous mode; `yolo` (Full access), `build`,
`edit`, `plan` never get questions. An empty list removes the filter.

Resilience:

- deterministic rules run even when Laya is down;
- Laya is only an additional high-risk signal, never a permission grant;
- `smart` skips Laya for explicitly read-only Bash commands;
- `always` calls Laya on every matching tool call (slower);
- `never` disables Laya in the risk gate entirely.

### DoneGate (`Stop`)

- `off` — disabled.
- `report` — log gaps; one short notification per session when a concrete
  available check was not run (default).
- `block` — may return the task once when a high-severity gap exists, but only
  if `activeModes` explicitly contains the current permission mode.

Evidence is collected in every mode, including `yolo`. Absence of tests is not
automatically an error: the gate considers the type of changed files and the
checks actually available in the project.

The notification is delivered to the agent through `continue:true` once per
session; it is not a `decision:"block"` and does not ask the user for approval.

### Router (`UserPromptSubmit`)

- `off` — nothing.
- `log` — classify the task into metrics only (default).
- `advise` — opt-in: one short recommendation line in the prompt context.

The router never switches the model.

## Context tools

`layaAll` lowers the thresholds for self-fetching tools but does not require a
`laya_*` call on every turn. Small operations should use normal `Read`/`rg`.

- `laya_search(query, root?, budget?, top_k?, max_candidates?, context?, timeout_ms?, case_sensitive?, fixed?)`
- `laya_read_relevant(path, query, budget?, context?, max_blocks?, use_laya?)`
- `laya_run_check(check_id, budget?, root?, timeout_ms?)`
- `laya_get_chunk(id, offset?, limit?, full?)` — pages of 4000 chars by default;
  `full:true` returns the complete stored chunk.
- `laya_log_triage`, `laya_search_relevant`, `laya_context_pick`,
  `laya_rank_diff` — compatibility/ranking tools.

## Project checks for `laya_run_check`

By default the tool discovers commands from:

- `package.json` scripts (`test`, `lint`, `typecheck`, `build`);
- `go.mod` (`go test ./...`, `go build ./...`, `go vet ./...`);
- `pyproject.toml` / `pytest.ini` (`python -m pytest -q`);
- `Cargo.toml` (`cargo test`, `cargo clippy`);
- `Makefile` targets (`test`, `lint`).

Override or add explicit commands:

```json
"runChecks": {
  "autoDiscover": false,
  "commands": {
    "test": { "command": "npm test", "kind": "test" },
    "typecheck": { "command": "npx tsc --noEmit", "kind": "typecheck" }
  }
}
```

The model only passes `check_id`; it cannot inject an arbitrary command.

## Budget

`max_len` is the total model sequence; `head_max_len` is the instruction plus
all answer options. The client calls `/count` with the full question set before
`/decide`. If the state does not fit, it is shortened with an explicit marker
and re-counted; if the question itself does not fit, `/decide` is not called.
`stateCharBudget`/`budget.hardStateChars` are only safety caps, not token
budgets.

## Toggles

- `sessionContext: true` adds one status line at session start.
- `layaAll: true` lowers selection thresholds; it does not add per-turn calls.
- `/laya-all on|off` toggles `router=log`, `sessionContext` and `layaAll`
  without changing `riskGate.mode`, `doneGate.mode` or `activeModes`.
- `/laya-mode risk|done|router <mode>` changes one gate.
- `/laya-status` prints the active file path, modes and metrics.
