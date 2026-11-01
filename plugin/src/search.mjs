// search.mjs — детерминированный поиск по файлам для laya_search.
//
// Инструмент сам получает данные: агенту не нужно сначала запускать rg, а потом
// передавать MCP текст найденного. Это убирает один платный round-trip и не
// позволяет случайно вставить в контекст весь вывод поиска.
//
// Слои:
//   1. ripgrep (если есть) — быстро, с учётом .gitignore;
//   2. Node-обход — если rg нет или он не смог разобрать шаблон;
//   3. дедупликация и слияние соседних совпадений — бесплатно, до Laya.
//
// Laya здесь не вызывается: ранжирование делает laya_search.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { isSecretPath } from "./sanitize.mjs";

const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "out", "target",
  ".next", ".nuxt", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache",
  ".gradle", ".idea", ".vscode", "coverage", ".cache",
]);
const BINARY_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".tiff", ".pdf",
  ".zip", ".gz", ".7z", ".rar", ".exe", ".dll", ".so", ".dylib", ".bin",
  ".onnx", ".pt", ".pth", ".safetensors", ".mp4", ".mov", ".mp3", ".wav",
  ".woff", ".woff2", ".ttf", ".otf", ".class", ".jar", ".pyc",
]);

function runProcess(cmd, args, { cwd, timeoutMs = 15000, maxBytes = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      resolve({ ok: false, code: null, stdout: "", stderr: "", error: err.message, timedOut: false });
      return;
    }
    const out = [];
    const errOut = [];
    let outBytes = 0;
    let errBytes = 0;
    let truncated = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      finish(null, null, true);
    }, timeoutMs);

    function finish(code, signal, timedOut) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        ok: code === 0 || (code === 1 && outBytes > 0),
        code,
        signal,
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(errOut).toString("utf8"),
        truncated,
        timedOut: timedOut === true,
      });
    }

    child.stdout.on("data", (buf) => {
      if (outBytes >= maxBytes) {
        truncated = true;
        return;
      }
      out.push(buf);
      outBytes += buf.length;
    });
    child.stderr.on("data", (buf) => {
      if (errBytes >= 256 * 1024) return;
      errOut.push(buf);
      errBytes += buf.length;
    });
    child.on("error", (err) => finish(null, null, false, (err.code = err.code || "spawn_error")));
    child.on("close", (code, signal) => finish(code, signal, false));
  });
}

function normalizeQuery(q) {
  return String(q || "").trim().slice(0, 500);
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeMatcher(query, caseSensitive) {
  try {
    const re = new RegExp(query, caseSensitive ? "" : "i");
    return (line) => re.test(line);
  } catch {
    const needle = query.toLowerCase();
    return (line) => (caseSensitive ? line : line.toLowerCase()).includes(caseSensitive ? query : needle);
  }
}

function isProbablyBinary(buf) {
  const n = Math.min(buf.length, 8192);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

/** Собирает блоки из набора «строка → текст» вокруг совпадений. */
function blocksFromLines(lines, matchLines, context, maxHits, file) {
  const sortedMatches = [...new Set(matchLines)].sort((a, b) => a - b);
  const ranges = [];
  for (const line of sortedMatches) {
    const start = Math.max(1, line - context);
    const end = line + context;
    const last = ranges[ranges.length - 1];
    if (last && start <= last.end + 1) {
      last.end = Math.max(last.end, end);
      last.matches.push(line);
    } else {
      ranges.push({ start, end, matches: [line] });
    }
    if (ranges.length >= maxHits) break;
  }
  return ranges.map((r) => {
    const parts = [];
    let prev = r.start - 1;
    for (let i = r.start; i <= r.end; i++) {
      const text = lines.get(i);
      if (text === undefined) continue;
      if (i > prev + 1) parts.push(`… строки ${prev + 1}-${i - 1} пропущены …`);
      parts.push(`${i}│ ${text}`);
      prev = i;
    }
    const snippet = parts.join("\n").slice(0, 2000);
    return {
      path: file,
      line: r.start,
      end_line: r.end,
      match_lines: r.matches,
      snippet,
      matches: r.matches.length,
    };
  });
}

function parseRgJson(stdout, context, maxHits) {
  const perFile = new Map();
  let matches = 0;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type !== "match" && ev.type !== "context") continue;
    const p = ev.data?.path?.text;
    const n = ev.data?.line_number;
    if (!p || !Number.isFinite(n)) continue;
    if (ev.type === "match") matches += 1;
    if (!perFile.has(p)) perFile.set(p, { lines: new Map(), matches: [] });
    const f = perFile.get(p);
    f.lines.set(n, String(ev.data?.lines?.text ?? "").replace(/\r?\n$/, ""));
    if (ev.type === "match") f.matches.push(n);
    if (matches > maxHits * 8) break;
  }
  const hits = [];
  for (const [file, f] of perFile) {
    if (!f.matches.length) continue;
    hits.push(...blocksFromLines(f.lines, f.matches, context, maxHits - hits.length, file));
    if (hits.length >= maxHits) break;
  }
  return hits;
}

let rgCache = null;
async function rgAvailable() {
  if (rgCache !== null) return rgCache;
  // Дешёвая проверка: --version без обхода файлов.
  const r = await runProcess("rg", ["--version"], { timeoutMs: 3000, maxBytes: 8192 });
  rgCache = r.code === 0;
  return rgCache;
}

/** Поиск через ripgrep. */
async function searchRg(query, root, opts) {
  const args = [
    "--json",
    "--line-number",
    "--context", String(opts.context),
    "--max-columns", "500",
    "--max-columns-preview",
    "--max-filesize", "2M",
    "--max-count", String(Math.max(5, Math.min(100, opts.maxHits))),
    "--glob", "!node_modules/**",
    "--glob", "!.git/**",
    "--glob", "!dist/**",
    "--glob", "!build/**",
    "--glob", "!target/**",
    "--glob", "!.env",
    "--glob", "!.env.*",
    "--glob", "!*.pem",
    "--glob", "!*.p12",
    "--glob", "!id_rsa*",
    "--glob", "!credentials",
    "--glob", "!.npmrc",
    "--glob", "!.aws/**",
    "--glob", "!.ssh/**",
  ];
  if (!opts.caseSensitive) args.push("--ignore-case");
  if (opts.fixed) args.push("--fixed-strings");
  args.push("-e", query, root);

  let r = await runProcess("rg", args, { cwd: root, timeoutMs: opts.timeoutMs });
  if (r.code === 2 && /regex|pattern/i.test(r.stderr) && !opts.fixed) {
    // Пользователь передал не regex, а что-то вроде «foo[» — повторяем буквально.
    const retry = args.filter((a) => a !== "--ignore-case");
    retry.push("--fixed-strings");
    r = await runProcess("rg", retry, { cwd: root, timeoutMs: opts.timeoutMs });
  }
  if (r.code === 2) throw new Error(r.stderr.trim() || "rg завершился с кодом 2");
  const hits = parseRgJson(r.stdout, opts.context, opts.maxHits);
  return { engine: "rg", hits, timedOut: r.timedOut, truncated: r.truncated, warnings: r.stderr ? [r.stderr.trim().slice(0, 300)] : [] };
}

function walkFiles(root, maxFiles, maxFileBytes) {
  const out = [];
  const stack = [root];
  while (stack.length && out.length < maxFiles) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const ent of entries) {
      if (out.length >= maxFiles) break;
      if (ent.name.startsWith(".") && ent.name !== ".env.example") {
        if (SKIP_DIRS.has(ent.name)) continue;
      }
      const full = path.join(dir, ent.name);
      if (isSecretPath(full)) continue;
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name)) continue;
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(ent.name).toLowerCase();
      if (BINARY_EXT.has(ext)) continue;
      try {
        const st = fs.statSync(full);
        if (st.size > maxFileBytes) continue;
        out.push({ path: full, size: st.size });
      } catch {
        /* ignore */
      }
    }
  }
  return out;
}

/** Резервный поиск без rg: обход файлов и построчный regex. */
function searchNode(query, root, opts) {
  const match = makeMatcher(query, opts.caseSensitive);
  const files = walkFiles(root, opts.maxFiles, opts.maxFileBytes);
  const hits = [];
  let scanned = 0;
  for (const f of files) {
    if (hits.length >= opts.maxHits) break;
    let buf;
    try {
      buf = fs.readFileSync(f.path);
    } catch {
      continue;
    }
    if (isProbablyBinary(buf)) continue;
    scanned += 1;
    const text = buf.toString("utf8");
    const lines = text.split(/\r?\n/);
    const lineMap = new Map(lines.map((l, i) => [i + 1, l.slice(0, 400)]));
    const matchLines = [];
    for (let i = 0; i < lines.length; i++) {
      if (match(lines[i])) matchLines.push(i + 1);
      if (matchLines.length >= opts.maxHits * 4) break;
    }
    if (!matchLines.length) continue;
    hits.push(...blocksFromLines(lineMap, matchLines, opts.context, opts.maxHits - hits.length, f.path));
  }
  return { engine: "node", hits, timedOut: false, truncated: hits.length >= opts.maxHits, warnings: [], filesScanned: scanned };
}

function normalizeHit(hit, root) {
  let rel = hit.path;
  try {
    if (path.isAbsolute(hit.path)) rel = path.relative(root, hit.path) || hit.path;
  } catch {
    /* keep as is */
  }
  return { ...hit, path: String(rel).replace(/\\/g, "/") };
}

/** Убирает точные дубли и одинаковые блоки, пришедшие из rg и fallback. */
export function dedupeHits(hits) {
  const seen = new Set();
  const out = [];
  for (const h of hits) {
    const key = `${h.path}\u0000${h.line}\u0000${h.end_line}\u0000${String(h.snippet).replace(/\s+/g, " ").slice(0, 200)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

/**
 * Ищет query в root. Возвращает хиты с путями/строками и сниппетами.
 * Никаких запросов к Laya и никаких записей в её state.
 */
export async function searchFiles(query, root, opts = {}) {
  const q = normalizeQuery(query);
  if (!q) throw new Error("query пуст");
  const start = Date.now();
  const resolved = path.resolve(root || process.cwd());
  let st;
  try {
    st = fs.statSync(resolved);
  } catch {
    throw new Error(`root не найден: ${resolved}`);
  }
  if (!st.isDirectory()) throw new Error(`root не каталог: ${resolved}`);

  const options = {
    context: Math.max(0, Math.min(20, opts.context ?? 2)),
    maxHits: Math.max(1, Math.min(500, opts.maxHits ?? 200)),
    timeoutMs: Math.max(1000, Math.min(60000, opts.timeoutMs ?? 15000)),
    caseSensitive: opts.caseSensitive === true,
    fixed: opts.fixed === true,
    maxFiles: 5000,
    maxFileBytes: 2 * 1024 * 1024,
  };

  let result;
  let hasRg = false;
  try {
    hasRg = await rgAvailable();
  } catch {
    hasRg = false;
  }
  try {
    result = hasRg ? await searchRg(q, resolved, options) : searchNode(q, resolved, options);
  } catch (err) {
    if (!hasRg) throw err;
    result = searchNode(q, resolved, options);
    result.warnings = [...(result.warnings || []), `rg: ${err.message}`];
  }

  const hits = dedupeHits(result.hits.map((h) => normalizeHit(h, resolved)));
  return {
    ok: true,
    query: q,
    root: resolved,
    engine: result.engine,
    hits,
    stats: {
      hits: hits.length,
      files_scanned: result.filesScanned ?? null,
      duration_ms: Date.now() - start,
      timed_out: result.timedOut === true,
      truncated: result.truncated === true,
    },
    warnings: result.warnings || [],
  };
}

export { runProcess, escapeRegex, makeMatcher };
