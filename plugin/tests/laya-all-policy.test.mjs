// laya-all-policy.test.mjs — Laya-first больше не добавляет обязательный
// per-turn вызов и не заставляет router писать строку в каждый промпт.
//
// Проверяется:
//   • SessionStart даёт только статус (и только при sessionContext=true);
//   • текст «минимум один laya_* вызов» отсутствует;
//   • router по умолчанию (log) не трогает контекст; advise — opt-in.

import { group, test, assert, assertEq, summary, makeTempDataDir, cleanupTempDataDir, fakeClient } from "./helpers.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { sessionStartGate, userPromptGate } from "../src/gates.mjs";

const dir = makeTempDataDir("policy");
const client = fakeClient({ answers: { trivial: 0.1, investigation: 0.8 } });
const baseCfg = {
  ...DEFAULTS,
  sessionContext: true,
  router: { ...DEFAULTS.router, mode: "log" },
  layaAll: true,
};

function contextOf(result) {
  return result?.output?.hookSpecificOutput?.additionalContext || "";
}

group("SessionStart: только статус, без обязательного вызова");
await test("layaAll=true не добавляет политику per-turn", async () => {
  const r = await sessionStartGate({ session_id: "test-policy", cwd: process.cwd() }, { cfg: baseCfg, client });
  const text = contextOf(r);
  assert(/Laya: готова/.test(text), `нет статуса: ${text}`);
  assert(/Режимы: risk=/.test(text), `нет режимов: ${text}`);
  assert(!/Laya-first/.test(text), "политики Laya-first быть не должно");
  assert(!/минимум один/i.test(text), "обязательного checkpoint быть не должно");
  assert(!/laya_classify/.test(text), "checkpoint classify быть не должно");
});

await test("sessionContext=false молчит даже при layaAll=true", async () => {
  const r = await sessionStartGate(
    { session_id: "test-policy-2", cwd: process.cwd() },
    { cfg: { ...baseCfg, sessionContext: false }, client },
  );
  assertEq(r.output, null, "без sessionContext контекст не трогается");
});

group("UserPromptSubmit: рекомендация только в метрики");
await test("router=log не добавляет строку в контекст", async () => {
  const r = await userPromptGate({ session_id: "test-policy-3", prompt: "проанализируй большой лог" }, { cfg: baseCfg, client });
  assertEq(r.output, null, "log: контекст не трогается");
});

await test("router=advise — opt-in, без обязательного checkpoint", async () => {
  const cfg = { ...baseCfg, router: { ...baseCfg.router, mode: "advise" } };
  const r = await userPromptGate({ session_id: "test-policy-4", prompt: "проанализируй большой лог" }, { cfg, client });
  const text = contextOf(r);
  assert(/класс задачи: deep/.test(text), `нет рекомендации: ${text}`);
  assert(!/Laya-first/.test(text), "политики быть не должно");
  assert(!/минимум один/i.test(text), "обязательного checkpoint быть не должно");
});

cleanupTempDataDir(dir);
process.exit(summary("laya-all-policy.test"));
