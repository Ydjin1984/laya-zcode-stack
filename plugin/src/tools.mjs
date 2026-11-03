// tools.mjs — реализации MCP-инструментов.
//
// Каждый инструмент обязан деградировать без Laya: если сервис недоступен,
// возвращается детерминированная часть (или честная ошибка), но не выдуманный
// результат. Поле `degraded: true` и текст `error` — часть контракта.
//
// Общее правило экономии (§6.3 ТЗ): сначала бесплатные детерминированные фильтры
// (grep-подобный отбор, regex по логам, разбор diff), и только по УЖЕ суженному
// набору вызывается Laya. Вызывать модель на каждый файл запрещено — это дороже,
// чем прочитать файл.

import fs from "node:fs";
import path from "node:path";
import { health, choice, score, noul, questions, QUESTION_SET_VERSION } from "./laya-client.mjs";
import { decideFitted, decideManyFitted } from "./budget.mjs";
import { maskText, prepareForLaya, isSecretPath } from "./sanitize.mjs";
import { storeChunks, getChunk, pruneChunks } from "./chunk-store.mjs";
import { loadConfig } from "./config.mjs";
import { recordEvent } from "./telemetry.mjs";
import { searchFiles } from "./search.mjs";
import { runCheck } from "./run-check.mjs";
import { findProjectRoot } from "./project.mjs";
import { currentTrace, runWithWorkTrace } from "./work-client.mjs";

// ------------------------------------------------------------------ утилиты

/**
 * Laya-first: больше кандидатов ранжируется локально, но меньше текста
 * возвращается в основной контекст. Локальный инференс не расходует токены
 * главной модели, поэтому это баланс «точнее выбор, меньше выдачи».
 */
function layaFirst(cfg) {
  return cfg?.layaAll === true;
}

/** Параллельная обработка с ограничением одновременных запросов. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Токены латинских/цифровых слов и кириллицы — для бесплатного предфильтра. */
function tokens(s) {
  return new Set((String(s || "").toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) || []).slice(0, 4000));
}

/** Доля токенов запроса, встречающихся в тексте. 0..1 */
function overlap(qTokens, text) {
  if (qTokens.size === 0) return 0;
  const t = tokens(text);
  let hit = 0;
  for (const tok of qTokens) if (t.has(tok)) hit++;
  return hit / qTokens.size;
}

/** Извлекает номер строки из id вида «path:line» (формат вывода rg/grep). */
function parseLineFromId(id) {
  const m = /:(\d+)$/.exec(String(id || ""));
  return m ? Number(m[1]) : null;
}

function normAnswers(res) {  const answers = {};
  for (const id of res.order) {
    const a = res.answers[id];
    answers[id] = {
      type: a.type,
      choice: a.choice ?? null,
      score: a.type === "score" ? a.score : null,
      noul: a.type === "noul" ? a.noul : null,
      probabilities: a.probabilities || [],
      answer_confidence: a.answer_confidence,
      confidence: a.confidence,
      collapsed: a.collapsed === true,
      state_dropped: a.state_dropped || 0,
      head_truncated: a.head_truncated === true,
      temperature: a.temperature,
    };
  }
  return answers;
}

/** Нормализует вопросы из аргументов инструмента в форму /decide. */
function normalizeQuestions(input) {
  if (!input) return null;
  if (Array.isArray(input)) {
    const out = {};
    input.forEach((q, i) => {
      const id = q.id || `q${i}`;
      out[id] = { type: q.type, instructions: q.instructions, criteria: q.criteria, labels: q.labels };
    });
    return out;
  }
  if (typeof input === "object") return input;
  return null;
}

/**
 * Проверяет вопросы, пришедшие от агента (laya_decide/laya_batch), ДО запроса.
 * Живой сбой, ради которого это добавлено: score-вопрос без criteria уходил в
 * движок, движок отвечал 400 «вопрос 1: вопрос типа score без вариантов», а
 * инструмент показывал «Laya недоступна (inference_failed)» — и счётчик ошибок
 * движка рос из-за запроса, который можно было отклонить локально.
 */
function validateQuestions(qs) {
  const problems = [];
  for (const [id, q] of Object.entries(qs || {})) {
    if (!q || typeof q !== "object") {
      problems.push(`${id}: вопрос не объект`);
      continue;
    }
    if (typeof q.instructions !== "string" || !q.instructions.trim()) problems.push(`${id}: нет instructions`);
    if (q.type === "score") {
      const crit = q.criteria;
      if (!Array.isArray(crit) || crit.length < 2 || crit.some((c) => String(c ?? "").trim() === "")) {
        problems.push(`${id} (score): нужны уровни — criteria: ["низкий", "высокий", …], минимум 2`);
      }
    } else if (q.type === "choice") {
      const crit = q.criteria;
      const n = crit && typeof crit === "object" && !Array.isArray(crit) ? Object.keys(crit).length : 0;
      if (n < 2) problems.push(`${id} (choice): нужны варианты — criteria: {метка: описание}, минимум 2`);
    } else if (q.type !== "noul") {
      problems.push(`${id}: тип «${q.type}» неизвестен (choice | score | noul)`);
    }
  }
  return problems;
}

/** Человекочитаемая диагностика сбоя: не всякий сбой — «Laya недоступна». */
function layaErrorText(error) {
  const code = error?.code || "error";
  if (code === "state_too_long") return `Состояние не помещается в бюджет: ${error?.message || "нет деталей"}`;
  if (code === "question_too_long") return `Постановка вопроса не помещается: ${error?.message || "нет деталей"}`;
  const requestSide = ["invalid_questions", "invalid_json", "bad_schema", "bad_json", "unsupported_schema"];
  const where = requestSide.includes(code)
    ? "Laya отклонила запрос"
    : code === "circuit_open"
      ? "Laya в cooldown после серии сбоев"
      : "Laya недоступна или сбой";
  return `${where} (${code}): ${error?.message || "нет деталей"}`;
}

function errResult(text, extra = {}) {
  return { isError: true, content: [{ type: "text", text }], structuredContent: { ok: false, error: text, ...extra } };
}

function okResult(text, structured) {
  return { isError: false, content: [{ type: "text", text }], structuredContent: structured };
}

function summarizeDecide(res) {
  const lines = [];
  for (const id of res.order) {
    const a = res.answers[id];
    if (a.type === "choice") lines.push(`${id}: ${a.choice} (p=${a.answer_confidence})`);
    else if (a.type === "score") lines.push(`${id}: score=${a.score} (p=${a.answer_confidence})`);
    else lines.push(`${id}: ${a.noul >= 0.5 ? "да" : "нет"} (p=${a.answer_confidence})`);
  }
  return lines.join("; ");
}

// ------------------------------------------------------------------- tools

export const TOOLDEFS = [];
function tool(def) {
  TOOLDEFS.push(def);
  return def;
}

// 1 ---------------------------------------------------------------- health
tool({
  name: "laya_health",
  title: "Laya: состояние сервиса",
  description:
    "Проверяет локальный decision-engine Laya (127.0.0.1:8095): готовность, устройство, чекпоинт, статистику. Используй при старте/восстановлении связи/диагностике, а не на каждом ходе.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler() {
    const cfg = loadConfig();
    const h = await health({ cfg });
    recordEvent({ kind: "mcp_call", tool: "laya_health", source: "mcp:laya_health", action: h.ok ? "ok" : "unavailable", latencyMs: h.latencyMs, checkpoint: h.checkpointId, inferenceError: h.ok ? null : h.error?.code });
    if (!h.ok) {
      return okResult(
        `Laya недоступна (${h.url}): ${h.error.message}. Штатная работа ZCode продолжается; гейты плагина в пассивном режиме.`,
        { ok: true, available: false, url: h.url, error: h.error, latency_ms: h.latencyMs },
      );
    }
    const text = `Laya готова: device=${h.device}, checkpoint=${h.checkpointId}, max_len=${h.maxLen}, запросов=${h.stats?.requests ?? "?"}, ошибок=${h.stats?.failures ?? 0}, latency=${h.latencyMs} мс.`;
    return okResult(text, { ok: true, available: true, ...h });
  },
});

// 2 ---------------------------------------------------------------- decide
tool({
  name: "laya_decide",
  title: "Laya: типизированные решения",
  description:
    "Задаёт Laya один или несколько типизированных вопросов (choice/score/noul) о коротком состоянии. Возвращает вероятности и answer_confidence. Бюджет проверяется через /count по полной постановке вопроса; если state не помещается — инструмент вернёт ошибку с точными числами, а не молча обрежет конец.",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", description: "Короткое состояние/текст, о котором задаются вопросы (≤ ~1400 символов)." },
      questions: {
        type: "object",
        description:
          'Вопросы: {id: {type: "choice"|"score"|"noul", instructions, criteria, labels?}}. Для choice criteria — {метка: описание}; для score — [уровни]; для noul criteria не обязателен.',
        additionalProperties: true,
      },
      timeout_ms: { type: "number", description: "Таймаут запроса, по умолчанию из конфигурации (1500 мс)." },
    },
    required: ["state", "questions"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const cfg = loadConfig();
    const qs = normalizeQuestions(args.questions);
    if (!qs || Object.keys(qs).length === 0) return errResult("questions пуст: нужен хотя бы один вопрос.");
    const problems = validateQuestions(qs);
    if (problems.length) {
      return errResult(
        `Laya не вызывалась: вопросы не по контракту — ${problems.join("; ")}. Исправь questions и повтори (score требует criteria-уровни, choice — criteria-варианты).`,
        { ok: false, degraded: true, invalid_questions: problems },
      );
    }
    const started = Date.now();
    const res = await decideFitted(String(args.state ?? ""), qs, { cfg, timeoutMs: args.timeout_ms, onOverflow: "error" });
    recordEvent({
      kind: "mcp_call",
      tool: "laya_decide",
      source: "mcp:laya_decide",
      action: res.ok ? `questions:${Object.keys(qs).length}` : "error",
      latencyMs: Date.now() - started,
      inferenceError: res.ok ? null : res.error?.code || "error",
    });
    if (!res.ok) {
      return okResult(`${layaErrorText(res.error)}. Решение не получено — не выдумывай ответ.`, {
        ok: false,
        degraded: true,
        error: res.error,
      });
    }
    const answers = normAnswers(res);
    const warnings = res.warnings || [];
    const text =
      `Laya (${res.checkpoint}, ${res.elapsedMs} мс): ${summarizeDecide(res)}` +
      (warnings.length ? `\nПредупреждения: ${warnings.join("; ")}` : "") +
      (res.budget?.state_truncated ? `\nСостояние обрезано: передано ${res.budget.state_tokens} ток., потеряно до ${res.budget.state_dropped_max}. Укороти state и повтори, если факт мог оказаться за границей.` : "");
    return okResult(text, {
      ok: true,
      checkpoint: res.checkpoint,
      elapsed_ms: res.elapsedMs,
      budget: res.budget,
      warnings,
      answers,
      question_set_version: QUESTION_SET_VERSION,
    });
  },
});

// 3 -------------------------------------------------------------- classify
tool({
  name: "laya_classify",
  title: "Laya: классификация в одну категорию",
  description:
    "Быстрая классификация текста по заданным категориям. Возвращает выбранную метку, вероятности и уверенность. Категории — до ~10 коротких описаний.",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", description: "Текст/состояние для классификации." },
      instructions: { type: "string", description: "Вопрос классификации, например «К какому типу относится изменение?»." },
      labels: {
        description: 'Категории: объект {метка: описание} или массив меток. Порядок сохраняется.',
        anyOf: [{ type: "object", additionalProperties: { type: "string" } }, { type: "array", items: { type: "string" } }],
      },
      min_confidence: { type: "number", description: "Порог уверенности: ниже него результат помечается ambiguous (по умолчанию 0.6)." },
    },
    required: ["state", "labels"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const cfg = loadConfig();
    let criteria = args.labels;
    if (Array.isArray(criteria)) {
      const obj = {};
      for (const l of criteria) obj[String(l)] = null;
      criteria = obj;
    }
    if (!criteria || Object.keys(criteria).length < 2) return errResult("labels: нужно минимум две категории.");
    const instr = args.instructions || "К какой категории относится описание?";
    const started = Date.now();
    const res = await decideFitted(String(args.state ?? ""), questions([choice("label", instr, criteria)]), { cfg, onOverflow: "error" });
    recordEvent({
      kind: "mcp_call",
      tool: "laya_classify",
      source: "mcp:laya_classify",
      action: res.ok ? `labels:${Object.keys(criteria).length}` : "error",
      latencyMs: Date.now() - started,
      inferenceError: res.ok ? null : res.error?.code || "error",
    });
    if (!res.ok) {
      return okResult(`${layaErrorText(res.error)} — классификация не выполнена.`, { ok: false, degraded: true, error: res.error });
    }
    const a = res.answers.label;
    const min = typeof args.min_confidence === "number" ? args.min_confidence : 0.6;
    const ambiguous = a.answer_confidence < min || a.collapsed || a.head_truncated || (a.state_dropped || 0) > 0;
    return okResult(
      `Категория: ${a.choice} (p=${a.answer_confidence}${ambiguous ? ", НЕНАДЁЖНО" : ""}). Распределение: ${a.probabilities.map((p) => `${p.label}=${p.value}`).join(", ")}`,
      { ok: true, label: a.choice, confidence: a.answer_confidence, ambiguous, probabilities: a.probabilities, checkpoint: res.checkpoint, elapsed_ms: res.elapsedMs },
    );
  },
});

// 4 ----------------------------------------------------------------- score
tool({
  name: "laya_score",
  title: "Laya: оценка по шкале",
  description:
    "Оценивает текст по упорядоченной шкале уровней. Возвращает ожидаемый уровень (дробный) и нормированную оценку 0..1. Уровни — от низшего к высшему.",
  inputSchema: {
    type: "object",
    properties: {
      state: { type: "string", description: "Текст/состояние для оценки." },
      levels: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 12, description: "Уровни от низшего к высшему, например [«провал»,«частично»,«успех»]." },
      instructions: { type: "string", description: "Что именно оценивается." },
    },
    required: ["state", "levels"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const cfg = loadConfig();
    if (!Array.isArray(args.levels) || args.levels.length < 2) return errResult("levels: нужно ≥ 2 уровней.");
    const instr = args.instructions || "Насколько описание соответствует высокому уровню шкалы?";
    const started = Date.now();
    const res = await decideFitted(String(args.state ?? ""), questions([score("level", instr, args.levels.map(String))]), { cfg, onOverflow: "error" });
    recordEvent({
      kind: "mcp_call",
      tool: "laya_score",
      source: "mcp:laya_score",
      action: res.ok ? `levels:${args.levels.length}` : "error",
      latencyMs: Date.now() - started,
      inferenceError: res.ok ? null : res.error?.code || "error",
    });
    if (!res.ok) {
      return okResult(`${layaErrorText(res.error)} — оценка не выполнена.`, { ok: false, degraded: true, error: res.error });
    }
    const a = res.answers.level;
    const k = args.levels.length;
    const normalized = k > 1 ? Number((a.score / (k - 1)).toFixed(4)) : 0;
    return okResult(
      `Уровень: ${a.score.toFixed(2)} из ${k - 1} (нормировано ${normalized}, p=${a.answer_confidence}). Распределение: ${a.probabilities.map((p) => `${p.label}=${p.value}`).join(", ")}`,
      { ok: true, score: a.score, score_normalized: normalized, probabilities: a.probabilities, confidence: a.answer_confidence, checkpoint: res.checkpoint, elapsed_ms: res.elapsedMs },
    );
  },
});

// 5 ----------------------------------------------------------------- batch
tool({
  name: "laya_batch",
  title: "Laya: пакет решений по нескольким состояниям",
  description:
    "Прогоняет несколько независимых пар (state, questions) параллельно с ограничением одновременности. Полезно для сравнения N кандидатов одним вызовом. Суммарный бюджет: держи states короткими.",
  inputSchema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        minItems: 1,
        maxItems: 32,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            state: { type: "string" },
            questions: { type: "object", additionalProperties: true },
          },
          required: ["state", "questions"],
          additionalProperties: false,
        },
      },
      concurrency: { type: "number", description: "Одновременных запросов к Laya (1..8, по умолчанию 4)." },
    },
    required: ["items"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const cfg = loadConfig();
    const items = args.items;
    if (!Array.isArray(items) || items.length === 0) return errResult("items пуст.");
    const limit = Math.max(1, Math.min(8, args.concurrency || 4));
    const started = Date.now();
    const batchId = currentTrace()?.trace_id || null;
    const results = await mapLimit(items, limit, (it, i) =>
      runWithWorkTrace({ cfg, itemId: it.id || `item${i}`, batchId }, async () => {
        const qs = normalizeQuestions(it.questions);
        if (!qs) return { id: it.id || `item${i}`, ok: false, error: "questions пуст" };
        const problems = validateQuestions(qs);
        if (problems.length) {
          return { id: it.id || `item${i}`, ok: false, error: { code: "invalid_questions", message: problems.join("; ") } };
        }
        const res = await decideFitted(String(it.state ?? ""), qs, { cfg, onOverflow: "error" });
        if (!res.ok) return { id: it.id || `item${i}`, ok: false, error: res.error };
        return { id: it.id || `item${i}`, ok: true, checkpoint: res.checkpoint, elapsed_ms: res.elapsedMs, answers: normAnswers(res), warnings: res.warnings };
      }),
    );
    const okCount = results.filter((r) => r.ok).length;
    recordEvent({ kind: "mcp_call", tool: "laya_batch", source: "mcp:laya_batch", action: `items:${items.length}`, latencyMs: Date.now() - started });
    return okResult(`Laya batch: ${okCount}/${items.length} выполнено за ${Date.now() - started} мс.`, {
      ok: okCount > 0,
      degraded: okCount !== items.length,
      results,
    });
  },
});

// 6 ------------------------------------------------------- search_relevant
//
// Контракт вывода: top-k приходит не только порядком, но и СОДЕРЖИМЫМ —
// сниппетами и готовыми подсказками Read(offset, limit). Смысл в сокращении
// round-trip'ов: схема «ранжируй → сходи прочитай → ответь» стоит лишний вызов
// модели (~91k токенов контекста в этой среде), поэтому инструмент обязан сразу
// отдать достаточно, чтобы ответить или прочитать ОДИН нужный участок.
tool({
  name: "laya_search_relevant",
  title: "Laya: ранжирование попаданий со встроенными сниппетами",
  description:
    "Ранжирует уже найденные попадания (путь + snippet) по релевантности. Оставлен для совместимости; для нового поиска используй laya_search, который сам выполняет rg/обход и не заставляет передавать вывод в MCP. Возвращает top-k со сниппетами и подсказками Read; полные фрагменты — laya_get_chunk.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Что ищем (запрос пользователя или его ключевая часть)." },
      hits: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            path: { type: "string" },
            snippet: { type: "string", description: "Короткий фрагмент (1-10 строк), а не весь файл." },
          },
          additionalProperties: true,
        },
      },
      top_k: { type: "number", description: "Сколько верхних вернуть явно (по умолчанию 8)." },
      max_candidates: { type: "number", description: "Сколько кандидатов отдать Laya (по умолчанию 24)." },
      inline_chars: { type: "number", description: "Бюджет символов на встроенные сниппеты top-k (по умолчанию 2500)." },
    },
    required: ["query", "hits"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const cfg = loadConfig();
    const hits = args.hits || [];
    if (!hits.length) return errResult("hits пуст.");
    const qTok = tokens(args.query);
    // Бесплатный предфильтр: без пересечения слов попадание не отдаём модели.
    const scored = hits.map((h, i) => ({
      id: h.id || `hit${i}`,
      path: h.path || h.id || `hit${i}`,
      snippet: String(h.snippet || "").slice(0, 900),
      line: Number.isFinite(Number(h.line)) ? Number(h.line) : parseLineFromId(h.id),
      overlap: Math.round(overlap(qTok, `${h.path || ""} ${h.snippet || ""}`) * 100),
      index: i,
    }));
    const byOverlap = [...scored].sort((a, b) => b.overlap - a.overlap || a.index - b.index);
    const first = layaFirst(cfg);
    const maxCand = Math.max(1, Math.min(48, args.max_candidates || (first ? 32 : 24)));
    const candidates = byOverlap.filter((h) => h.overlap > 0).slice(0, maxCand);
    const stored = storeChunks(candidates.map((c) => ({ id: `search-${c.id}`, kind: "search_hit", text: c.snippet })));
    pruneChunks(cfg);
    if (candidates.length === 0) {
      return okResult(
        `Ни одно попадание не пересекается со словами запроса — вероятно, запрос сформулирован иначе. Возвращаю первые ${Math.min(scored.length, 8)} по порядку.`,
        { ok: true, degraded: true, ranked: byOverlap.slice(0, 8).map((h) => ({ id: h.id, path: h.path, relevance: null })), dropped: [] },
      );
    }
    const started = Date.now();
    const ranked = await mapLimit(candidates, 4, async (c) => {
      const state = prepareForLaya(`Запрос: ${args.query}\nФайл: ${c.path}\nФрагмент: ${c.snippet}`, 1300).text;
      const res = await decideFitted(state, questions([score("rel", "Насколько этот фрагмент может содержать ответ на запрос?", ["не относится", "слабо связан", "может содержать ответ", "прямо отвечает"])]), { cfg, onOverflow: "shrink" });
      if (!res.ok) return { ...c, relevance: null, confidence: null, error: res.error.code };
      const a = res.answers.rel;
      return { ...c, relevance: a.score, confidence: a.answer_confidence, degraded: !res.trustworthy };
    });
    const ordered = [...ranked].sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1) || b.overlap - a.overlap);
    const topK = Math.max(1, Math.min(32, args.top_k || (first ? 6 : 8)));
    const top = ordered.slice(0, topK);
    const rest = ordered.slice(topK);
    recordEvent({ kind: "mcp_call", tool: "laya_search_relevant", source: "mcp:laya_search_relevant", action: `hits:${hits.length}→cand:${candidates.length}`, latencyMs: Date.now() - started });

    // Встроенные сниппеты top-k в пределах бюджета символов: этого часто хватает
    // для ответа без чтения файлов вообще.
    const budget = Math.max(400, Math.min(8000, args.inline_chars || (first ? 2000 : 2500)));
    let spent = 0;
    const lines = [];
    const rankedOut = [];
    for (const [i, h] of top.entries()) {
      const snippet = String(h.snippet || "").replace(/\s*\n\s*/g, " ⏎ ").slice(0, 240);
      const hint = h.line ? { path: h.path, offset: Math.max(1, h.line - 5), limit: 15 } : null;
      const hintText = hint ? ` · Read(path="${hint.path}", offset=${hint.offset}, limit=${hint.limit})` : "";
      const canInline = spent + snippet.length <= budget;
      if (canInline) spent += snippet.length;
      lines.push(`${i + 1}. ${h.path}${h.line ? `:${h.line}` : ""} — релевантность ${h.relevance ?? "?"}/3 (p=${h.confidence ?? "?"}), совпадение ${h.overlap}%${hintText}` + (canInline && snippet ? `\n   > ${snippet}` : ""));
      rankedOut.push({
        id: h.id,
        path: h.path,
        line: h.line,
        relevance: h.relevance,
        confidence: h.confidence,
        overlap_percent: h.overlap,
        snippet: canInline ? snippet : null,
        read_hint: hint,
        chunk_id: `search-${h.id}`,
      });
    }
    return okResult(
      `Ранжировано ${ordered.length} попаданий (Laya, ${Date.now() - started} мс). Верхние с содержимым:\n${lines.join("\n")}` +
        `\nЕсли ответа достаточно — отвечай сразу; иначе прочитай ОДНИМ пакетом только top-1…3 по подсказкам Read выше.` +
        (rest.length ? `\nОстальные ${rest.length} — слабее; полные фрагменты сохранены (chunk id: search-…).` : ""),
      {
        ok: true,
        ranked: rankedOut,
        rest: rest.map((h) => ({ id: h.id, path: h.path, relevance: h.relevance, overlap_percent: h.overlap })),
        stored_ids: stored,
        degraded: ordered.some((h) => h.error),
      },
    );
  },
});

// 7 ----------------------------------------------------------- log_triage
//
// Контракт вывода — «готовый ответ, а не приглашение к чтению». Замерено на A/B
// (docs/AB-RESULTS.md): когда инструмент отдавал 42 блока с 30 дубликатами одних
// и тех же ошибок, агент шёл дочитывать каждый — 19 вызовов модели вместо 5, и
// вся экономия контекста съедалась round-trip'ами. Поэтому здесь:
//   1) уникальные ошибки группируются по подписи (пути/числа нормализуются),
//      дубликаты сворачиваются в счётчик «×N»;
//   2) у каждой группы — готовая подсказка Read(offset, limit) и id чанка;
//   3) Laya опрашивается только по УНИКАЛЬНЫМ неоднозначным блокам.
/** Нормализует строку-доказательство в подпись: пути и числа → плейсхолдеры. */
function errorSignature(evidence) {
  return String(evidence || "")
    .toLowerCase()
    .replace(/[a-zа-я]?:?[\\/][^\s:"']+/gi, "<p>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Подсказка для Read из id блока вида «L151-200» (1-based строки). */
function readHintFromId(id, pad = 5) {
  const m = /^L(\d+)-(\d+)$/.exec(String(id));
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  const offset = Math.max(1, start - pad);
  return { offset, limit: end - start + 1 + pad * 2 };
}

tool({
  name: "laya_log_triage",
  title: "Laya: триаж логов (уникальные ошибки с готовыми подсказками)",
  description:
    "Делит лог/вывод на важное и второстепенное. Возвращает УЖЕ СГРУППИРОВАННЫЙ список уникальных ошибок (повторы сворачиваются в «×N») с подсказками Read(offset, limit) и id сохранённых блоков. Сначала бесплатные regex-признаки, затем Laya оценивает важность неоднозначных блоков. ВАЖНО: повторных чтений для перечисления ошибок не требуется — список исчерпывающий; читай файл только если нужен контекст вокруг конкретного места (одним пакетом).",
  inputSchema: {
    type: "object",
    properties: {
      chunks: {
        type: "array",
        minItems: 1,
        maxItems: 128,
        items: {
          type: "object",
          properties: { id: { type: "string" }, text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      },
      focus: { type: "string", description: "На что обращать внимание (например «ошибки сборки»)." },
      max_laya: { type: "number", description: "Сколько неоднозначных блоков отдать Laya (по умолчанию 12)." },
      max_listed: { type: "number", description: "Сколько уникальных ошибок перечислить в ответе (по умолчанию 8)." },
    },
    required: ["chunks"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const cfg = loadConfig();
    const chunks = args.chunks || [];
    if (!chunks.length) return errResult("chunks пуст.");
    const SIGNALS = [
      // \w*Error ловит TypeError/ValueError/ReferenceError/SyntaxError: без этого
      // «TypeError: …» проходил мимо детерминированного слоя (проверено на
      // experiments/log-700.txt) и находился только моделью — то есть терялся бы
      // при выключенной Laya.
      { re: /(\b\w*Error\b|\bExceptions?\b|Traceback|\bfatal\b|\bpanic\b|\berror\b|\bfailed\b|\bfailure\b|\bdenied\b|\brefused\b|\btimeout\b|\btimed out\b)/i, w: 3, name: "ошибка" },
      { re: /(exit\s*(code|status)[:=]?\s*[1-9]\d*|process exited with \d+|command failed)/i, w: 4, name: "ненулевой код возврата" },
      { re: /(at\s+[\w.$]+\([\w./\\:-]+:\d+\)|File "[^"]+", line \d+|^\s+at\s+)/m, w: 2, name: "стек-трейс" },
      { re: /(E\d{3,4}|ERR_[A-Z_]+|ENOENT|EACCES|ECONNREFUSED|MODULE_NOT_FOUND)/, w: 3, name: "код ошибки" },
      { re: /(warning|deprecated|WARN)\b/i, w: 1, name: "предупреждение" },
    ];
    // Маркеры успеха: строка не может быть «ошибкой», даже если содержит слово
    // error — «[ok] неизвестный инструмент → isError-результат» — это описание
    // ПРОЙДЕННОЙ проверки, а «провалено 0» — агрегат. Без фильтра триаж выдавал
    // ложную «уникальную ошибку» (проверено на выводе tests/run-all.mjs).
    const PASS_LINE_RE = /^\s*(\[ok\]|ok([:\s]|$)|✓|✔|PASS\b)|\bпровалено\s*[:=]?\s*0\b|\bfailures?[:=]\s*0\b/i;
    const triaged = chunks.map((c, i) => {
      const text = String(c.text || "");
      const scanText = text
        .split(/\r?\n/)
        .filter((l) => !PASS_LINE_RE.test(l))
        .join("\n");
      const hits = SIGNALS.filter((s) => s.re.test(scanText));
      const weight = hits.reduce((s, h) => s + h.w, 0);
      // Доказательство — строка самого ВЕСОМОГО сигнала, а не первая попавшаяся:
      // в блоке с 40 DeprecationWarning и одной реальной ошибкой первой совпадает
      // именно предупреждение, и evidence вводил бы в заблуждение. Внутри сигнала
      // предпочитаем строку с конкретным именем ошибки («ValueError: boom»), а не
      // заголовок «Traceback (most recent call last):».
      let evidence = "";
      for (const sig of [...hits].sort((a, b) => b.w - a.w)) {
        const candidates = scanText.split(/\r?\n/).filter((l) => sig.re.test(l));
        if (candidates.length) {
          evidence = candidates.find((l) => /\b\w*(Error|Exception)\b/.test(l)) || candidates[0];
          break;
        }
      }
      const evidenceTrim = evidence.trim();
      // Кадры стека собираются из ВСЕГО блока, а не только после строки-evidence:
      // нужный file:line часто лежит за 2–5 строк (или в соседнем блоке того же
      // вхождения, см. слияние ниже). Именно так «scripts/prepare-config.mjs:12:18»
      // терялся, и агенту приходилось дочитывать блок — а каждое такое чтение
      // стоит round-trip (замерено: ~93k токенов контекста).
      const stack = scanText
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter((l) => l && /(at\s+[\w.$@]+[\s(]|\bFile "|:\d+:\d+\)|^\s*at\s)/.test(l))
        .slice(0, 3)
        .map((l) => l.slice(0, 140));
      return {
        id: c.id || `chunk${i}`,
        text,
        weight,
        signals: hits.map((h) => h.name),
        evidence: evidenceTrim.slice(0, 160),
        stack,
        // Итоговые строки раннеров («Test Suites: 1 failed…», «Build failed with…»,
        // «Time: 38 s») — агрегаты, а не ошибки: в списке уникальных ошибок им не
        // место, иначе «перечисли ошибки» получает лишние пункты. Их выводим
        // отдельной строкой «Итог:», чтобы ничего не потерять.
        summary: /^(test suites|tests?[:\s]|snapshots?[:\s]|time[:\s]|build (failed|succeeded))/i.test(evidenceTrim),
        index: i,
      };
    });
    const essential = triaged.filter((t) => t.weight >= 3).sort((a, b) => b.weight - a.weight);
    const essentialErrors = essential.filter((t) => !t.summary);
    const essentialSummaries = essential.filter((t) => t.summary);

    // Группировка уникального: 30 вхождений одной ошибки — это ОДНА ошибка с ×30,
    // а не 30 приглашений сходить в файл.
    const groupOf = (t) => {
      const signature = errorSignature(t.evidence || t.text);
      return signature || `block-${t.id}`;
    };
    const groups = new Map();
    for (const t of essentialErrors) {
      const key = groupOf(t);
      const g = groups.get(key);
      if (g) {
        g.count += 1;
        g.ids.push(t.id);
        // Стек вхождений объединяем: кадр с нужным file:line часто лежит в
        // СОСЕДНЕМ блоке того же вхождения (ошибка на границе чанков).
        for (const line of t.stack || []) {
          if (g.stack.length < 4 && !g.stack.includes(line)) g.stack.push(line);
        }
        if (t.weight > g.weight) {
          g.weight = t.weight;
          g.evidence = t.evidence;
        }
      } else {
        groups.set(key, { signature: key, count: 1, ids: [t.id], evidence: t.evidence, stack: t.stack || [], signals: t.signals, weight: t.weight });
      }
    }
    // Кадры из СМЕЖНЫХ блоков: ошибка на границе чанков часто оставляет
    // `at ... (file:line)` в соседнем блоке (в нашем логе — «at async loadConfig
    // (scripts/prepare-config.mjs:12:18)» сразу после ENOENT). Без этого агент
    // дочитывал блок, чтобы назвать место падения.
    const blockSpan = (id) => {
      const m = /^L(\d+)-(\d+)$/.exec(String(id));
      return m ? [Number(m[1]), Number(m[2])] : null;
    };
    for (const g of groups.values()) {
      const spans = g.ids.map(blockSpan).filter(Boolean);
      for (const t of triaged) {
        if ((t.stack || []).length === 0) continue;
        const sp = blockSpan(t.id);
        if (!sp) continue;
        const adjacent = spans.some(([a, b]) => sp[0] === b + 1 || sp[1] === a - 1);
        if (!adjacent) continue;
        for (const line of t.stack) {
          if (g.stack.length < 4 && !g.stack.includes(line)) g.stack.push(line);
        }
      }
    }
    const unique = [...groups.values()].sort((a, b) => b.weight - a.weight || b.count - a.count);

    // Итоговые строки — отдельным коротким списком (их места в перечне ошибок нет).
    const summaryMap = new Map();
    for (const t of essentialSummaries) {
      const key = groupOf(t);
      if (!summaryMap.has(key)) summaryMap.set(key, t.evidence);
    }
    const summaries = [...summaryMap.values()].slice(0, 3);

    // Laya — только по уникальным неоднозначным блокам (дедупликация экономит и
    // вызовы модели, и время инструмента).
    const ambiguousAll = triaged.filter((t) => t.weight > 0 && t.weight < 3).concat(triaged.filter((t) => t.weight === 0));
    const seenAmbiguous = new Set();
    const ambiguous = [];
    for (const t of ambiguousAll) {
      const key = groupOf(t);
      if (seenAmbiguous.has(key)) continue;
      seenAmbiguous.add(key);
      ambiguous.push(t);
      if (ambiguous.length >= Math.max(1, Math.min(32, args.max_laya || 12))) break;
    }
    storeChunks(triaged.map((t) => ({ id: `log-${t.id}`, kind: "log_chunk", text: t.text })));
    pruneChunks(cfg);
    let degraded = false;
    let rankedAmbiguous = ambiguous.map((t) => ({ id: t.id, importance: null, confidence: null, index: t.index }));
    if (ambiguous.length > 0) {
      const started = Date.now();
      rankedAmbiguous = await mapLimit(ambiguous, 4, async (t) => {
        const state = prepareForLaya(`Фокус: ${args.focus || "важные ошибки и причины сбоев"}\nБлок вывода:\n${t.text}`, 1300).text;
        const res = await decideFitted(state, questions([noul("important", "Содержит ли этот блок вывода информацию, важную для диагностики результата (ошибку, причину, влияние)?")]), { cfg, onOverflow: "shrink" });
        if (!res.ok) {
          degraded = true;
          return { id: t.id, importance: null, confidence: null, index: t.index, error: res.error.code };
        }
        const a = res.answers.important;
        return { id: t.id, importance: a.noul, confidence: a.answer_confidence, index: t.index };
      });
      recordEvent({ kind: "mcp_call", tool: "laya_log_triage", source: "mcp:laya_log_triage", action: `chunks:${chunks.length}→unique:${ambiguous.length}`, latencyMs: Date.now() - started });
      rankedAmbiguous.sort((a, b) => (b.importance ?? -1) - (a.importance ?? -1) || a.index - b.index);
    }
    const important = rankedAmbiguous.filter((r) => (r.importance ?? 0) >= 0.5);
    const totalHits = unique.reduce((s, g) => s + g.count, 0);
    const maxListed = Math.max(1, Math.min(32, args.max_listed || 8));
    const listed = unique.slice(0, maxListed);
    const uniqueOut = unique.map((g) => {
      const hint = readHintFromId(g.ids[0]);
      return {
        signature: g.signature,
        count: g.count,
        evidence: g.evidence,
        stack: g.stack || [],
        signals: g.signals,
        block_id: `log-${g.ids[0]}`,
        all_block_ids: g.ids.map((i) => `log-${i}`),
        read_hint: hint,
      };
    });
    const lines = listed.map((g, i) => {
      const hint = readHintFromId(g.ids[0]);
      const where = hint ? ` · Read(offset=${hint.offset}, limit=${hint.limit})` : "";
      const stackText = (g.stack || []).slice(0, 2).map((l) => `
     ↳ ${l}`).join("");
      return `${i + 1}. ${g.count > 1 ? `×${g.count}  ` : ""}${g.evidence}  [log-${g.ids[0]}${where}]${stackText}`;
    });
    const text =
      `Уникальных ошибок: ${unique.length}` +
      (totalHits !== unique.length ? ` (вхождений: ${totalHits})` : "") +
      `, блоков обработано: ${triaged.length}.\n` +
      (lines.length ? lines.join("\n") : "(детерминированных ошибок не найдено)") +
      (unique.length > listed.length ? `\n… ещё ${unique.length - listed.length} уникальных (см. structuredContent.unique).` : "") +
      (summaries.length ? `\nИтог: ${summaries.join(" · ")}` : "") +
      `\nСписок исчерпывающий: для перечисления ошибок повторные чтения не нужны.` +
      (important.length ? `\nLaya: важность подтверждена ещё для ${important.length} блоков без ошибок (${important.map((r) => r.id).join(", ")}).` : "") +
      `\nДетали при необходимости: laya_get_chunk("log-…") или Read по подсказке выше.`;
    return okResult(text, {
      ok: true,
      degraded,
      unique: uniqueOut,
      summaries,
      truncated_listing: unique.length > listed.length,
      // Совместимость: полный список блоков с признаками ошибок (как раньше).
      essential: essential.map((e) => ({ id: e.id, signals: e.signals, evidence: e.evidence, chunk_id: `log-${e.id}` })),
      laya_important: important.map((r) => ({ id: r.id, importance: r.importance, confidence: r.confidence })),
      others: rankedAmbiguous.filter((r) => !important.includes(r)),
      stored: triaged.map((t) => `log-${t.id}`),
    });
  },
});

// 8 --------------------------------------------------------- context_pick
tool({
  name: "laya_context_pick",
  title: "Laya: отбор артефактов keep/archive/fetch_on_demand",
  description:
    "Решает, что держать в контексте (keep), что вынести в хранилище (archive) и что дочитать при необходимости (fetch_on_demand). Pinned-артефакты (требования пользователя, ошибки, принятые решения, доказательства тестов) всегда остаются. Ничего не удаляется: архив доступен через laya_get_chunk.",
  inputSchema: {
    type: "object",
    properties: {
      artifacts: {
        type: "array",
        minItems: 1,
        maxItems: 64,
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            kind: {
              type: "string",
              description: "user_requirement | error | test_evidence | decision | path | code | log | dump | other",
            },
            text: { type: "string" },
            pinned: { type: "boolean" },
          },
          required: ["text"],
          additionalProperties: false,
        },
      },
    },
    required: ["artifacts"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const cfg = loadConfig();
    const arts = args.artifacts || [];
    if (!arts.length) return errResult("artifacts пуст.");
    // Pinned и «дорогие по смыслу» виды остаются безусловно (§9.6 ТЗ).
    const PINNED_KINDS = new Set(["user_requirement", "error", "test_evidence", "decision", "path"]);
    const store = [];
    const keep = [];
    const archive = [];
    const fetchOnDemand = [];
    const ambiguous = [];
    for (const [i, a] of arts.entries()) {
      const id = a.id || `art${i}`;
      const kind = a.kind || "other";
      const text = String(a.text || "");
      store.push({ id: `ctx-${id}`, kind: `ctx:${kind}`, text });
      if (a.pinned === true || PINNED_KINDS.has(kind)) {
        keep.push({ id, kind, reason: a.pinned ? "pinned" : `вид «${kind}» обязателен` });
      } else if (kind === "dump" || kind === "log" || text.length > 6000) {
        archive.push({ id, kind, reason: "объёмный вспомогательный блок" });
      } else {
        ambiguous.push({ id, kind, text, index: i });
      }
    }
    storeChunks(store);
    pruneChunks(cfg);
    let degraded = false;
    if (ambiguous.length) {
      const ranked = await mapLimit(ambiguous, 4, async (a) => {
        const state = prepareForLaya(`Кандидат (${a.kind}): ${a.text}`, 1200).text;
        const res = await decideFitted(state, questions([
          choice("decision", "Нужен ли этот блок для продолжения текущей работы прямо сейчас?", {
            keep: "Нужен сейчас",
            archive: "Может понадобиться позже, сейчас нет",
            fetch_on_demand: "Достаточно знать, что он есть; содержимое не нужно",
          }),
        ]), { cfg, onOverflow: "shrink" });
        if (!res.ok) {
          degraded = true;
          return { ...a, decision: "fetch_on_demand", confidence: null, error: res.error.code };
        }
        return { ...a, decision: res.answers.decision.choice, confidence: res.answers.decision.answer_confidence };
      });
      for (const r of ranked) {
        const item = { id: r.id, kind: r.kind, reason: r.error ? "Laya недоступна — консервативно" : `Laya p=${r.confidence}` };
        if (r.decision === "keep") keep.push(item);
        else if (r.decision === "archive") archive.push(item);
        else fetchOnDemand.push(item);
      }
    }
    const lines = [
      `keep: ${keep.length} (${keep.map((k) => k.id).join(", ") || "—"})`,
      `archive: ${archive.length} (${archive.map((k) => k.id).join(", ") || "—"}) — доступно через laya_get_chunk id ctx-…`,
      `fetch_on_demand: ${fetchOnDemand.length} (${fetchOnDemand.map((k) => k.id).join(", ") || "—"})`,
    ];
    return okResult(`Laya context_pick:\n${lines.join("\n")}`, {
      ok: true,
      degraded,
      keep,
      archive,
      fetch_on_demand: fetchOnDemand,
      stored: store.map((s) => s.id),
    });
  },
});

// 9 ------------------------------------------------------------- get_chunk
tool({
  name: "laya_get_chunk",
  title: "Laya: вернуть сохранённый фрагмент",
  description:
    "Достаёт сохранённый фрагмент постранично: по умолчанию ограниченная выдача с offset/limit и признаком продолжения (has_more/next_offset). full=true явно возвращает весь текст. Полный источник всегда остаётся на диске.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "Идентификатор фрагмента." },
      offset: { type: "number", description: "С какого символа начать (0-based, по умолчанию 0)." },
      limit: { type: "number", description: "Сколько символов вернуть (по умолчанию 4000, максимум 50000)." },
      full: { type: "boolean", description: "Явно вернуть весь фрагмент (игнорирует offset/limit)." },
    },
    required: ["id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const r = getChunk(String(args.id || ""));
    if (!r.ok) return errResult(r.error);
    const total = r.text.length;
    if (args.full === true) {
      return okResult(r.text, {
        ok: true,
        id: r.id,
        bytes: r.bytes,
        total_chars: total,
        returned_chars: total,
        offset: 0,
        limit: total,
        has_more: false,
        next_offset: null,
        full: true,
      });
    }
    const offset = Math.max(0, Math.min(total, Number(args.offset) || 0));
    const limit = Math.max(1, Math.min(50_000, Number(args.limit) || 4000));
    if (offset >= total) {
      return okResult(
        `chunk ${r.id}: offset ${offset} за пределами (всего ${total} симв.). Используй offset=0 или full=true.`,
        { ok: true, id: r.id, bytes: r.bytes, total_chars: total, returned_chars: 0, offset, limit, has_more: false, next_offset: null, full: false },
      );
    }
    const end = Math.min(total, offset + limit);
    const slice = r.text.slice(offset, end);
    const hasMore = end < total;
    const text = hasMore
      ? `chunk ${r.id}: символы ${offset}-${end} из ${total}.\n${slice}\n… продолжение: offset=${end}, limit=${limit}; full=true — весь фрагмент …`
      : slice;
    return okResult(text, {
      ok: true,
      id: r.id,
      bytes: r.bytes,
      total_chars: total,
      returned_chars: end - offset,
      offset,
      limit,
      has_more: hasMore,
      next_offset: hasMore ? end : null,
      full: false,
    });
  },
});

// 10 ------------------------------------------------------------ rank_diff
tool({
  name: "laya_rank_diff",
  title: "Laya: ранжирование ханков diff",
  description:
    "Разбирает unified diff на ханки и ранжирует их: тип изменения и нужность внимания. Это НЕ code review и НЕ security-аудит: Laya только упорядочивает внимание, решение остаётся за моделью/пользователем.",
  inputSchema: {
    type: "object",
    properties: {
      diff: { type: "string", description: "Вывод git diff / git show (unified)." },
      top_k: { type: "number", description: "Сколько верхних ханков выделить (по умолчанию 10)." },
      max_hunks: { type: "number", description: "Ограничение на число ханков к Laya (по умолчанию 24)." },
    },
    required: ["diff"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const cfg = loadConfig();
    const diff = String(args.diff || "");
    if (!diff.trim()) return errResult("diff пуст.");
    // Разбор unified diff: ханки начинаются с @@, файл — из предыдущей строки diff --git.
    const lines = diff.split(/\r?\n/);
    const hunks = [];
    let file = "";
    let cur = null;
    for (const line of lines) {
      if (line.startsWith("diff --git")) {
        const m = line.match(/b\/(.+)$/);
        file = m ? m[1] : file;
        continue;
      }
      if (line.startsWith("@@")) {
        if (cur) hunks.push(cur);
        cur = { file, header: line, body: [] };
        continue;
      }
      if (cur) cur.body.push(line);
    }
    if (cur) hunks.push(cur);
    if (hunks.length === 0) return okResult("В diff не найдено ханков (@@).", { ok: true, hunks: [] });
    const maxHunks = Math.max(1, Math.min(64, args.max_hunks || 24));
    const selected = hunks.slice(0, maxHunks);
    const started = Date.now();
    const ranked = await mapLimit(selected, 4, async (h, i) => {
      const changed = h.body.filter((l) => /^[+-]/.test(l) && !/^[+-]{3}/.test(l));
      const added = changed.filter((l) => l.startsWith("+")).length;
      const removed = changed.filter((l) => l.startsWith("-")).length;
      const text = h.body.join("\n").slice(0, 900);
      const state = prepareForLaya(`Файл: ${h.file}\nХанк: ${h.header}\nИзменения (+${added}/-${removed}):\n${text}`, 1300).text;
      const res = await decideFitted(state, questions([
        choice("kind", "Что за изменение в этом ханке?", {
          logic: "логика или поведение кода",
          test: "тесты",
          docs: "документация и комментарии",
          config: "конфигурация, сборка, зависимости",
          data: "данные, схемы, миграции",
          style: "форматирование и переименования без смены поведения",
        }),
        noul("attention", "Требует ли это изменение повышенного внимания (рискованный участок, неочевидное поведение, безопасность)?"),
      ]), { cfg, onOverflow: "shrink" });
      if (!res.ok) {
        // Без Laya — эвристика: больше изменённых строк = выше внимание.
        const heuristic = Math.min(1, (added + removed) / 40);
        return { index: i, file: h.file, header: h.header, added, removed, kind: null, kind_confidence: null, attention: heuristic, attention_confidence: null, degraded: true };
      }
      const kindA = res.answers.kind;
      const attA = res.answers.attention;
      return {
        index: i,
        file: h.file,
        header: h.header,
        added,
        removed,
        kind: kindA.choice,
        kind_confidence: kindA.answer_confidence,
        attention: attA.noul,
        attention_confidence: attA.answer_confidence,
        degraded: !res.trustworthy,
      };
    });
    const ordered = [...ranked].sort((a, b) => (b.attention ?? 0) - (a.attention ?? 0) || b.added + b.removed - (a.added + a.removed));
    const topK = Math.max(1, Math.min(32, args.top_k || 10));
    const byKind = {};
    for (const h of ranked) byKind[h.kind || "unknown"] = (byKind[h.kind || "unknown"] || 0) + 1;
    recordEvent({ kind: "mcp_call", tool: "laya_rank_diff", source: "mcp:laya_rank_diff", action: `hunks:${hunks.length}`, latencyMs: Date.now() - started });
    const topLines = ordered.slice(0, topK).map((h, i) => `${i + 1}. ${h.file} ${h.header} — ${h.kind || "?"} (внимание ${h.attention === null ? "?" : (h.attention * 100).toFixed(0) + "%"}, +${h.added}/-${h.removed})`);
    return okResult(
      `Laya rank_diff: ${hunks.length} ханков, типы: ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(", ")}.\nВерхние по вниманию:\n${topLines.join("\n")}\n(Это ранжирование, не review: окончательное суждение — за моделью.)`,
      { ok: true, degraded: ranked.some((h) => h.degraded), hunks_total: hunks.length, by_kind: byKind, hunks: ordered },
    );
  },
});

// 11 ---------------------------------------------------------- laya_search
//
// Сам выполняет поиск (rg/Node), дедуплицирует, затем отдаёт Laya только
// короткие кандидаты. Агенту не нужно передавать MCP текст, который MCP может
// получить сам; полный результат всегда доступен по chunk_id.
tool({
  name: "laya_search",
  title: "Laya: поиск по проекту с ранжированием и выдержками",
  description:
    "Сам выполняет поиск по root (rg, при отсутствии — обход файлов), детерминированно убирает дубли и ранжирует короткие фрагменты через Laya. Возвращает выдержки с путями и строками; полный результат сохранён в chunk (laya_get_chunk). Используй для широкого поиска вместо ручного rg + передачи всего вывода модели.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Что искать (литерал или regex; при ошибке regex поиск повторится буквально)." },
      root: { type: "string", description: "Каталог поиска. По умолчанию корень проекта/текущий каталог." },
      budget: { type: "number", description: "Бюджет символов на выдержки в ответе (по умолчанию 6000)." },
      top_k: { type: "number", description: "Сколько результатов показать с выдержками (по умолчанию 8)." },
      max_candidates: { type: "number", description: "Сколько кандидатов отдать Laya (по умолчанию 24)." },
      context: { type: "number", description: "Строк контекста вокруг совпадения (по умолчанию 2)." },
      timeout_ms: { type: "number", description: "Таймаут поиска, мс (по умолчанию 15000)." },
      case_sensitive: { type: "boolean", description: "Учитывать регистр (по умолчанию нет)." },
      fixed: { type: "boolean", description: "Искать как литерал, а не regex." },
    },
    required: ["query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const cfg = loadConfig();
    const query = String(args.query || "").trim();
    if (!query) return errResult("query пуст.");
    const root = path.resolve(args.root || process.env.DAVINCI_LAYA_PROJECT_DIR || process.cwd());
    const first = layaFirst(cfg);
    const budget = Math.max(800, Math.min(30_000, Number(args.budget) || (first ? 4500 : 6000)));
    const topK = Math.max(1, Math.min(20, Number(args.top_k) || (first ? 5 : 8)));
    const maxCand = Math.max(1, Math.min(48, Number(args.max_candidates) || (first ? 32 : 24)));
    const started = Date.now();

    let found;
    try {
      found = await searchFiles(query, root, {
        context: Number(args.context) || cfg.search?.contextLines || 2,
        maxHits: cfg.search?.maxHits || 200,
        timeoutMs: Number(args.timeout_ms) || cfg.search?.timeoutMs || 15000,
        caseSensitive: args.case_sensitive === true,
        fixed: args.fixed === true,
      });
    } catch (err) {
      return errResult(`Поиск не выполнен: ${err.message}`);
    }
    if (!found.hits.length) {
      return okResult(
        `Поиск «${query}» в ${root}: совпадений нет (${found.engine}, ${found.stats.duration_ms} мс).`,
        { ok: true, query, root, engine: found.engine, results: [], stats: { ...found.stats, returned: 0 }, chunk_id: null, warnings: found.warnings },
      );
    }

    const qTokens = tokens(query);
    const scored = found.hits.map((h, i) => ({
      ...h,
      overlap: Math.round(overlap(qTokens, `${h.path} ${h.snippet}`) * 100),
      index: i,
    }));
    const byOverlap = [...scored].sort((a, b) => b.overlap - a.overlap || a.index - b.index);
    const candidates = byOverlap.slice(0, maxCand);

    // Базовый id для восстановления: один chunk со всеми найденными хитами и
    // по одному chunk на кандидата (полный сниппет без бюджетной обрезки).
    const base = `search-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    const allId = `${base}-all`;
    const chunkIds = candidates.map((c) => `${base}-hit-${c.index}`);
    storeChunks([
      { id: allId, kind: "search_full", text: JSON.stringify({ query, root, engine: found.engine, stats: found.stats, hits: found.hits }, null, 2) },
      ...candidates.map((c, i) => ({ id: chunkIds[i], kind: "search_hit", text: c.snippet })),
    ]);
    pruneChunks(cfg);

    const qset = questions([
      score("rel", "Насколько этот фрагмент может содержать ответ на запрос? (Учитывай путь, строки и совпадения.)", [
        "не относится",
        "слабо связан",
        "может содержать ответ",
        "прямо отвечает",
      ]),
    ]);
    const states = candidates.map((c) => ({
      state: prepareForLaya(`Запрос: ${query}\nФайл: ${c.path}:${c.line}\nФрагмент:\n${String(c.snippet).slice(0, 900)}`, 1300).text,
    }));
    const rankStarted = Date.now();
    const ranked = await decideManyFitted(states, qset, { cfg, onOverflow: "shrink", concurrency: 4 });
    const rankMs = Date.now() - rankStarted;
    let degraded = false;
    const ordered = candidates
      .map((c, i) => {
        const res = ranked[i];
        if (!res || !res.ok) {
          degraded = true;
          return { ...c, relevance: null, confidence: null, error: res?.error?.code || "error", chunk_id: chunkIds[i] };
        }
        const a = res.answers?.rel;
        return {
          ...c,
          relevance: a?.score ?? null,
          confidence: a?.answer_confidence ?? null,
          chunk_id: chunkIds[i],
          degraded: !res.trustworthy,
        };
      })
      .sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1) || b.overlap - a.overlap || a.index - b.index);

    const top = ordered.slice(0, topK);
    const perExcerpt = Math.max(220, Math.floor((budget - 600) / Math.max(1, top.length)));
    let spent = 0;
    const lines = [];
    const results = [];
    for (const [i, h] of top.entries()) {
      const remaining = budget - spent;
      let excerpt = String(h.snippet || "");
      let cut = null;
      if (remaining <= 120) {
        cut = "выдержка не показана: бюджет ответа исчерпан; полный фрагмент в chunk";
        excerpt = "";
      } else if (excerpt.length > Math.min(perExcerpt, remaining)) {
        const keep = Math.max(120, Math.min(perExcerpt, remaining));
        excerpt = excerpt.slice(0, keep);
        cut = `фрагмент сокращён; полный сниппет: chunk ${h.chunk_id}`;
      }
      spent += excerpt.length;
      lines.push(
        `${i + 1}. ${h.path}:${h.line}${h.end_line && h.end_line !== h.line ? `-${h.end_line}` : ""} — релевантность ${h.relevance === null || h.relevance === undefined ? "?" : Number(h.relevance).toFixed(2)}/3` +
          `${h.confidence !== null ? ` (p=${h.confidence})` : ""}, совпадение ${h.overlap}%` +
          `${h.error ? ` · degraded: ${h.error}` : ""}\n   [chunk ${h.chunk_id}]` +
          (excerpt ? `\n${indent(excerpt, "   ")}` : "") +
          (cut ? `\n   … ${cut} …` : ""),
      );
      results.push({
        path: h.path,
        line: h.line,
        end_line: h.end_line,
        relevance: h.relevance,
        confidence: h.confidence,
        overlap_percent: h.overlap,
        excerpt: excerpt || null,
        truncated: Boolean(cut),
        chunk_id: h.chunk_id,
        match_lines: h.match_lines,
      });
    }
    const totalMs = Date.now() - started;
    const sourceBytes = found.hits.reduce((n, h) => n + String(h.snippet || "").length, 0);
    const returnedBytes = results.reduce((n, r) => n + String(r.excerpt || "").length, 0);
    recordEvent({
      kind: "mcp_call",
      tool: "laya_search",
      source: "mcp:laya_search",
      action: `hits:${found.hits.length}→returned:${top.length}`,
      latencyMs: totalMs,
      elapsedMs: rankMs,
      extra: { search_ms: found.stats.duration_ms, rank_ms: rankMs, candidates: candidates.length, engine: found.engine, degraded },
    });
    const header =
      `Поиск «${query}» в ${root}: ${found.hits.length} совпадений (${found.engine}, ${found.stats.duration_ms} мс). ` +
      `Laya ранжировала ${candidates.length} кандидатов за ${rankMs} мс.`;
    const footer =
      `\nПолный результат (все ${found.hits.length} совпадений): laya_get_chunk("${allId}"). ` +
      `Если ответа достаточно — отвечай; для правки дочитай нужную реализацию (laya_read_relevant или Read) — выдержка не заменяет исходник.`;
    return okResult(`${header}\n${lines.join("\n")}${footer}`, {
      ok: true,
      query,
      root,
      engine: found.engine,
      results,
      stats: {
        hits: found.hits.length,
        candidates: candidates.length,
        returned: top.length,
        search_ms: found.stats.duration_ms,
        rank_ms: rankMs,
        total_ms: totalMs,
        degraded,
        timed_out: found.stats.timed_out,
      },
      chunk_id: allId,
      stored_ids: [allId, ...chunkIds],
      warnings: found.warnings,
      savings: {
        source_bytes: sourceBytes,
        returned_bytes: returnedBytes,
        followup_bytes: 0,
        chunk_id: allId,
        stored_ids: [allId, ...chunkIds],
      },
    });
  },
});

function indent(text, prefix) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => prefix + l)
    .join("\n");
}

// 12 --------------------------------------------------- laya_read_relevant
tool({
  name: "laya_read_relevant",
  title: "Laya: релевантные блоки файла с отметками пропусков",
  description:
    "Сам читает файл и возвращает блоки вокруг совпадений с нужным контекстом, явно отмечая пропущенные участки. Полный файл сохранён в chunk (laya_get_chunk). Перед редактированием дочитай реализацию: выдержка показывает совпадения, но не весь контекст.",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", description: "Путь к файлу (относительно проекта или абсолютный)." },
      query: { type: "string", description: "Что ищем в файле: слова/фраза, влияющие на выбор блоков." },
      budget: { type: "number", description: "Бюджет символов на блоки в ответе (по умолчанию 8000)." },
      context: { type: "number", description: "Строк контекста вокруг совпадения (по умолчанию 6)." },
      max_blocks: { type: "number", description: "Сколько блоков вернуть (по умолчанию 8)." },
      use_laya: { type: "boolean", description: "Ранжировать блоки Laya, если их больше max_blocks (по умолчанию да)." },
    },
    required: ["path", "query"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: false },
  async handler(args) {
    const cfg = loadConfig();
    const query = String(args.query || "").trim();
    if (!query) return errResult("query пуст.");
    const projectDir = process.env.DAVINCI_LAYA_PROJECT_DIR || process.cwd();
    const abs = path.isAbsolute(String(args.path || "")) ? String(args.path) : path.resolve(projectDir, String(args.path || ""));
    if (isSecretPath(abs)) return errResult("Содержимое секретных файлов (.env/ключи/credentials) не читается и не отправляется в Laya.");
    let st;
    try {
      st = fs.statSync(abs);
    } catch {
      return errResult(`Файл не найден: ${abs}`);
    }
    if (!st.isFile()) return errResult(`Не файл: ${abs}`);
    const maxBytes = cfg.readRelevant?.maxBytes || 2 * 1024 * 1024;
    if (st.size > maxBytes) return errResult(`Файл слишком большой для этого инструмента (${st.size} > ${maxBytes} байт). Используй laya_search или Read по частям.`);
    let buf;
    try {
      buf = fs.readFileSync(abs);
    } catch (err) {
      return errResult(`Не удалось прочитать ${abs}: ${err.message}`);
    }
    if (buf.subarray(0, 8192).includes(0)) return errResult("Файл выглядит бинарным — блоки кода не извлекаются.");
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    const first = layaFirst(cfg);
    const budget = Math.max(800, Math.min(30_000, Number(args.budget) || (first ? 6000 : cfg.readRelevant?.budget || 8000)));
    const context = Math.max(0, Math.min(20, Number(args.context) || cfg.readRelevant?.contextLines || 6));
    const maxBlocks = Math.max(1, Math.min(20, Number(args.max_blocks) || (first ? 6 : cfg.readRelevant?.maxBlocks || 8)));
    const terms = [...tokens(query)];

    const matchLines = [];
    const lineScores = new Map();
    const lowerQuery = query.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const low = line.toLowerCase();
      let score = 0;
      for (const term of terms) if (low.includes(term)) score += 1;
      if (query.length >= 3 && low.includes(lowerQuery)) score += 2;
      if (score > 0) {
        matchLines.push(i + 1);
        lineScores.set(i + 1, score);
      }
    }

    const chunkId = `file-${Date.now().toString(36)}-${path.basename(abs).replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 40)}`;
    storeChunks([{ id: chunkId, kind: "file_full", text }]);
    pruneChunks(cfg);

    if (!matchLines.length) {
      return okResult(
        `В ${abs} нет совпадений с «${query}» (${lines.length} строк). Полный файл: laya_get_chunk("${chunkId}"). ` +
          `Если нужен обзор — прочитай файл напрямую; этот инструмент не подменяет полное чтение.`,
        { ok: true, path: abs, total_lines: lines.length, blocks: [], omitted: [], chunk_id: chunkId, degraded: false },
      );
    }

    // Соседние совпадения сливаются в один блок; контекст добавляется вокруг.
    const ranges = [];
    for (const line of matchLines) {
      const start = Math.max(1, line - context);
      const end = Math.min(lines.length, line + context);
      const last = ranges[ranges.length - 1];
      if (last && start <= last.end + 1) {
        last.end = Math.max(last.end, end);
        last.matches.push(line);
        last.score += lineScores.get(line) || 0;
      } else {
        ranges.push({ start, end, matches: [line], score: lineScores.get(line) || 0 });
      }
    }

    let rankedRanges = ranges;
    let layaUsed = false;
    let degraded = false;
    if (ranges.length > maxBlocks && args.use_laya !== false) {
      const qset = questions([
        score("rel", "Насколько этот блок файла содержит реализацию или ответ, нужный для запроса?", [
          "не относится",
          "слабо связан",
          "содержит часть ответа",
          "содержит нужную реализацию",
        ]),
      ]);
      const states = ranges.map((r) => ({
        state: prepareForLaya(
          `Запрос: ${query}\nФайл: ${path.basename(abs)}\nСтроки ${r.start}-${r.end}:\n${lines.slice(r.start - 1, r.end).join("\n").slice(0, 900)}`,
          1300,
        ).text,
      }));
      const ranked = await decideManyFitted(states, qset, { cfg, onOverflow: "shrink", concurrency: 4 });
      layaUsed = ranked.some((r) => r && r.ok);
      degraded = ranked.some((r) => !r || !r.ok);
      rankedRanges = ranges
        .map((r, i) => ({
          ...r,
          relevance: ranked[i]?.ok ? ranked[i].answers?.rel?.score ?? null : null,
          confidence: ranked[i]?.ok ? ranked[i].answers?.rel?.answer_confidence ?? null : null,
        }))
        .sort((a, b) => (b.relevance ?? -1) - (a.relevance ?? -1) || b.score - a.score || a.start - b.start);
    }

    // Бюджет: блоки идут по релевантности; в ответе явно перечисляем, что
    // выброшено и где это взять.
    let spent = 0;
    const selected = [];
    const omittedBlocks = [];
    const perBlock = Math.max(260, Math.floor(budget / Math.max(1, maxBlocks)));
    for (const r of rankedRanges) {
      if (selected.length >= maxBlocks) {
        omittedBlocks.push(r);
        continue;
      }
      const body = lines.slice(r.start - 1, r.end).map((l, i) => `${r.start + i}│ ${l}`).join("\n");
      const remaining = budget - spent;
      if (remaining < 160) {
        omittedBlocks.push(r);
        continue;
      }
      const limit = Math.min(remaining, perBlock);
      let blockText = body;
      let truncated = false;
      if (body.length > limit) {
        blockText = body.slice(0, limit) + `\n… остальные строки блока ${r.start}-${r.end} пропущены; полный файл: chunk ${chunkId} …`;
        truncated = true;
      }
      spent += blockText.length;
      selected.push({ ...r, blockText, truncated });
    }
    selected.sort((a, b) => a.start - b.start);

    const parts = [];
    let cursor = 1;
    for (const r of selected) {
      if (r.start > cursor) parts.push(`… строки ${cursor}-${r.start - 1} пропущены (нет совпадений/вне бюджета) …`);
      parts.push(`── строки ${r.start}-${r.end}${r.relevance !== null && r.relevance !== undefined ? ` · релевантность ${Number(r.relevance).toFixed(2)}/3` : ""} ──`);
      parts.push(r.blockText);
      cursor = r.end + 1;
    }
    if (cursor <= lines.length) parts.push(`… строки ${cursor}-${lines.length} пропущены …`);
    if (omittedBlocks.length) {
      parts.push(
        `… ещё ${omittedBlocks.length} блок(ов) не показаны: ${omittedBlocks
          .slice(0, 8)
          .map((r) => `${r.start}-${r.end}`)
          .join(", ")} …`,
      );
    }
    const textOut =
      `Файл ${abs}: ${lines.length} строк, блоков с совпадениями: ${ranges.length}, показано: ${selected.length}` +
      `${layaUsed ? ` (Laya ранжировала)` : ""}.\n` +
      parts.join("\n") +
      `\nПолный файл: laya_get_chunk("${chunkId}"). Перед редактированием дочитай нужную реализацию — выдержки не заменяют исходник.`;

    const sourceBytes = buf.length;
    const returnedBytes = selected.reduce((n, r) => n + String(r.blockText || "").length, 0);
    recordEvent({
      kind: "mcp_call",
      tool: "laya_read_relevant",
      source: "mcp:laya_read_relevant",
      action: `lines:${lines.length}→blocks:${selected.length}`,
      latencyMs: null,
      extra: { matches: matchLines.length, ranges: ranges.length, omitted: omittedBlocks.length, laya_used: layaUsed, degraded },
    });
    return okResult(textOut, {
      ok: true,
      path: abs,
      total_lines: lines.length,
      matches: matchLines.length,
      blocks: selected.map((r) => ({ start: r.start, end: r.end, relevance: r.relevance ?? null, confidence: r.confidence ?? null, matches: r.matches, truncated: r.truncated })),
      omitted_blocks: omittedBlocks.map((r) => ({ start: r.start, end: r.end })),
      chunk_id: chunkId,
      laya_used: layaUsed,
      degraded,
      savings: {
        source_bytes: sourceBytes,
        returned_bytes: returnedBytes,
        followup_bytes: 0,
        chunk_id: chunkId,
        omitted_blocks: omittedBlocks.length,
      },
    });
  },
});

// 13 ------------------------------------------------------ laya_run_check
tool({
  name: "laya_run_check",
  title: "Laya: запустить проверку проекта и вернуть факты",
  description:
    "Запускает настроенную проверку проекта (test/typecheck/lint/build; автопоиск по package.json/go.mod/pyproject/Cargo.toml/Makefile или runChecks.commands). Полный stdout/stderr сохраняется локально в chunk; возвращает exit code, уникальные ошибки, итог и chunk_id. Провал/таймаут никогда не скрываются.",
  inputSchema: {
    type: "object",
    properties: {
      check_id: { type: "string", description: "id проверки из конфигурации/автопоиска или \"auto\" (первая доступная: test→typecheck→lint→build)." },
      budget: { type: "number", description: "Бюджет символов на хвост вывода/ошибки в ответе (по умолчанию 6000)." },
      root: { type: "string", description: "Корень проекта (по умолчанию DAVINCI_LAYA_PROJECT_DIR/текущий каталог)." },
      timeout_ms: { type: "number", description: "Таймаут проверки, мс (по умолчанию 180000, максимум 600000)." },
    },
    required: ["check_id"],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: false, openWorldHint: false },
  async handler(args) {
    const cfg = loadConfig();
    const root = path.resolve(args.root || process.env.DAVINCI_LAYA_PROJECT_DIR || findProjectRoot(process.cwd()));
    const budget = Math.max(500, Math.min(30_000, Number(args.budget) || 6000));
    const started = Date.now();
    const r = await runCheck({
      checkId: String(args.check_id || "auto"),
      root,
      cfg,
      budget,
      timeoutMs: Number(args.timeout_ms) || undefined,
    });
    recordEvent({
      kind: "mcp_call",
      tool: "laya_run_check",
      source: "mcp:laya_run_check",
      action: r.ok ? (r.success ? "exit:0" : r.timed_out ? "timeout" : `exit:${r.exit_code}`) : "invalid_check",
      latencyMs: Date.now() - started,
      extra: { check_id: r.check_id || args.check_id, root, bytes: r.bytes || 0 },
    });
    if (!r.ok) {
      const available = Object.entries(r.available || {})
        .map(([id, c]) => `${id} (${c.kind}): ${c.command}`)
        .join("\n");
      return errResult(
        `${r.error}${available ? `\nДоступные проверки:\n${available}` : ""}`,
        { ok: false, root, available: r.available || null },
      );
    }
    const status = r.success
      ? `Проверка «${r.check_id}» ПРОЙДЕНА (exit 0, ${r.duration_ms} мс).`
      : r.timed_out
        ? `ТАЙМАУТ проверки «${r.check_id}» через ${r.duration_ms} мс — процесс убит.`
        : `ПРОВАЛ проверки «${r.check_id}»: exit code ${r.exit_code ?? "null"}${r.signal ? `, signal ${r.signal}` : ""} (${r.duration_ms} мс).`;
    const errLines = (r.errors || []).slice(0, 10).map((e, i) => `${i + 1}. ${e.count > 1 ? `×${e.count} ` : ""}${e.text}`);
    const summary = (r.summary || []).length ? `\nИтог:\n${r.summary.join("\n")}` : "";
    const tail = r.stdout_tail ? `\nХвост вывода:\n${r.stdout_tail}` : "";
    return okResult(
      `${status}${errLines.length ? `\nОшибки:\n${errLines.join("\n")}` : ""}${summary}${tail}\n` +
        `Полный stdout/stderr (${r.bytes} байт): laya_get_chunk("${r.chunk_id}"). Команда: ${r.command}.`,
      {
        ok: true,
        success: r.success,
        check_id: r.check_id,
        kind: r.kind,
        command: r.command,
        root: r.root,
        exit_code: r.exit_code,
        signal: r.signal,
        timed_out: r.timed_out,
        duration_ms: r.duration_ms,
        chunk_id: r.chunk_id,
        bytes: r.bytes,
        errors: r.errors,
        summary: r.summary,
        available: r.available,
      },
    );
  },
});

export function findTool(name) {
  return TOOLDEFS.find((t) => t.name === name) || null;
}

/** Схемы для tools/list — без исполняемых полей. */
export function toolList() {
  return TOOLDEFS.map(({ name, title, description, inputSchema, annotations }) => ({ name, title, description, inputSchema, annotations }));
}
