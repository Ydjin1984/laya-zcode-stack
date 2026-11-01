#!/usr/bin/env node
// Stop — DoneGate.
//
// Проверяет доказательства завершения по ledger. В режиме report (по умолчанию)
// ничего не возвращает; в режиме block может ОДИН раз на сессию вернуть
// decision:"block" с причиной — и только по детерминированным пробелам
// (например: код менялся, тесты не запускались). Бесконечные циклы исключены:
// учитывается stop_hook_active и счётчик блокировок в ledger.

import { runHook } from "../src/hooklib.mjs";
import { stopGate } from "../src/gates.mjs";
import * as client from "../src/laya-client.mjs";

await runHook("stop", (input) => stopGate(input, { client }));
