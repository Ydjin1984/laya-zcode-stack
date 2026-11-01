// mcp-smoke.test.mjs — протокол MCP (stdio JSON-RPC) и вызовы инструментов.
//
// Сервер запускается дочерним процессом и общается построчно: так проверяется
// ровно тот путь, которым его запускает ZCode. Требования: корректный handshake,
// список инструментов, строгие ошибки протокола (-32700/-32601) и отсутствие
// крэша при недоступной Laya или мусорных аргументах.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { group, test, assert, assertEq, summary, makeTempDataDir, cleanupTempDataDir, layaIsUp } from "./helpers.mjs";

const dataDir = makeTempDataDir("mcp");
const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "src", "mcp-server.mjs");
const up = await layaIsUp();

/** Запускает сервер, шлёт строки, ждёт ответов на перечисленные id. */
function runServer(lines, expectIds, { timeoutMs = 60_000, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      env: { ...process.env, DAVINCI_LAYA_DATA: dataDir, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d.toString();
    });
    child.stderr.on("data", (d) => {
      err += d.toString();
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`таймаут сервера; stdout: ${out.slice(0, 500)}; stderr: ${err.slice(0, 500)}`));
    }, timeoutMs);
    child.on("close", () => {
      clearTimeout(timer);
      const messages = out
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { parseError: l };
          }
        });
      resolve({ messages, stderr: err, code: 0 });
    });
    for (const l of lines) child.stdin.write(l + "\n");
    child.stdin.end();
    // Игнорируем expectIds — ждём закрытия потока: сервер дожидается in-flight запросов.
    void expectIds;
  });
}

const rpc = (id, method, params) => JSON.stringify({ jsonrpc: "2.0", id, method, params });
const call = (id, name, args) => rpc(id, "tools/call", { name, arguments: args });

group("handshake и список инструментов");
const handshake = await runServer(
  [
    rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "1" } }),
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    rpc(2, "tools/list", {}),
    rpc(3, "ping", {}),
  ],
  [1, 2, 3],
);

await test("initialize отвечает protocolVersion и serverInfo", () => {
  const m = handshake.messages.find((x) => x.id === 1);
  assert(m && m.result, `нет ответа initialize: ${handshake.stderr.slice(0, 300)}`);
  assertEq(m.result.protocolVersion, "2025-06-18", "протокол эхом клиента");
  assertEq(m.result.serverInfo.name, "davinci-laya-decisions", "имя сервера");
  assert(m.result.capabilities.tools, "заявлены tools");
});
await test("неизвестная версия протокола → наша поддерживаемая", async () => {
  const r = await runServer([rpc(1, "initialize", { protocolVersion: "1999-01-01" })], [1]);
  const m = r.messages.find((x) => x.id === 1);
  assert(["2025-06-18", "2025-03-26", "2024-11-05"].includes(m.result.protocolVersion), `получено ${m.result.protocolVersion}`);
});
await test("tools/list: 13 инструментов с обязательными полями", () => {
  const m = handshake.messages.find((x) => x.id === 2);
  assert(m && m.result, "нет ответа tools/list");
  const names = m.result.tools.map((t) => t.name).sort();
  assertEq(
    names,
    [
      "laya_batch",
      "laya_classify",
      "laya_context_pick",
      "laya_decide",
      "laya_get_chunk",
      "laya_health",
      "laya_log_triage",
      "laya_rank_diff",
      "laya_read_relevant",
      "laya_run_check",
      "laya_score",
      "laya_search",
      "laya_search_relevant",
    ],
    "состав инструментов",
  );
  for (const t of m.result.tools) {
    assert(t.description && t.description.length > 20, `${t.name}: описание`);
    assert(t.inputSchema?.type === "object", `${t.name}: inputSchema`);
  }
});
await test("ping отвечает пустым результатом", () => {
  const m = handshake.messages.find((x) => x.id === 3);
  assert(m && m.result && Object.keys(m.result).length === 0, "ping → {}");
});

group("ошибки протокола");
const protoErr = await runServer(['{не json', rpc(2, "unknown/method", {}), call(3, "laya_no_such_tool", {})], [2, 3]);
await test("невалидный JSON → -32700", () => {
  const m = protoErr.messages.find((x) => x.error?.code === -32700);
  assert(m, `нет -32700; получено: ${JSON.stringify(protoErr.messages).slice(0, 300)}`);
});
await test("неизвестный метод → -32601", () => {
  const m = protoErr.messages.find((x) => x.id === 2);
  assert(m?.error?.code === -32601, `получено ${JSON.stringify(m)}`);
});
await test("неизвестный инструмент → isError-результат, не протокольная ошибка", () => {
  const m = protoErr.messages.find((x) => x.id === 3);
  assert(m?.result?.isError === true, "isError=true");
  assert(m.result.content[0].text.includes("Неизвестный инструмент"), "текст ошибки");
});

group("вызовы инструментов");
const calls = await runServer(
  [
    call(1, "laya_health", {}),
    call(2, "laya_decide", { state: "" }),
    call(3, "laya_classify", { state: "тест", labels: { a: "один" } }),
    call(4, "laya_get_chunk", { id: "нет-такого" }),
    call(5, "laya_log_triage", {
      chunks: [
        { id: "L1-6", text: "Traceback (most recent call last):\n  File \"app.py\", line 10\nValueError: boom" },
        { id: "L7-9", text: "всё в порядке, продолжаем" },
      ],
      max_laya: 2,
    }),
  ],
  [1, 2, 3, 4, 5],
);
await test("laya_health отвечает структурно даже без Laya", () => {
  const m = calls.messages.find((x) => x.id === 1);
  assert(m?.result && m.result.structuredContent, "structuredContent есть");
  const sc = m.result.structuredContent;
  assert(sc.available === true || sc.available === false, "поле available");
  if (!up) assert(sc.available === false, "без сервера available=false");
});
await test("laya_decide с пустым questions → понятная ошибка", () => {
  const m = calls.messages.find((x) => x.id === 2);
  assert(m?.result?.isError === true, "isError");
  assert(/questions пуст/.test(m.result.content[0].text), `текст: ${m.result.content[0].text}`);
});
await test("laya_classify: одна категория → ошибка валидации", () => {
  const m = calls.messages.find((x) => x.id === 3);
  assert(m?.result?.isError === true, "isError");
  assert(/две категории/.test(m.result.content[0].text), `текст: ${m.result.content[0].text}`);
});
await test("laya_get_chunk: отсутствующий id → isError", () => {
  const m = calls.messages.find((x) => x.id === 4);
  assert(m?.result?.isError === true, "isError");
});
await test("laya_log_triage: детерминированно находит Traceback и сохраняет чанки", () => {
  const m = calls.messages.find((x) => x.id === 5);
  assert(m?.result && !m.result.isError, "вызов прошёл");
  const sc = m.result.structuredContent;
  assert(sc.essential.some((e) => e.id === "L1-6"), "L1-6 в essential");
  assert(!sc.essential.some((e) => e.id === "L7-9"), "L7-9 не essential");
  assert(sc.stored.includes("log-L1-6") && sc.stored.includes("log-L7-9"), "оба чанка сохранены");
  assert(sc.essential[0].chunk_id === "log-L1-6", "ссылка на полный чанк");
  // Вывод «answer-shaped»: уникальные ошибки с счётчиками и подсказками чтения.
  const uniq = sc.unique || [];
  assert(uniq.length === 1, "одна уникальная ошибка, получено " + uniq.length);
  assert(uniq[0].count === 1, "счётчик вхождений на месте");
  assert(/TypeError|ValueError/.test(uniq[0].evidence), "evidence содержит ошибку: " + uniq[0].evidence);
  assert(uniq[0].read_hint && uniq[0].read_hint.offset >= 1, "подсказка Read(offset, limit)");
  assert(uniq[0].block_id === "log-L1-6", "id сохранённого блока");
  assert(/уникальн/i.test(m.result.content[0].text), "текст говорит об уникальных ошибках");
  assert(/повторные чтения не нужны/i.test(m.result.content[0].text), "контракт «не читай лишнего»");
  assert(Array.isArray(sc.summaries), "итоговые строки вынесены отдельно");
});

group("недоступная Laya: деградация без крэша");
const down = await runServer(
  [
    call(1, "laya_health", {}),
    call(2, "laya_decide", { state: "текст", questions: { q: { type: "noul", instructions: "?" } } }),
    call(3, "laya_search_relevant", { query: "нужное слово", hits: [{ id: "h1", path: "a.ts", snippet: "тут нужное слово" }] }),
  ],
  [1, 2, 3],
  { env: { DAVINCI_LAYA_URL: "http://127.0.0.1:1", DAVINCI_LAYA_TIMEOUT_MS: "400" } },
);
await test("laya_decide при недоступной Laya: ok=false и degraded", () => {
  const m = down.messages.find((x) => x.id === 2);
  assert(m?.result && !m.result.isError, "инструмент не падает");
  assertEq(m.result.structuredContent.ok, false, "ok=false");
  assertEq(m.result.structuredContent.degraded, true, "degraded=true");
  assert(/не выдумывай ответ/i.test(m.result.content[0].text), "текст предупреждает не выдумывать");
});
await test("laya_search_relevant без Laya: детерминированный порядок и degraded", () => {
  const m = down.messages.find((x) => x.id === 3);
  assert(m?.result && !m.result.isError, "инструмент не падает");
  const sc = m.result.structuredContent;
  assert(sc.degraded === true, "degraded=true");
  assert(sc.ranked.length === 1, "кандидат возвращён");
});

await test("все ответы сервера — валидный JSON-RPC 2.0", () => {
  for (const m of [...handshake.messages, ...protoErr.messages, ...calls.messages, ...down.messages]) {
    if (m.parseError) throw new Error(`не JSON: ${m.parseError}`);
    assert(m.jsonrpc === "2.0", "jsonrpc");
    assert(typeof m.id !== "undefined" || m.error, "id или error");
  }
});

cleanupTempDataDir(dataDir);
process.exit(summary("mcp-smoke.test"));
