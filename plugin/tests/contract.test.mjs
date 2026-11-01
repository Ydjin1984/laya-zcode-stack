// contract.test.mjs — контракт с живым Laya-сервисом (Этап 0 ТЗ).
//
// Если сервис не поднят, live-блоки помечаются SKIP и тест не проваливается:
// недоступная Laya — штатная ситуация (fail-open), а не поломка плагина.
// Приёмочные пункты: три типа вопросов (choice/score/noul) проходят без ошибок,
// распознаётся checkpoint, работают /count, бюджет, Jev-фасад и коды ошибок.

import { createRequire } from "node:module";
import { group, test, assert, assertEq, summary, makeTempDataDir, cleanupTempDataDir, layaIsUp } from "./helpers.mjs";

const dataDir = makeTempDataDir("contract");

const { decide, count, health, questions, noul, choice, score, QUESTION_SET_VERSION } = await import("../src/laya-client.mjs");
const { loadConfig } = await import("../src/config.mjs");

const cfg = loadConfig();
const BASE = cfg.layaUrl.replace(/\/+$/, "");
const up = await layaIsUp(BASE);

function raw(path, body, method = "POST") {
  return fetch(BASE + path, {
    method,
    headers: body ? { "content-type": "application/json; charset=utf-8" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));
}

if (!up) {
  process.stdout.write(`Laya недоступна (${BASE}) — live-тесты пропущены (SKIP). Гейты в проде работают в fail-open.\n`);
}

group("health/ready/info");
await test(up ? "GET /health отвечает ok" : "SKIP /health", async () => {
  if (!up) return;
  const r = await raw("/health", null, "GET");
  assertEq(r.status, 200, "status");
  assertEq(r.json.ok, true, "ok");
});
await test(up ? "GET /info содержит checkpoint с sha256" : "SKIP /info", async () => {
  if (!up) return;
  const r = await raw("/info", null, "GET");
  assertEq(r.status, 200, "status");
  assert(r.json.checkpoint?.sha256?.length === 64, "sha256 из 64 hex");
  assert(r.json.checkpoint?.source === "manifest" || r.json.checkpoint?.source === "runtime", "источник суммы");
  assertEq(r.json.version, 1, "версия API");
  const id = `${r.json.checkpoint.file.replace(/\.[^.]+$/, "")}-${r.json.checkpoint.sha256.slice(0, 12)}`;
  assert(id.includes("-"), `checkpoint id собран: ${id}`);
});
await test(up ? "адаптер health() возвращает checkpointId" : "SKIP health()", async () => {
  if (!up) return;
  const h = await health({ cfg });
  assert(h.ok === true, "health ok");
  assert(typeof h.checkpointId === "string" && h.checkpointId.length > 5, `checkpointId: ${h.checkpointId}`);
  assert(h.ready === true, "ready");
});

group("три типа вопросов и калибровка");
await test(up ? "choice/score/noul в одном батче, порядок сохранён" : "SKIP decide", async () => {
  if (!up) return;
  const q = questions([
    noul("loss", "Уничтожит ли действие несохранённые данные?"),
    score("grade", "Насколько сложна задача?", ["простая", "средняя", "сложная"]),
    choice("kind", "Что за изменение?", { logic: "логика", test: "тесты", docs: "документация" }),
  ]);
  const res = await decide("Команда: rm -rf ./build. Задача: уборка каталога сборки.", q, { cfg });
  assert(res.ok === true, `decide ok: ${JSON.stringify(res.error || {})}`);
  assertEq(res.order, ["loss", "grade", "kind"], "порядок вопросов");
  assertEq(res.answers.loss.type, "noul", "loss.type");
  assertEq(res.answers.grade.type, "score", "grade.type");
  assertEq(res.answers.kind.type, "choice", "kind.type");
  for (const id of res.order) {
    const a = res.answers[id];
    assert(typeof a.answer_confidence === "number" && a.answer_confidence >= 0 && a.answer_confidence <= 1, `${id}: answer_confidence в [0,1]`);
    assert(typeof a.temperature === "number", `${id}: temperature отдана`);
    assert(Array.isArray(a.probabilities) && a.probabilities.length >= 2, `${id}: распределение`);
  }
  assert(res.checkpoint && res.checkpoint.length > 5, "checkpoint в ответе");
  assert(res.budget && res.budget.state_tokens > 0, "budget.state_tokens");
});
await test(up ? "answer_confidence = max(probabilities)" : "SKIP answer_confidence", async () => {
  if (!up) return;
  const res = await decide("Тестовый текст для сверки вероятностей.", questions([noul("x", "Это проверка?")]), { cfg });
  assert(res.ok, "decide ok");
  const a = res.answers.x;
  const maxP = Math.max(...a.probabilities.map((p) => p.value));
  assert(Math.abs(maxP - a.answer_confidence) < 1e-3, `max(p)=${maxP} и answer_confidence=${a.answer_confidence} совпадают`);
});

group("бюджет и обрезка (важнейшее ограничение длины)");
await test(up ? "короткое состояние: fits, без обрезки" : "SKIP count short", async () => {
  if (!up) return;
  const q = questions([choice("k", "Тип?", { a: "первый", b: "второй" })]);
  const res = await count("Короткое состояние: две строки текста.", q, { cfg });
  assert(res.ok, "count ok");
  assertEq(res.fits, true, "fits");
  assertEq(res.questions[0].state_dropped, 0, "нет обрезки");
});
await test(up ? "гигантское состояние: обрезка видна в /count и в /decide" : "SKIP truncation", async () => {
  if (!up) return;
  const huge = ("длинное состояние ".repeat(600)).trim(); // ~10k символов
  const q = questions([noul("x", "Есть ли тут слово длинное?")]);
  const c = await count(huge, q, { cfg });
  assert(c.ok, "count ok");
  assert(c.fits === false, "fits=false на гигантском состоянии");
  assert(c.questions[0].state_dropped > 0, `state_dropped>0 (${c.questions[0].state_dropped})`);
  const d = await decide(huge, q, { cfg });
  assert(d.ok, "decide ok");
  assert(d.budget?.state_truncated === true, "budget.state_truncated=true");
  assert(d.answers.x.state_dropped > 0, "per-answer state_dropped > 0");
  assert(d.warnings.length > 0, "предупреждение об обрезке в warnings");
  assert(d.trustworthy === false, "ответ помечен нетrusted (trustworthy=false)");
});
await test(up ? "max_len override для одного запроса" : "SKIP max_len override", async () => {
  if (!up) return;
  const res = await raw("/decide", {
    state: "короткий текст",
    questions: { x: { type: "noul", instructions: "Это текст?" } },
    max_len: 128,
  });
  assertEq(res.status, 200, "status");
  assertEq(res.json.budget.max_len, 128, "override применён");
});

group("Jev-совместимый фасад");
await test(up ? "GET /v1/models отдаёт чекпоинт и лимиты" : "SKIP /v1/models", async () => {
  if (!up) return;
  const r = await raw("/v1/models", null, "GET");
  assertEq(r.status, 200, "status");
  const m = r.json.data?.[0];
  assert(m && m.id === "laya-go", "id модели");
  assert(m.metadata.checkpoint_sha256.length === 64, "sha256 в metadata");
  assertEq(m.metadata.question_types.join(","), "choice,score,noul", "типы вопросов");
});
await test(up ? "POST /v1/systemone отвечает как /decide" : "SKIP /v1/systemone", async () => {
  if (!up) return;
  const r = await raw("/v1/systemone", {
    model: "laya",
    state: "Пользователь просит удалить временный файл.",
    questions: { q: { type: "choice", instructions: "Категория риска?", criteria: { low: "безопасно", high: "опасно" } } },
  });
  assertEq(r.status, 200, "status");
  assertEq(r.json.answers.q.type, "choice", "тип ответа");
  assert(typeof r.json.checkpoint === "string", "checkpoint есть");
  const bad = await raw("/v1/systemone", { model: "нечто-иное", state: "x", questions: { q: { type: "noul", instructions: "?" } } });
  assertEq(bad.status, 404, "неизвестная модель — 404");
});

group("коды ошибок");
await test(up ? "невалидный JSON и пустой state отклоняются" : "SKIP error codes", async () => {
  if (!up) return;
  const badJson = await fetch(BASE + "/decide", { method: "POST", body: "{not json" });
  const bj = await badJson.json();
  assertEq(badJson.status, 400, "невалидный JSON → 400");
  assertEq(bj.code, "invalid_json", "код invalid_json");
  const noState = await raw("/decide", { questions: { q: { type: "noul", instructions: "?" } } });
  assertEq(noState.status, 400, "пустой state → 400");
  const badType = await raw("/decide", { state: "x", questions: { q: { type: "unknown", instructions: "?" } } });
  assertEq(badType.status, 400, "неизвестный тип → 400");
  assertEq(badType.json.code, "invalid_questions", "код invalid_questions");
  const noQuestions = await raw("/decide", { state: "x", questions: {} });
  assertEq(noQuestions.status, 200, "пустые вопросы — не ошибка");
  assertEq(noQuestions.json.order, [], "order пуст");
});
await test(up ? "адаптер валидирует схему и fail-open на мусор" : "SKIP adapter validation", async () => {
  if (!up) return;
  const res = await decide("текст", { q: { type: "noul", instructions: "?" } }, { cfg, timeoutMs: 300 });
  assert(res.ok, "нормальный ответ проходит");
  assert(typeof res.trustworthy === "boolean", "trustworthy определён");
  // Таймаут 1 мс с высокой вероятностью срабатывает и не должен бросать исключение.
  const timed = await decide("текст", { q: { type: "noul", instructions: "?" } }, { cfg, timeoutMs: 1 });
  assert(timed.ok === true || timed.error?.code === "timeout" || timed.error?.code === "unreachable", `fail-open: ${JSON.stringify(timed.error || "ok")}`);
});

group("контракт плагина");
await test("QUESTION_SET_VERSION задан", async () => {
  assert(/^\d{4}-\d{2}-\d{2}\.\d+$/.test(QUESTION_SET_VERSION), `версия шаблонов: ${QUESTION_SET_VERSION}`);
});

cleanupTempDataDir(dataDir);
process.exit(summary("contract.test"));
