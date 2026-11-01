// helpers.mjs — минимальный тест-фреймворк и фиктивный клиент Laya.
//
// Фиктивный клиент отвечает детерминированно (по id вопросов), поэтому тесты
// гейтов не требуют ни сервера, ни GPU и не «мигают» на медленной машине.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ------------------------------------------------------------- фреймворк

const results = [];
let currentGroup = "";

export function group(name) {
  currentGroup = name;
  process.stdout.write(`\n== ${name} ==\n`);
}

export async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ group: currentGroup, name, ok: true, ms: Date.now() - t0 });
    process.stdout.write(`  [ok]   ${name} (${Date.now() - t0} мс)\n`);
  } catch (err) {
    results.push({ group: currentGroup, name, ok: false, ms: Date.now() - t0, err });
    process.stdout.write(`  [FAIL] ${name}: ${err?.message || err}\n`);
    if (process.env.TEST_VERBOSE) process.stdout.write(`         ${err?.stack}\n`);
  }
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

export function assertEq(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg || "не равны"}: получено ${a}, ожидалось ${e}`);
}

export function assertClose(actual, expected, eps = 1e-6, msg) {
  if (Math.abs(actual - expected) > eps) throw new Error(`${msg || "не близко"}: ${actual} vs ${expected}`);
}

/** Итог: печатает сводку и возвращает код выхода. */
export function summary(title) {
  const ok = results.filter((r) => r.ok).length;
  const fail = results.length - ok;
  process.stdout.write(`\n${title}: всего ${results.length}, успешно ${ok}, провалено ${fail}\n`);
  if (fail) {
    process.stdout.write("Провалы:\n");
    for (const r of results.filter((r) => !r.ok)) process.stdout.write(`  - ${r.group} / ${r.name}: ${r.err?.message}\n`);
  }
  return fail === 0 ? 0 : 1;
}

// -------------------------------------------------- изолированный каталог

/** Временный каталог данных для теста: метрики и ledger не трогают реальные. */
export function makeTempDataDir(tag = "test") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `davinci-laya-${tag}-`));
  process.env.DAVINCI_LAYA_DATA = dir;
  return dir;
}

export function cleanupTempDataDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ------------------------------------------------------ фиктивный клиент

/**
 * Фиктивная Laya. `answers` задаёт переопределения по id вопроса:
 *   answers: { risk_class: "high", data_loss: 0.9, verification_needed: 0.8 }
 * Остальные вопросы получают значения по умолчанию (низкий риск, «нет»).
 */
export function fakeClient(opts = {}) {
  const {
    answers = {},
    conf = 0.9,
    fail = null,
    trustworthy = true,
    warnings = [],
    elapsedMs = 42,
    checkpoint = "test-cp-0000",
    budget = { state_tokens: 10, state_dropped_max: 0, state_truncated: false, max_len: 1024 },
    onDecide = null,
    countResult = null,
  } = opts;

  const defaults = {
    data_loss: 0.05,
    exfiltration: 0.02,
    risk_class: "low",
    verification_needed: 0.2,
    evidence_strength: "weak",
    task_class: "balanced",
    needs_tools: 0.8,
    ambiguity: 0.1,
    label: "logic",
    level: 1.5,
    rel: 1.5,
    important: 0.3,
    decision: "fetch_on_demand",
    kind: "logic",
    attention: 0.2,
  };

  return {
    calls: [],
    countCalls: [],
    async decide(state, questions, _opts = {}) {
      this.calls.push({ state, questions });
      if (onDecide) {
        const custom = onDecide({ state, questions, callIndex: this.calls.length });
        if (custom !== undefined) return custom;
      }
      if (fail) return { ok: false, error: { code: fail.code || "timeout", message: fail.message || "fake failure" } };
      const out = { ok: true, answers: {}, order: [], warnings: warnings.slice(), checkpoint, elapsedMs, budget, trustworthy, model: "fake" };
      for (const [id, q] of Object.entries(questions)) {
        out.order.push(id);
        const raw = id in answers ? answers[id] : defaults[id];
        const base = {
          type: q.type,
          answer_confidence: typeof conf === "number" ? conf : conf.risk_class,
          confidence: 0.3,
          temperature: 1,
          collapsed: false,
          state_dropped: 0,
          head_truncated: false,
        };
        if (q.type === "noul") base.noul = typeof raw === "number" ? raw : raw ? 1 : 0;
        else if (q.type === "score") base.score = typeof raw === "number" ? raw : 1;
        else base.choice = typeof raw === "string" ? raw : "low";
        out.answers[id] = base;
      }
      return out;
    },
    async count(state, questions) {
      this.countCalls.push({ state, questions });
      if (countResult) {
        return typeof countResult === "function" ? countResult({ state, questions, callIndex: this.countCalls.length }) : countResult;
      }
      return {
        ok: true,
        state_tokens: Math.max(1, Math.ceil(String(state).length / 4)),
        max_len: 1024,
        head_max_len: 256,
        fits: true,
        questions: Object.keys(questions || {}).map(() => ({ state_kept: Math.max(1, Math.ceil(String(state).length / 4)), state_dropped: 0, head_truncated: false, collapsed: false })),
      };
    },
    async health() {
      if (fail) return { ok: false, error: { code: fail.code || "timeout", message: "fake" }, url: "http://fake" };
      return { ok: true, ready: true, device: "cpu", checkpointId: checkpoint, latencyMs: 5, url: "http://fake" };
    },
  };
}

// --------------------------------------------------------------- сервер?

/** Проверка живости Laya для live-тестов. */
export async function layaIsUp(url = process.env.DAVINCI_LAYA_URL || "http://127.0.0.1:8095") {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 1000);
    const res = await fetch(url.replace(/\/+$/, "") + "/ready", { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return false;
    const j = await res.json();
    return j.ready === true;
  } catch {
    return false;
  }
}
