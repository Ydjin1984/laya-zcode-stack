#!/usr/bin/env node
// PostToolUseFailure — ошибки инструментов идут в ledger как unresolved.
//
// Отдельный хук, потому что ZCode шлёт сбои отдельным событием с полем error.
// Stdout пуст: рекомендации по восстановлению — задача основной модели, а не
// локального классификатора.

import { runHook } from "../src/hooklib.mjs";
import { postToolFailureGate } from "../src/gates.mjs";

await runHook("post-tool-failure", (input) => postToolFailureGate(input));
