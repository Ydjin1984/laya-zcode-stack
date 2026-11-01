#!/usr/bin/env node
// collect-results.mjs — сводит прогоны A/B из manifest.json и сохранённых
// журналов model-io (experiments/io-captures) в results.json и печатает таблицу.
//
// Что считается (см. experiments/README.md):
//   peak      — пик контекста (сколько осело в контексте и оплачивается дальше);
//   newTokens — новые токены промпта (inputTokens − cacheReadTokens);
//   sumInput  — сумма контекстов по вызовам (полная стоимость эпизода);
//   calls     — число вызовов модели;
//   secs      — время вызовов модели.
// Для каждого режима печатается медиана и диапазон: разброс между прогонами
// реален и должен быть виден, а не спрятан за средним.

import fs from "node:fs";
import path from "node:path";
import rl from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "manifest.json"), "utf8"));
const capturesDir = path.join(here, "io-captures");

async function readIo(file) {
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
      input: u.inputTokens ?? 0,
      cache: u.cacheReadTokens ?? 0,
      output: u.outputTokens ?? 0,
      ms: d.durationMs ?? 0,
    });
  }
  return rows;
}

const captured = fs.existsSync(capturesDir) ? fs.readdirSync(capturesDir) : [];
const runs = [];
for (const r of manifest.runs) {
  let io = null;
  const file = captured.find((n) => n.includes(r.agent.replace("agent_", "")));
  if (file) {
    const rows = await readIo(path.join(capturesDir, file));
    if (rows.length > 0) {
      io = {
        calls: rows.length,
        peak: Math.max(...rows.map((x) => x.input)),
        sumInput: rows.reduce((a, x) => a + x.input, 0),
        newTokens: rows.reduce((a, x) => a + Math.max(0, x.input - x.cache), 0),
        output: rows.reduce((a, x) => a + x.output, 0),
        secs: rows.reduce((a, x) => a + x.ms, 0) / 1000,
      };
    }
  }
  runs.push({ ...r, io });
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)) : null;
};
const range = (arr) => (arr.length ? `${Math.min(...arr)}..${Math.max(...arr)}` : "—");

const summary = {};
for (const exp of ["log700", "log7000", "log700-v2", "log7000-v2", "search", "search-v2"]) {
  for (const mode of ["A", "C"]) {
    const set = runs.filter((r) => r.experiment === exp && r.mode === mode);
    const peaks = set.filter((r) => r.io).map((r) => r.io.peak);
    const sums = set.filter((r) => r.io).map((r) => r.io.sumInput);
    const news = set.filter((r) => r.io).map((r) => r.io.newTokens);
    const calls = set.filter((r) => r.io).map((r) => r.io.calls);
    const secs = set.filter((r) => r.io).map((r) => r.io.secs);
    const harn = set.map((r) => r.harnessTokens).filter(Boolean);
    const harnDur = set.map((r) => r.durationMs).filter((v) => typeof v === "number");
    summary[`${exp}:${mode}`] = {
      runs: set.length,
      ioRuns: peaks.length,
      peakMedian: median(peaks),
      peakRange: range(peaks),
      sumMedian: median(sums),
      newMedian: median(news),
      callsMedian: median(calls),
      secsMedian: median(secs),
      harnessMedian: median(harn),
      harnessDurMedian: median(harnDur),
      harnessRange: range(harn),
      correct: `${set.filter((r) => r.answerCorrect).length}/${set.length}`,
    };
  }
}

const pad = (s, n) => String(s ?? "—").padEnd(n);
console.log("эксперимент  режим  прогонов  пик(медиана)  сумма harness(медиана)  вызовов  сек   верных");
for (const [key, s] of Object.entries(summary)) {
  const [exp, mode] = key.split(":");
  console.log(
    `${pad(exp, 11)} ${pad(mode, 6)} ${pad(s.runs, 9)} ${pad(s.peakMedian, 13)} ${pad(s.harnessMedian, 21)} ${pad(s.callsMedian, 8)} ${pad(s.secsMedian, 5)} ${s.correct}`,
  );
}
console.log("\nдиапазоны (где видно разброс):");
for (const [key, s] of Object.entries(summary)) {
  console.log(`  ${key}: пик ${s.peakRange}; harness-токены ${s.harnessRange}`);
}

fs.writeFileSync(
  path.join(here, "results.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), summary, runs }, null, 2) + "\n",
  "utf8",
);
console.log(`\nзаписано: ${path.join(here, "results.json")}`);
