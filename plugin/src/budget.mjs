// budget.mjs — проверка и подгонка состояния под реальный бюджет движка.
//
// Причина существования: max_len и head_max_len — это ДВА разных бюджета.
// head_max_len ограничивает вопрос (инструкцию + все варианты ответа), а
// max_len — всю последовательность [CLS] head [SEP] options [SEP] state [SEP].
// Поэтому свободное место под state зависит от полной сериализованной
// постановки вопроса, а не от длины state. Символьный лимит («≤1400 символов»)
// этого не выражает: кириллица, длинные варианты и много вопросов дают разный
// расход токенов.
//
// Правило: перед /decide спрашиваем /count с ТЕМИ ЖЕ questions. Если state не
// помещается — сокращаем его явно (с маркером) и пересчитываем. Если не
// помещается сам вопрос (head_truncated/collapsed) — не вызываем /decide:
// ответ по обрезанной инструкции или схлопнутым вариантам не является ответом.

import { count, decide } from "./laya-client.mjs";
import { truncateMiddle } from "./sanitize.mjs";
import { currentTrace, noteCount, runWithWorkTrace } from "./work-client.mjs";

const DEFAULT_MARGIN = 12;
const MAX_FIT_ATTEMPTS = 4;
const MIN_STATE_CHARS = 80;

function questionProblems(counted) {
  const qs = Array.isArray(counted?.questions) ? counted.questions : [];
  const dropped = qs.reduce((m, q) => Math.max(m, Number(q.state_dropped) || 0), 0);
  const head = qs.some((q) => q.head_truncated === true);
  const collapsed = qs.some((q) => q.collapsed === true);
  const room = qs.length ? Math.min(...qs.map((q) => Number(q.state_kept) || 0)) : 0;
  return { dropped, head, collapsed, room, fits: !head && !collapsed && dropped === 0 };
}

function countFit(counted) {
  const qs = Array.isArray(counted?.questions) ? counted.questions : [];
  return {
    counted: true,
    state_tokens: counted?.state_tokens ?? null,
    state_kept: qs.length ? Math.min(...qs.map((q) => Number(q.state_kept) || 0)) : null,
    state_dropped: qs.length ? Math.max(...qs.map((q) => Number(q.state_dropped) || 0)) : null,
    head_truncated: qs.some((q) => q.head_truncated === true),
    collapsed: qs.some((q) => q.collapsed === true),
    max_len: counted?.max_len ?? null,
    head_max_len: counted?.head_max_len ?? null,
    truncated_by_client: false,
  };
}

function fitSummary(fit) {
  const c = fit.count || {};
  const qs = Array.isArray(c.questions) ? c.questions : [];
  return {
    counted: fit.counted !== false,
    attempts: fit.attempts || 0,
    state_tokens: c.state_tokens ?? null,
    state_kept: qs.length ? Math.min(...qs.map((q) => Number(q.state_kept) || 0)) : null,
    state_dropped: qs.length ? Math.max(...qs.map((q) => Number(q.state_dropped) || 0)) : null,
    head_truncated: qs.some((q) => q.head_truncated === true),
    collapsed: qs.some((q) => q.collapsed === true),
    max_len: c.max_len ?? null,
    head_max_len: c.head_max_len ?? null,
    truncated_by_client: fit.truncated === true,
    original_chars: fit.original_chars ?? null,
    used_chars: String(fit.text || "").length,
  };
}

/** Человекочитаемое объяснение, почему /decide не вызывается. */
function budgetError(fit) {
  const c = fit.count || {};
  const problems = questionProblems(c);
  if (problems.head || problems.collapsed) {
    return {
      code: "question_too_long",
      message:
        `постановка вопроса не помещается в head_max_len=${c.head_max_len ?? "?"}: ` +
        `${problems.head ? "инструкция обрезана" : ""}${problems.head && problems.collapsed ? ", " : ""}` +
        `${problems.collapsed ? "варианты схлопнулись" : ""}. ` +
        `Сократи instructions и/или criteria (варианты) — состояние тут не поможет.`,
    };
  }
  return {
    code: "state_too_long",
    message:
      `state не помещается в max_len=${c.max_len ?? "?"}: нужно ${c.state_tokens ?? "?"} ток., ` +
      `свободно ${problems.room} ток. после вопроса. Сократи state или раздели вопрос на части.`,
  };
}

/**
 * Проверяет бюджет и (при необходимости) сокращает state.
 *
 * Возвращает:
 *   { ok:true, text, count, attempts, truncated, original_chars }
 *   { ok:false, error, code, count, attempts, text }
 *
 * `client` инжектируется для офлайн-тестов; по умолчанию — настоящий адаптер.
 */
export async function fitState(
  state,
  questions,
  { cfg, maxLen, timeoutMs, marginTokens = DEFAULT_MARGIN, client = { count } } = {},
) {
  const original = String(state ?? "");
  let text = original;
  const countStart = Date.now();
  let counted = await client.count(text, questions, { cfg, timeoutMs, maxLen });
  noteCount({ countMs: Date.now() - countStart, fit: counted?.ok ? countFit(counted) : null });
  if (!counted || counted.ok !== true) {
    const error = counted?.error || { code: "count_failed", message: "Laya не ответила на /count" };
    // Старый движок без /count: не маскируем это под «всё помещается».
    if (error.code === "http_404" || error.code === "unknown_endpoint") {
      return { ok: true, text, count: null, counted: false, attempts: 0, truncated: false, original_chars: original.length };
    }
    return { ok: false, code: error.code || "count_failed", error, count: null, counted: true, attempts: 0, text };
  }

  let attempts = 0;
  for (;;) {
    const problems = questionProblems(counted);
    if (problems.head || problems.collapsed) {
      return { ok: false, code: "question_too_long", error: budgetError({ count: counted }), count: counted, counted: true, attempts, text };
    }
    if (problems.fits) {
      return {
        ok: true,
        text,
        count: counted,
        counted: true,
        attempts,
        truncated: attempts > 0,
        original_chars: original.length,
      };
    }
    if (attempts >= MAX_FIT_ATTEMPTS) break;

    // Сколько символов оставить: пропорция свободного места к полной длине
    // state в токенах. Маркер обрезки сам съедает токены, поэтому берём запас
    // marginTokens и повторяем замер после каждого шага.
    const stateTokens = Number(counted.state_tokens) || 0;
    const room = Math.max(0, problems.room - marginTokens);
    if (!stateTokens || room <= 0) break;
    const ratio = Math.max(0.05, Math.min(0.95, room / stateTokens));
    const targetChars = Math.max(MIN_STATE_CHARS, Math.floor(text.length * ratio));
    const cut = truncateMiddle(text, targetChars);
    if (!cut.truncated) break;
    text = cut.text;
    attempts += 1;
    const retryStart = Date.now();
    counted = await client.count(text, questions, { cfg, timeoutMs, maxLen });
    noteCount({ countMs: Date.now() - retryStart, fit: counted?.ok ? countFit(counted) : null });
    if (!counted || counted.ok !== true) {
      const error = counted?.error || { code: "count_failed", message: "Laya не ответила на /count" };
      return { ok: false, code: error.code || "count_failed", error, count: null, counted: true, attempts, text };
    }
  }

  const error = budgetError({ count: counted });
  return { ok: false, code: error.code, error, count: counted, counted: true, attempts, text };
}

/**
 * /decide с предварительной проверкой бюджета.
 *
 * onOverflow="error" (по умолчанию) — не вызывать модель, вернуть понятную
 * ошибку. Это обязательно для laya_decide: агент передал факты, и молча
 * сократить их нельзя.
 * onOverflow="shrink" — сократить state с явным маркером (для внутренних
 * фрагментов поиска/триажа, где мы сами управляем размером).
 */
export async function decideFitted(state, questions, opts = {}) {
  const { cfg, maxLen, timeoutMs, onOverflow = "error", client = { count, decide } } = opts;
  const fit = await fitState(state, questions, { cfg, maxLen, timeoutMs, client });
  if (!fit.ok) {
    return {
      ok: false,
      error: fit.error,
      fit: fitSummary(fit),
      state_truncated: fit.code === "state_too_long",
      budget_checked: fit.counted !== false,
    };
  }
  const res = await client.decide(fit.text, questions, { cfg, timeoutMs, maxLen });
  if (!res || res.ok !== true) return res;
  const summary = fitSummary(fit);
  res.fit = summary;
  res.state_truncated = fit.truncated === true;
  res.budget_checked = fit.counted !== false;
  if (fit.truncated) {
    res.warnings = [...(res.warnings || []), `state сокращён клиентом до бюджета max_len (${summary.used_chars} из ${summary.original_chars} симв.)`];
    res.trustworthy = false;
  }
  return res;
}

/**
 * Пакетная проверка бюджета: если у всех элементов одинаковый набор вопросов,
 * достаточно замерить самый длинный state — короткие при том же вопросе имеют
 * не меньше свободного места. При разных вопросах каждый элемент проверяется
 * отдельно.
 */
export async function decideManyFitted(items, questions, opts = {}) {
  const { cfg, maxLen, timeoutMs, onOverflow = "shrink", client = { count, decide }, concurrency = 4 } = opts;
  if (!items.length) return [];
  const signature = JSON.stringify(questions);
  const sameQuestions = items.every((it) => JSON.stringify(it.questions || questions) === signature);
  const useOneCount = sameQuestions && client.count && typeof client.count === "function";

  let longestFits = false;
  let probeError = null;
  if (useOneCount) {
    const longest = items.reduce((a, b) => (String(b.state || "").length > String(a.state || "").length ? b : a), items[0]);
    const probeStart = Date.now();
    const probe = await client.count(String(longest.state || ""), questions, { cfg, timeoutMs, maxLen });
    noteCount({ countMs: Date.now() - probeStart, fit: probe?.ok ? countFit(probe) : null });
    // 5% запас: токенизация не строго монотонна по длине строки.
    longestFits = probe?.ok === true && questionProblems(probe).fits === true && questionProblems(probe).room > 32;
    if (!probe || probe.ok !== true) probeError = probe?.error || { code: "count_failed", message: "нет ответа /count" };
  }
  // Сервис недоступен/в cooldown: не ждём timeout на каждом кандидате — это
  // превратило бы «деградацию» в многократную задержку.
  if (probeError && ["unreachable", "timeout", "circuit_open"].includes(probeError.code)) {
    return items.map(() => ({ ok: false, error: probeError, budget_checked: false }));
  }

  const lim = Math.max(1, Math.min(8, concurrency));
  let next = 0;
  const out = new Array(items.length);
  const workers = Array.from({ length: Math.min(lim, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const it = items[i];
      const workMeta = {
        cfg,
        itemId: it.item_id ?? it.itemId ?? it.id ?? i,
        batchId: currentTrace()?.trace_id || null,
      };
      const run = async () => {
        if (longestFits) {
          const res = await client.decide(String(it.state || ""), it.questions || questions, { cfg, timeoutMs, maxLen });
          if (res && res.ok) res.budget_checked = true;
          return res;
        }
        return decideFitted(String(it.state || ""), it.questions || questions, { ...opts, onOverflow, concurrency: lim });
      };
      out[i] = await runWithWorkTrace(workMeta, run);
    }
  });
  await Promise.all(workers);
  return out;
}

export { questionProblems, fitSummary };
