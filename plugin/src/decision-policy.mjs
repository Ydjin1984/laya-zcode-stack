// decision-policy.mjs — политика решений: правила, приоритеты, fail-open.
//
// Главный принцип (§6 ТЗ DaVinci): вероятность от Laya и детерминированный факт —
// разные вещи, и смешивать их нельзя.
//   1. Детерминированные правила (пути вне workspace, удаление, секреты в сеть,
//      системные команды) имеют приоритет и не зависят от Laya.
//   2. Laya даёт оценку риска для неоднозначных случаев и никогда не может
//      «разрешить» то, что запрещено правилами, — на выходе гейта вообще нет
//      allow/deny: только none (без изменений) и ask (спросить пользователя).
//   3. Любая ошибка Laya = отсутствие мнения, а не «низкий риск».

import { isSecretPath, maskText } from "./sanitize.mjs";
import { ROUTER_TRIVIAL_Q, ROUTER_INVESTIGATION_Q, ROUTER_THRESHOLDS, deriveTaskClass } from "./router-cases.mjs";
import { summarizeChanges, availableCheckKinds, firstCheckOfKind } from "./project.mjs";

// ------------------------------------------------------------- правила

/**
 * Детерминированные правила риска. `risk`: high — необратимые последствия,
 * medium — потенциальная потеря или утечка при неверном шаге.
 * `tools` — ограничение по инструментам; без него правило применяется к строке
 * команды/аргументов любого инструмента.
 */
export const DETERMINISTIC_RULES = [
  // --- удаление и перезапись данных ---
  { id: "rm-recursive-force", re: /(^|[;&|(\s])rm\s+(-[a-z]*[rf][a-z]*\s+)+/i, risk: "high", kind: "data_loss" },
  { id: "rmdir-recursive", re: /(^|[;&|(\s])(rd|rmdir)\s+\/s/i, risk: "high", kind: "data_loss" },
  { id: "del-recursive-force", re: /(^|[;&|(\s])(del|erase)\s+(\/[a-z-]+\s+)*(\/[a-z]*[sfq])/i, risk: "high", kind: "data_loss" },
  { id: "remove-item-recurse", re: /remove-item\b[^\n]*(-recurse|\s-r\b)/i, risk: "high", kind: "data_loss" },
  { id: "git-reset-hard", re: /git\s+reset\s+--hard/i, risk: "high", kind: "data_loss" },
  { id: "git-clean-force", re: /git\s+clean\s+-[a-z]*[fdx]/i, risk: "high", kind: "data_loss" },
  { id: "git-checkout-discard", re: /git\s+checkout\s+(--\s+)?\.\s*($|[;&|])/i, risk: "high", kind: "data_loss" },
  { id: "git-restore-discard", re: /git\s+restore\b[^\n]*\s\.\s*($|[;&|])/i, risk: "high", kind: "data_loss" },
  { id: "git-stash-drop", re: /git\s+stash\s+(drop|clear)\b/i, risk: "high", kind: "data_loss" },
  { id: "git-branch-force-delete", re: /git\s+branch\s+-D\b/, risk: "medium", kind: "data_loss" },
  { id: "git-push-force", re: /git\s+push\b[^\n]*(\s--force(-with-lease)?|\s-f\b)/i, risk: "high", kind: "external" },
  { id: "truncate-file", re: /(>|truncate\s+-s\s*0)\s*\S+/i, risk: "medium", kind: "data_loss" },

  // --- дисковые и системные операции ---
  { id: "filesystem-format", re: /\b(mkfs(\.\w+)?|format)\s+[a-z]:/i, risk: "high", kind: "system" },
  { id: "dd-to-device", re: /\bdd\b[^\n]*of=\/dev\//i, risk: "high", kind: "system" },
  { id: "reg-delete", re: /\breg\s+delete\b/i, risk: "high", kind: "system" },
  { id: "shutdown-restart", re: /(^|[;&|(\s])(shutdown|reboot|halt|poweroff)(\s|$)/i, risk: "high", kind: "system" },
  { id: "taskkill-force", re: /taskkill\b[^\n]*\/f/i, risk: "medium", kind: "system" },
  { id: "stop-process-force", re: /stop-process\b[^\n]*-force/i, risk: "medium", kind: "system" },
  { id: "chmod-world-writable", re: /chmod\s+(-[a-z-]+\s+)*(\d?777|a\+rwx)/i, risk: "medium", kind: "system" },
  { id: "chown-recursive", re: /chown\s+-R\b/i, risk: "medium", kind: "system" },
  { id: "acl-grant-everyone", re: /icacls\b[^\n]*\/grant\b/i, risk: "medium", kind: "system" },
  { id: "takeown", re: /\btakeown\b/i, risk: "medium", kind: "system" },
  { id: "service-disable", re: /(sc\s+(config|delete)|systemctl\s+(disable|mask|stop))\b/i, risk: "medium", kind: "system" },
  { id: "firewall-change", re: /(netsh\s+advfirewall|ufw\s+(disable|allow)|iptables\s+-F)\b/i, risk: "high", kind: "system" },

  // --- базы данных и инфраструктура ---
  { id: "sql-destructive", re: /\b(drop\s+(table|database|schema)|truncate\s+table|delete\s+from\s+\w+\s*;?$)/i, risk: "high", kind: "data_loss" },
  { id: "kubectl-delete", re: /kubectl\s+delete\b/i, risk: "high", kind: "prod" },
  { id: "docker-prune", re: /docker\s+(system|volume|image|container)\s+prune\b/i, risk: "medium", kind: "system" },
  { id: "publish-release", re: /\b(npm\s+publish|yarn\s+publish|twine\s+upload|cargo\s+publish|gh\s+release\s+create)\b/i, risk: "high", kind: "external" },
  { id: "find-delete", re: /\bfind\b[^\n]*\s-(delete|exec\s+rm)\b/i, risk: "high", kind: "data_loss" },
  { id: "xargs-remove", re: /\bxargs\b[^\n]*\b(rm|del|rmdir)\b/i, risk: "high", kind: "data_loss" },
  { id: "move-overwrite", re: /\bmv\b[^\n]*\s-f\b/i, risk: "medium", kind: "data_loss" },

  // --- конфигурация и секреты ---
  { id: "env-file-write", pathRe: /(^|[\\/])\.env(\.(local|dev|prod|production|staging))?$/i, tools: ["Write", "Edit", "MultiEdit", "ApplyPatch"], risk: "medium", kind: "config" },
  { id: "private-key-read", pathRe: /(^|[\\/])(id_rsa|id_ed25519|id_ecdsa|\.netrc|\.git-credentials|credentials|\.npmrc|\.pypirc)$/i, risk: "medium", kind: "secret" },
  { id: "ssh-dir-access", pathRe: /(^|[\\/])\.ssh([\\/]|$)/i, risk: "medium", kind: "secret" },
  { id: "cloud-credentials", pathRe: /\.aws[\\/]credentials$|\.config[\\/]gcloud[\\/]|\.azure[\\/]/i, risk: "high", kind: "secret" },
  { id: "prod-config-write", pathRe: /(production|prod)\.(json|ya?ml|toml|env|config\.\w+)$/i, tools: ["Write", "Edit", "MultiEdit", "ApplyPatch"], risk: "high", kind: "config" },
  { id: "workflow-write", pathRe: /(^|[\\/])\.github[\\/]workflows[\\/]/i, tools: ["Write", "Edit", "MultiEdit", "ApplyPatch"], risk: "medium", kind: "config" },
  { id: "git-hooks-write", pathRe: /(^|[\\/])\.git[\\/]hooks[\\/]/i, tools: ["Write", "Edit", "MultiEdit", "ApplyPatch"], risk: "medium", kind: "config" },
];

/** Сетевые инструменты, через которые возможна отправка данных наружу. */
const NETWORK_TOOLS_RE = /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|nc|ncat|netcat|scp|sftp|ftp|ssh)\b/i;

/** Шаблоны секретов в аргументах (после маскирования их уже не видно — ищем до). */
const SECRET_INPUT_RE = [
  /\b(sk-[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/,
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/,
  /\b(bearer\s+[A-Za-z0-9._~+/=-]{12,}|authorization\s*:\s*\S{8,})/i,
  /\b[A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_.-]*\s*[:=]\s*["']?[^\s"';,]{6,}/i,
];

/** Системные каталоги: запись в них почти всегда означает «мимо проекта». */
const SYSTEM_PATH_RE = /^([a-z]:)?[\\/](windows|program files( \(x86\))?|programdata|etc|usr|bin|sbin|boot|sys|proc|dev)([\\/]|$)/i;

/**
 * Проверяет, находится ли путь внутри рабочего каталога, с учётом Windows/Linux
 * правил. `..` разрешается до сравнения: иначе `cwd\..\..\etc\passwd` выглядел бы
 * «внутри workspace».
 */
export function pathRelation(targetPath, cwd) {
  if (!targetPath || !cwd) return "unknown";
  const norm = (p) => {
    let s = String(p).replace(/\\/g, "/").replace(/\/+/g, "/");
    const isWin = /^[a-z]:/i.test(s);
    const parts = [];
    for (const seg of s.split("/")) {
      if (!seg || seg === ".") continue;
      if (seg === "..") parts.pop();
      else parts.push(isWin ? seg.toLowerCase() : seg);
    }
    return (isWin ? "" : "/") + parts.join("/");
  };
  const t = norm(targetPath);
  const c = norm(cwd);
  if (t === c) return "inside";
  if (t.startsWith(c.endsWith("/") ? c : c + "/")) return "inside";
  if (SYSTEM_PATH_RE.test(t)) return "system";
  return "outside";
}

/**
 * Детерминированное сканирование вызова инструмента. Возвращает список
 * совпавших правил — пустой список означает «правила промолчали», а не
 * «безопасно»: за неоднозначные случаи отвечает следующий слой (Laya).
 */
export function scanDeterministic({ toolName, toolInput, cwd, extraRules = [] }) {
  const hits = [];
  const input = toolInput || {};
  const text = [input.command, input.file_path, input.path, input.pattern, input.content ? "(содержимое)" : ""]
    .filter(Boolean)
    .join("\n");
  // Пути проверяются не только в полях file_path/path, но и ВНУТРИ команды:
  // `cat ~/.aws/credentials` или `scp -i ~/.ssh/id_rsa` — это доступ к секретам
  // через терминал, и path-правила обязаны его видеть.
  const pathCandidates = [input.file_path, input.path];
  if (typeof input.command === "string") pathCandidates.push(input.command.trim().split(/\s+/).pop() || "", input.command);
  const rules = [...DETERMINISTIC_RULES, ...extraRules];
  for (const rule of rules) {
    if (rule.tools && !rule.tools.includes(toolName)) continue;
    if (rule.re && rule.re.test(text)) {
      hits.push({ id: rule.id, risk: rule.risk, kind: rule.kind, layer: "pattern" });
    }
    if (rule.pathRe) {
      for (const cand of pathCandidates) {
        if (cand && rule.pathRe.test(String(cand))) {
          hits.push({ id: rule.id, risk: rule.risk, kind: rule.kind, layer: "path" });
          break;
        }
      }
    }
  }
  // Секреты + сеть в одной команде — отдельный класс: эксфильтрация.
  const rawText = [input.command, input.content, input.new_string].filter(Boolean).join("\n");
  if (rawText && NETWORK_TOOLS_RE.test(text) && SECRET_INPUT_RE.some((re) => re.test(rawText))) {
    hits.push({ id: "secret-over-network", risk: "high", kind: "secret", layer: "combined" });
  }
  // Путь вне workspace — только для инструментов записи и только с реальным путём.
  const p = input.file_path || input.path;
  if (p && ["Write", "Edit", "MultiEdit", "ApplyPatch"].includes(toolName)) {
    const rel = pathRelation(p, cwd);
    if (rel === "system") hits.push({ id: "write-outside-workspace", risk: "high", kind: "path_escape", layer: "path" });
    else if (rel === "outside") hits.push({ id: "write-outside-workspace", risk: "medium", kind: "path_escape", layer: "path" });
  }
  if (p && isSecretPath(p) && ["Write", "Edit", "MultiEdit", "ApplyPatch"].includes(toolName)) {
    hits.push({ id: "secret-file-write", risk: "medium", kind: "secret", layer: "path" });
  }
  // Дубликаты по id не нужны: одно правило — одна запись.
  const seen = new Set();
  return hits.filter((h) => (seen.has(h.id) ? false : (seen.add(h.id), true)));
}

/** Максимальный риск среди совпадений. */
export function maxRisk(hits) {
  if (hits.some((h) => h.risk === "high")) return "high";
  if (hits.some((h) => h.risk === "medium")) return "medium";
  return "none";
}

function riskRank(r) {
  return r === "high" ? 2 : r === "medium" ? 1 : 0;
}

/** Итоговый класс риска: берём максимум из детерминированной оценки и вердикта Laya. */
export function combineRisk(a, b) {
  return riskRank(b) > riskRank(a) ? b : a;
}

// --------------------------------------------------- состояние для Laya

/**
 * Собирает короткое state для RiskGate. Порядок строк — от самого важного к
 * менее важному: состояние режется С КОНЦА, поэтому решающие факты (операция,
 * цель) обязаны стоять первыми и пережить обрезку.
 *
 * Функция НЕ усекает текст: усечение с маркером делает prepareForLaya, чтобы
 * молчаливой потери хвоста не было ни на одном шаге.
 */
export function buildRiskState({ toolName, toolInput, cwd, detHits, gitEvidence }) {
  const input = toolInput || {};
  const lines = [];
  lines.push(`Инструмент: ${toolName}`);
  if (input.command) lines.push(`Команда: ${input.command}`);
  const p = input.file_path || input.path;
  if (p) {
    const rel = pathRelation(p, cwd);
    lines.push(`Путь: ${p} (${rel === "inside" ? "внутри проекта" : rel === "system" ? "СИСТЕМНЫЙ каталог" : rel === "outside" ? "вне проекта" : "неизвестно"})`);
  }
  if (input.old_string !== undefined && input.new_string !== undefined) {
    lines.push(`Правка: замена ${String(input.old_string).length} симв. на ${String(input.new_string).length} симв.`);
  }
  if (detHits.length > 0) {
    lines.push(`Правила: ${detHits.map((h) => `${h.id}(${h.risk})`).join(", ")}`);
  }
  if (gitEvidence) lines.push(`Git: ${gitEvidence}`);
  return lines.join("\n");
}

/**
 * Три вопроса RiskGate (§6.1 ТЗ). Формулировки — часть «question set»: менять их
 * можно только вместе с версией QUESTION_SET_VERSION и повторной калибровкой.
 */
export function riskQuestions() {
  return {
    data_loss: {
      type: "noul",
      instructions: "Уничтожит ли это действие несохранённые или невосстановимые данные пользователя (сброс изменений, удаление файлов, перезапись без копии)?",
    },
    exfiltration: {
      type: "noul",
      instructions: "Может ли это действие отправить секрет (токен, пароль, ключ, содержимое .env) за пределы машины или записать его в открытый файл?",
    },
    risk_class: {
      type: "choice",
      instructions: "Выбери категорию риска действия, если выполнить его как есть.",
      criteria: {
        low: "Чтение или безвредная операция, легко отменяется",
        medium: "Меняет обычные файлы проекта, восстановление возможно (git, бэкап)",
        high: "Потеря данных, утечка секретов, необратимое или внешнее действие",
      },
    },
  };
}

// --------------------------------------------------- политика RiskGate

/**
 * Явно читающие команды: для них Laya не опрашивается при layaPolicy="smart".
 *
 * Почему это безопасно и осмысленно: правила отвечают за полноту (FNR=0 на
 * наборе опасных), а на безопасных командах Laya за 70 замеров ни разу не дала
 * `high` без сигнала правил. Платить 150 мс на `ls`/`git status` за мнение,
 * которое ничего не меняет, нерационально — но любой незнакомый синтаксис
 * (перенаправления, цепочки, произвольные флаги) уходит к модели: список
 * намеренно узкий, «умное» пропускание ошибок здесь дороже экономии.
 */
const READ_ONLY_CMD_RE =
  /^\s*(?:(?:ls|dir|cat|type|head|tail|wc|stat|file|pwd|echo|where|which|whoami|hostname|nvidia-smi)\b[^\n;&|>]*|git\s+(?:status|log|diff|show|branch|remote|tag|describe|rev-parse|ls-files|blame)\b[^\n;&|>]*|npm\s+(?:ls|view|outdated)\b[^\n;&|>]*|node\s+--version|go\s+version|python\s+--version|rg\b[^\n;&|>|]*|grep\b[^\n;&|>]*|findstr\b[^\n;&|>]*|find\b[^\n;&|>]*(?!-delete|-exec))$/i;

/**
 * Нужно ли спрашивать Laya об этом вызове.
 * always — всегда; never — никогда; smart (по умолчанию) — кроме явно читающих.
 * Детерминированные правила выполняются НЕЗАВИСИМО от этого решения.
 */
export function shouldAskLaya({ toolName, toolInput, detHits, policy }) {
  if (policy === "never") return false;
  if (policy === "always") return true;
  // Запись/правка файлов — всегда к модели: правил по содержимому у нас нет.
  if (["Write", "Edit", "MultiEdit", "ApplyPatch"].includes(toolName)) return true;
  // Совпало правило — модель уточняет класс (medium/high/низкий).
  if (detHits.length > 0) return true;
  const cmd = toolInput?.command;
  if (typeof cmd !== "string") return true;
  return !READ_ONLY_CMD_RE.test(cmd);
}

/**
 * Решение по вызову инструмента. Выход — только {action: "none"|"log"|"ask"}:
 * allow/deny здесь не существует по конструкции (§6 ТЗ: низкий риск от Laya
 * никогда не расширяет разрешения, а запрет — прерогатива штатных политик).
 */
export function evaluateRisk({ detHits, laya, cfg }) {
  const mode = cfg.riskGate.mode;
  const detRisk = maxRisk(detHits);
  const out = {
    mode,
    detRisk,
    detHits,
    action: "log",
    riskClass: detRisk,
    confidence: null,
    reason: detHits.length ? `правила: ${detHits.map((h) => h.id).join(", ")}` : "правил не найдено",
    source: detHits.length ? "deterministic" : "none",
    trustworthy: true,
  };
  if (mode === "off") {
    out.action = "none";
    return out;
  }
  // Вердикт Laya учитывается только целиком доверенный: обрезка состояния,
  // схлопнутые варианты и сбои инференса = мнения нет.
  let layaRisk = null;
  if (laya && laya.ok) {
    // Недоверие к ответу фиксируется независимо от того, есть ли ответ по
    // risk_class: клиент должен видеть, что мнение Laya в этом вызове неполно.
    if (!laya.trustworthy) out.trustworthy = false;
    const a = laya.answers?.risk_class;
    if (a && a.type === "choice" && laya.trustworthy) {
      layaRisk = { cls: a.choice, conf: a.answer_confidence };
      out.riskClass = combineRisk(detRisk, a.choice);
      out.confidence = a.answer_confidence;
      if (a.state_dropped > 0 || a.collapsed || a.head_truncated) out.trustworthy = false;
    }
    out.laya = {
      data_loss: laya.answers?.data_loss?.noul ?? null,
      exfiltration: laya.answers?.exfiltration?.noul ?? null,
      risk_class: layaRisk?.cls ?? null,
      confidence: layaRisk?.conf ?? null,
      elapsed_ms: laya.elapsedMs,
      checkpoint: laya.checkpoint,
    };
  } else if (laya && !laya.ok) {
    out.inference_error = laya.error;
    out.source = detHits.length ? "deterministic" : "laya_unavailable";
  }

  if (mode === "shadow") {
    out.action = "log";
    return out;
  }

  // mode === "ask": поднимаем вопрос только для подтверждённо опасного.
  const detEscalate = detRisk === "high";
  const layaEscalate =
    layaRisk &&
    layaRisk.cls === "high" &&
    typeof layaRisk.conf === "number" &&
    layaRisk.conf >= cfg.riskGate.askMinConfidence &&
    out.trustworthy;
  const needDetSignal = cfg.riskGate.askRequiresDeterministicSignal === true;
  if (detEscalate || (layaEscalate && (!needDetSignal || detHits.length > 0))) {
    out.action = "ask";
    out.source = detEscalate ? "deterministic" : "laya";
    if (detEscalate) out.reason = `детерминированное правило: ${detHits.filter((h) => h.risk === "high").map((h) => h.id).join(", ")}`;
    else out.reason = `Laya: риск high (p=${layaRisk.conf.toFixed(2)}), сигналов правил нет или medium`;
    return out;
  }
  out.action = "log";
  if (detRisk === "medium") out.reason = `правила medium: ${detHits.map((h) => h.id).join(", ")} — без эскалации`;
  return out;
}

// --------------------------------------------------- политика DoneGate

/**
 * Разбирает ledger и находит детерминированные пробелы доказательств.
 *
 * Важное отличие от первой версии: «нет тестов» — не универсальная ошибка.
 *   • изменение только документации/конфига не требует тестов;
 *   • если в проекте нет ни одной доступной проверки, это не провал работы;
 *   • если проверка доступна и код менялся — это конкретный незакрытый пункт.
 *
 * Laya здесь не участвует: пробелы — факты из ledger и файловой системы.
 */
export function evaluateDoneGaps(ledger, cfg, context = {}) {
  const gaps = [];
  const changed = ledger.changedFiles || [];
  const checks = [...(ledger.checks || [])].sort((a, b) => (a.ts || 0) - (b.ts || 0));
  const errors = ledger.unresolvedErrors || [];
  const changes = summarizeChanges(changed);
  const available = context.checks || {};
  const kinds = availableCheckKinds(available);

  if (changes.hasCode) {
    const tests = checks.filter((c) => c.kind === "test");
    const lastChangeTs = Number(ledger.lastChangeTs) || 0;
    const lastOkTest = [...tests].reverse().find((c) => c.exitCode === 0);
    // Если известен timestamp последней правки — он точнее залипшего boolean:
    // успешная проверка ПОСЛЕ правки должна снимать пробел (в т.ч. если она
    // пришла из laya_run_check, а не из Bash-команды).
    const changedAfterTest = Boolean(
      tests.length > 0 &&
        lastOkTest &&
        (lastChangeTs ? lastChangeTs > (lastOkTest.ts || 0) : ledger.changedAfterLastTest === true),
    );

    if (tests.length === 0) {
      const testCheck = firstCheckOfKind(available, ["test"]);
      if (testCheck) {
        gaps.push({
          id: "no-check-run",
          severity: "high",
          detail: `изменены файлы кода (${changes.code.length + changes.test.length}), проверка «${testCheck.id}» не запускалась`,
          check_id: testCheck.id,
          available: true,
          notify: true,
        });
      } else if (kinds.size > 0) {
        const fallback = firstCheckOfKind(available, ["typecheck", "lint", "build"]);
        gaps.push({
          id: "no-check-run",
          severity: "medium",
          detail: `изменён код, проверки не запускались; доступны: ${[...kinds].join(", ")}`,
          check_id: fallback?.id || null,
          available: true,
          notify: false,
        });
      } else {
        gaps.push({
          id: "no-checks-available",
          severity: "info",
          detail: "изменён код, но в проекте не найдено настроенных проверок; отметь результат как непроверенный",
          available: false,
          notify: false,
        });
      }
    } else {
      const last = tests[tests.length - 1];
      if (last.exitCode !== 0) {
        gaps.push({
          id: "failing-tests",
          severity: "high",
          detail: `последняя тестовая команда завершилась кодом ${last.exitCode}`,
          check_id: last.command || null,
          available: true,
          notify: true,
        });
      } else if (changedAfterTest) {
        gaps.push({
          id: "changed-after-tests",
          severity: "medium",
          detail: "файлы менялись после последнего успешного теста",
          available: true,
          notify: true,
        });
      }
    }
  }

  if (errors.length > 0) {
    const lastErrorTs = Math.max(...errors.map((e) => e.ts || 0));
    const lastOkCheck = checks.filter((c) => c.exitCode === 0).pop();
    if (!lastOkCheck || (lastOkCheck.ts || 0) < lastErrorTs) {
      gaps.push({
        id: "unresolved-errors",
        severity: "medium",
        detail: `необработанных ошибок инструментов: ${errors.length}`,
        available: false,
        notify: false,
      });
    }
  }
  return gaps;
}

/** Вопросы для неоднозначного случая: Laya оценивает обоснованность проверки. */
export function doneQuestions() {
  return {
    verification_needed: {
      type: "noul",
      instructions: "Нужна ли дополнительная проверка (тесты, запуск, сверка результата) прежде чем считать работу завершённой, судя по описанию?",
    },
    evidence_strength: {
      type: "choice",
      instructions: "Насколько собранные доказательства подтверждают заявленное завершение?",
      criteria: {
        none: "Ничего не подтверждает",
        weak: "Косвенно, без запуска кода",
        moderate: "Часть сценариев проверена",
        strong: "Реальные команды прошли, результат воспроизводим",
      },
    },
  };
}

// --------------------------------------------------- TaskRouter
//
// История: трёхсторонний choice (fast/balanced/deep) на этой модели не работает —
// измеренная точность 25–50%, класс deep не распознавался вообще (0/4 во всех
// формулировках, включая обратный порядок критериев, что выявило позиционное
// смещение). Бинарная пара «тривиально?» + «нужно исследование?» с порогами 0.7
// даёт 7/12 и впервые различает deep. Всё равно это слабый сигнал: router по
// умолчанию остаётся в режиме `log` и НИКОГДА не переключает модель.

export function routerQuestions() {
  return {
    trivial: ROUTER_TRIVIAL_Q,
    investigation: ROUTER_INVESTIGATION_Q,
  };
}

/**
 * Разбирает ответы бинарной пары в рекомендацию роутера. Модель не переключается —
 * это совет, и при любой неточности (обрезка, недоступность) совет не выдаётся.
 */
export function interpretRouter(laya, cfg) {
  if (!laya || !laya.ok || !laya.trustworthy) {
    return { available: false, reason: laya && !laya.ok ? "Laya недоступна" : "ответ Laya неполон" };
  }
  const a = laya.answers;
  if (!a?.trivial || !a?.investigation) return { available: false, reason: "нет ответов бинарной пары" };
  const thresholds = {
    trivial: cfg.router.trivialThreshold ?? ROUTER_THRESHOLDS.trivial,
    investigation: cfg.router.investigationThreshold ?? ROUTER_THRESHOLDS.investigation,
  };
  const { taskClass, basis } = deriveTaskClass(a, thresholds);
  // Уверенность — вероятность того вопроса, который определил класс; для
  // balanced это уверенность, что ни одно из условий не выполняется.
  const confidence =
    taskClass === "deep"
      ? a.investigation.noul
      : taskClass === "fast"
        ? a.trivial.noul
        : Math.max(0, 1 - Math.max(a.trivial.noul, a.investigation.noul));
  let suggestion = null;
  if (confidence >= cfg.router.minConfidence) {
    suggestion =
      taskClass === "deep"
        ? { target: "deep", text: "задача класса deep: планирование и полный контекст" }
        : taskClass === "fast"
          ? { target: "fast", text: "задача класса fast: короткий путь без лишних исследований" }
          : { target: "balanced", text: "задача класса balanced: обычный режим" };
  }
  return {
    available: true,
    taskClass,
    confidence,
    basis,
    thresholds,
    trivial: a.trivial.noul,
    investigation: a.investigation.noul,
    suggestion,
    checkpoint: laya.checkpoint,
    elapsedMs: laya.elapsedMs,
  };
}
