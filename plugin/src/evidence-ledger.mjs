// EvidenceLedger — минимальная история доказательств по сессии.
//
// Хранит только факты, которые нельзя вывести из «модель так сказала»: какие
// файлы менялись, какие проверки запускались и с каким кодом, какие ошибки
// инструментов остались неразрешёнными. Содержимое файлов и полные команды не
// сохраняются — только усечённые безопасные формы (§9.7 ТЗ: логи краткие, без
// секретов и полного prompt по умолчанию).
//
// Ledger — файл на сессию в каталоге данных плагина: хуки и MCP-сервер видят его
// из разных процессов, поэтому in-memory состояние здесь непригодно.

import fs from "node:fs";
import path from "node:path";
import { loadConfig, paths, safeId } from "./config.mjs";
import { clampValue, maskText, textHash } from "./sanitize.mjs";

const empty = (sessionId) => ({
  sessionId: sessionId || "unknown",
  createdAt: Date.now(),
  updatedAt: Date.now(),
  cwd: "",
  toolCalls: 0,
  changedFiles: [],
  checks: [], // {kind, command, exitCode, ts}
  unresolvedErrors: [], // {tool, code, ts}
  lastGitStatus: "",
  lastChangeTs: 0, // время последней правки файла (для «после теста»)
  blocks: 0, // сколько раз DoneGate блокировал завершение (ограничен)
  counters: {}, // счётчики гейтов: {risk_ask: 2, risk_high: 5, ...}
});

/** Читает ledger сессии; при отсутствии/порче — пустой (не бросает). */
export function readLedger(sessionId, cfg = loadConfig()) {
  const file = paths().ledger(sessionId);
  try {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      const base = empty(sessionId);
      return { ...base, ...parsed, counters: parsed.counters || {} };
    }
  } catch {
    /* нет файла или битый JSON — начинаем сессию заново */
  }
  return empty(sessionId);
}

/** Атомарно записывает ledger (tmp + rename), чтобы параллельные хуки не рвали файл. */
export function writeLedger(ledger, cfg = loadConfig()) {
  const file = paths().ledger(ledger.sessionId);
  ledger.updatedAt = Date.now();
  // TTL и лимит: старые сессии сами исчезают, файл не растёт бесконечно.
  const maxEvents = cfg.ledger.maxEventsPerSession;
  ledger.unresolvedErrors = (ledger.unresolvedErrors || []).slice(-Math.max(8, Math.floor(maxEvents / 8)));
  ledger.checks = (ledger.checks || []).slice(-Math.max(16, Math.floor(maxEvents / 4)));
  ledger.changedFiles = [...new Set(ledger.changedFiles || [])].slice(-maxEvents);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(ledger), "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    process.stderr.write(`[davinci-laya] ledger не записан: ${err.message}\n`);
  }
  return ledger;
}

/** Обновляет ledger функцией-мутатором. Возвращает обновлённый ledger. */
export function updateLedger(sessionId, mutator, cfg = loadConfig()) {
  const ledger = readLedger(sessionId, cfg);
  mutator(ledger);
  return writeLedger(ledger, cfg);
}

/** Убирает слишком старые ledger-файлы (вызывается нечасто). */
export function pruneLedgers(cfg = loadConfig()) {
  const ttlMs = (cfg.ledger.ttlHours || 72) * 3600_000;
  const dir = paths().stateDir;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith("ledger-")) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (Date.now() - st.mtimeMs > ttlMs) fs.unlinkSync(full);
    }
  } catch {
    /* каталога нет — нечего чистить */
  }
}

/** Счётчики гейтов: сюда пишется каждое решение (для /laya-status и A/B). */
export function bumpCounter(ledger, key, by = 1) {
  ledger.counters = ledger.counters || {};
  ledger.counters[key] = (ledger.counters[key] || 0) + by;
}

// ------------------------------------------------- разбор событий инструментов

/** Команда считается изменяющей файлы, если это не чистое чтение/запрос. */
const READ_ONLY_CMD_RE = /^\s*(ls|dir|cat|type|head|tail|grep|rg|find|findstr|git\s+(status|log|diff|show|branch|remote)|npm\s+(ls|view)|node\s+--version|go\s+version|where|which|echo|pwd|cd)\b/i;

/**
 * Дополняет ledger по факту выполненного инструмента (PostToolUse).
 * `ok` — успех инструмента; при false ошибка уходит в unresolvedErrors.
 */
export function recordToolUse(sessionId, { toolName, toolInput, ok, error, cfg = loadConfig() }) {
  return updateLedger(
    sessionId,
    (l) => {
      l.toolCalls += 1;
      const input = toolInput || {};
      if (cfg.doneGate.codeTools.includes(toolName)) {
        const p = input.file_path || input.path;
        if (p) {
          if (!l.changedFiles.includes(p)) l.changedFiles.push(p);
          // Файл менялся — значит предыдущий успешный тест устарел.
          l.changedAfterLastTest = true;
          l.lastChangeTs = Date.now();
        }
      }
      if (toolName === "Bash" && typeof input.command === "string") {
        const cmd = input.command;
        const masked = maskText(cmd);
        // git status --porcelain — дешёвое доказательство состояния дерева;
        // сохраняем только его (короткий вывод), чтобы RiskGate не запускал
        // новый тяжёлый git-вызов при каждом tool call.
        if (/git\s+status\b/.test(cmd) && ok && input.__result_stdout) {
          l.lastGitStatus = clampValue(String(input.__result_stdout), 400);
        }
        if (!READ_ONLY_CMD_RE.test(cmd)) {
          for (const c of cfg.doneGate.checks) {
            if (new RegExp(c.re, "i").test(cmd)) {
              l.checks.push({
                kind: c.kind,
                command: clampValue(masked, 200),
                exitCode: ok ? 0 : (error?.exitCode ?? 1),
                ts: Date.now(),
              });
              if (ok && c.kind === "test") l.changedAfterLastTest = false;
              break;
            }
          }
        }
      }
      if (!ok) {
        l.unresolvedErrors.push({ tool: toolName, code: clampValue(String(error?.code || error?.message || "failure"), 160), ts: Date.now() });
      }
    },
    cfg,
  );
}

/** Краткая сводка для state DoneGate (без полного содержимого). */
export function ledgerSummary(ledger) {
  const checks = ledger.checks || [];
  const tests = checks.filter((c) => c.kind === "test");
  const lines = [
    `Изменённых файлов: ${(ledger.changedFiles || []).length}`,
    `Вызовов инструментов: ${ledger.toolCalls}`,
    `Проверок запущено: ${checks.length} (тестов: ${tests.length})`,
  ];
  if (tests.length) {
    const last = tests[tests.length - 1];
    lines.push(`Последний тест: код ${last.exitCode}`);
  }
  if ((ledger.unresolvedErrors || []).length) lines.push(`Необработанных ошибок: ${ledger.unresolvedErrors.length}`);
  return lines.join("\n");
}

// ------------------------------------- проектные проверки (laya_run_check)
//
// MCP-сервер не знает session_id, а доказательство проверки должно пережить
// границу процессов и попасть в StopGate. Поэтому проверки пишутся в отдельный
// файл, привязанный к корню проекта, и StopGate подмешивает их к ledger.

function projectChecksFile(projectDir) {
  const key = safeId(textHash(path.resolve(String(projectDir || "."))));
  return path.join(paths().stateDir, `project-checks-${key}.json`);
}

/** Записывает факт запуска проверки (последние 50 на проект). */
export function recordProjectCheck(projectDir, entry) {
  const file = projectChecksFile(projectDir);
  const row = {
    checkId: String(entry?.checkId || "check").slice(0, 80),
    kind: String(entry?.kind || "custom").slice(0, 40),
    command: clampValue(String(entry?.command || ""), 200),
    exitCode: typeof entry?.exitCode === "number" ? entry.exitCode : null,
    timedOut: entry?.timedOut === true,
    ts: Number(entry?.ts) || Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    let rows = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) rows = parsed;
    } catch {
      /* новый файл */
    }
    rows.push(row);
    rows = rows.slice(-50);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rows), "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    process.stderr.write(`[davinci-laya] project checks не записаны: ${err.message}\n`);
  }
  return row;
}

/** Читает факты проверок проекта (пустой массив при отсутствии). */
export function readProjectChecks(projectDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectChecksFile(projectDir), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export { safeId };
