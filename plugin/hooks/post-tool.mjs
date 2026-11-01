#!/usr/bin/env node
// PostToolUse — запись доказательств.
//
// Кормит EvidenceLedger фактами: какие файлы менялись, какие проверки
// запускались, с каким кодом, что в git status. Никогда не пишет в stdout:
// этот хук не имеет права заменять вывод инструмента или добавлять контекст.

import { runHook } from "../src/hooklib.mjs";
import { postToolGate } from "../src/gates.mjs";

await runHook("post-tool", (input) => postToolGate(input));
