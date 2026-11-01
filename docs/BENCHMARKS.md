# Benchmarks

Measurements were taken on a Windows machine with an RTX 3060, checkpoint
`multilingual-fp16-0b095e005a4c`. They are indicative, not guarantees for other
hardware.

## Tool output size (bytes, actual)

Baseline is the old workflow: `rg` + full file reads / direct command execution.
"Improved" is the self-fetching MCP tool. Bytes are actual UTF-8 lengths of what
would enter the model context; tokens are not estimated here.

| Task | baseline | improved | steps | context bytes B → I | saved bytes |
|---|---:|---:|---:|---:|---:|
| search `activeModes` | 97 ms | 914 ms | 3 → 1 | 42,131 → 5,545 | 36,586 |
| read `gates.mjs` | 0.3 ms | 304 ms | 1 → 1 | 23,444 → 10,922 | 12,522 |
| `npm test` | 22.5 s | 20.7 s | 1 → 1 | 23,118 → 3,756 | 19,362 |

Restoration check: search chunk contained all 35 hits; the file chunk matched
the source byte-for-byte; the check chunk contained the full output.

Latency separately: `/health` p50 ≈1.6 ms (this is `/info`, not classification),
`/decide` p50 ≈26 ms, full `laya_search` MCP call ≈649 ms (includes cold Node
startup).

Hook overhead: permission-skip in the Go launcher ≈120 ms versus ≈178 ms for the
same `PreToolUse` through Node; read-only `smart` path ≈20 ms.

The improved search/read path is slower in wall time because it performs local
ranking; the gain is in context size and fewer agent steps.

## Agent A/B/C (actual provider usage)

One fixture, one bug-fixing task, same prompt and model
(`Kibborg_Flash_v5.7`), 3 runs per variant:

- **A** — raw built-in tools, no Laya tools.
- **B** — self-fetching tools with the Laya server stopped (deterministic
  ranking only).
- **C** — self-fetching tools with Laya ranking enabled.

All 9 runs succeeded: `npm test` exit 0, hidden acceptance passed, `tests/`
unchanged, only `src/pricing/discounts.mjs` modified.

| Median | A raw | B no Laya | C with Laya |
|---|---:|---:|---:|
| input tokens | 359,085 | 264,062 | 239,544 |
| total tokens | 361,230 | 265,806 | 241,389 |
| cache read | 336,281 | 236,410 | 211,777 |
| model requests | 16 | 10 | 9 |
| tool calls | 20 | 13 | 10 |
| wall, s | 119.1 | 89.9 | 91.1 |

Contributions:

- **A → B (deterministic self-fetching):** input −26.5%, wall −24.5%.
- **B → C (Laya ranking):** input −9.3%, requests 10→9, tool calls 13→10,
  wall +1.3% (noise).
- **A → C:** input −33.3%, wall −23.5%.

Caveats:

- n=3, one fixture; B and C ranges overlap (B 244–266k, C 208–268k input).
  The ~9% Laya effect is observed, not statistically proven.
- Laya was used only for `laya_search` ranking in C; `laya_read_relevant` on
  small blocks ran without Laya (`laya_used=false`), and `laya_run_check` does
  not use Laya.
- `Kibborg_Flash_v5.7` is the local CLI model; it is not DeepSeek.
- Full report and raw methodology: `plugin/experiments/agent-ab-2026-11-02.md`.

## Verification artifacts

- Plugin tests: `cd plugin && node tests/run-all.mjs` — 9 test files, 258 tests.
- MCP E2E: 13 tools, search/read/check chunk restoration.
- New-session check: the agent listed all 13 `laya_*` tools and called
  `laya_health` + `laya_search`; provider usage was 395,628 input / 629 output /
  262,104 cache read over 3 model requests.
- DoneGate delivery: a new session quoted the notification verbatim; another
  session ran `laya_run_check` after being told not to run tests, confirming the
  `continue:true` path.
