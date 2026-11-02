// gates.mjs — реализации гейтов, вызываемые из хуков и из тестов.
//
// Все функции принимают зависимости явно (cfg, client, ledgerApi, now), поэтому
// офлайн-тесты подставляют фиктивного клиента Laya и проверяют решения без
// сервера и без GPU. Хуки — тонкие обёртки: прочитать stdin, позвать gate,
// вывести JSON.
//
// Формат вывода повторяет документированную схему ZCode: наружу уходит только
// `hookSpecificOutput` соответствующего события либо ничего. Никаких allow/deny:
// PreToolUse может лишь повысить вопрос (ask), Stop — лишь попросить одну
// дополнительную проверку.

import { loadConfig } from "./config.mjs";
import { prepareForLaya, maskText, textHash } from "./sanitize.mjs";
import {
  scanDeterministic,
  buildRiskState,
  riskQuestions,
  evaluateRisk,
  evaluateDoneGaps,
  routerQuestions,
  interpretRouter,
  shouldAskLaya,
} from "./decision-policy.mjs";
import { decideFitted } from "./budget.mjs";
import { discoverChecks } from "./project.mjs";
import { readLedger, recordToolUse, updateLedger, bumpCounter, readProjectChecks } from "./evidence-ledger.mjs";
import { recordEvent } from "./telemetry.mjs";
import { recordPolicyEvent, recordAgentAction } from "./work-client.mjs";

const TOOL_MATCH_CACHE = new Map();
function toolMatches(pattern, toolName) {
  let re = TOOL_MATCH_CACHE.get(pattern);
  if (!re) {
    try {
      re = new RegExp(`^(?:${pattern})$`);
    } catch {
      re = null;
    }
    TOOL_MATCH_CACHE.set(pattern, re);
  }
  return re ? re.test(toolName) : false;
}

/**
 * Режим разрешений ZCode из входа хука. ZCode 3.15 присылает и camelCase
 * (`permissionMode`), и snake_case (`permission_mode`), и короткий `mode`;
 * читаем любой, чтобы политика не зависела от версии хоста.
 */
export function permissionModeOf(input) {
  for (const key of ["permission_mode", "permissionMode", "mode"]) {
    const value = input?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Вправе ли гейт вмешиваться в текущем режиме разрешений.
 * Пустой или отсутствующий список activeModes — без фильтра (совместимость).
 * Непустой — только перечисленные режимы; если хост режим не сообщил,
 * защиту молча не отключаем (fail-safe: неизвестность не равна Full access).
 */
export function gateActiveInMode(activeModes, input) {
  if (!Array.isArray(activeModes) || activeModes.length === 0) return true;
  const mode = permissionModeOf(input);
  if (mode === null) return true;
  return activeModes.includes(mode);
}

function scoresFromDecide(laya) {
  if (!laya || !laya.ok) return null;
  const out = {};
  for (const id of laya.order) {
    const a = laya.answers[id];
    out[id] = {
      type: a.type,
      choice: a.choice ?? null,
      score: a.type === "score" ? a.score : null,
      noul: a.type === "noul" ? a.noul : null,
      answer_confidence: a.answer_confidence,
    };
  }
  return out;
}

// ------------------------------------------------------------ RiskGate

/**
 * Гейт риска на PreToolUse.
 *
 * Возвращает { output, telemetry }: `output` — объект для stdout (null = молчать).
 * В shadow-режиме output всегда null: решение пишется только локально, разрешения
 * не трогаются — ровно как требует §6.1 ТЗ для первого этапа.
 */
export async function preToolGate(input, deps = {}) {
  const cfg = deps.cfg || loadConfig();
  const client = deps.client;
  const now = deps.now || Date.now();
  const toolName = input?.tool_name || "";
  const toolInput = input?.tool_input || {};
  const cwd = input?.cwd || process.cwd();
  const sessionId = input?.session_id || "unknown";

  if (!toolName || !toolMatches(cfg.riskGate.tools, toolName)) {
    return { output: null, telemetry: null };
  }

  // Полный доступ (yolo) и остальные режимы, кроме Autonomous (guarded), не
  // должны получать вопросы от Laya: пользователь уже согласился один раз.
  // Выходим до вызова модели, чтобы не тратить инференс и ничего не спрашивать.
  const permissionMode = permissionModeOf(input);
  if (!gateActiveInMode(cfg.riskGate.activeModes, input)) {
    updateLedger(
      sessionId,
      (l) => {
        l.cwd = l.cwd || cwd;
        if (permissionMode) l.permissionMode = permissionMode;
        bumpCounter(l, "risk_skipped_mode");
      },
      cfg,
    );
    recordEvent(
      {
        kind: "risk_gate",
        sessionId,
        tool: toolName,
        source: "hook:pre-tool",
        mode: cfg.riskGate.mode,
        action: "skip_mode",
        reason: `permission_mode=${permissionMode ?? "unknown"} вне activeModes`,
        latencyMs: 0,
        questionSetVersion: "risk-v1",
        extra: { permission_mode: permissionMode, active_modes: cfg.riskGate.activeModes },
      },
      cfg,
    );
    recordPolicyEvent({
      action: "skip_mode",
      basis: "permission_mode",
      reason: `permission_mode=${permissionMode ?? "unknown"} вне activeModes`,
      layaCalled: false,
      operation: "risk_gate",
      evidence: { permission_mode: permissionMode, active_modes: cfg.riskGate.activeModes },
      status: "skipped",
    });
    return { output: null, telemetry: { skipped: "permission_mode", permissionMode } };
  }

  const t0 = now;
  const detHits = scanDeterministic({ toolName, toolInput, cwd, extraRules: cfg.riskGate.extraRules });
  const ledger = readLedger(sessionId, cfg);
  const rawState = buildRiskState({
    toolName,
    toolInput,
    cwd,
    detHits,
    gitEvidence: ledger.lastGitStatus || "",
  });
  // Маскируем ПОСЛЕ сборки: строка содержит команду, а в ней может быть токен.
  // stateCharBudget здесь — только жёсткий предохранитель от гигантских команд;
  // реальный бюджет проверяет /count (см. budget.mjs), потому что он зависит от
  // полной постановки вопроса, а не от числа символов.
  const hardCap = cfg.budget?.hardStateChars ?? 20_000;
  const prepared = prepareForLaya(rawState, hardCap, cfg.riskGate.extraSecrets);
  const state = prepared.text;
  const hardTruncated = prepared.truncated;

  let laya = null;
  let inferenceError = null;
  let layaSkipped = null;
  if (client && cfg.riskGate.mode !== "off") {
    if (shouldAskLaya({ toolName, toolInput, detHits, policy: cfg.riskGate.layaPolicy })) {
      laya = await decideFitted(state, riskQuestions(), { cfg, client, onOverflow: "shrink" });
      if (laya && !laya.ok) inferenceError = laya.error?.code || "error";
    } else {
      layaSkipped = "read_only";
    }
  }
  const truncated = hardTruncated || laya?.state_truncated === true;

  const verdict = evaluateRisk({ detHits, laya, cfg });
  const latencyMs = (deps.now ? deps.now() : Date.now()) - t0;

  updateLedger(
    sessionId,
    (l) => {
      l.cwd = l.cwd || cwd;
      if (permissionMode) l.permissionMode = permissionMode;
      bumpCounter(l, `risk_${verdict.riskClass}`);
      if (verdict.action === "ask") bumpCounter(l, "risk_ask");
      if (inferenceError) bumpCounter(l, "laya_errors");
      if (layaSkipped) bumpCounter(l, "laya_skipped");
      if (truncated) bumpCounter(l, "state_truncated");
    },
    cfg,
  );

  recordEvent(
    {
      kind: "risk_gate",
      sessionId,
      tool: toolName,
      source: "hook:pre-tool",
      mode: verdict.mode,
      action: verdict.action,
      reason: verdict.reason,
      latencyMs,
      elapsedMs: laya?.elapsedMs ?? null,
      checkpoint: laya?.checkpoint || null,
      questionSetVersion: "risk-v1",
      stateHash: await textHash(state),
      stateChars: laya?.fit?.used_chars ?? state.length,
      stateTruncated: truncated || (laya?.budget?.state_truncated ?? false),
      scores: scoresFromDecide(laya),
      inferenceError,
      detHits: detHits.map((h) => `${h.id}:${h.risk}`),
      extra: {
        permission_mode: permissionMode,
        ...(layaSkipped ? { laya_skipped: layaSkipped } : {}),
        fit: laya?.fit || null,
      },
    },
    cfg,
  );

  recordPolicyEvent({
    action: verdict.action,
    basis: verdict.source,
    ruleIds: detHits.map((h) => h.id),
    reason: verdict.reason,
    layaCalled: Boolean(laya && laya.ok),
    fallback: Boolean(laya && !laya.ok),
    input: { original_redacted: rawState, effective_redacted: state },
    fit: laya?.fit || null,
    result: laya
      ? {
          elapsed_ms: laya.elapsedMs,
          checkpoint: laya.checkpoint,
          selected: verdict.riskClass,
          answer_confidence: verdict.confidence,
          risk: verdict.laya || null,
        }
      : null,
    evidence: {
      det_hits: detHits.map((h) => `${h.id}:${h.risk}`),
      permission_mode: permissionMode,
      fit: laya?.fit || null,
    },
    operation: "risk_gate",
    callId: laya?.call_id,
    startedAt: Date.now() - latencyMs,
    status: "completed",
  });

  let output = null;
  if (verdict.mode === "ask" && verdict.action === "ask") {
    output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason:
          `Laya RiskGate: класс «${verdict.riskClass}»${verdict.confidence !== null ? `, p=${verdict.confidence.toFixed(2)}` : ""}. ${verdict.reason}. ` +
          `Проверьте действие перед подтверждением.`,
      },
    };
  } else if (
    cfg.riskGate.warnHighRisk === true &&
    verdict.riskClass === "high" &&
    (verdict.detRisk === "high" ||
      (verdict.confidence !== null && verdict.confidence >= cfg.riskGate.askMinConfidence && verdict.trustworthy !== false))
  ) {
    // Full access: пользователя не спрашиваем, но агент получает предупреждение
    // перед выполнением. Строка добавляется только при high — обычные вызовы
    // остаются бесплатными по токенам.
    output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext:
          `Laya RiskGate: риск high${verdict.confidence !== null ? ` (p=${verdict.confidence.toFixed(2)})` : ""}. ${verdict.reason}. ` +
          `Учтите риск перед выполнением.`,
      },
    };
  }
  return { output, telemetry: { verdict, detHits, truncated, latencyMs, stateHash: null } };
}

// ------------------------------------------------------- PostToolUse

/** Извлекает короткий stdout из tool_response, если он там есть. */
function extractStdout(toolResponse) {
  if (!toolResponse) return "";
  if (typeof toolResponse === "string") return toolResponse.slice(0, 4000);
  for (const key of ["stdout", "output", "content", "text"]) {
    const v = toolResponse[key];
    if (typeof v === "string") return v.slice(0, 4000);
  }
  return "";
}

/** Есть ли в tool_response признак ошибки (когда PostToolUse пришёл на сбой). */
function responseFailed(toolResponse) {
  if (!toolResponse || typeof toolResponse !== "object") return false;
  if (toolResponse.is_error === true || toolResponse.isError === true) return true;
  if (typeof toolResponse.exit_code === "number" && toolResponse.exit_code !== 0) return true;
  if (typeof toolResponse.exitCode === "number" && toolResponse.exitCode !== 0) return true;
  return false;
}

/**
 * Запись доказательств по завершённому вызову инструмента.
 * Stdout хука всегда пуст: PostToolUse не должен ни заменять вывод инструмента,
 * ни добавлять контекст — это стоило бы токенов на каждом вызове.
 */
export async function postToolGate(input, deps = {}) {
  const cfg = deps.cfg || loadConfig();
  const toolName = input?.tool_name || "";
  const toolInput = { ...(input?.tool_input || {}) };
  const sessionId = input?.session_id || "unknown";
  const stdout = extractStdout(input?.tool_response);
  if (stdout) toolInput.__result_stdout = stdout;
  const ok = !responseFailed(input?.tool_response);

  if (["Bash", "Write", "Edit", "MultiEdit", "ApplyPatch"].includes(toolName)) {
    recordToolUse(sessionId, {
      toolName,
      toolInput,
      ok,
      error: input?.error,
      cfg,
    });
    recordAgentAction({
      tool: toolName,
      command: toolInput.command || "",
      exitCode: ok ? 0 : 1,
      durationMs: input?.duration_ms ?? input?.durationMs ?? null,
      toolUseId: input?.tool_use_id,
      error: input?.error || null,
    });
  }
  return { output: null, telemetry: { recorded: ok ? "success" : "failure" } };
}

/** Отдельный обработчик PostToolUseFailure: ошибка идёт в unresolvedErrors. */
export async function postToolFailureGate(input, deps = {}) {
  const cfg = deps.cfg || loadConfig();
  const toolName = input?.tool_name || "";
  const sessionId = input?.session_id || "unknown";
  recordToolUse(sessionId, {
    toolName,
    toolInput: input?.tool_input || {},
    ok: false,
    error: { code: input?.error || "tool_failure", message: input?.error || "" },
    cfg,
  });
  recordAgentAction({
    tool: toolName || "tool",
    command: input?.tool_input?.command || "",
    exitCode: 1,
    durationMs: input?.duration_ms ?? input?.durationMs ?? null,
    toolUseId: input?.tool_use_id,
    error: input?.error || "tool_failure",
  });
  return { output: null, telemetry: { recorded: "failure" } };
}

// ----------------------------------------------------------- DoneGate

/**
 * Гейт завершения на Stop.
 *
 * Контроль качества отделён от режима разрешений:
 *   • evidence и пробелы считаются всегда, включая yolo;
 *   • по умолчанию выдаётся короткое уведомление только при конкретном
 *     незакрытом пункте (доступная проверка не запускалась / упала);
 *   • блокировка — только в явно разрешённом режиме и только при high-пробеле;
 *   • Laya здесь не вызывается: успех подтверждается фактами (exit code,
 *     изменённые файлы, доступные проверки), а не вероятностной оценкой.
 */
export async function stopGate(input, deps = {}) {
  const cfg = deps.cfg || loadConfig();
  const sessionId = input?.session_id || "unknown";
  const stopHookActive = input?.stop_hook_active === true;
  const ledger = readLedger(sessionId, cfg);
  // Stop может не нести режим разрешений; берём последний известный из ledger,
  // который PreToolUse/launcher записывают на вызовах инструментов.
  const permissionMode = permissionModeOf(input) ?? ledger.permissionMode ?? null;
  const projectRoot = input?.cwd || ledger.cwd || process.cwd();
  const discovered = discoverChecks(projectRoot, cfg);

  // Проверки, запущенные через laya_run_check, живут в отдельном файле проекта
  // (MCP не знает session_id). Подмешиваем только те, что новее начала сессии.
  // Только проверки, запущенные после старта этой сессии: чужая/прошлая
  // проверка не должна закрывать текущий пробел.
  const projectChecks = readProjectChecks(projectRoot).filter(
    (c) => (Number(c.ts) || 0) >= (Number(ledger.createdAt) || 0),
  );
  const mergedChecks = [...(ledger.checks || []), ...projectChecks].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const effectiveLedger = { ...ledger, checks: mergedChecks };
  const gaps = evaluateDoneGaps(effectiveLedger, cfg, { checks: discovered, projectRoot });

  const highGaps = gaps.filter((g) => g.severity === "high");
  const mode = cfg.doneGate.mode;
  const activeModes = Array.isArray(cfg.doneGate.activeModes) ? cfg.doneGate.activeModes : [];
  // Если режим разрешений неизвестен, блокировать нельзя: это была бы новая
  // блокировка «по догадке». Unknown → только лог/уведомление.
  const activeInMode = activeModes.length === 0 ? true : Boolean(permissionMode && activeModes.includes(permissionMode));
  let output = null;
  let action = "log";
  let blockSkipped = null;

  if (
    mode === "block" &&
    highGaps.length > 0 &&
    !stopHookActive &&
    (ledger.blocks || 0) < cfg.doneGate.maxBlocksPerSession
  ) {
    if (activeInMode) {
      action = "block";
      const checkHint = highGaps.find((g) => g.check_id)?.check_id;
      output = {
        decision: "block",
        reason:
          `Laya DoneGate: работа заявлена завершённой, но доказательств не хватает — ${highGaps.map((g) => g.detail).join("; ")}. ` +
          (checkHint ? `Запусти laya_run_check("${checkHint}") и покажи exit code, ` : `Запусти доступную проверку и покажи exit code, `) +
          `либо явно отметь, что проверка невозможна (untested).`,
      };
      updateLedger(sessionId, (l) => {
        l.blocks = (l.blocks || 0) + 1;
        bumpCounter(l, "done_block");
      }, cfg);
    } else {
      blockSkipped = `permission_mode=${permissionMode ?? "unknown"} вне activeModes`;
    }
  }

  const notifyGaps = gaps.filter((g) => g.notify === true);
  // Уведомление — не блокировка, но и не навязчивое: максимум один раз на
  // сессию и только если блокировка ещё не использовалась.
  const notifyAllowed = !output && !stopHookActive && (ledger.blocks || 0) === 0 && (ledger.counters?.done_notify || 0) === 0;
  if (notifyAllowed && cfg.doneGate.notify !== false && notifyGaps.length > 0) {
    action = "notify";
    const checkHint = notifyGaps.find((g) => g.check_id)?.check_id;
    const message =
      `Laya DoneGate: ${notifyGaps.map((g) => g.detail).join("; ")}. ` +
      (checkHint ? `Запусти laya_run_check("${checkHint}") и покажи exit code. ` : `Покажи фактическую проверку или отметь untested. `) +
      `Это уведомление, не блокировка.`;
    output = {
      // Continue без decision:"block": уведомление должно попасть в контекст
      // агента, иначе Stop завершает ход и additionalContext никто не прочитает.
      // Ограничение — один раз на сессию (done_notify).
      continue: true,
      stopReason: message,
      hookSpecificOutput: {
        hookEventName: "Stop",
        additionalContext: message,
      },
    };
    updateLedger(sessionId, (l) => bumpCounter(l, "done_notify"), cfg);
  } else if (!output && gaps.length > 0) {
    updateLedger(sessionId, (l) => bumpCounter(l, "done_gap_logged"), cfg);
  }

  recordEvent(
    {
      kind: "done_gate",
      sessionId,
      source: "hook:stop",
      mode,
      action,
      reason: gaps.map((g) => g.id).join(",") || "no-gaps",
      latencyMs: null,
      questionSetVersion: "done-v2",
      extra: {
        gaps: gaps.map((g) => `${g.id}:${g.severity}`),
        changed_files: (ledger.changedFiles || []).length,
        checks_in_ledger: (ledger.checks || []).length,
        checks_from_project: projectChecks.length,
        available_checks: Object.keys(discovered),
        permission_mode: permissionMode,
        active_in_mode: activeInMode,
        block_skipped: blockSkipped,
      },
    },
    cfg,
  );

  recordPolicyEvent({
    action,
    basis: "evidence",
    ruleIds: gaps.map((g) => g.id),
    reason: gaps.map((g) => g.detail).join("; ") || "no-gaps",
    layaCalled: false,
    evidence: {
      gaps: gaps.map((g) => ({ id: g.id, severity: g.severity, detail: g.detail, check_id: g.check_id || null })),
      changed_files: (ledger.changedFiles || []).length,
      checks: mergedChecks.slice(-20),
      available_checks: Object.keys(discovered),
      permission_mode: permissionMode,
      block_skipped: blockSkipped,
    },
    operation: "done_gate",
    status: "completed",
  });

  return { output, telemetry: { gaps, action, permissionMode, blockSkipped, availableChecks: Object.keys(discovered) } };
}

// -------------------------------------------------------- SessionStart

export async function sessionStartGate(input, deps = {}) {
  const cfg = deps.cfg || loadConfig();
  const client = deps.client;
  const sessionId = input?.session_id || "unknown";
  const cwd = input?.cwd || process.cwd();
  updateLedger(sessionId, (l) => {
    l.cwd = cwd;
    if (!l.createdAt) l.createdAt = Date.now();
  }, cfg);

  let output = null;
  // Health — один раз на старте сессии (и при диагностике через laya_health),
  // а не на каждом ходе: строка контекста стоит токенов, а статус не меняет
  // решения. Никакого обязательного laya_* вызова здесь больше нет.
  if (cfg.sessionContext && client) {
    const h = await client.health({ cfg });
    const modes = Array.isArray(cfg.riskGate.activeModes) && cfg.riskGate.activeModes.length
      ? cfg.riskGate.activeModes.join(",")
      : "все";
    const line = h.ok
      ? `Laya: готова (${h.device}, ${h.checkpointId || "чекпоинт неизвестен"}). Режимы: risk=${cfg.riskGate.mode}, done=${cfg.doneGate.mode}, router=${cfg.router.mode}; гейты вмешиваются только в: ${modes}.`
      : `Laya: недоступна (${h.error?.code || "error"}) — работа продолжается штатно, разрешения не изменяются.`;
    output = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: line } };
  }
  return { output, telemetry: { cwd } };
}

// ------------------------------------------------------ UserPromptSubmit

/**
 * TaskRouter: рекомендация класса задачи. Модель НЕ переключается — штатный
 * UserPromptSubmit этого не умеет, и делать вид, что умеет, запрещено ТЗ.
 * Режимы: log — только метрика; advise — одна короткая строка в контекст.
 */
export async function userPromptGate(input, deps = {}) {
  const cfg = deps.cfg || loadConfig();
  const client = deps.client;
  const sessionId = input?.session_id || "unknown";
  const prompt = String(input?.prompt || "");
  if (!prompt || cfg.router.mode === "off" || !client) {
    return { output: null, telemetry: null };
  }
  const prepared = prepareForLaya(maskText(prompt, cfg.riskGate.extraSecrets), 4000, cfg.riskGate.extraSecrets);
  const laya = await decideFitted(prepared.text, routerQuestions(), { cfg, client, onOverflow: "shrink" });
  const rec = interpretRouter(laya, cfg);
  recordEvent(
    {
      kind: "router",
      sessionId,
      source: "hook:user-prompt-submit",
      mode: cfg.router.mode,
      action: rec.available ? `class:${rec.taskClass}` : "unavailable",
      reason: rec.reason || null,
      elapsedMs: laya?.elapsedMs ?? null,
      checkpoint: laya?.checkpoint || null,
      questionSetVersion: "router-v2",
      stateHash: await textHash(prepared.text),
      scores: scoresFromDecide(laya),
      inferenceError: laya && !laya.ok ? laya.error?.code : null,
      extra: rec.available ? { trivial: rec.trivial, investigation: rec.investigation, basis: rec.basis, confidence: rec.confidence } : null,
    },
    cfg,
  );
  recordPolicyEvent({
    action: rec.available ? `class:${rec.taskClass}` : "unavailable",
    basis: "router",
    ruleIds: [],
    reason: rec.reason || "",
    layaCalled: Boolean(laya && laya.ok),
    fallback: Boolean(laya && !laya.ok),
    input: { original_redacted: prompt, effective_redacted: prepared.text },
    fit: laya?.fit || null,
    result: laya
      ? {
          elapsed_ms: laya.elapsedMs,
          checkpoint: laya.checkpoint,
          selected: rec.taskClass || "",
          confidence: rec.confidence ?? null,
          trivial: rec.trivial ?? null,
          investigation: rec.investigation ?? null,
        }
      : null,
    evidence: { thresholds: rec.thresholds || null, basis: rec.basis || null },
    operation: "router",
    callId: laya?.call_id,
    status: "completed",
  });
  let output = null;
  // По умолчанию router.mode="log": класс задачи уходит в метрики, а не в
  // каждый промпт. advise оставлен только как явный opt-in для замеров.
  if (cfg.router.mode === "advise" && rec.available && rec.suggestion) {
    output = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `Laya (класс задачи: ${rec.taskClass}, p=${rec.confidence?.toFixed?.(2) ?? "?"}): ${rec.suggestion.text}. Это рекомендация, а не переключение модели.`,
      },
    };
  }
  return { output, telemetry: rec };
}
