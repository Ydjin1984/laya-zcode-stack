// tools-validation.test.mjs — офлайн-проверки контракта инструментов.
//
// Живой сбой, ради которого они добавлены (2026-10-15): laya_decide со
// score-вопросом без criteria уходил в движок, движок отвечал 400 («вопрос 1:
// вопрос типа score без вариантов»), счётчик ошибок движка рос, а инструмент
// показывал «Laya недоступна (inference_failed)» — хотя Laya была жива.

import { group, test, assert, summary, makeTempDataDir, cleanupTempDataDir } from "./helpers.mjs";

const dir = makeTempDataDir("validation");
process.env.DAVINCI_LAYA_URL = "http://127.0.0.1:1"; // заведомо закрытый порт: валидация обязана срабатывать ДО сети
process.env.DAVINCI_LAYA_TIMEOUT_MS = "300";

const { findTool } = await import("../src/tools.mjs");
const decide = findTool("laya_decide");
const batch = findTool("laya_batch");
const triage = findTool("laya_log_triage");

group("валидация вопросов: до сети, без Laya");
await test("score без criteria отклоняется локально", async () => {
  const res = await decide.handler({
    state: "текст",
    questions: {
      first: { type: "noul", instructions: "Это проверка?" },
      second: { type: "score", instructions: "Насколько?" },
    },
  });
  assert(res.isError === true, "ожидался isError");
  const text = res.content[0].text;
  assert(/score/.test(text) && /criteria/.test(text), `подсказка про score/criteria: ${text}`);
  assert(/не по контракту/.test(text), "причина названа");
});

await test("choice с одним вариантом отклоняется", async () => {
  const res = await decide.handler({
    state: "x",
    questions: { c: { type: "choice", instructions: "Тип?", criteria: { one: "единственный" } } },
  });
  assert(res.isError === true, "ожидался isError");
  assert(/choice/.test(res.content[0].text), "подсказка про choice");
});

await test("неизвестный тип отклоняется", async () => {
  const res = await decide.handler({ state: "x", questions: { q: { type: "magic", instructions: "?" } } });
  assert(res.isError === true, "ожидался isError");
  assert(/неизвестен/.test(res.content[0].text), "назван неизвестный тип");
});

await test("валидный набор проходит валидацию и упирается только в сеть", async () => {
  const res = await decide.handler({
    state: "x",
    questions: { g: { type: "score", instructions: "Насколько?", criteria: ["низко", "высоко"] } },
  });
  assert(res.isError === false, "ошибки контракта нет");
  assert(res.structuredContent.ok === false, "без Laya ответ деградирует, но принят");
  assert(!/не по контракту/.test(res.content[0].text), "это не ошибка валидации");
});

await test("laya_batch: невалидный item помечен invalid_questions", async () => {
  const res = await batch.handler({ items: [{ id: "bad", state: "x", questions: { s: { type: "score", instructions: "?" } } }] });
  const r = res.structuredContent.results[0];
  assert(r.ok === false && r.error.code === "invalid_questions", `item-ошибка: ${JSON.stringify(r)}`);
});

group("триаж: маркеры успеха не считаются ошибками");
await test("[ok]-строка с isError не даёт «уникальных ошибок»", async () => {
  const res = await triage.handler({
    chunks: [
      {
        id: "L1-3",
        text: "== mcp ==\n  [ok]   неизвестный инструмент → isError-результат, не протокольная ошибка (0 мс)\nmcp-smoke.test: всего 15, успешно 15, провалено 0",
      },
    ],
  });
  const text = res.content[0].text;
  assert(!/Уникальных ошибок: [1-9]/.test(text), `ложных ошибок быть не должно: ${text.slice(0, 300)}`);
});

await test("настоящая ошибка по-прежнему находится", async () => {
  const res = await triage.handler({
    chunks: [{ id: "L1-3", text: "TypeError: boom\n    at run (/tmp/x.mjs:12:9)\nпровалено 0" }],
  });
  const text = res.content[0].text;
  assert(/TypeError/.test(text), `ошибка найдена: ${text.slice(0, 300)}`);
});

group("doneGate: какие команды считаются проверками");
const { DEFAULTS } = await import("../src/config.mjs");
const testRe = DEFAULTS.doneGate.checks.find((c) => c.kind === "test").re;
// Тот же способ сопоставления, что в evidence-ledger.mjs (new RegExp(re, "i")).
const looksLikeCheck = (cmd) => new RegExp(testRe, "i").test(cmd);
await test("node tests/run-all.mjs — это проверка (штатная команда README)", () => {
  assert(looksLikeCheck("node tests/run-all.mjs"), "штатная команда тестов не распознана");
});
await test("npm test / npx vitest — это проверки", () => {
  assert(looksLikeCheck("npm test"), "npm test не распознан");
  assert(looksLikeCheck("npx vitest run"), "npx vitest не распознан");
});
await test("чтение файлов проверкой не считается", () => {
  assert(!looksLikeCheck("node scripts/laya-admin.mjs status"), "ложное срабатывание на статусе");
  assert(!looksLikeCheck("ls -la"), "ложное срабатывание на ls");
});

cleanupTempDataDir(dir);
process.exit(summary("tools-validation.test"));
