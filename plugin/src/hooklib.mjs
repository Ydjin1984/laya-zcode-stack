// hooklib.mjs — ввод/вывод hook-скриптов ZCode.
//
// Контракт (документация ZCode, /docs/hooks):
//   stdin  — JSON события: {session_id, transcript_path, cwd, hook_event_name,
//            tool_name, tool_input, tool_use_id, ...}; для Stop дополнительно
//            stop_hook_active; для UserPromptSubmit — prompt.
//   stdout — строго JSON по схеме события ЛИБО пусто.
//   exit   — 0 успех; 2 блокировка (deny/block); прочие коды = ошибка хука.
//
// Правило этого плагина: хук НИКОГДА не должен ломать сессию. Любая внутренняя
// ошибка → сообщение в stderr (попадает в лог ZCode) и exit 0. Единственное
// исключение — осознанный вывод decision:"block" (Stop) в режиме block.

import { createInterface } from "node:readline";

/** Читает stdin целиком (одна JSON-строка от ZCode). */
export async function readStdin() {
  const chunks = [];
  if (process.stdin.isTTY) return "";
  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) chunks.push(line);
  return chunks.join("\n");
}

/** Разбирает вход; при мусоре возвращает null и пишет диагностику в stderr. */
export async function readHookInput() {
  const raw = await readStdin();
  if (!raw.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    process.stderr.write(`[davinci-laya] stdin не JSON: ${err.message}\n`);
    return null;
  }
}

/** Выводит JSON-результат (или ничего при null) и завершает процесс с кодом 0. */
export function emit(result) {
  if (result !== null && result !== undefined) {
    process.stdout.write(JSON.stringify(result));
  }
  process.exit(0);
}

/** Диагностика в stderr; stdout не трогаем — там живёт только JSON-протокол. */
export function diag(msg) {
  process.stderr.write(`[davinci-laya] ${msg}\n`);
}

/**
 * Обёртка запуска хука: гарантирует fail-open. Если тело хука упало, сессия
 * ZCode продолжается штатно, а причина остаётся в stderr.
 */
export async function runHook(name, body) {
  try {
    const input = await readHookInput();
    if (!input) emit(null);
    const result = await body(input);
    emit(result?.output ?? null);
  } catch (err) {
    diag(`${name}: ${err?.stack || err?.message || err}`);
    emit(null);
  }
}
