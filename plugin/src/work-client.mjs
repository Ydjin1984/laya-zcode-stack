// work-client.mjs — отправка событий в локальную панель Laya Work.
//
// Быстрый путь — spool-файл: hook/инструмент пишет маленький JSON в каталог
// обмена и сразу продолжает работу. Никакого сетевого ожидания, поэтому
// недоступный или зависший сервер /work не добавляет задержку к хукам.
// Сервер забирает файлы и пишет их в SQLite. HTTP-приём с токеном остаётся для
// внешних клиентов и ручных проверок.
//
// Трассировка: AsyncLocalStorage хранит trace_id/session_id/tool на время
// вызова. Каждый /decide получает свой call_id; engine- и plugin-события с
// одним call_id считаются одним решением.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { maskText } from "./sanitize.mjs";
import { loadConfig } from "./config.mjs";

const als = new AsyncLocalStorage();
let callSeq = 0;
let spoolReady = false;
let dropped = 0;

function rid(prefix) {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function currentTrace() {
  return als.getStore() || null;
}

export function workEnabled(cfg) {
  const w = cfg?.work || {};
  if (w.enabled === false) return false;
  return Boolean(spoolDirFor(cfg) || w.url);
}

export function spoolDirFor(cfg) {
  const w = cfg?.work || {};
  if (w.spoolDir) return w.spoolDir;
  if (w.tokenFile) return path.join(path.dirname(w.tokenFile), "work-spool");
  if (process.env.DAVINCI_LAYA_WORK_SPOOL) return process.env.DAVINCI_LAYA_WORK_SPOOL;
  return "";
}

export function runWithWorkTrace(meta, fn) {
  const parent = currentTrace();
  const trace = {
    cfg: meta?.cfg || parent?.cfg,
    trace_id: meta?.traceId || parent?.trace_id || rid("tr"),
    session_id: meta?.sessionId || parent?.session_id || null,
    tool: meta?.tool || parent?.tool || "unknown",
    operation: meta?.operation || meta?.tool || parent?.operation || "unknown",
    tool_use_id: meta?.toolUseId || parent?.tool_use_id || null,
    batch_id: meta?.batchId || parent?.batch_id || null,
    item_id: meta?.itemId ?? parent?.item_id ?? null,
    original_redacted: meta?.originalRedacted || parent?.original_redacted || "",
    count_ms: 0,
    fit: null,
  };
  return als.run(trace, fn);
}

/** Начинает один вызов модели: call_id уходит в заголовках и в оба события. */
export function beginCall(extra = {}) {
  const t = currentTrace();
  callSeq += 1;
  return {
    trace_id: t?.trace_id || rid("tr"),
    call_id: extra.callId || `${rid("call")}_${callSeq}`,
    session_id: t?.session_id || null,
    operation: t?.operation || "decide",
    tool: t?.tool || "unknown",
    tool_use_id: t?.tool_use_id || null,
    batch_id: extra.batchId || t?.batch_id || null,
    item_id: extra.itemId ?? t?.item_id ?? null,
  };
}

/** Заголовки трассировки для /decide и /count. */
export function workHeaders(meta) {
  const h = {};
  if (!meta) return h;
  if (meta.trace_id) h["x-laya-trace-id"] = meta.trace_id;
  if (meta.call_id) h["x-laya-call-id"] = meta.call_id;
  if (meta.session_id) h["x-laya-session-id"] = meta.session_id;
  if (meta.operation) h["x-laya-operation"] = meta.operation;
  if (meta.tool) h["x-laya-tool"] = meta.tool;
  if (meta.tool_use_id) h["x-laya-tool-use-id"] = meta.tool_use_id;
  return h;
}

/** Запоминает время /count и fit в текущем trace. */
export function noteCount({ countMs, fit } = {}) {
  const t = currentTrace();
  if (!t) return;
  if (Number.isFinite(countMs)) t.count_ms = (t.count_ms || 0) + countMs;
  if (fit) t.fit = fit;
}

function ensureSpool(dir) {
  if (spoolReady) return;
  fs.mkdirSync(dir, { recursive: true });
  spoolReady = true;
}

function spoolCount(dir) {
  try {
    return fs.readdirSync(dir).filter((n) => n.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

/** Пишет событие в spool без сети. Возвращает true/false. */
export function writeSpool(event, cfg) {
  if (!workEnabled(cfg)) return false;
  const dir = spoolDirFor(cfg);
  if (!dir) return false;
  try {
    ensureSpool(dir);
    const maxFiles = Number(cfg?.work?.maxSpoolFiles) || 5000;
    if (spoolCount(dir) >= maxFiles) {
      dropped += 1;
      return false;
    }
    const name = `w-${Date.now()}-${process.pid}-${crypto.randomBytes(4).toString("hex")}.json`;
    const tmp = path.join(dir, `.${name}.tmp`);
    const final = path.join(dir, name);
    fs.writeFileSync(tmp, JSON.stringify(event), "utf8");
    fs.renameSync(tmp, final);
    return true;
  } catch {
    dropped += 1;
    return false;
  }
}

function workToken(cfg) {
  const w = cfg?.work || {};
  if (w.token) return String(w.token);
  if (process.env.DAVINCI_LAYA_WORK_TOKEN) return process.env.DAVINCI_LAYA_WORK_TOKEN;
  if (w.tokenFile) {
    try {
      return fs.readFileSync(w.tokenFile, "utf8").trim();
    } catch {
      /* токен ещё не создан */
    }
  }
  return "";
}

/** Асинхронный HTTP-fallback. Никогда не ожидается вызывающим кодом. */
export function postHTTP(event, cfg) {
  const w = cfg?.work || {};
  const url = String(w.url || cfg?.layaUrl || "");
  if (!url) return false;
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const body = Buffer.from(JSON.stringify({ events: [event] }), "utf8");
  const headers = {
    "content-type": "application/json; charset=utf-8",
    "content-length": body.length,
  };
  const token = workToken(cfg);
  if (token) headers["x-laya-work-token"] = token;
  try {
    const req = http.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 80,
        path: "/api/work/v1/ingest",
        method: "POST",
        headers,
        agent: false,
      },
      (res) => res.resume(),
    );
    req.setTimeout(Number(w.timeoutMs) || 400, () => req.destroy());
    req.on("error", () => {});
    req.end(body);
    return true;
  } catch {
    return false;
  }
}

export function emitWork(event, cfg) {
  if (!workEnabled(cfg)) return false;
  const dir = spoolDirFor(cfg);
  if (dir) return writeSpool(event, cfg);
  return postHTTP(event, cfg);
}

export function flushWork() {
  // Spool-запись синхронна: ждать нечего. HTTP-fallback намеренно не ожидается,
  // чтобы недоступный /work не задерживал hook.
  return Promise.resolve({ dropped });
}

// ---------------------------------------------------------------- builders

function mask(value, cfg) {
  return maskText(String(value ?? ""), cfg?.riskGate?.extraSecrets);
}

function optionsFor(q) {
  if (Array.isArray(q?.options)) return q.options.map(String);
  const c = q?.criteria;
  if (q?.type === "choice" && c && typeof c === "object" && !Array.isArray(c)) {
    return Object.keys(c).map((k) => (c[k] ? `${k}: ${c[k]}` : k));
  }
  if (q?.type === "score" && Array.isArray(c)) return c.map((v, i) => `${i}: ${v}`);
  if (q?.type === "noul") {
    const labels = q.labels || {};
    return [labels.false || labels[false] || "no", labels.true || labels[true] || "yes"];
  }
  return [];
}

export function questionsArray(questions) {
  const entries = Array.isArray(questions)
    ? questions.map((q, i) => [q.id || `q${i}`, q])
    : Object.entries(questions || {});
  return entries.map(([id, q]) => ({
    id,
    type: q?.type || "choice",
    instructions: String(q?.instructions || ""),
    options: optionsFor(q),
    criteria: q?.criteria,
  }));
}

function selectedOfAnswer(a) {
  if (!a) return "";
  if (a.choice !== undefined && a.choice !== null && a.choice !== "") return String(a.choice);
  if (a.score !== undefined && a.score !== null) return String(a.score);
  if (a.noul !== undefined && a.noul !== null) return String(a.noul);
  return "";
}

function selectedMap(answers, order) {
  const out = {};
  const keys = Array.isArray(order) && order.length ? order : Object.keys(answers || {});
  for (const id of keys) out[id] = selectedOfAnswer(answers?.[id]);
  return out;
}

function inputFrom(state, cfg, fit) {
  const effective = mask(state, cfg);
  const t = currentTrace();
  const original = t?.original_redacted ? mask(t.original_redacted, cfg) : effective;
  const received = Number(fit?.state_tokens ?? 0);
  const droppedTokens = Number(fit?.state_dropped ?? 0);
  return {
    original_redacted: original,
    effective_redacted: effective,
    original_chars: [...original].length,
    effective_chars: [...effective].length,
    received_tokens: received,
    processed_tokens: fit?.state_kept !== undefined ? Number(fit.state_kept) : Math.max(0, received - droppedTokens),
    dropped_tokens: droppedTokens,
    truncated: fit?.truncated_by_client === true || fit?.head_truncated === true || fit?.collapsed === true,
  };
}

function baseEvent(kind, meta, cfg, extra = {}) {
  const t = currentTrace();
  const ev = {
    schema_version: 1,
    event_id: rid("evt"),
    trace_id: meta.trace_id,
    call_id: meta.call_id,
    session_id: meta.session_id || null,
    timestamp: new Date().toISOString(),
    source: "plugin",
    kind,
    operation: meta.operation || meta.tool || "unknown",
    status: "completed",
    policy_version: "work-v1",
    demo: false,
  };
  if (meta.batch_id) ev.batch_id = meta.batch_id;
  if (meta.item_id !== null && meta.item_id !== undefined) ev.item_id = String(meta.item_id);
  if (t?.tool || meta.tool) ev.evidence = { ...(ev.evidence || {}), tool: t?.tool || meta.tool };
  return Object.assign(ev, extra);
}

/** Событие фактического вызова модели. */
export function recordModelCall({ cfg, call, state, questions, response, error, startedAt, status }) {
  cfg = cfg || call?.cfg || (currentTrace() || {}).cfg || loadConfig();
  if (!workEnabled(cfg)) return null;
  const t = currentTrace();
  const fit = response?.fit || t?.fit || null;
  const ok = Boolean(response && response.ok !== false && !error);
  const answers = response?.answers || {};
  const order = response?.order || Object.keys(answers);
  const byQuestion = selectedMap(answers, order);
  let selected = "";
  for (const id of order) {
    if (byQuestion[id]) {
      selected = byQuestion[id];
      break;
    }
  }
  const input = inputFrom(state, cfg, fit);
  const meta = call;
  const ev = baseEvent("model_call", meta, cfg, {
    model: { checkpoint: response?.checkpoint || null, device: null },
    input,
    questions: questionsArray(questions),
    model_result: ok
      ? {
          answers,
          order,
          selected,
          selected_by_question: byQuestion,
          probabilities: answers?.[order[0]]?.probabilities || [],
          answer_confidence: answers?.[order[0]]?.answer_confidence,
          budget: response?.budget || null,
          warnings: response?.warnings || [],
          elapsed_ms: response?.elapsedMs ?? null,
          score_semantics: "softmax_probability",
        }
      : { error: error?.code || "error", selected: "" },
    timing_ms: {
      count: Number(t?.count_ms) || 0,
      inference: Number(response?.elapsedMs) || 0,
      total: startedAt ? Date.now() - startedAt : 0,
    },
    status: ok ? "completed" : /timeout/i.test(String(error?.code || "")) ? "timeout" : "fallback",
    model_attempted: ok || error?.code === "inference_failed",
  });
  emitWork(ev, cfg);
  return ev;
}

/** Событие политики плагина: ask/log/block/notify/... */
export function recordPolicyEvent({
  action,
  basis = "rules",
  ruleIds = [],
  reason = "",
  layaCalled = false,
  fallback = false,
  input,
  fit,
  result,
  evidence,
  operation,
  callId,
  startedAt,
  status = "completed",
} = {}) {
  const t = currentTrace();
  const cfg = t?.cfg || loadConfig();
  if (!workEnabled(cfg)) return null;
  const meta = {
    trace_id: t?.trace_id || rid("tr"),
    call_id: callId || t?.call_id || rid("call"),
    session_id: t?.session_id || null,
    operation: operation || t?.operation || "policy",
    tool: t?.tool || "unknown",
    tool_use_id: t?.tool_use_id || null,
    batch_id: t?.batch_id || null,
    item_id: t?.item_id,
  };
  const inp = input
    ? {
        ...input,
        original_redacted: mask(input.original_redacted ?? input.original ?? "", cfg),
        effective_redacted: mask(input.effective_redacted ?? input.effective ?? "", cfg),
      }
    : inputFrom(input?.effective_redacted ?? "", cfg, fit || t?.fit);
  const ev = baseEvent("policy", meta, cfg, {
    input: inp,
    model_result: result || null,
    policy_result: {
      action: action || "log",
      basis,
      rule_ids: Array.isArray(ruleIds) ? ruleIds : [],
      reason: reason || "",
      laya_called: layaCalled,
      fallback,
      truncated: Boolean(fit?.truncated_by_client || fit?.head_truncated || fit?.collapsed),
    },
    timing_ms: {
      count: Number(t?.count_ms) || 0,
      inference: Number(result?.elapsed_ms) || 0,
      total: startedAt ? Date.now() - startedAt : 0,
    },
    status,
    evidence: evidence || undefined,
  });
  emitWork(ev, cfg);
  return ev;
}

/** Событие результата MCP-инструмента (включая savings и chunk_id). */
export function recordToolResult({ tool, result, startedAt, evidence, status = "completed", action = "tool_result", layaCalled = false } = {}) {
  const t = currentTrace();
  const cfg = t?.cfg || loadConfig();
  if (!workEnabled(cfg)) return null;
  const meta = {
    trace_id: t?.trace_id || rid("tr"),
    call_id: rid("tool"),
    session_id: t?.session_id || null,
    operation: tool || t?.operation || "tool",
    tool: tool || t?.tool || "tool",
    tool_use_id: t?.tool_use_id || null,
    batch_id: t?.batch_id || null,
    item_id: t?.item_id,
  };
  const ev = baseEvent("tool_result", meta, cfg, {
    model_result: result || null,
    policy_result: { action, basis: "tool", laya_called: layaCalled },
    timing_ms: { total: startedAt ? Date.now() - startedAt : 0 },
    status,
    evidence: evidence || undefined,
  });
  emitWork(ev, cfg);
  return ev;
}

/** Действие агента из post-tool hook; текст команды маскируется. */
export function recordAgentAction({ tool, command, exitCode, durationMs, toolUseId, error } = {}) {
  const cfg = (currentTrace() || {}).cfg || loadConfig();
  if (!workEnabled(cfg)) return null;
  const trace = currentTrace();
  const meta = {
    trace_id: toolUseId || trace?.trace_id || rid("tr"),
    call_id: toolUseId || rid("act"),
    session_id: trace?.session_id || null,
    operation: tool || "agent_action",
    tool: tool || "tool",
    tool_use_id: toolUseId || null,
  };
  const ev = baseEvent("agent_action", meta, cfg, {
    input: { effective_redacted: mask(command || "", cfg) },
    evidence: { tool, command: mask(command || "", cfg), exit_code: exitCode ?? null, duration_ms: durationMs ?? null, error: error || null },
    status: exitCode === undefined || exitCode === null || exitCode === 0 ? "completed" : "error",
  });
  emitWork(ev, cfg);
  return ev;
}

export function workStats() {
  return { dropped, spool: spoolReady };
}
