#!/usr/bin/env node
// mcp-server.mjs — MCP-сервер (stdio) плагина davinci-laya-decisions.
//
// Транспорт: JSON-RPC 2.0, по одному сообщению на строку в stdin/stdout
// (документированный stdio-транспорт MCP; HTTP-эндпоинт Laya как MCP URL
// использовать нельзя — это другая сторона протокола).
//
// Поддерживается минимум, нужный клиенту ZCode: initialize,
// notifications/initialized, tools/list, tools/call, ping. Неизвестные
// нотификации игнорируются, неизвестные запросы получают -32601.
//
// Никакого filesystem-write сверх каталога данных плагина: этот сервер —
// «советник», а не исполнитель (§9.9 ТЗ).

import { createInterface } from "node:readline";
import { toolList, findTool } from "./tools.mjs";
import { ensureDataDir, loadConfig } from "./config.mjs";
import { runWithWorkTrace, recordToolResult } from "./work-client.mjs";
import pkg from "../package.json" with { type: "json" };

const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "davinci-laya-decisions", version: pkg.version || "0.1.0" };

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message, data) {
  const error = { code, message };
  if (data !== undefined) error.data = data;
  send({ jsonrpc: "2.0", id, error });
}

async function handleRequest(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case "initialize": {
      const requested = params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOLS.includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
      sendResult(id, {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Локальные типизированные решения Laya (choice/score/noul). Инструменты ранжирования и триажа экономят контекст: сначала детерминированный поиск, затем Laya на коротких фрагментах. Вытесненные фрагменты всегда доступны через laya_get_chunk.",
      });
      return;
    }
    case "ping":
      sendResult(id, {});
      return;
    case "tools/list":
      sendResult(id, { tools: toolList() });
      return;
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments || {};
      const def = findTool(name);
      if (!def) {
        // Ошибка вызова инструмента, а не протокола: так требует MCP.
        sendResult(id, { content: [{ type: "text", text: `Неизвестный инструмент: ${name}` }], isError: true });
        return;
      }
      try {
        const cfg = loadConfig();
        const started = Date.now();
        const sessionId = process.env.ZCODE_SESSION_ID || process.env.CLAUDE_SESSION_ID || null;
        const res = await runWithWorkTrace(
          { cfg, tool: name, operation: name, sessionId },
          async () => {
            const out = await def.handler(args);
            // Запись внутри trace: tool_result должен нести тот же trace/session,
            // что и model_call, иначе панель не свяжет их.
            if (name !== "laya_health") {
              const sc = out?.structuredContent || null;
              recordToolResult({
                tool: name,
                result: sc,
                startedAt: started,
                evidence: toolEvidence(name, sc),
                status: out?.isError ? "error" : "completed",
                action: toolAction(name),
                layaCalled: toolUsedLaya(name, sc),
              });
            }
            return out;
          },
        );
        sendResult(id, res);
      } catch (err) {
        sendResult(id, {
          content: [{ type: "text", text: `Ошибка инструмента ${name}: ${err?.message || err}` }],
          isError: true,
          structuredContent: { ok: false, error: String(err?.message || err) },
        });
      }
      return;
    }
    default:
      if (typeof id !== "undefined") sendError(id, -32601, `method not found: ${method}`);
  }
}

/** Действие плагина для ленты: не безликое «tool_result». */
function toolAction(name) {
  switch (name) {
    case "laya_search":
    case "laya_search_relevant":
    case "laya_rank_diff":
      return "rank";
    case "laya_read_relevant":
      return "keep";
    case "laya_run_check":
      return "check";
    case "laya_get_chunk":
      return "chunk_read";
    case "laya_context_pick":
      return "context_pick";
    case "laya_log_triage":
      return "triage";
    case "laya_decide":
    case "laya_classify":
    case "laya_score":
    case "laya_batch":
      return "answer";
    default:
      return "tool_result";
  }
}

/** Вызывалась ли Laya в этом инструменте (для «Laya не вызывалась» в UI). */
function toolUsedLaya(name, sc) {
  if (name === "laya_get_chunk" || name === "laya_run_check") return false;
  if (name === "laya_read_relevant") return sc?.laya_used !== false;
  return true;
}

/**
 * Короткое evidence для панели. Полный текст сюда не попадает: только id
 * артефакта, размеры и факты проверки.
 */
function toolEvidence(name, sc) {
  if (!sc || typeof sc !== "object") return null;
  const ev = {};
  if (sc.savings && typeof sc.savings === "object") Object.assign(ev, sc.savings);
  if (sc.chunk_id) ev.chunk_id = sc.chunk_id;
  if (Array.isArray(sc.stored_ids)) ev.stored_ids = sc.stored_ids.slice(0, 50);
  if (name === "laya_get_chunk") {
    ev.chunk_id = sc.id || sc.chunk_id || null;
    ev.returned_chars = sc.returned_chars ?? null;
    ev.bytes = sc.bytes ?? null;
    ev.offset = sc.offset ?? null;
    ev.limit = sc.limit ?? null;
    ev.full = sc.full === true;
  }
  if (name === "laya_run_check") {
    ev.check_id = sc.check_id || null;
    ev.command = sc.command || null;
    ev.exit_code = sc.exit_code ?? null;
    ev.timed_out = sc.timed_out === true;
    ev.errors = Array.isArray(sc.errors) ? sc.errors.length : 0;
  }
  if (name === "laya_batch") {
    ev.items = Array.isArray(sc.results) ? sc.results.length : null;
    ev.ok_items = Array.isArray(sc.results) ? sc.results.filter((r) => r && r.ok).length : null;
  }
  return Object.keys(ev).length ? ev : null;
}

function main() {
  ensureDataDir();
  const cfg = loadConfig();
  process.stderr.write(`[davinci-laya-mcp] запущен: Laya=${cfg.layaUrl}, tools=${toolList().length}\n`);
  // Незавершённые запросы: вызовы Laya асинхронны, и при закрытии stdin (клиент
  // завершился или тест подал пакет строк и закрыл поток) нельзя убивать процесс
  // до их ответа — иначе последние tool/call теряются молча.
  const inFlight = new Set();
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      sendError(null, -32700, "parse error");
      return;
    }
    // Нотификации (без id) не требуют ответа.
    const isNotification = typeof msg.id === "undefined" || msg.id === null;
    if (isNotification) return;
    const task = handleRequest(msg)
      .catch((err) => sendError(msg.id, -32603, `internal error: ${err?.message || err}`))
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
  });
  rl.on("close", async () => {
    // Даём последним запросам завершиться (у каждого свой таймаут внутри клиента).
    const deadline = Date.now() + 30_000;
    while (inFlight.size > 0 && Date.now() < deadline) {
      await Promise.allSettled([...inFlight]);
    }
    process.exit(0);
  });
}

main();
