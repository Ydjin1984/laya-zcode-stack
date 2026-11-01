// gate-fixtures.test.mjs — офлайн-валидация решений гейтов (§6, §9.4 ТЗ).
//
// Набор намеренно опасных и безопасных вызовов прогоняется через
// детерминированные правила и политику с фиктивной Laya. Считаются
// false-negative / false-positive по правилам и проверяются границы режимов:
//   shadow — никогда не спрашивает; ask — спрашивает только по подтверждённому
//   риску; низкий риск Laya никогда не «разрешает» опасное; ошибки Laya —
//   fail-open без эскалации.
//
// Дополнительно: маскирование секретов, pathRelation, DoneGate, TaskRouter.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { group, test, assert, assertEq, summary, makeTempDataDir, cleanupTempDataDir, fakeClient } from "./helpers.mjs";
import { DANGEROUS, SAFE } from "./fixtures-risk.mjs";

const dataDir = makeTempDataDir("gates");
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-project-"));
fs.writeFileSync(
  path.join(projectDir, "package.json"),
  JSON.stringify({ name: "fixture", version: "1.0.0", scripts: { test: "node -e \"process.exit(0)\"" } }),
);
const AVAILABLE_TEST = { test: { id: "test", command: "npm test", kind: "test", source: "package.json" } };

const { scanDeterministic, maxRisk, pathRelation, evaluateRisk, riskQuestions, buildRiskState, evaluateDoneGaps, interpretRouter, routerQuestions } = await import("../src/decision-policy.mjs");
const { maskText, prepareForLaya, isSecretPath, truncateMiddle } = await import("../src/sanitize.mjs");
const { preToolGate, stopGate, userPromptGate, postToolGate } = await import("../src/gates.mjs");
const { loadConfig } = await import("../src/config.mjs");

const baseCfg = loadConfig();
const cfgShadow = { ...baseCfg, riskGate: { ...baseCfg.riskGate, mode: "shadow" } };
const cfgAsk = { ...baseCfg, riskGate: { ...baseCfg.riskGate, mode: "ask", askMinConfidence: 0.7 } };

const CWD = "D:/proj/work";

// ------------------------------------------------------- детерминированные

// Наборы опасных/безопасных вызовов — общий модуль (тот же список в laya-eval.mjs).


group("детерминированные правила: опасное");
let detTP = 0;
let detFN = 0;
for (const c of DANGEROUS) {
  await test(`${c.tool}: ${String(c.input.command || c.input.file_path).slice(0, 60)}`, () => {
    const hits = scanDeterministic({ toolName: c.tool, toolInput: c.input, cwd: CWD });
    const risks = hits.map((h) => h.risk);
    const ok = hits.length > 0;
    if (ok) detTP++;
    else detFN++;
    assert(ok, `правила молчат, ожидались ${c.ids.join("/")}`);
    const top = maxRisk(hits);
    const rank = { none: 0, medium: 1, high: 2 };
    assert(rank[top] >= rank[c.risk], `класс риска ${top} ниже ожидаемого ${c.risk} (hits: ${hits.map((h) => h.id + ":" + h.risk)})`);
  });
}

group("детерминированные правила: безопасное (ложные срабатывания)");
let detFP = 0;
for (const c of SAFE) {
  await test(`${c.tool}: ${String(c.input.command || c.input.file_path).slice(0, 60)}`, () => {
    const hits = scanDeterministic({ toolName: c.tool, toolInput: c.input, cwd: CWD });
    if (hits.length > 0) detFP++;
    assertEq(hits.map((h) => h.id), [], "ложное срабатывание правил");
  });
}

await test("FNR/FPR детерминированного слоя в норме", () => {
  // Правила обязаны покрывать весь список опасного (FNR=0): это их единственная
  // гарантия — их отсутствие нельзя «компенсировать» вероятностью Laya.
  process.stdout.write(`     TP=${detTP}, FN=${detFN}, FP=${detFP} из ${DANGEROUS.length} опасных / ${SAFE.length} безопасных\n`);
  assertEq(detFN, 0, "false-negative по правилам");
  assertEq(detFP, 0, "false-positive по правилам");
});

// ---------------------------------------------------------- pathRelation

group("pathRelation");
await test("внутри/вне/системный путь", () => {
  assertEq(pathRelation("D:/proj/work/src/a.ts", "D:/proj/work"), "inside", "вложенный файл");
  assertEq(pathRelation("D:/proj/work", "D:/proj/work"), "inside", "сам каталог");
  assertEq(pathRelation("D:/proj/work/../other/a.ts", "D:/proj/work"), "outside", "выход через ..");
  assertEq(pathRelation("C:/Windows/x.dll", "D:/proj/work"), "system", "системный каталог");
  assertEq(pathRelation("/etc/passwd", "D:/proj/work"), "system", "etc");
  assertEq(pathRelation("E:/backup/a.ts", "D:/proj/work"), "outside", "другой диск");
});

group("маскирование секретов");
await test("токены и заголовки маскируются", () => {
  const cases = [
    ["Authorization: Bearer abcdefghijklmnop123456", "Bearer", "abcdefghijklmnop"],
    ["token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456", "token=", "ABCDEFGHIJ"],
    ["https://user:SuperSecret123@example.com/x", "example.com", "SuperSecret123"],
    ["password = hunter2hunter2", "password", "hunter2"],
    ["AWS_KEY=AKIAIOSFODNN7EXAMPLE", "AKIA", "IOSFODNN7EXAMPLE"],
    ["curl -H 'Cookie: session=abcdef123456' x", "Cookie", "abcdef123456"],
  ];
  for (const [text, keep, hide] of cases) {
    const masked = maskText(text);
    assert(masked.includes(keep), `«${keep}» остался: ${masked}`);
    assert(!masked.includes(hide), `«${hide}» не замаскирован: ${masked}`);
  }
});
await test("PEM-блок маскируется целиком", () => {
  const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----";
  const masked = maskText(pem);
  assert(!masked.includes("MIIEowIBAAKCAQEA1234"), "тело ключа скрыто");
});
await test("маскирование идемпотентно", () => {
  const src = "token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456 и password = hunter2hunter2";
  const once = maskText(src);
  assertEq(maskText(once), once, "повторное маскирование не меняет текст");
});
await test("isSecretPath и усечение с маркером", () => {
  assert(isSecretPath("D:/proj/.env"), ".env — секретный путь");
  assert(isSecretPath("/home/u/.ssh/id_rsa"), "id_rsa — секретный путь");
  assert(!isSecretPath("D:/proj/src/app.ts"), "обычный файл не секретный");
  const t = truncateMiddle("a".repeat(100), 40);
  assert(t.truncated && t.text.length <= 40 + 40, "усечение сохраняет маркер");
  assert(t.text.includes("выпущено 60 симв"), `маркер содержит число: ${t.text}`);
});

group("политика RiskGate: режимы и границы");
const riskyInput = { toolName: "Bash", toolInput: { command: "rm -rf ./src" }, cwd: CWD };
const safeInput = { toolName: "Bash", toolInput: { command: "ls" }, cwd: CWD };

function evalWith({ input, det, laya, cfg }) {
  const hits = det ?? scanDeterministic(input);
  return evaluateRisk({ detHits: hits, laya, cfg });
}

await test("shadow: никогда не ask, даже при полном согласии", async () => {
  const highLaya = await fakeClient({ answers: { risk_class: "high" }, conf: 0.99 }).decide("s", riskQuestions());
  const v = evaluateRisk({ detHits: scanDeterministic(riskyInput), laya: highLaya, cfg: cfgShadow });
  assertEq(v.action, "log", "shadow не повышает вопрос");
  assertEq(v.riskClass, "high", "класс риска зафиксирован в логе");
});
await test("ask: детерминированный high — эскалация", () => {
  const v = evaluateRisk({ detHits: scanDeterministic(riskyInput), laya: null, cfg: cfgAsk });
  assertEq(v.action, "ask", "правило high → ask");
  assertEq(v.source, "deterministic", "источник — правила");
});
await test("ask: Laya high с высокой уверенностью — эскалация", async () => {
  const laya = await fakeClient({ answers: { risk_class: "high" }, conf: 0.92 }).decide("s", riskQuestions());
  const v = evaluateRisk({ detHits: [], laya, cfg: cfgAsk });
  assertEq(v.action, "ask", "Laya high p=0.92 → ask");
  assertEq(v.source, "laya", "источник — Laya");
});
await test("ask: Laya high с НИЗКОЙ уверенностью — без эскалации", async () => {
  const laya = await fakeClient({ answers: { risk_class: "high" }, conf: 0.55 }).decide("s", riskQuestions());
  const v = evaluateRisk({ detHits: [], laya, cfg: cfgAsk });
  assertEq(v.action, "log", "порог 0.7 не пройден");
});
await test("ask: обрезанное состояние/схлопнутые варианты отменяют доверие", async () => {
  const laya = await fakeClient({ answers: { risk_class: "high" }, conf: 0.95, trustworthy: false }).decide("s", riskQuestions());
  const v = evaluateRisk({ detHits: [], laya, cfg: cfgAsk });
  assertEq(v.action, "log", "нетрusted ответ не поднимает вопрос");
  assertEq(v.trustworthy, false, "флаг доверия снят");
});
await test("ask: низкий риск Laya на опасной команде не мешает правилу", async () => {
  const laya = await fakeClient({ answers: { risk_class: "low" }, conf: 0.99 }).decide("s", riskQuestions());
  const v = evaluateRisk({ detHits: scanDeterministic(riskyInput), laya, cfg: cfgAsk });
  assertEq(v.action, "ask", "детерминированный high важнее Laya low");
  assertEq(v.riskClass, "high", "итоговый класс — максимум из двух");
});
await test("ask: безопасное + Laya low → log, никаких allow", async () => {
  const laya = await fakeClient({ answers: { risk_class: "low" }, conf: 0.99 }).decide("s", riskQuestions());
  const v = evaluateRisk({ detHits: scanDeterministic(safeInput), laya, cfg: cfgAsk });
  assertEq(v.action, "log", "безопасное действие проходит штатно");
  assert(!["allow", "deny"].includes(v.action), "allow/deny в политике отсутствуют по конструкции");
});
await test("askRequiresDeterministicSignal: Laya-только high без сигнала не эскалирует", async () => {
  const cfgStrict = { ...cfgAsk, riskGate: { ...cfgAsk.riskGate, askRequiresDeterministicSignal: true } };
  const laya = await fakeClient({ answers: { risk_class: "high" }, conf: 0.95 }).decide("s", riskQuestions());
  const v = evaluateRisk({ detHits: [], laya, cfg: cfgStrict });
  assertEq(v.action, "log", "без сигнала правил эскалации нет (строгий режим)");
});

group("RiskGate end-to-end (гейт с фиктивной Laya)");
await test("shadow пишет телеметрию и молчит в stdout", async () => {
  const client = fakeClient({ answers: { risk_class: "high" }, conf: 0.9 });
  const r = await preToolGate(
    { session_id: "g1", cwd: CWD, tool_name: "Bash", tool_input: { command: "git reset --hard" } },
    { client, cfg: cfgShadow },
  );
  assertEq(r.output, null, "shadow: stdout пуст");
  assertEq(r.telemetry.verdict.action, "log", "действие — log");
});
await test("shadow + warnHighRisk: предупреждение в контекст без permissionDecision", async () => {
  const client = fakeClient({ answers: { risk_class: "high" }, conf: 0.9 });
  const warnCfg = { ...cfgShadow, riskGate: { ...cfgShadow.riskGate, warnHighRisk: true } };
  const r = await preToolGate(
    { session_id: "g1w", cwd: CWD, tool_name: "Bash", tool_input: { command: "git reset --hard" } },
    { client, cfg: warnCfg },
  );
  assert(r.output !== null, "warnHighRisk отдаёт предупреждение");
  const h = r.output.hookSpecificOutput;
  assertEq(h.hookEventName, "PreToolUse", "имя события");
  assertEq(h.permissionDecision, undefined, "вопрос перед пользователем не поднимается");
  assert(typeof h.additionalContext === "string" && h.additionalContext.includes("high"), "контекст содержит класс риска");
  assertEq(r.telemetry.verdict.action, "log", "действие остаётся log");
});
await test("warnHighRisk молчит на неуверенный high без сигналов правил", async () => {
  const client = fakeClient({ answers: { risk_class: "high" }, conf: 0.55 });
  const warnCfg = { ...cfgShadow, riskGate: { ...cfgShadow.riskGate, warnHighRisk: true } };
  const r = await preToolGate(
    { session_id: "g1q", cwd: CWD, tool_name: "Bash", tool_input: { command: "node -e \"console.log(1)\"" } },
    { client, cfg: warnCfg },
  );
  assertEq(r.output, null, "неуверенный вердикт не тратит контекст");
  assertEq(r.telemetry.verdict.riskClass, "high", "класс при этом зафиксирован в метриках");
});
await test("ask возвращает строго документированную схему PreToolUse", async () => {
  const client = fakeClient({ answers: { risk_class: "high" }, conf: 0.9 });
  const askCfg = { ...cfgAsk, riskGate: { ...cfgAsk.riskGate, extraSecrets: ["SECRET-CANARY-12345"] } };
  const r = await preToolGate(
    {
      session_id: "g2",
      cwd: CWD,
      tool_name: "Bash",
      tool_input: { command: "rm -rf ./src  # SECRET-CANARY-12345" },
    },
    { client, cfg: askCfg },
  );
  assert(r.output !== null, "ask отдаёт решение");
  assertEq(Object.keys(r.output), ["hookSpecificOutput"], "только hookSpecificOutput");
  assertEq(r.output.hookSpecificOutput.hookEventName, "PreToolUse", "имя события");
  assertEq(r.output.hookSpecificOutput.permissionDecision, "ask", "решение — ask");
  assert(r.output.hookSpecificOutput.permissionDecisionReason.includes("high"), "причина содержит класс");
  const sent = client.calls[0].state;
  assert(!sent.includes("SECRET-CANARY-12345"), "секрет не ушёл в Laya");
});
await test("Laya недоступна: гейт работает на правилах, не падает", async () => {
  const client = fakeClient({ fail: { code: "timeout", message: "тестовый таймаут" } });
  const r = await preToolGate(
    { session_id: "g3", cwd: CWD, tool_name: "Bash", tool_input: { command: "git clean -fdx" } },
    { client, cfg: cfgAsk },
  );
  assertEq(r.telemetry.verdict.action, "ask", "правило high работает без Laya");
  const r2 = await preToolGate(
    { session_id: "g4", cwd: CWD, tool_name: "Bash", tool_input: { command: "echo привет" } },
    { client, cfg: cfgAsk },
  );
  assertEq(r2.output, null, "без Laya и без правил — молчание");
});
await test("бюджет проверяется через /count, а не по числу символов", async () => {
  const client = fakeClient();
  await preToolGate(
    {
      session_id: "g5",
      cwd: CWD,
      tool_name: "Bash",
      tool_input: { command: "x".repeat(5000) },
    },
    { client, cfg: { ...cfgShadow, riskGate: { ...cfgShadow.riskGate, stateCharBudget: 700 } } },
  );
  const sent = client.calls[0].state;
  assert(client.countCalls.length === 1, "/count вызван перед /decide");
  assert(sent.length > 700, "символьный лимит больше не режет state молча");
  assert(sent.startsWith("Инструмент: Bash"), "инструмент — первая строка");
  assert(sent.includes("Команда:"), "команда — в начале");
});
await test("если /count показывает обрезку, state сокращается с маркером", async () => {
  const client = fakeClient({
    countResult: ({ callIndex }) =>
      callIndex === 1
        ? {
            ok: true,
            state_tokens: 300,
            max_len: 1024,
            head_max_len: 256,
            fits: false,
            questions: [{ state_kept: 50, state_dropped: 250, head_truncated: false, collapsed: false }],
          }
        : {
            ok: true,
            state_tokens: 40,
            max_len: 1024,
            head_max_len: 256,
            fits: true,
            questions: [{ state_kept: 40, state_dropped: 0, head_truncated: false, collapsed: false }],
          },
  });
  const r = await preToolGate(
    {
      session_id: "g5b",
      cwd: CWD,
      tool_name: "Bash",
      tool_input: { command: "x".repeat(5000) },
    },
    { client, cfg: cfgShadow },
  );
  const sent = client.calls[0].state;
  assert(sent.length < 1500, `state сокращён (${sent.length})`);
  assert(sent.includes("выпущено"), "сокращение помечено маркером");
  assertEq(client.countCalls.length, 2, "повторный замер после сокращения");
  assertEq(r.telemetry.truncated, true, "телеметрия фиксирует сокращение");
});

group("layaPolicy: smart не тратит вызов на чтение, но не пропускает неизвестное");
await test("read-only команда: Laya не вызывается, решение всё равно записано", async () => {
  const client = fakeClient({ answers: { risk_class: "high" }, conf: 0.99 });
  const r = await preToolGate(
    { session_id: "p1", cwd: CWD, tool_name: "Bash", tool_input: { command: "git status --porcelain" } },
    { client, cfg: cfgAsk },
  );
  assertEq(client.calls.length, 0, "Laya не опрошена");
  assertEq(r.output, null, "эскалации нет (Laya не спрашивали)");
  assertEq(r.telemetry.verdict.action, "log", "решение записано");
});
await test("незнакомая команда: Laya вызывается", async () => {
  const client = fakeClient({ answers: { risk_class: "high" }, conf: 0.99 });
  await preToolGate(
    { session_id: "p2", cwd: CWD, tool_name: "Bash", tool_input: { command: "./deploy.sh --target staging" } },
    { client, cfg: cfgAsk },
  );
  assertEq(client.calls.length, 1, "Laya опрошена");
});
await test("запись файла: Laya вызывается всегда (инструмент Write)", async () => {
  const client = fakeClient({ answers: { risk_class: "high" }, conf: 0.95 });
  await preToolGate(
    { session_id: "p3", cwd: CWD, tool_name: "Write", tool_input: { file_path: "D:/proj/work/src/new.ts", content: "export {}" } },
    { client, cfg: cfgAsk },
  );
  assertEq(client.calls.length, 1, "Laya опрошена");
});
await test("правило сработало — модель уточняет класс даже на чтении-подобном", async () => {
  const client = fakeClient({ answers: { risk_class: "medium" }, conf: 0.8 });
  await preToolGate(
    { session_id: "p4", cwd: CWD, tool_name: "Bash", tool_input: { command: "chmod -R 777 ./dist" } },
    { client, cfg: cfgAsk },
  );
  assertEq(client.calls.length, 1, "Laya опрошена");
});
await test("политика always/never управляется конфигурированием", async () => {
  const readCmd = { session_id: "p5", cwd: CWD, tool_name: "Bash", tool_input: { command: "ls" } };
  const cAlways = fakeClient();
  await preToolGate(readCmd, { client: cAlways, cfg: { ...cfgAsk, riskGate: { ...cfgAsk.riskGate, layaPolicy: "always" } } });
  assertEq(cAlways.calls.length, 1, "always: вызов есть");
  const cNever = fakeClient();
  await preToolGate(
    { ...readCmd, tool_input: { command: "./unknown-script --x" } },
    { client: cNever, cfg: { ...cfgAsk, riskGate: { ...cfgAsk.riskGate, layaPolicy: "never" } } },
  );
  assertEq(cNever.calls.length, 0, "never: вызова нет");
});

group("режимы разрешений: гейт спрашивает только в Autonomous mode");
await test("guarded (Autonomous mode): высокий риск → ask", async () => {
  const client = fakeClient({ answers: { risk_class: "high" }, conf: 0.9 });
  const r = await preToolGate(
    { session_id: "m1", cwd: CWD, mode: "guarded", tool_name: "Bash", tool_input: { command: "rm -rf ./src" } },
    { client, cfg: cfgAsk },
  );
  assert(r.output && r.output.hookSpecificOutput.permissionDecision === "ask", "Autonomous mode спрашивает");
  assertEq(client.calls.length, 1, "Laya вызвана");
});
await test("yolo (Full access): высокий риск → молчание и никакого инференса", async () => {
  const client = fakeClient({ answers: { risk_class: "high" }, conf: 0.99 });
  const r = await preToolGate(
    {
      session_id: "m2",
      cwd: CWD,
      mode: "yolo",
      permission_mode: "yolo",
      tool_name: "Bash",
      tool_input: { command: "rm -rf ./src" },
    },
    { client, cfg: cfgAsk },
  );
  assertEq(r.output, null, "Full access: вопроса нет");
  assertEq(client.calls.length, 0, "Laya не тратит инференс");
  assertEq(r.telemetry.skipped, "permission_mode", "пропуск зафиксирован");
  assertEq(r.telemetry.permissionMode, "yolo", "режим распознан");
});
await test("build/plan/edit: вопросы не поднимаются (только guarded)", async () => {
  for (const mode of ["build", "plan", "edit"]) {
    const client = fakeClient({ answers: { risk_class: "high" }, conf: 0.99 });
    const r = await preToolGate(
      { session_id: `m3-${mode}`, cwd: CWD, permission_mode: mode, tool_name: "Bash", tool_input: { command: "rm -rf ./src" } },
      { client, cfg: cfgAsk },
    );
    assertEq(r.output, null, `${mode}: вопроса нет`);
    assertEq(client.calls.length, 0, `${mode}: Laya не вызвана`);
  }
});

group("EvidenceLedger и DoneGate");
await test("код менялся, доступная проверка не запускалась → no-check-run", () => {
  const gaps = evaluateDoneGaps({ changedFiles: ["src/a.ts"], checks: [], unresolvedErrors: [] }, baseCfg, { checks: AVAILABLE_TEST });
  assertEq(gaps.map((g) => g.id), ["no-check-run"], "детерминированный пробел");
  assertEq(gaps[0].severity, "high", "severity high");
  assertEq(gaps[0].check_id, "test", "подсказывает доступную проверку");
});
await test("изменение только README не требует тестов", () => {
  const gaps = evaluateDoneGaps({ changedFiles: ["README.md"], checks: [], unresolvedErrors: [] }, baseCfg, { checks: AVAILABLE_TEST });
  assertEq(gaps, [], "docs-only — не повод искать отсутствующие тесты");
});
await test("код менялся, но проверок в проекте нет → info, не ошибка", () => {
  const gaps = evaluateDoneGaps({ changedFiles: ["src/a.ts"], checks: [], unresolvedErrors: [] }, baseCfg, { checks: {} });
  assertEq(gaps.map((g) => g.id), ["no-checks-available"], "нет доступных проверок");
  assertEq(gaps[0].severity, "info", "это не провал работы");
});
await test("упавший тест → gap failing-tests", () => {
  const gaps = evaluateDoneGaps({ changedFiles: ["a.ts"], checks: [{ kind: "test", exitCode: 1, ts: 1 }], unresolvedErrors: [] }, baseCfg, { checks: AVAILABLE_TEST });
  assertEq(gaps.map((g) => g.id), ["failing-tests"], "провал теста виден");
});
await test("успешный тест после изменения → пробелов нет", () => {
  const gaps = evaluateDoneGaps({ changedFiles: ["a.ts"], changedAfterLastTest: false, checks: [{ kind: "test", exitCode: 0, ts: 2 }], unresolvedErrors: [] }, baseCfg, { checks: AVAILABLE_TEST });
  assertEq(gaps, [], "чистая картина");
});
await test("изменение после теста → changed-after-tests", () => {
  const gaps = evaluateDoneGaps({ changedFiles: ["a.ts"], changedAfterLastTest: true, checks: [{ kind: "test", exitCode: 0, ts: 2 }], unresolvedErrors: [] }, baseCfg, { checks: AVAILABLE_TEST });
  assertEq(gaps.map((g) => g.id), ["changed-after-tests"], "порядок проверок нарушен");
});
await test("неразрешённые ошибки без последующей проверки → gap", () => {
  const gaps = evaluateDoneGaps({ changedFiles: ["a.ts"], checks: [{ kind: "test", exitCode: 0, ts: 1 }], unresolvedErrors: [{ tool: "Bash", ts: 5 }] }, baseCfg, { checks: AVAILABLE_TEST });
  assertEq(gaps.map((g) => g.id).sort(), ["unresolved-errors"], "ошибка осталась");
});
await test("report: короткое уведомление вместо блокировки", async () => {
  const client = fakeClient();
  const cfgReport = { ...baseCfg, doneGate: { ...baseCfg.doneGate, mode: "report" } };
  await postToolGate(
    { session_id: "d1", tool_name: "Write", tool_input: { file_path: "D:/proj/work/src/a.ts", content: "x" }, tool_response: { success: true } },
    { cfg: cfgReport },
  );
  const r1 = await stopGate({ session_id: "d1", stop_hook_active: false, cwd: projectDir }, { client, cfg: cfgReport });
  assert(r1.output && r1.output.hookSpecificOutput, "report: уведомление");
  assert(!r1.output.decision, "report: без decision/block");
  assertEq(r1.output.continue, true, "continue доставляет уведомление агенту");
  assert(r1.output.stopReason.includes("Laya DoneGate"), "stopReason содержит уведомление");
  assert(r1.output.hookSpecificOutput.additionalContext.includes("laya_run_check"), "уведомление называет проверку");
  assertEq(r1.telemetry.gaps.map((g) => g.id), ["no-check-run"], "пробел зафиксирован");

  const cfgBlock = { ...baseCfg, doneGate: { ...baseCfg.doneGate, mode: "block", maxBlocksPerSession: 1 } };
  const r2 = await stopGate({ session_id: "d1", stop_hook_active: false, cwd: projectDir, mode: "guarded", permission_mode: "guarded" }, { client, cfg: cfgBlock });
  assert(r2.output && r2.output.decision === "block", "block: решение block");
  assert(/тест|test/.test(r2.output.reason), "причина называет пробел");
  const r3 = await stopGate({ session_id: "d1", stop_hook_active: false, cwd: projectDir, mode: "guarded", permission_mode: "guarded" }, { client, cfg: cfgBlock });
  assertEq(r3.output, null, "повторно не блокирует (ограничение в ledger)");
  const r4 = await stopGate({ session_id: "d1", stop_hook_active: true, cwd: projectDir, mode: "guarded", permission_mode: "guarded" }, { client, cfg: cfgBlock });
  assertEq(r4.output, null, "stop_hook_active гасит блокировку");
});
await test("laya_run_check закрывает пробел: проверка из MCP видна StopGate", async () => {
  const { recordProjectCheck } = await import("../src/evidence-ledger.mjs");
  const client = fakeClient();
  const cfgReport = { ...baseCfg, doneGate: { ...baseCfg.doneGate, mode: "report" } };
  await postToolGate(
    { session_id: "d5", tool_name: "Write", tool_input: { file_path: path.join(projectDir, "src", "d.ts"), content: "x" }, tool_response: { success: true } },
    { cfg: cfgReport },
  );
  recordProjectCheck(projectDir, { checkId: "test", kind: "test", command: "npm test", exitCode: 0, ts: Date.now() + 1 });
  const r = await stopGate({ session_id: "d5", stop_hook_active: false, cwd: projectDir }, { client, cfg: cfgReport });
  assertEq(r.output, null, "проверка запущена — уведомления нет");
  assertEq(r.telemetry.gaps, [], "пробелов нет");
  assertEq(r.telemetry.availableChecks.includes("test"), true, "доступные проверки видны");
});
await test("упавшая проверка остаётся high даже когда уведомление уже исчерпано", async () => {
  const { recordProjectCheck, updateLedger } = await import("../src/evidence-ledger.mjs");
  const client = fakeClient();
  const cfgReport = { ...baseCfg, doneGate: { ...baseCfg.doneGate, mode: "report" } };
  await postToolGate(
    { session_id: "d6", tool_name: "Write", tool_input: { file_path: path.join(projectDir, "src", "e.ts"), content: "x" }, tool_response: { success: true } },
    { cfg: cfgReport },
  );
  recordProjectCheck(projectDir, { checkId: "test", kind: "test", command: "npm test", exitCode: 1, ts: Date.now() + 1 });
  updateLedger("d6", (l) => {
    l.counters = l.counters || {};
    l.counters.done_notify = 1;
    l.blocks = 1;
  }, cfgReport);
  const r = await stopGate(
    { session_id: "d6", stop_hook_active: false, cwd: projectDir, mode: "guarded", permission_mode: "guarded" },
    { client, cfg: cfgReport },
  );
  assertEq(r.output, null, "повторное уведомление запрещено");
  assert(r.telemetry.gaps.some((g) => g.id === "failing-tests" && g.severity === "high"), "провал проверки сохранён");
  assertEq(r.telemetry.action, "log", "только лог, но не no-gaps");
});
await test("yolo: evidence собирается, блокировки нет, уведомление о конкретной проверке", async () => {
  const client = fakeClient();
  const cfgBlock = { ...baseCfg, doneGate: { ...baseCfg.doneGate, mode: "block", maxBlocksPerSession: 1 } };
  await preToolGate(
    { session_id: "d3", cwd: projectDir, mode: "yolo", permission_mode: "yolo", tool_name: "Bash", tool_input: { command: "echo x" } },
    { client, cfg: cfgBlock },
  );
  await postToolGate(
    { session_id: "d3", tool_name: "Write", tool_input: { file_path: "D:/proj/work/src/b.ts", content: "x" }, tool_response: { success: true } },
    { cfg: cfgBlock },
  );
  const r = await stopGate({ session_id: "d3", stop_hook_active: false, cwd: projectDir }, { client, cfg: cfgBlock });
  assertEq(r.output?.decision, undefined, "Full access: блокировки нет");
  assertEq(r.output?.continue, true, "уведомление доставляется продолжением");
  assert(r.output?.hookSpecificOutput?.additionalContext?.includes("laya_run_check"), "есть короткое уведомление");
  assertEq(r.telemetry.gaps.map((g) => g.id), ["no-check-run"], "пробел остаётся в телеметрии");
});
await test("guarded (Autonomous mode): DoneGate блокирует", async () => {
  const client = fakeClient();
  const cfgBlock = { ...baseCfg, doneGate: { ...baseCfg.doneGate, mode: "block", maxBlocksPerSession: 1 } };
  await postToolGate(
    { session_id: "d4", tool_name: "Write", tool_input: { file_path: "D:/proj/work/src/c.ts", content: "x" }, tool_response: { success: true } },
    { cfg: cfgBlock },
  );
  const r = await stopGate(
    { session_id: "d4", stop_hook_active: false, mode: "guarded", permission_mode: "guarded" },
    { client, cfg: cfgBlock },
  );
  assert(r.output && r.output.decision === "block", "Autonomous mode: блокировка работает");
});
await test("postTool: тестовая команда считается проверкой, git status — доказательством", async () => {
  const cfg = { ...baseCfg, doneGate: { ...baseCfg.doneGate, mode: "report" } };
  await postToolGate(
    { session_id: "d2", tool_name: "Bash", tool_input: { command: "npm test" }, tool_response: { exit_code: 0 } },
    { cfg },
  );
  await postToolGate(
    {
      session_id: "d2",
      tool_name: "Bash",
      tool_input: { command: "git status --porcelain" },
      tool_response: { stdout: "M src/a.ts\n?? new.txt" },
    },
    { cfg },
  );
  const { readLedger } = await import("../src/evidence-ledger.mjs");
  const ledger = readLedger("d2", cfg);
  assertEq(ledger.checks.length, 1, "одна проверка");
  assertEq(ledger.checks[0].kind, "test", "распознан тест");
  assert(ledger.lastGitStatus.includes("src/a.ts"), "git-доказательство сохранено");
});

group("TaskRouter");
await test("интерпретация классов и порог уверенности", async () => {
  const laya = await fakeClient({ answers: { trivial: 0.9, investigation: 0.9 } }).decide("s", routerQuestions());
  const rec = interpretRouter(laya, baseCfg);
  assertEq(rec.taskClass, "deep", "класс deep");
  assert(rec.suggestion && rec.suggestion.target === "deep", "совет deep");
  const lowConf = await fakeClient({ answers: { trivial: 0.1, investigation: 0.55 } }).decide("s", routerQuestions());
  const rec2 = interpretRouter(lowConf, baseCfg);
  assertEq(rec2.suggestion, null, "низкая уверенность — без совета");
  const down = interpretRouter({ ok: false, error: { code: "timeout" } }, baseCfg);
  assertEq(down.available, false, "недоступность → available=false");
});
await test("router в режиме log не пишет в контекст", async () => {
  const client = fakeClient({ answers: { trivial: 0.9, investigation: 0.9 } });
  const cfgLog = { ...baseCfg, router: { ...baseCfg.router, mode: "log" } };
  const r = await userPromptGate({ session_id: "r1", prompt: "Отрефактори весь бэкенд" }, { client, cfg: cfgLog });
  assertEq(r.output, null, "log: контекст не трогается");
  const cfgAdvise = { ...baseCfg, router: { ...baseCfg.router, mode: "advise" } };
  const r2 = await userPromptGate({ session_id: "r2", prompt: "Отрефактори весь бэкенд" }, { client, cfg: cfgAdvise });
  assert(r2.output?.hookSpecificOutput?.additionalContext?.includes("deep"), "advise: короткая строка");
});

cleanupTempDataDir(dataDir);
fs.rmSync(projectDir, { recursive: true, force: true });
process.exit(summary("gate-fixtures.test"));
