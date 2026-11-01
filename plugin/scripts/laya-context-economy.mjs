// laya-context-economy.mjs — A/B-замер: старый путь (rg + полное чтение +
// прямой запуск проверки) против новых self-fetching инструментов.
//
// Что измеряется:
//   • байты, которые попадают в контекст основной модели (фактические байты;
//     токены здесь не оцениваются — для usage есть отдельный агентный A/B/C);
//   • wall-time каждого пути;
//   • число шагов/вызовов;
//   • Laya: /health отдельно, /decide отдельно, полный MCP-вызов отдельно;
//   • восстановление источника по chunk_id (точное для файла/поиска,
//     по ключевым строкам для вывода проверки).
//
// Запуск: node scripts/laya-context-economy.mjs
// Пишет experiments/context-economy-<date>.json и .md.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "laya-econ-"));
process.env.DAVINCI_LAYA_DATA = dataDir;
process.env.DAVINCI_LAYA_PROJECT_DIR = pluginRoot;

const { findTool } = await import("../src/tools.mjs");
const { getChunk } = await import("../src/chunk-store.mjs");
const { health, decide } = await import("../src/laya-client.mjs");
const { loadConfig } = await import("../src/config.mjs");
const cfg = loadConfig();

const now = () => Number(process.hrtime.bigint()) / 1e6;
const bytes = (s) => Buffer.byteLength(String(s ?? ""), "utf8");

async function timed(fn) {
  const t0 = now();
  const value = await fn();
  return { ms: Math.round((now() - t0) * 10) / 10, value };
}

function p50(values) {
  const a = values.filter((x) => typeof x === "number").sort((x, y) => x - y);
  return a.length ? Math.round(a[Math.floor((a.length - 1) * 0.5)] * 10) / 10 : null;
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...opts });
}

// ---------------------------------------------------------------- baseline
const searchBaseline = await timed(() => {
  const rg = run("rg", ["-n", "activeModes", path.join(pluginRoot, "src")]);
  const gates = fs.readFileSync(path.join(pluginRoot, "src", "gates.mjs"), "utf8");
  const configSrc = fs.readFileSync(path.join(pluginRoot, "src", "config.mjs"), "utf8");
  return `${rg.stdout}\n${gates}\n${configSrc}`;
});

const readBaseline = await timed(() => fs.readFileSync(path.join(pluginRoot, "src", "gates.mjs"), "utf8"));

const checkBaseline = await timed(() => {
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const r = run(npm, ["test"], { cwd: pluginRoot, timeout: 180000, shell: true });
  return `${r.stdout || ""}${r.stderr || ""}`;
});

// ---------------------------------------------------------------- improved
const searchTool = findTool("laya_search");
const searchImproved = await timed(() => searchTool.handler({
  query: "activeModes",
  root: pluginRoot,
  budget: 6000,
  top_k: 8,
  max_candidates: 12,
}));

const readTool = findTool("laya_read_relevant");
const readImproved = await timed(() => readTool.handler({
  path: path.join(pluginRoot, "src", "gates.mjs"),
  query: "permission mode activeModes gate skip",
  budget: 8000,
  max_blocks: 6,
}));

const checkTool = findTool("laya_run_check");
const checkImproved = await timed(() => checkTool.handler({
  check_id: "test",
  root: pluginRoot,
  budget: 6000,
}));

// ------------------------------------------------------- restore by chunk_id
const searchChunk = getChunk(searchImproved.value.structuredContent.chunk_id);
let searchRestored = false;
let searchChunkHits = 0;
try {
  const parsed = JSON.parse(searchChunk.text);
  searchChunkHits = parsed.hits.length;
  searchRestored = searchChunk.ok && searchChunkHits >= searchImproved.value.structuredContent.stats.hits;
} catch {
  searchRestored = false;
}

const readChunk = getChunk(readImproved.value.structuredContent.chunk_id);
const readRestored = readChunk.ok && readChunk.text === fs.readFileSync(path.join(pluginRoot, "src", "gates.mjs"), "utf8");

const checkChunk = getChunk(checkImproved.value.structuredContent.chunk_id);
const checkRestored =
  checkChunk.ok &&
  checkChunk.text.includes("Итог:") &&
  bytes(checkChunk.text) >= Math.max(0, bytes(checkBaseline.value) - 200);

// --------------------------------------------------------- latency sections
async function latency(fn, n = 10) {
  const values = [];
  for (let i = 0; i < n; i++) {
    const t0 = now();
    await fn();
    values.push(now() - t0);
  }
  return { p50_ms: p50(values), n };
}
const healthLatency = await latency(() => health({ cfg }), 10);
const decideLatency = await latency(
  () =>
    decide("git status", {
      risk_class: {
        type: "choice",
        instructions: "Выбери категорию риска действия, если выполнить его как есть.",
        criteria: { low: "Чтение", medium: "Обычная правка", high: "Потеря данных" },
      },
    }, { cfg }),
  10,
);

const nodeStartup = [];
for (let i = 0; i < 8; i++) {
  const t0 = now();
  spawnSync(process.execPath, ["-e", "0"], { stdio: "ignore" });
  nodeStartup.push(now() - t0);
}

const launcher = path.join(pluginRoot, "bin", "laya-hook.exe");
const configPath = path.join(dataDir, "config.json");
const yoloInput = JSON.stringify({ session_id: "bench", cwd: pluginRoot, mode: "yolo", permission_mode: "yolo", tool_name: "Bash", tool_input: { command: "rm -rf ./src" } });
const launcherTimes = [];
const nodeHookTimes = [];
fs.writeFileSync(configPath, JSON.stringify({ riskGate: { mode: "ask", activeModes: ["guarded"], layaPolicy: "always" } }));
for (let i = 0; i < 6; i++) {
  const t0 = now();
  spawnSync(launcher, ["pre", path.join(pluginRoot, "hooks", "pre-tool.mjs")], { input: yoloInput, encoding: "utf8" });
  launcherTimes.push(now() - t0);
}
for (let i = 0; i < 6; i++) {
  const t0 = now();
  spawnSync(process.execPath, [path.join(pluginRoot, "hooks", "pre-tool.mjs")], {
    input: yoloInput,
    encoding: "utf8",
    env: { ...process.env, DAVINCI_LAYA_DATA: dataDir },
  });
  nodeHookTimes.push(now() - t0);
}
// Явно читающая команда при smart: лаунчер должен обойтись без Node.
const smartLauncherTimes = [];
fs.writeFileSync(configPath, JSON.stringify({ riskGate: { mode: "ask", activeModes: ["guarded"], layaPolicy: "smart" } }));
const readOnlyInput = JSON.stringify({ session_id: "bench", cwd: pluginRoot, mode: "guarded", permission_mode: "guarded", tool_name: "Bash", tool_input: { command: "ls -la src" } });
for (let i = 0; i < 6; i++) {
  const t0 = now();
  spawnSync(launcher, ["pre", path.join(pluginRoot, "hooks", "pre-tool.mjs")], { input: readOnlyInput, encoding: "utf8" });
  smartLauncherTimes.push(now() - t0);
}

// ----------------------------------------------------------- full MCP call
async function mcpCall(name, args) {
  return await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(pluginRoot, "src", "mcp-server.mjs")], {
      cwd: pluginRoot,
      env: { ...process.env, DAVINCI_LAYA_DATA: dataDir, DAVINCI_LAYA_PROJECT_DIR: pluginRoot },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const t0 = now();
    let buf = "";
    let done = false;
    const timer = setTimeout(() => finish(new Error("timeout")), 30000);
    function finish(err, msg) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      resolve({ err, msg, ms: Math.round((now() - t0) * 10) / 10 });
    }
    child.stdout.on("data", (d) => {
      buf += d.toString("utf8");
      for (const line of buf.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const m = JSON.parse(line);
          if (m.id === 2) finish(null, m);
        } catch { /* partial line */ }
      }
    });
    child.on("error", (e) => finish(e));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
}
const mcp = await mcpCall("laya_search", { query: "permission_mode", root: pluginRoot, budget: 2000, top_k: 3, max_candidates: 4 });

// ------------------------------------------------------------------ report
function resultOf(res, extra = {}) {
  return {
    wall_ms: res.ms,
    steps: extra.steps ?? 1,
    context_bytes: extra.bytes ?? bytes(res.value?.content?.[0]?.text || res.value || ""),
    ...extra,
  };
}

const searchOut = {
  baseline: resultOf(searchBaseline, { steps: 3, bytes: bytes(searchBaseline.value), note: "rg + полное чтение gates.mjs и config.mjs" }),
  improved: resultOf(searchImproved, {
    steps: 1,
    bytes: bytes(searchImproved.value.content[0].text),
    laya_rank_ms: searchImproved.value.structuredContent.stats.rank_ms,
    search_ms: searchImproved.value.structuredContent.stats.search_ms,
    hits: searchImproved.value.structuredContent.stats.hits,
    returned: searchImproved.value.structuredContent.stats.returned,
    degraded: searchImproved.value.structuredContent.stats.degraded,
    restored: searchRestored,
    chunk_hits: searchChunkHits,
  }),
};
const readOut = {
  baseline: resultOf(readBaseline, { steps: 1, bytes: bytes(readBaseline.value), note: "полное чтение gates.mjs" }),
  improved: resultOf(readImproved, {
    steps: 1,
    bytes: bytes(readImproved.value.content[0].text),
    blocks: readImproved.value.structuredContent.blocks.length,
    omitted: readImproved.value.structuredContent.omitted_blocks.length,
    restored: readRestored,
  }),
};
const checkOut = {
  baseline: resultOf(checkBaseline, { steps: 1, bytes: bytes(checkBaseline.value), note: "npm test напрямую, весь вывод" }),
  improved: resultOf(checkImproved, {
    steps: 1,
    bytes: bytes(checkImproved.value.content[0].text),
    success: checkImproved.value.structuredContent.success,
    exit_code: checkImproved.value.structuredContent.exit_code,
    chunk_bytes: checkImproved.value.structuredContent.bytes,
    restored: checkRestored,
  }),
};

const summary = {
  generated_at: new Date().toISOString(),
  checkpoint: healthLatency && (await health({ cfg })).checkpointId,
  note: "Байты — фактические; токены не оцениваются.",
  search: searchOut,
  read: readOut,
  check: checkOut,
  latency: {
    health: healthLatency,
    decide: decideLatency,
    mcp_full_call: mcp,
    node_startup: { p50_ms: p50(nodeStartup), n: nodeStartup.length },
    launcher_permission_skip: { p50_ms: p50(launcherTimes), n: launcherTimes.length },
    node_hook_same_event: { p50_ms: p50(nodeHookTimes), n: nodeHookTimes.length },
    launcher_smart_readonly: { p50_ms: p50(smartLauncherTimes), n: smartLauncherTimes.length },
  },
  limitations: [
    "baseline эмулирует старый путь (rg + полное чтение), а не реальный LLM-вызов",
    "npm test включает одни и те же тесты, но вывод может содержать тайминги",
    "MCP full call включает холодный старт процесса Node",
  ],
};

const outDir = path.join(pluginRoot, "experiments");
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(outDir, `context-economy-${stamp}.json`), JSON.stringify(summary, null, 2), "utf8");

const row = (label, b, i) => {
  const saved = b.context_bytes - i.context_bytes;
  return `| ${label} | ${b.wall_ms} | ${i.wall_ms} | ${b.steps} | ${i.steps} | ${b.context_bytes} | ${i.context_bytes} | ${saved} |`;
};
const md = [
  `# Laya: экономия контекста (${stamp})`,
  "",
  "Байты — фактические. Токены здесь не оцениваются; фактический usage — в agent-ab-2026-11-02.md. Baseline — rg + полное чтение / прямой запуск.",
  "",
  "| Задача | baseline, мс | improved, мс | шагов B | шагов I | байт B | байт I | экономия байт |",
  "|---|---:|---:|---:|---:|---:|---:|---:|",
  row("поиск activeModes", searchOut.baseline, searchOut.improved),
  row("чтение gates.mjs", readOut.baseline, readOut.improved),
  row("проверка npm test", checkOut.baseline, checkOut.improved),
  "",
  "## Восстановление источника",
  `- поиск: chunk ${searchRestored ? "содержит все " + searchChunkHits + " хитов" : "НЕ восстановлен"}`,
  `- файл: chunk ${readRestored ? "совпадает с файлом побайтно" : "НЕ совпадает"}`,
  `- проверка: chunk ${checkRestored ? "содержит полный вывод" : "НЕ содержит полный вывод"}`,
  "",
  "## Латентность (раздельно)",
  `- /health p50: ${healthLatency.p50_ms} мс (не скорость классификации)`,
  `- /decide p50: ${decideLatency.p50_ms} мс`,
  `- полный MCP-вызов laya_search: ${mcp.ms} мс (${mcp.err ? "ошибка: " + mcp.err.message : "ok"})`,
  `- запуск Node p50: ${p50(nodeStartup)} мс`,
  `- launcher permission skip p50: ${p50(launcherTimes)} мс`,
  `- тот же PreToolUse напрямую через Node p50: ${p50(nodeHookTimes)} мс`,
  `- launcher read-only (smart) p50: ${p50(smartLauncherTimes)} мс`,
  "",
  "## Ограничения",
  ...summary.limitations.map((l) => `- ${l}`),
].join("\n");
fs.writeFileSync(path.join(outDir, `context-economy-${stamp}.md`), md + "\n", "utf8");

console.log(md);
fs.rmSync(dataDir, { recursive: true, force: true });
