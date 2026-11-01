#!/usr/bin/env node
// laya-cli.mjs — те же инструменты плагина из командной строки.
//
// Зачем: MCP-инструменты доступны только внутри сессии ZCode, а для замеров,
// скриптов и A/B-экспериментов нужен тот же код без MCP-слоя. Обработчики здесь
// ровно те же (src/tools.mjs) — это тонкая обёртка, а не вторая реализация.
//
// Использование:
//   node scripts/laya-cli.mjs log-triage <файл> [--chunk-lines 50] [--focus "..."]
//   rg -n "pattern" src/ | node scripts/laya-cli.mjs search-relevant --query "..." [--top-k 6]
//   git diff | node scripts/laya-cli.mjs rank-diff [--top-k 10]
//   node scripts/laya-cli.mjs classify --state "..." --label logic=... --label test=...
//   node scripts/laya-cli.mjs decide --state "..." --questions questions.json
//   node scripts/laya-cli.mjs health

import fs from "node:fs";
import { findTool } from "../src/tools.mjs";

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let buf = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", () => resolve(buf));
  });
}

/** Разбирает argv: позиционные и --key value / --flag. */
function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        if (out.flags[key] === undefined) out.flags[key] = next;
        else out.flags[key] = [].concat(out.flags[key], next);
        i++;
      } else out.flags[key] = true;
    } else out._.push(a);
  }
  return out;
}

const argv = process.argv.slice(2);
const cmd = argv[0];
const { _, flags } = parseArgs(argv.slice(1));

async function callTool(name, args) {
  const tool = findTool(name);
  if (!tool) {
    console.error(`нет инструмента ${name}`);
    process.exit(2);
  }
  const res = await tool.handler(args);
  const text = res.content?.[0]?.text ?? "";
  process.stdout.write(text.endsWith("\n") ? text : text + "\n");
  if (res.isError) process.exit(1);
  return res;
}

switch (cmd) {
  case "log-triage": {
    const file = _[0];
    if (!file) {
      console.error("нужен путь к файлу лога");
      process.exit(2);
    }
    const chunkLines = Number(flags["chunk-lines"] || 50);
    const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
    const chunks = [];
    for (let i = 0; i < lines.length; i += chunkLines) {
      chunks.push({ id: `L${i + 1}-${Math.min(i + chunkLines, lines.length)}`, text: lines.slice(i, i + chunkLines).join("\n") });
    }
    const res = await callTool("laya_log_triage", { chunks, focus: flags.focus || undefined, max_laya: Number(flags["max-laya"] || 12) });
    // Компактная сводка, по которой видно эффект: сколько строк проглочено и сколько
    // осталось в контексте. Полные блоки — через laya_get_chunk / get-chunk.
    const essential = res.structuredContent?.essential || [];
    process.stdout.write(`\n[log-triage] строк: ${lines.length}, блоков: ${chunks.length}, essential: ${essential.length}, в контекст ушли только строки-доказательства выше\n`);
    break;
  }
  case "get-chunk": {
    await callTool("laya_get_chunk", { id: String(_[0] || flags.id || "") });
    break;
  }
  case "search-relevant": {
    const raw = await readStdin();
    const query = String(flags.query || "");
    if (!query) {
      console.error("нужен --query");
      process.exit(2);
    }
    // Принимаем вывод rg/grep построчно: path:line:text
    const hits = [];
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^(.+?):(\d+):(.*)$/);
      if (m) hits.push({ id: `${m[1]}:${m[2]}`, path: m[1], snippet: m[3] });
    }
    if (hits.length === 0) {
      console.error("во входе нет строк вида path:line:text (передай вывод rg/grep)");
      process.exit(2);
    }
    await callTool("laya_search_relevant", { query, hits, top_k: Number(flags["top-k"] || 8) });
    break;
  }
  case "rank-diff": {
    const diff = flags.file ? fs.readFileSync(String(flags.file), "utf8") : await readStdin();
    await callTool("laya_rank_diff", { diff, top_k: Number(flags["top-k"] || 12) });
    break;
  }
  case "classify": {
    const labels = {};
    for (const l of [].concat(flags.label || [])) {
      const [k, ...v] = String(l).split("=");
      labels[k] = v.join("=");
    }
    await callTool("laya_classify", { state: String(flags.state || ""), instructions: flags.instructions, labels, min_confidence: Number(flags["min-confidence"] || 0.6) });
    break;
  }
  case "decide": {
    const questions = JSON.parse(fs.readFileSync(String(flags.questions), "utf8"));
    await callTool("laya_decide", { state: String(flags.state || ""), questions });
    break;
  }
  case "health": {
    await callTool("laya_health", {});
    break;
  }
  default:
    console.log(`laya-cli: log-triage | search-relevant | rank-diff | classify | decide | health
Примеры:
  node scripts/laya-cli.mjs log-triage build.log --chunk-lines 50
  rg -n "TODO" src/ | node scripts/laya-cli.mjs search-relevant --query "незавершённые места"
  git diff | node scripts/laya-cli.mjs rank-diff
  node scripts/laya-cli.mjs classify --state "правит тесты" --label test="тесты" --label logic="логика"`);
    process.exit(cmd ? 2 : 0);
}
