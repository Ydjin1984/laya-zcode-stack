// project.mjs — дешёвые детерминированные факты о проекте.
//
// Нужны там, где раньше решение принимала модель или где решение принималось
// по одному расширению файла:
//   • какие проверки реально доступны в проекте (test/lint/typecheck/build);
//   • какой тип работы изменился (код/тесты/доки/конфиг/данные);
//   • стоит ли вообще требовать проверку: изменение README — не повод искать
//     «отсутствующие тесты».
//
// Ничего не запускает и не изменяет: только чтение файлов проекта.

import fs from "node:fs";
import path from "node:path";

const CODE_EXT = new Set([
  ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".mts", ".cts",
  ".go", ".py", ".pyi", ".rs", ".java", ".kt", ".kts", ".cs", ".fs", ".vb",
  ".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".m", ".mm", ".swift",
  ".rb", ".php", ".pl", ".pm", ".lua", ".scala", ".clj", ".cljs", ".ex", ".exs",
  ".erl", ".hrl", ".hs", ".ml", ".mli", ".r", ".jl", ".sh", ".bash", ".zsh",
  ".ps1", ".psm1", ".bat", ".cmd", ".sql", ".vue", ".svelte", ".astro",
]);
const DOC_EXT = new Set([".md", ".mdx", ".txt", ".rst", ".adoc", ".asciidoc", ".tex"]);
const CONFIG_EXT = new Set([
  ".json", ".jsonc", ".json5", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
  ".properties", ".env", ".lock", ".mod", ".sum", ".gradle", ".cmake", ".mk",
]);
const CONFIG_NAMES = new Set([
  "dockerfile", "makefile", "cmakelists.txt", "procfile", "gemfile", "rakefile",
  ".gitignore", ".dockerignore", ".editorconfig", ".npmrc", ".nvmrc", ".python-version",
]);
const DATA_EXT = new Set([".csv", ".tsv", ".parquet", ".db", ".sqlite", ".sqlite3", ".ndjson", ".jsonl"]);

const TEST_RE = /(^|[\\/])(__tests__|tests?|specs?)([\\/]|$)|\.(test|spec)\.[^.\\/]+$|_test\.[^.\\/]+$|(^|[\\/])test_[^\\/]+\.py$/i;

/** Тип изменённого файла: code | test | docs | config | data | other. */
export function classifyPath(p) {
  const s = String(p || "").replace(/\\/g, "/");
  const base = s.split("/").pop() || "";
  const ext = path.extname(base).toLowerCase();
  if (TEST_RE.test(s)) return "test";
  if (CODE_EXT.has(ext)) return "code";
  if (DOC_EXT.has(ext)) return "docs";
  if (CONFIG_EXT.has(ext) || CONFIG_NAMES.has(base.toLowerCase())) return "config";
  if (DATA_EXT.has(ext)) return "data";
  return "other";
}

/** Сводка по изменённым файлам — без содержимого и без модели. */
export function summarizeChanges(paths = []) {
  const out = { total: 0, code: [], test: [], docs: [], config: [], data: [], other: [] };
  for (const p of paths || []) {
    const kind = classifyPath(p);
    out[kind].push(p);
    out.total += 1;
  }
  out.hasCode = out.code.length > 0 || out.test.length > 0;
  out.hasTests = out.test.length > 0;
  out.hasDocs = out.docs.length > 0;
  out.hasConfig = out.config.length > 0;
  out.docsOnly = out.total > 0 && out.code.length === 0 && out.test.length === 0 && out.config.length === 0 && out.data.length === 0;
  return out;
}

const ROOT_MARKERS = [
  ".git", ".hg", ".svn", "package.json", "go.mod", "pyproject.toml", "setup.py",
  "Cargo.toml", "Makefile", "pnpm-workspace.yaml", "composer.json", "build.gradle",
  "build.gradle.kts", "pom.xml", "*.sln",
];

function markerExists(dir, marker) {
  if (marker.startsWith("*.")) {
    try {
      return fs.readdirSync(dir).some((n) => n.endsWith(marker.slice(1)));
    } catch {
      return false;
    }
  }
  return fs.existsSync(path.join(dir, marker));
}

/** Ищет корень проекта вверх от start; при отсутствии маркеров возвращает start. */
export function findProjectRoot(start) {
  start = start || process.cwd();
  let dir;
  try {
    dir = fs.statSync(start).isDirectory() ? start : path.dirname(start);
  } catch {
    dir = start;
  }
  dir = path.resolve(dir);
  for (let i = 0; i < 12; i++) {
    if (ROOT_MARKERS.some((m) => markerExists(dir, m))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(start);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function packageManager(root) {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(root, "bun.lockb")) || fs.existsSync(path.join(root, "bun.lock"))) return "bun";
  return "npm";
}

function makefileTargets(root) {
  try {
    const text = fs.readFileSync(path.join(root, "Makefile"), "utf8");
    return new Set([...text.matchAll(/^([A-Za-z0-9_.-]+)\s*:/gm)].map((m) => m[1]));
  } catch {
    return new Set();
  }
}

function normalizeConfigured(value) {
  if (typeof value === "string") return { command: value, kind: "custom" };
  if (value && typeof value === "object" && typeof value.command === "string") {
    return { command: value.command, kind: value.kind || "custom", cwd: value.cwd || null };
  }
  return null;
}

/**
 * Возвращает доступные проверки: { id: { command, kind, source } }.
 * Явно настроенные команды имеют приоритет над автопоиском.
 */
export function discoverChecks(root, cfg = {}) {
  const out = {};
  const rc = cfg.runChecks || {};
  for (const [id, value] of Object.entries(rc.commands || {})) {
    const norm = normalizeConfigured(value);
    if (norm && /^[A-Za-z0-9_.-]+$/.test(id)) out[id] = { ...norm, source: "config" };
  }
  if (rc.autoDiscover === false) return out;

  const pkg = readJson(path.join(root, "package.json"));
  if (pkg && pkg.scripts && typeof pkg.scripts === "object") {
    const pm = packageManager(root);
    const map = {
      test: { kind: "test", cmd: pm === "npm" ? "npm test" : `${pm} test` },
      lint: { kind: "lint", cmd: `${pm} run lint` },
      typecheck: { kind: "typecheck", cmd: `${pm} run typecheck` },
      types: { kind: "typecheck", cmd: `${pm} run types` },
      build: { kind: "build", cmd: `${pm} run build` },
    };
    for (const [script, spec] of Object.entries(map)) {
      if (typeof pkg.scripts[script] === "string" && !out[spec.kind]) {
        out[spec.kind] = { command: spec.cmd, kind: spec.kind, source: "package.json" };
      }
    }
  }

  if (fs.existsSync(path.join(root, "go.mod"))) {
    if (!out.test) out.test = { command: "go test ./...", kind: "test", source: "go.mod" };
    if (!out.build) out.build = { command: "go build ./...", kind: "build", source: "go.mod" };
    if (!out.lint) out.lint = { command: "go vet ./...", kind: "lint", source: "go.mod" };
  }

  if (
    fs.existsSync(path.join(root, "pyproject.toml")) ||
    fs.existsSync(path.join(root, "pytest.ini")) ||
    fs.existsSync(path.join(root, "tox.ini")) ||
    fs.existsSync(path.join(root, "setup.cfg"))
  ) {
    if (!out.test) out.test = { command: "python -m pytest -q", kind: "test", source: "pytest" };
  }

  if (fs.existsSync(path.join(root, "Cargo.toml"))) {
    if (!out.test) out.test = { command: "cargo test", kind: "test", source: "Cargo.toml" };
    if (!out.lint) out.lint = { command: "cargo clippy -- -D warnings", kind: "lint", source: "Cargo.toml" };
  }

  const targets = makefileTargets(root);
  if (targets.has("test") && !out.test) out.test = { command: "make test", kind: "test", source: "Makefile" };
  if (targets.has("lint") && !out.lint) out.lint = { command: "make lint", kind: "lint", source: "Makefile" };

  return out;
}

/** Множество видов доступных проверок. */
export function availableCheckKinds(checks) {
  return new Set(Object.values(checks || {}).map((c) => c.kind));
}

/** Первая доступная проверка из приоритетного списка видов. */
export function firstCheckOfKind(checks, kinds = ["test", "typecheck", "lint", "build"]) {
  for (const kind of kinds) {
    const hit = Object.entries(checks || {}).find(([, c]) => c.kind === kind);
    if (hit) return { id: hit[0], ...hit[1] };
  }
  return null;
}
