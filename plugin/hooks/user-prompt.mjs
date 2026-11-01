#!/usr/bin/env node
// UserPromptSubmit — TaskRouter (рекомендация, не переключение).
//
// Штатный UserPromptSubmit не умеет менять модель, и этот хук не пытается:
// он записывает класс задачи в метрики (mode=log) либо добавляет одну короткую
// строку-рекомендацию (mode=advise). Исходный промпт не переписывается.

import { runHook } from "../src/hooklib.mjs";
import { userPromptGate } from "../src/gates.mjs";
import * as client from "../src/laya-client.mjs";

await runHook("user-prompt", (input) => userPromptGate(input, { client }));
