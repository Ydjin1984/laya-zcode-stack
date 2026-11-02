// Конфигурация плагина davinci-laya-decisions.
//
// Иерархия: значения по умолчанию (этот файл) ← config.json в каталоге данных
// плагина (его правит пользователь) ← переменные окружения (адрес Laya, путь к
// данным). Ничего не читается из установочного каталога: обновление плагина не
// должно затирать настройки и историю.
//
// Все режимы по умолчанию — максимально консервативные:
//   riskGate.mode  = "shadow"  — считать, логировать, НЕ менять разрешения;
//   doneGate.mode  = "report"  — сообщать о пробелах в доказательствах, не блокировать;
//   router.mode    = "log"     — записывать рекомендацию, не влиять на промпт.
// Переход в активные режимы («ask», «block», «advise») — осознанный шаг
// пользователя после калибровки на своих данных (§6 ТЗ DaVinci).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Корень каталогов данных плагинов ZCode (создаёт сам ZCode при установке). */
function pluginDataRoot() {
  return path.join(os.homedir(), ".zcode", "cli", "plugins", "data");
}

/**
 * Каталог, которым пользуется сам плагин в ZCode: ZCode передаёт его хукам и
 * MCP через ZCODE_PLUGIN_DATA/DAVINCI_LAYA_DATA. Ручной запуск CLI из обычного
 * shell этих переменных не имеет и раньше писал в запасной каталог — режимы и
 * метрики расходились: /laya-all сообщал об успехе, а хуки читали другой
 * config.json (живой случай 2026-10-15). Поэтому без переменных выбираем самый
 * свежий существующий каталог данных плагина; иначе — запасной путь.
 */
function livePluginDataDir() {
  let best = null;
  let bestTime = -1;
  try {
    for (const name of fs.readdirSync(pluginDataRoot())) {
      if (!name.startsWith("davinci-laya-decisions@")) continue;
      const dir = path.join(pluginDataRoot(), name);
      try {
        const t = fs.statSync(path.join(dir, "config.json")).mtimeMs;
        if (t > bestTime) {
          bestTime = t;
          best = dir;
        }
      } catch {
        /* без config.json каталог не считается активным */
      }
    }
  } catch {
    /* каталога нет: установка без ZCode или тесты */
  }
  return best;
}

/** Все существующие каталоги данных (для диагностики расхождений в status). */
export function allDataDirs() {
  const out = [];
  try {
    for (const name of fs.readdirSync(pluginDataRoot())) {
      if (name.startsWith("davinci-laya-decisions@")) out.push(path.join(pluginDataRoot(), name));
    }
  } catch {
    /* нет каталога */
  }
  out.push(path.join(os.homedir(), ".zcode", "davinci-laya-decisions"));
  return out;
}

/** Каталог данных плагина: сюда пишутся config.json, ledger, метрики, чанки. */
export function dataDir() {
  const candidates = [
    process.env.DAVINCI_LAYA_DATA,
    process.env.ZCODE_PLUGIN_DATA,
    process.env.CLAUDE_PLUGIN_DATA,
  ];
  for (const c of candidates) {
    // Неразвёрнутая подстановка ("${CLAUDE_PLUGIN_DATA}") — это «переменная не
    // задана», а не путь: писать в каталог с таким именем нельзя.
    if (c && !c.includes("${")) return c;
  }
  // Без переменных окружения — работаем с тем же каталогом, что хуки и MCP:
  // ledger, метрики и config должны совпадать у CLI и рантайма.
  return livePluginDataDir() || path.join(os.homedir(), ".zcode", "davinci-laya-decisions");
}

export const DEFAULTS = {
  // Адрес локального decision-engine. Переопределяется DAVINCI_LAYA_URL.
  layaUrl: "http://127.0.0.1:8095",
  // Таймаут одного запроса к Laya. Локальный инференс — десятки миллисекунд;
  // 1500 мс уже аномалия, но даём запас на холодный старт.
  timeoutMs: 1500,
  // Предохранитель: после стольких подряд ошибок Laya не опрашивается cooldownMs.
  circuitBreaker: { failures: 5, cooldownMs: 30_000 },

  riskGate: {
    // off — выключен; shadow — только локальный лог; ask — может вернуть
    // permissionDecision:"ask" (никогда не allow/deny).
    mode: "shadow",
    // Режимы разрешений ZCode, в которых гейт вправе спрашивать.
    // guarded = «Autonomous mode»; yolo («Full access»), build, edit, plan —
    // только лог без каких-либо вопросов. Пустой массив — без фильтра.
    activeModes: ["guarded"],
    // Когда спрашивать Laya: smart — кроме явно читающих команд (ls/git status/…),
    // always — на каждом подходящем вызове, never — только детерминированные
    // правила. Smart выбран по замеру: на безопасных командах Laya не добавляла
    // эскалаций, а вызов стоит ~150 мс на каждый tool call.
    layaPolicy: "smart",
    // Инструменты, на которых работает гейт (регексп имён ZCode).
    tools: "Bash|Write|Edit|MultiEdit|ApplyPatch",
    // Порог answer_confidence, ниже которого вердикт Laya не поднимает вопрос.
    askMinConfidence: 0.7,
    // Жёсткий предохранитель от гигантских команд/логов. Реальный бюджет
    // считает /count по полной постановке вопроса (см. budget.mjs): число
    // символов не выражает токены, особенно для кириллицы и длинных вариантов.
    stateCharBudget: 20_000,
    // Требовать детерминированный сигнал (совпадение правила) для ask даже при
    // высоком риске Laya. false — достаточно калиброванного вердикта Laya.
    askRequiresDeterministicSignal: false,
    // Добавлять ОДНУ короткую строку в контекст модели при риске high, не поднимая
    // вопрос перед пользователем. Работает в shadow (Full access), где спросить
    // нельзя, но предупредить агента до выполнения — полезно. На обычных вызовах
    // не добавляет ничего (0 токенов).
    warnHighRisk: false,
    // Дополнительные регулярные выражения-правила (см. decision-policy.mjs).
    extraRules: [],
    // Дополнительные литеральные секреты для маскирования.
    extraSecrets: [],
  },

  doneGate: {
    // off — выключен; report — только лог; block — одна блокировка на сессию
    // при подтверждённых детерминированных пробелах (тесты не запускались и т.п.).
    mode: "report",
    // Блокировать завершение можно только в Autonomous mode; в Full access
    // и остальных режимах пробелы лишь логируются.
    activeModes: ["guarded"],
    maxBlocksPerSession: 1,
    // Команды, считающиеся проверками (тест/lint/typecheck/сборка).
    checks: [
      { kind: "test", re: "(^|[\\s;&|(])(go\\s+test|npm\\s+(run\\s+)?test|yarn\\s+test|pnpm\\s+(run\\s+)?test|npx\\s+(jest|vitest|mocha)|pytest|python\\s+-m\\s+pytest|cargo\\s+test|dotnet\\s+test|mvn\\s+test|gradle(w)?\\s+test|jest|vitest|node\\s+[^\\s;&|]*\\btests?\\b[^\\s;&|]*)" },
      { kind: "lint", re: "(^|[\\s;&|(])(eslint|ruff|flake8|pylint|golangci-lint|npm\\s+run\\s+lint|yarn\\s+lint|pnpm\\s+(run\\s+)?lint|cargo\\s+clippy)" },
      { kind: "typecheck", re: "(^|[\\s;&|(])(tsc\\b|npx\\s+tsc|mypy|pyright|npm\\s+run\\s+(typecheck|types)|yarn\\s+(typecheck|types))" },
      { kind: "build", re: "(^|[\\s;&|(])(npm\\s+run\\s+build|yarn\\s+build|pnpm\\s+(run\\s+)?build|cargo\\s+build|go\\s+build|dotnet\\s+build|mvn\\s+(package|verify)|gradle(w)?\\s+build|make\\b)" },
    ],
    // Крупные команды, после которых «код не менялся» — уже не аргумент.
    codeTools: ["Write", "Edit", "MultiEdit", "ApplyPatch"],
    // Короткое уведомление в Stop при конкретном незакрытом пункте (доступная
    // проверка не запускалась/упала). Это не блокировка и не подтверждение.
    notify: true,
  },

  // Бюджет модели Laya. max_len — вся последовательность, включая вопрос и
  // варианты; head_max_len — инструкция + варианты. Поэтому перед /decide
  // вызывается /count с теми же questions, а не режется state по символам.
  budget: {
    maxLen: 1024,
    hardStateChars: 20_000,
    marginTokens: 12,
  },

  // laya_run_check: команды только из конфигурации/автопоиска проекта.
  // Модель передаёт check_id, а не произвольную команду.
  runChecks: {
    autoDiscover: true,
    commands: {}, // id -> "команда" | {command, kind, cwd}
    timeoutMs: 180_000,
  },

  // laya_search: сам выполняет поиск; это верхние пределы, не бюджет ответа.
  search: {
    maxHits: 200,
    contextLines: 2,
    timeoutMs: 15_000,
  },

  // laya_read_relevant: бюджет ответа агенту в символах (не в токенах Laya —
  // выдержки сюда не отправляются целиком).
  readRelevant: {
    maxBytes: 2 * 1024 * 1024,
    budget: 8000,
    contextLines: 6,
    maxBlocks: 8,
  },

  router: {
    // off — ничего; log — запись рекомендации в метрики; advise — короткая
    // строка-рекомендация в контекст (каждый совет стоит токенов главной модели).
    mode: "log",
    minConfidence: 0.6,
    // Пороги бинарной пары (router-v2). Подобраны на размеченном наборе:
    // scripts/laya-router-thresholds.mjs. Точность сигнала ≈ 58% — это совет,
    // а не решение, и никогда не основание для автопереключения модели.
    trivialThreshold: 0.7,
    investigationThreshold: 0.7,
  },

  // SessionStart: по умолчанию одна строка статуса Laya на старте сессии.
  // Это не влияет на разрешения и не добавляет вызов на каждый ход.
  sessionContext: true,

  // Laya-first включён по умолчанию: низкие пороги применения self-fetching
  // инструментов (search/read_relevant/run_check/triage/rank). Это НЕ требование
  // вызывать Laya каждый ход: мелкие операции читаются напрямую, а инструменты
  // применяются там, где заменяют чтение. Режим не меняет risk/done/activeModes.
  layaAll: true,

  ledger: { maxEventsPerSession: 800, ttlHours: 72 },
  telemetry: { enabled: true, keepDays: 14 },
  // Панель Laya Work. Быстрый путь — spool-файл в каталоге движка; HTTP —
  // резервный транспорт для внешних клиентов. Пустые spoolDir/url означают
  // «панель не настроена»: события не пишутся и хуки не замедляются.
  work: {
    enabled: true,
    url: "",
    spoolDir: "",
    token: "",
    tokenFile: "",
    timeoutMs: 400,
    maxSpoolFiles: 5000,
  },
  // Хранилище вытесненных чанков (ContextSelector): сколько файлов держать.
  chunks: { maxFiles: 500 },
};

/** Глубокое слияние: объекты сливаются, массивы и скаляры заменяются целиком. */
function merge(base, override) {
  if (override === undefined || override === null) return base;
  if (Array.isArray(base) || Array.isArray(override)) return override;
  if (typeof base !== "object" || typeof override !== "object") return override;
  const out = { ...base };
  for (const key of Object.keys(override)) out[key] = merge(base[key], override[key]);
  return out;
}

/**
 * Загружает эффективную конфигурацию. Ошибки чтения/парсинга не должны ломать
 * хуки: при любой проблеме возвращаются значения по умолчанию, а текст ошибки
 * попадает в stderr (виден в логе ZCode).
 */
export function loadConfig() {
  const dir = ensureDataDir();
  let cfg = DEFAULTS;
  const file = path.join(dir, "config.json");
  try {
    if (fs.existsSync(file)) {
      cfg = merge(DEFAULTS, JSON.parse(fs.readFileSync(file, "utf8")));
    }
  } catch (err) {
    process.stderr.write(`[davinci-laya] config.json не прочитан (${err.message}) — беру значения по умолчанию\n`);
  }
  if (process.env.DAVINCI_LAYA_URL) cfg.layaUrl = process.env.DAVINCI_LAYA_URL;
  if (process.env.DAVINCI_LAYA_TIMEOUT_MS) {
    const v = Number.parseInt(process.env.DAVINCI_LAYA_TIMEOUT_MS, 10);
    if (Number.isFinite(v) && v > 0) cfg.timeoutMs = v;
  }
  if (process.env.DAVINCI_LAYA_WORK_ENABLED !== undefined) {
    cfg.work.enabled = !["0", "false", "off", "no"].includes(String(process.env.DAVINCI_LAYA_WORK_ENABLED).toLowerCase());
  }
  if (process.env.DAVINCI_LAYA_WORK_URL) cfg.work.url = process.env.DAVINCI_LAYA_WORK_URL;
  if (process.env.DAVINCI_LAYA_WORK_SPOOL) cfg.work.spoolDir = process.env.DAVINCI_LAYA_WORK_SPOOL;
  if (process.env.DAVINCI_LAYA_WORK_TOKEN) cfg.work.token = process.env.DAVINCI_LAYA_WORK_TOKEN;
  if (process.env.DAVINCI_LAYA_WORK_TOKEN_FILE) cfg.work.tokenFile = process.env.DAVINCI_LAYA_WORK_TOKEN_FILE;
  return cfg;
}

/** Создаёт каталог данных и (при первом запуске) файл конфигурации. */
export function ensureDataDir() {
  const dir = dataDir();
  fs.mkdirSync(path.join(dir, "state", "chunks"), { recursive: true });
  fs.mkdirSync(path.join(dir, "metrics"), { recursive: true });
  const file = path.join(dir, "config.json");
  if (!fs.existsSync(file)) {
    const sample = {
      _readme: [
        "Конфигурация плагина davinci-laya-decisions. Значения ниже — режимы по",
        "умолчанию (shadow/report/log). Переключение в ask/block/advise — после",
        "калибровки на своих данных: /laya-status покажет текущие режимы и метрики.",
      ].join(" "),
      riskGate: { mode: "shadow", askMinConfidence: 0.7, stateCharBudget: 20000 },
      doneGate: { mode: "report", maxBlocksPerSession: 1, notify: true },
      router: { mode: "log" },
      sessionContext: true,
      layaAll: true,
      layaUrl: process.env.DAVINCI_LAYA_URL || DEFAULTS.layaUrl,
      timeoutMs: DEFAULTS.timeoutMs,
    };
    try {
      fs.writeFileSync(file, JSON.stringify(sample, null, 2) + "\n", "utf8");
    } catch (err) {
      process.stderr.write(`[davinci-laya] не удалось создать config.json: ${err.message}\n`);
    }
  }
  return dir;
}

export function paths() {
  const dir = dataDir();
  return {
    dir,
    config: path.join(dir, "config.json"),
    stateDir: path.join(dir, "state"),
    chunksDir: path.join(dir, "state", "chunks"),
    metricsDir: path.join(dir, "metrics"),
    ledger: (sessionId) => path.join(dir, "state", `ledger-${safeId(sessionId)}.json`),
    breaker: path.join(dir, "state", "circuit-breaker.json"),
  };
}

/** Идентификатор сессии в имени файла: только безопасные символы. */
export function safeId(id) {
  return String(id || "unknown").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 96);
}
