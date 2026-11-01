// LayaAdapter — единственный путь к локальному decision-engine.
//
// Контракт сервиса (фактический, проверен на живой сборке laya-engine):
//   GET  /health  → {ok, uptime_s}                    процесс жив
//   GET  /ready   → {ready}                           веса загружены
//   GET  /info    → {version, device, model, checkpoint, stats, ...}
//   POST /decide  → {version, model, checkpoint, answers{id:{...}}, order, usage, budget, elapsed_ms}
//   POST /count   → бюджеты без инференса (state_tokens, fits, questions[])
//   GET  /v1/models, POST /v1/systemone — Jev-совместимый фасад (см. server.go)
//
// Ни один путь отсюда не выдумывает ответ при сбое: любая ошибка — это
// {ok:false, error}, и вызывающий код обязан продолжить работу ZCode штатно
// (§6 ТЗ: «при таймауте/ошибке — продолжать штатную работу, не делать
// авторазрешений»).
//
// Circuit breaker — в файле, а не в памяти: каждый hook запускается отдельным
// процессом, и состояние «сервис лежит» должно переживать между вызовами, иначе
// каждый вызов будет заново ждать таймаут.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { loadConfig, paths } from "./config.mjs";

/** Ошибка уровня адаптера: код для метрик + человекочитаемый текст. */
class LayaError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/**
 * Низкоуровневый HTTP-запрос на node:http вместо fetch.
 *
 * Замерено: в свежем процессе (а хук — это всегда свежий процесс) первый fetch
 * инициализирует undici и стоит 73–92 мс против 13–14 мс у node:http. Хуки
 * запускаются на каждое событие, поэтому эти ~65 мс — самая дорогая часть
 * вызова Laya, и отказ от fetch окупается целиком.
 */
// node:https грузится лениво: его импорт тянет TLS-стек и стоит десятки
// миллисекунд в каждом процессе хука, а Laya — всегда loopback http.
let httpsModule = null;
async function loadHttps() {
  if (!httpsModule) httpsModule = (await import("node:https")).default;
  return httpsModule;
}

async function httpRequest(url, { method = "GET", body = null, timeoutMs = 2000 } = {}) {
  // Разбор URL и выбор модуля — ДО создания Promise: внутри его колбэка await
  // недоступен, а ленивая загрузка https требует await.
  let u;
  try {
    u = new URL(url);
  } catch (err) {
    throw new LayaError("unreachable", `некорректный URL: ${url}`);
  }
  const mod = u.protocol === "https:" ? await loadHttps() : http;
  const payload = body ? Buffer.from(body, "utf8") : null;
  const headers = {};
  if (payload) {
    headers["content-type"] = "application/json; charset=utf-8";
    headers["content-length"] = payload.length;
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === "https:" ? 443 : 80),
        path: (u.pathname || "/") + (u.search || ""),
        method,
        headers,
        // Один запрос на процесс хука: держать пул соединений незачем.
        agent: false,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          if (settled) return;
          settled = true;
          resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString("utf8") });
        });
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error("timeout"));
    });
    req.on("error", (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function readBreaker() {
  try {
    const raw = fs.readFileSync(paths().breaker, "utf8");
    const st = JSON.parse(raw);
    if (st && typeof st === "object") return st;
  } catch {
    /* нет файла — значит, сбоев не было */
  }
  return { failures: 0, openedAt: 0, lastError: "" };
}

function writeBreaker(st) {
  try {
    fs.mkdirSync(path.dirname(paths().breaker), { recursive: true });
    fs.writeFileSync(paths().breaker, JSON.stringify(st), "utf8");
  } catch {
    /* метрика вспомогательная: её недоступность не должна ломать гейт */
  }
}

/** Состояние предохранителя: открыт — Laya не опрашивается до cooldown. */
export function breakerState(cfg = loadConfig()) {
  const st = readBreaker();
  const { cooldownMs } = cfg.circuitBreaker;
  if (st.failures >= cfg.circuitBreaker.failures && Date.now() - st.openedAt < cooldownMs) {
    return { open: true, until: st.openedAt + cooldownMs, lastError: st.lastError || "" };
  }
  return { open: false, failures: st.failures, lastError: st.lastError || "" };
}

function noteFailure(err) {
  const st = readBreaker();
  st.failures += 1;
  st.openedAt = Date.now();
  st.lastError = String(err?.code || err?.message || err).slice(0, 200);
  writeBreaker(st);
}

function noteSuccess() {
  const st = readBreaker();
  if (st.failures !== 0 || st.openedAt !== 0) writeBreaker({ failures: 0, openedAt: 0, lastError: "" });
}

async function request(cfg, urlPath, { method = "GET", body = null, timeoutMs } = {}) {
  const url = cfg.layaUrl.replace(/\/+$/, "") + urlPath;
  const effectiveTimeout = timeoutMs ?? cfg.timeoutMs;
  try {
    const res = await httpRequest(url, {
      method,
      body: body ? JSON.stringify(body) : null,
      timeoutMs: effectiveTimeout,
    });
    let parsed = null;
    try {
      parsed = res.text ? JSON.parse(res.text) : null;
    } catch {
      throw new LayaError("bad_json", `ответ не JSON (${res.status})`);
    }
    if (res.status < 200 || res.status >= 300) {
      const code = parsed?.code || `http_${res.status}`;
      throw new LayaError(code, parsed?.error || `HTTP ${res.status}`);
    }
    return parsed;
  } catch (err) {
    if (err instanceof LayaError) throw err;
    if (/timeout/i.test(String(err?.message)) || err?.code === "ETIMEDOUT") {
      throw new LayaError("timeout", `Laya не ответила за ${effectiveTimeout} мс`);
    }
    throw new LayaError("unreachable", `Laya недоступна: ${err?.message || err}`);
  }
}

// ---------------------------------------------------------------- валидация

/** Проверяет форму ответа /decide. Схема — часть контракта: «почти ответ» = сбой. */
function validateDecide(res) {
  if (!res || typeof res !== "object") throw new LayaError("bad_schema", "пустой ответ");
  if (res.version !== 1) throw new LayaError("unsupported_schema", `версия ответа ${res.version}`);
  if (!res.answers || typeof res.answers !== "object") throw new LayaError("bad_schema", "нет answers");
  if (!Array.isArray(res.order)) throw new LayaError("bad_schema", "нет order");
  const norm = { answers: {}, order: res.order.slice(), warnings: [] };
  for (const id of res.order) {
    const a = res.answers[id];
    if (!a || typeof a !== "object") throw new LayaError("bad_schema", `нет ответа ${id}`);
    if (typeof a.answer_confidence !== "number") throw new LayaError("bad_schema", `${id}: нет answer_confidence`);
    switch (a.type) {
      case "choice":
        if (typeof a.choice !== "string") throw new LayaError("bad_schema", `${id}: нет choice`);
        break;
      case "score":
        if (typeof a.score !== "number") throw new LayaError("bad_schema", `${id}: нет score`);
        break;
      case "noul":
        if (typeof a.noul !== "number") throw new LayaError("bad_schema", `${id}: нет noul`);
        break;
      default:
        throw new LayaError("bad_schema", `${id}: тип ${a.type}`);
    }
    // Ненадёжности не прячем и не «исправляем»: клиент обязан их видеть.
    if (a.collapsed) norm.warnings.push(`${id}: варианты неразличимы после обрезки`);
    if (a.state_dropped > 0) norm.warnings.push(`${id}: состояние обрезано на ${a.state_dropped} ток.`);
    if (a.head_truncated) norm.warnings.push(`${id}: инструкция обрезана`);
    norm.answers[id] = a;
  }
  norm.model = res.model || "";
  norm.checkpoint = res.checkpoint || "";
  norm.usage = res.usage || null;
  norm.elapsedMs = typeof res.elapsed_ms === "number" ? res.elapsed_ms : null;
  norm.budget = res.budget || null;
  // «Чистота» ответа: по ней решается, доверять ли вердикту Laya в гейтах.
  norm.trustworthy = norm.warnings.length === 0;
  return norm;
}

// ------------------------------------------------------------------- API

/**
 * Ответ на типизированные вопросы. При любом сбое возвращает {ok:false} —
 * вызывающий код сам решает, что делать в отсутствие Laya (fail-open).
 */
export async function decide(state, questions, { cfg = loadConfig(), timeoutMs, maxLen } = {}) {
  const br = breakerState(cfg);
  if (br.open) {
    return { ok: false, error: { code: "circuit_open", message: `Laya в cooldown до ${new Date(br.until).toISOString()}` } };
  }
  try {
    const body = { state, questions };
    if (maxLen) body.max_len = maxLen;
    const res = await request(cfg, "/decide", { method: "POST", body, timeoutMs });
    const norm = validateDecide(res);
    noteSuccess();
    return { ok: true, ...norm };
  } catch (err) {
    noteFailure(err);
    return { ok: false, error: { code: err.code || "error", message: String(err.message || err) } };
  }
}

/** Замер бюджета без инференса: вызывается до /decide, чтобы успеть укоротить state. */
export async function count(state, questions, { cfg = loadConfig(), timeoutMs, maxLen } = {}) {
  // Тот же предохранитель, что и у /decide: иначе при лежащем сервисе каждый
  // кандидат ранжирования ждал бы полный timeout, хотя ответа всё равно не будет.
  const br = breakerState(cfg);
  if (br.open) {
    return { ok: false, error: { code: "circuit_open", message: `Laya в cooldown до ${new Date(br.until).toISOString()}` } };
  }
  try {
    const body = { state, questions };
    if (maxLen) body.max_len = maxLen;
    const res = await request(cfg, "/count", { method: "POST", body, timeoutMs });
    if (!res || typeof res.state_tokens !== "number") {
      throw new LayaError("bad_schema", "нет state_tokens");
    }
    noteSuccess();
    return { ok: true, ...res };
  } catch (err) {
    const code = err.code || "error";
    if (!["invalid_questions", "invalid_json", "bad_schema", "bad_json"].includes(code)) noteFailure(err);
    return { ok: false, error: { code, message: String(err.message || err) } };
  }
}

/** Здоровье сервиса: /health + /ready + /info одним вызовом. */
export async function health({ cfg = loadConfig(), timeoutMs } = {}) {
  const started = Date.now();
  try {
    const info = await request(cfg, "/info", { timeoutMs });
    return {
      ok: true,
      ready: info.ready === true,
      device: info.device,
      runtime: info.runtime,
      checkpoint: info.checkpoint?.sha256 ? info.checkpoint : { ...info.checkpoint, sha256: null },
      checkpointId: info.checkpoint?.file
        ? `${String(info.checkpoint.file).replace(/\.[^.]+$/, "")}-${String(info.checkpoint.sha256 || "").slice(0, 12)}`
        : null,
      maxLen: info.model?.max_len,
      headMaxLen: info.model?.head_max_len,
      version: info.version,
      stats: info.stats,
      latencyMs: Date.now() - started,
      url: cfg.layaUrl,
    };
  } catch (err) {
    return { ok: false, error: { code: err.code || "error", message: String(err.message || err) }, latencyMs: Date.now() - started, url: cfg.layaUrl };
  }
}

// -------------------------------------------- сборка вопросов (шаблоны v1)

/**
 * Версия шаблонов вопросов. Меняется при любой правке формулировок: пороги и
 * калибровки привязаны к шаблону, поэтому она обязана попадать в метрики (§9.8).
 */
export const QUESTION_SET_VERSION = "2026-10-14.1";

/** `noul` — бинарный вопрос «верно ли утверждение». */
export function noul(id, instructions, labels) {
  const q = { type: "noul", instructions };
  if (labels) q.labels = labels;
  return [id, q];
}

/** `choice` — выбор одной категории; порядок критериев = порядок вероятностей. */
export function choice(id, instructions, criteria) {
  return [id, { type: "choice", instructions, criteria }];
}

/** `score` — уровень 0..k-1; возвращает ожидаемый уровень как число. */
export function score(id, instructions, levels) {
  return [id, { type: "score", instructions, criteria: levels }];
}

/** Преобразует список пар [id, question] в объект с сохранением порядка ключей. */
export function questions(pairs) {
  const out = {};
  for (const [id, q] of pairs) out[id] = q;
  return out;
}

export { LayaError };
