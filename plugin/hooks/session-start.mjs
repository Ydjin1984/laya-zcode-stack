#!/usr/bin/env node
// SessionStart — инициализация ledger и (опционально) строка статуса.
//
// По умолчанию молчит: additionalContext стоит токенов главной модели на каждом
// старте, а пользы в строке «Laya доступна» для обычной работы нет. Включить
// можно через sessionContext:true в config.json.

import { runHook } from "../src/hooklib.mjs";
import { sessionStartGate } from "../src/gates.mjs";
import { ensureDataDir } from "../src/config.mjs";
import * as client from "../src/laya-client.mjs";

await runHook("session-start", async (input) => {
  ensureDataDir();
  return sessionStartGate(input, { client });
});
