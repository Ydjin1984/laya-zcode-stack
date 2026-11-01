// Маскирование и усечение текста перед отправкой в Laya.
//
// Laya — это адрес модели на порту, и всё, что уходит в state, становится её
// входом. Секреты в state — утечка в локальный сервис и в его логи, поэтому
// маскирование делается ДО сборки состояния, а не «если получится» (§9.1 ТЗ).
//
// Правила:
//  1. Точные шаблоны известных форматов (bearer, sk-, ghp_, AKIA, URL с
//     credentials, PEM-блоки, cookie-заголовки).
//  2. Пары «ключ = значение» для слов-маркеров секретов (password, token, ...).
//  3. Содержимое файлов .env / *.pem / id_rsa не отправляется вообще.
//  4. Усечение с сохранением головы и хвоста: голова несёт операцию, хвост —
//     имя файла/флаг, середина — то, что можно потерять.

/** Заменители сохраняют длину «на глаз», чтобы структура текста не менялась. */
const MASK = "«СКРЫТО»";

const PATTERNS = [
  // URL с учётными данными: https://user:password@host — раньше остальных, иначе
  // generic-правила разрежут URL и учётные данные перестанут распознаваться.
  { re: /(https?:\/\/)[^\s/:@]+:[^\s/@]+@/gi, to: `$1${MASK}@` },
  // Пары ключ=значение со словами-маркерами секретов — ДО форматных шаблонов:
  // тогда `token=ghp_...` маскируется целиком, а не по частям.
  {
    re: /((?:pass(?:word|wd|phrase)?|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?(?:token|key)|cookie|session[_-]?id|семечко)\s*[:=]\s*)(["']?)([^\s"';,]{6,})/gi,
    to: `$1$2${MASK}`,
  },
  // Ключи популярных форматов
  { re: /\bsk-[A-Za-z0-9_-]{12,}/g, to: `sk-${MASK}` },
  { re: /\bghp_[A-Za-z0-9]{16,}/g, to: `ghp_${MASK}` },
  { re: /\bgithub_pat_[A-Za-z0-9_]{16,}/g, to: `github_pat_${MASK}` },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, to: `AKIA${MASK}` },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, to: `xox-${MASK}` },
  { re: /\bya29\.[A-Za-z0-9._-]{10,}/g, to: `ya29.${MASK}` },
  // Authorization: Bearer <...> / любой bearer-токен
  { re: /(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi, to: `$1${MASK}` },
  { re: /(authorization\s*[:=]\s*)(?!bearer)[^\s,;"']{8,}/gi, to: `$1${MASK}` },
  // Cookie-заголовок целиком
  { re: /((?:set-)?cookie\s*:\s*)[^\n\r]+/gi, to: `$1${MASK}` },
  // PEM-блоки (приватные ключи, сертификаты)
  {
    re: /-----BEGIN [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)[A-Z0-9 ]*-----[\s\S]*?-----END [A-Z0-9 ]*(?:PRIVATE KEY|CERTIFICATE)[A-Z0-9 ]*-----/g,
    to: `-----BEGIN ${MASK} KEY-----`,
  },
  // ENV-строки вида KEY=value для подозрительных имён
  { re: /\b([A-Z0-9_]*(?:SECRET|TOKEN|PASSWORD|PASSWD|APIKEY|API_KEY|PRIVATE)[A-Z0-9_]*)=([^\s"']{4,})/g, to: `$1=${MASK}` },
];

/** Пути, содержимое которых в Laya не отправляется никогда. */
const SECRET_PATH_RE = /(^|[\\/])(\.env(\.[a-z0-9-]+)?|\.netrc|credentials|id_rsa|id_ed25519|id_ecdsa|\.pem|\.p12|\.pfx|\.keystore|\.npmrc|\.pypirc|\.git-credentials|secrets?\.(ya?ml|json|toml))$/i;

/** Проверяет, что путь — файл с секретами (по имени). */
export function isSecretPath(p) {
  if (!p) return false;
  return SECRET_PATH_RE.test(String(p));
}

/**
 * Маскирует секреты в произвольной строке. Идемпотентна: повторный вызов не
 * меняет результат (важно для replay-тестов).
 */
export function maskText(input, extraSecrets = []) {
  if (input === null || input === undefined) return "";
  let s = String(input);
  for (const { re, to } of PATTERNS) s = s.replace(re, to);
  // Секреты из конфигурации маскируются как литералы (в том числе если они
  // короткие и не подходят под шаблоны).
  for (const lit of extraSecrets) {
    if (typeof lit === "string" && lit.length >= 4) {
      s = s.split(lit).join(MASK);
    }
  }
  return s;
}

/**
 * Усечение с сохранением ГОЛОВЫ и маркером выброшенного хвоста.
 *
 * Именно этот вариант применяется к state: движок режет состояние справа, поэтому
 * факты обязаны жить в начале, а хвост может быть потерян. Маркер с числом
 * выброшенных символов оставляем в любом случае — молчаливое усечение запрещено.
 */
export function truncateHead(s, maxChars) {
  const str = String(s ?? "");
  if (maxChars <= 0 || str.length <= maxChars) return { text: str, truncated: false, dropped: 0 };
  const dropped = str.length - maxChars;
  return {
    text: `${str.slice(0, maxChars)} …[выпущено ${dropped} симв.]…`,
    truncated: true,
    dropped,
  };
}

/** Усечение с сохранением головы и хвоста (для логов/команд, где важен и конец). */
export function truncateMiddle(s, maxChars) {
  const str = String(s ?? "");
  if (maxChars <= 0 || str.length <= maxChars) return { text: str, truncated: false, dropped: 0 };
  const headLen = Math.floor(maxChars * 0.62);
  const tailLen = maxChars - headLen;
  const dropped = str.length - maxChars;
  return {
    text: `${str.slice(0, headLen)} …[выпущено ${dropped} симв.]… ${str.slice(str.length - tailLen)}`,
    truncated: true,
    dropped,
  };
}

/** Обрезает одно значение до предела (для полей команды/пути). */
export function clampValue(v, max = 400) {
  const { text } = truncateMiddle(String(v ?? ""), max);
  return text;
}

/**
 * Готовит строку к отправке в Laya: маскирует секреты, затем усекает.
 * Порядок обязателен: усечение до маскирования может разрезать токен так, что
 * шаблон перестанет совпадать.
 *
 * `mode: "head"` (по умолчанию) — для state: движок режет хвост, поэтому хвост
 * сохранять бессмысленно, а факты обязаны быть в начале.
 * `mode: "middle"` — для длинных команд/логов, где важен и конец.
 */
export function prepareForLaya(input, maxChars, extraSecrets = [], mode = "head") {
  const masked = maskText(input, extraSecrets);
  return mode === "middle" ? truncateMiddle(masked, maxChars) : truncateHead(masked, maxChars);
}

/**
 * Короткий хэш текста для метрик: сам текст в логи не пишется (§9.7).
 *
 * FNV-1a вместо WebCrypto намеренно: криптостойкость здесь не нужна (идентификатор
 * для сопоставления решений в метриках), а инициализация `crypto.subtle` в каждом
 * процессе хука стоит десятки миллисекунд. Замерено: замена снимает заметную
 * часть накладных на горячем пути гейта.
 */
export function textHash(s) {
  const str = String(s ?? "");
  // Два 32-битных прохода FNV-1a с разными смещениями — 16 hex-символов.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = (h2 + c) >>> 0;
    h2 = Math.imul(h2 ^ (h2 >>> 13), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}
