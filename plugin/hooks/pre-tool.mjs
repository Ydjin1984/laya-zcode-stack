#!/usr/bin/env node
// PreToolUse — RiskGate.
//
// Вызывается ZCode на Bash/Write/Edit/MultiEdit. Решение записывается локально
// всегда; в stdout что-то попадает только в режиме ask и только когда порог
// подтверждён (см. decision-policy.mjs). Ошибки не ломают сессию: runHook
// гарантирует exit 0 и диагностику в stderr.

import { runHook } from "../src/hooklib.mjs";
import { preToolGate } from "../src/gates.mjs";
import * as client from "../src/laya-client.mjs";

await runHook("pre-tool", (input) => preToolGate(input, { client }));
