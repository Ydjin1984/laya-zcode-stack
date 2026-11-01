#!/usr/bin/env node
// analyze-io.mjs — разбор журнала model-io ZCode по сессиям и субагентам.
//
// ZCode пишет вызовы модели в ~/.zcode/cli/rollout/model-io-sess_*.jsonl, включая
// субагентов (у каждого свой файл sess_subagent_agent_<id>.jsonl). Здесь считается
// то, что нужно для честного A/B:
//   • inputTokens   — полный контекст вызова (система + история + артефакт);
//   • cacheReadTokens — часть контекста из кэша (дешевле, но всё ещё контекст);
//   • uncached = inputTokens − cacheReadTokens — «новые» токены промпта;
//   • outputTokens, durationMs.
// Пик inputTokens показывает, сколько мусора реально осело в контексте.
//
// Использование:
//   node experiments/analyze-io.mjs [--dir <rollout>] [--session sess_xxx | --file path] [--json]

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import rl from "node:readline";

function parseArgs(argv) {
  const out = { dir: path.join(os.homedir(), ".zcode", "cli", "rollout") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dir") out.dir = argv[++i];
    else if (argv[i] === "--session") out.session = argv[++i];
    else if (argv[i] === "--file") out.file = argv[++i];
    else if (argv[i] === "--json") out.json = true;
  }
  return out;
}

async function readRows(file) {
  const rows = [];
  const stream = fs.createReadStream(file, { encoding: "utf8" });
  for await (const line of rl.createInterface({ input: stream })) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    const u = d.response?.usage || {};
    rows.push({
      inputTokens: u.inputTokens ?? 0,
      cacheReadTokens: u.cacheReadTokens ?? 0,
      cacheWriteTokens: u.cacheWriteTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      durationMs: d.durationMs ?? 0,
      messageCount: d.request?.messageCount ?? null,
      model: d.response?.modelId || d.model?.modelId || "?",
      startedAt: d.startedAt || null,
    });
  }
  return rows;
}

function summarize(rows) {
  if (rows.length === 0) return null;
  const inputs = rows.map((r) => r.inputTokens);
  const uncached = rows.map((r) => Math.max(0, r.inputTokens - r.cacheReadTokens));
  return {
    calls: rows.length,
    peakInput: Math.max(...inputs),
    firstInput: inputs[0],
    sumInput: inputs.reduce((a, b) => a + b, 0),
    sumCacheRead: rows.reduce((a, b) => a + b.cacheReadTokens, 0),
    sumUncached: uncached.reduce((a, b) => a + b, 0),
    sumOutput: rows.reduce((a, b) => a + b.outputTokens, 0),
    sumDurationMs: rows.reduce((a, b) => a + b.durationMs, 0),
  };
}

const args = parseArgs(process.argv.slice(2));
let files = [];
if (args.file) files = [args.file];
else {
  files = fs
    .readdirSync(args.dir)
    .filter((n) => n.startsWith("model-io-") && n.endsWith(".jsonl"))
    .filter((n) => (args.session ? n.includes(args.session) : true))
    .map((n) => path.join(args.dir, n));
}

const result = {};
for (const file of files) {
  const rows = await readRows(file);
  const s = summarize(rows);
  if (!s) continue;
  result[path.basename(file)] = { ...s, rows: rows.map((r) => ({ in: r.inputTokens, cache: r.cacheReadTokens, out: r.outputTokens, ms: r.durationMs })) };
}

if (args.json) {
  console.log(JSON.stringify(result, null, 2));
} else {
  for (const [name, s] of Object.entries(result)) {
    console.log(`=== ${name} ===`);
    console.log(`  вызовов: ${s.calls}`);
    console.log(`  контекст: первый=${s.firstInput}, пик=${s.peakInput}, сумма=${s.sumInput}`);
    console.log(`  из кэша: ${s.sumCacheRead}, новых (uncached): ${s.sumUncached}`);
    console.log(`  ответы (output): ${s.sumOutput}, время вызовов: ${(s.sumDurationMs / 1000).toFixed(1)} с`);
    console.log(`  по вызовам (in/cache/out): ${s.rows.map((r) => `${r.in}/${r.cache}/${r.out}`).join("  ")}`);
    console.log("");
  }
}
