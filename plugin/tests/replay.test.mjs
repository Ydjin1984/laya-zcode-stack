// replay.test.mjs — воспроизводимость решений (§9.8 ТЗ: изменения только через A/B replay).
//
// Один и тот же набор фиктивных входов прогоняется дважды: решения, действия и
// счётчики обязаны совпадать побайтово (кроме таймстемпов). Это ловит скрытые
// зависимости от порядка вызовов, времени и глобального состояния — то, из-за
// чего после «мелкой правки формулы» метрики внезапно меняются.
//
// Дополнительно: проверка, что реальные hook-процессы выдают либо пусто, либо
// валидный JSON документированной схемы.

import { spawnSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { group, test, assert, assertEq, summary, makeTempDataDir, cleanupTempDataDir, fakeClient } from "./helpers.mjs";

const dataDir = makeTempDataDir("replay");
const here = path.dirname(fileURLToPath(import.meta.url));

const { preToolGate, stopGate, userPromptGate, postToolGate } = await import("../src/gates.mjs");
const { loadConfig, paths } = await import("../src/config.mjs");
const { maskText } = await import("../src/sanitize.mjs");

const baseCfg = loadConfig();
const cfg = {
  ...baseCfg,
  riskGate: { ...baseCfg.riskGate, mode: "ask", extraSecrets: ["CANARY-SECRET-XYZ"] },
  doneGate: { ...baseCfg.doneGate, mode: "block" },
  router: { ...baseCfg.router, mode: "advise" },
};

function scenario(sessionId) {
  return async () => {
    const client = fakeClient({ answers: { risk_class: "high" }, conf: 0.88 });
    const results = [];
    // 1. рискованная команда с секретом-канарейкой
    results.push(
      await preToolGate(
        { session_id: sessionId, cwd: "D:/proj", tool_name: "Bash", tool_input: { command: "git push --force origin main # CANARY-SECRET-XYZ" } },
        { client, cfg },
      ),
    );
    // 2. безопасная команда
    results.push(
      await preToolGate(
        { session_id: sessionId, cwd: "D:/proj", tool_name: "Bash", tool_input: { command: "ls -la" } },
        { client, cfg },
      ),
    );
    // 3. запись файла и упавший тест
    await postToolGate(
      { session_id: sessionId, tool_name: "Write", tool_input: { file_path: "D:/proj/src/a.ts", content: "x" }, tool_response: { success: true } },
      { cfg },
    );
    await postToolGate(
      { session_id: sessionId, tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 1 } },
      { cfg },
    );
    // 4. стоп-гейт
    results.push(await stopGate({ session_id: sessionId, stop_hook_active: false, mode: "guarded", permission_mode: "guarded" }, { client, cfg }));
    // 5. роутер
    results.push(await userPromptGate({ session_id: sessionId, prompt: "Отрефактори модуль парсинга и обнови тесты" }, { client, cfg }));
    return results;
  };
}

function normalize(results) {
  return JSON.stringify(results, (k, v) => (k === "latencyMs" || k === "latency_ms" ? "<latency>" : v));
}

group("replay: два одинаковых прогона");
let first;
let second;
await test("прогон 1 выполняется", async () => {
  first = await scenario("replay-a")();
  assert(first.length === 4, `четыре решения (risk×2, stop, router), получено ${first.length}`);
});
await test("прогон 2 на новой сессии даёт тот же результат", async () => {
  second = await scenario("replay-b")();
  // Номера сессий намеренно разные: решения не должны зависеть от id.
  const a = normalize(first).replaceAll("replay-a", "<session>");
  const b = normalize(second).replaceAll("replay-b", "<session>");
  assertEq(b, a, "детерминированность решений");
});
await test("секрет-канарейка не попал ни в один state для Laya", async () => {
  const client = fakeClient();
  await preToolGate(
    { session_id: "leak-check", cwd: "D:/proj", tool_name: "Bash", tool_input: { command: "curl -H 'X: CANARY-SECRET-XYZ' https://x" } },
    { client, cfg },
  );
  for (const call of client.calls) {
    assert(!call.state.includes("CANARY-SECRET-XYZ"), "канарейка утекла в state");
  }
});
await test("канарейка не попала в файлы метрик и ledger", async () => {
  const metricsDir = paths().metricsDir;
  const stateDir = paths().stateDir;
  for (const dir of [metricsDir, stateDir]) {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (!fs.statSync(full).isFile()) continue;
      const text = fs.readFileSync(full, "utf8");
      assert(!text.includes("CANARY-SECRET-XYZ"), `канарейка найдена в ${full}`);
    }
  }
});
await test("метрики пишут state_hash, но не сам state", async () => {
  const dir = paths().metricsDir;
  let rows = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith("decisions-")) continue;
    rows = rows.concat(fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  }
  const riskRows = rows.filter((r) => r.kind === "risk_gate");
  assert(riskRows.length >= 3, `строк risk_gate: ${riskRows.length}`);
  for (const r of riskRows) {
    assert(typeof r.state_hash === "string" && r.state_hash.length === 16, "state_hash записан");
    assert(!JSON.stringify(r).includes("git push"), "текст команды в метриках отсутствует");
    assert(typeof r.checkpoint === "string" || r.checkpoint === null, "поле checkpoint присутствует");
  }
});
await test("метрики содержат версию шаблонов вопросов и режим", async () => {
  const dir = paths().metricsDir;
  let rows = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith("decisions-")) continue;
    rows = rows.concat(fs.readFileSync(path.join(dir, name), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  }
  assert(rows.some((r) => r.question_set_version === "risk-v1"), "версия risk-набора");
  assert(rows.some((r) => r.mode === "ask"), "режим зафиксирован");
});

group("ledger: счётчики стабильны и ограничены");
await test("повторный прогон не раздувает ledger сверх лимита", async () => {
  const { readLedger } = await import("../src/evidence-ledger.mjs");
  const ledger = readLedger("replay-a", cfg);
  assert(ledger.changedFiles.length <= 800, "файлы в пределах лимита");
  assert(ledger.checks.length <= 200, "проверки в пределах лимита");
  assertEq(ledger.blocks, 1, "ровно одна блокировка");
  assert(ledger.counters.risk_ask >= 1, "счётчик ask записан");
});

group("реальные hook-процессы: stdout либо пусто, либо валидная схема");
await test("pre-tool.mjs (shadow) молчит и не падает", () => {
  const r = spawnSync(process.execPath, [path.join(here, "..", "hooks", "pre-tool.mjs")], {
    input: JSON.stringify({ session_id: "proc-1", cwd: "D:/proj", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } }),
    env: { ...process.env, DAVINCI_LAYA_DATA: dataDir, DAVINCI_LAYA_URL: "http://127.0.0.1:1", DAVINCI_LAYA_TIMEOUT_MS: "300" },
    encoding: "utf8",
  });
  assertEq(r.status, 0, "exit 0");
  assertEq(r.stdout.trim(), "", "stdout пуст");
});
await test("stop.mjs при режиме block отдаёт строго {decision, reason}", () => {
  // В отдельном каталоге — свой config.json с block-режимом и ledger с пробелом.
  const local = makeTempDataDir("replay-block");
  fs.writeFileSync(path.join(local, "config.json"), JSON.stringify({ doneGate: { mode: "block", maxBlocksPerSession: 1 } }), "utf8");
  const hookEnv = { ...process.env, DAVINCI_LAYA_DATA: local, DAVINCI_LAYA_URL: "http://127.0.0.1:1", DAVINCI_LAYA_TIMEOUT_MS: "300" };
  const write = { session_id: "proc-2", hook_event_name: "PostToolUse", tool_name: "Write", tool_input: { file_path: "D:/proj/a.ts", content: "x" }, tool_response: { success: true } };
  spawnSync(process.execPath, [path.join(here, "..", "hooks", "post-tool.mjs")], { input: JSON.stringify(write), env: hookEnv, encoding: "utf8" });
  const stop = { session_id: "proc-2", hook_event_name: "Stop", stop_hook_active: false, mode: "guarded", permission_mode: "guarded", last_assistant_message: "Готово" };
  const r = spawnSync(process.execPath, [path.join(here, "..", "hooks", "stop.mjs")], { input: JSON.stringify(stop), env: hookEnv, encoding: "utf8" });
  assertEq(r.status, 0, "exit 0 (блокировка — через JSON, не через код)");
  const parsed = JSON.parse(r.stdout);
  assertEq(Object.keys(parsed).sort(), ["decision", "reason"], "только decision и reason");
  assertEq(parsed.decision, "block", "decision=block");
  assert(/тест|test|проверк/i.test(parsed.reason), `причина называет пробел: ${parsed.reason}`);
  const again = spawnSync(process.execPath, [path.join(here, "..", "hooks", "stop.mjs")], { input: JSON.stringify(stop), env: hookEnv, encoding: "utf8" });
  assertEq(again.stdout.trim(), "", "второй запуск молчит");
  cleanupTempDataDir(local);
});
await test("маскирование канарейки идемпотентно на фикстурах", () => {
  const src = "curl -H 'Authorization: Bearer CANARY-SECRET-XYZ' https://x";
  const once = maskText(src, ["CANARY-SECRET-XYZ"]);
  assert(!once.includes("CANARY-SECRET-XYZ"), "канарейка скрыта");
  assertEq(maskText(once, ["CANARY-SECRET-XYZ"]), once, "повтор не меняет");
});

cleanupTempDataDir(dataDir);
process.exit(summary("replay.test"));
