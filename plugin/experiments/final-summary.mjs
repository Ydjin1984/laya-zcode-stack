#!/usr/bin/env node
// final-summary.mjs — сводка всех репликаций A/B по задачам.
//
// В отличие от percent-report (который сравнивает конкретные пары), здесь все
// прогоны группируются по задаче и по «поколению» инструментов:
//   A        — базовый режим без плагина;
//   C-v1     — плагин до исправлений вывода (дедупликация/сниппеты/стек не были);
//   C-v2     — после исправлений;
//   C-v2*    — прогон с дисциплинированным использованием (ответ из вывода триажа
//              без дочитываний) — так инструмент и задуман; отдельно, потому что
//              это поведение пользователя/модели, а не свойство инструмента.
//
// Токены — harness-суммы (полные и надёжные), время — harness-длительности,
// пик — из захваченных журналов model-io (там, где сохранились).
//
// Использование: node experiments/final-summary.mjs [--json]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(here, "manifest.json"), "utf8"));
const captures = fs.existsSync(path.join(here, "io-captures")) ? fs.readdirSync(path.join(here, "io-captures")) : [];

const TASK_OF = (exp) => {
  if (exp.startsWith("log7000")) return "лог 358 КБ";
  if (exp.startsWith("log700")) return "лог 36 КБ";
  if (exp.startsWith("search")) return "поиск по репо";
  return exp;
};
const V1_EXPERIMENTS = new Set(["log700", "log7000", "search"]);
const DISCIPLINED = new Set(["log700-final"]);

function generation(run) {
  if (run.mode === "A") return "A";
  if (V1_EXPERIMENTS.has(run.experiment)) return "C-v1";
  return DISCIPLINED.has(run.experiment) ? "C-v2*" : "C-v2";
}

const median = (arr) => {
  const s = [...arr].sort((a, b) => a - b);
  if (!s.length) return null;
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2);
};

const groups = {};
for (const run of manifest.runs) {
  const task = TASK_OF(run.experiment);
  const gen = generation(run);
  const key = `${task}|${gen}`;
  groups[key] = groups[key] || { task, gen, tokens: [], dur: [], peaks: [], calls: [], ok: 0, n: 0 };
  const g = groups[key];
  g.n += 1;
  if (run.answerCorrect) g.ok += 1;
  if (typeof run.harnessTokens === "number") g.tokens.push(run.harnessTokens);
  if (typeof run.durationMs === "number") g.dur.push(run.durationMs);
  if (typeof run.toolUses === "number") g.calls.push(run.toolUses);
}

// Пики из захватов (атрибуция по agent id в имени файла)
for (const g of Object.values(groups)) {
  const runs = manifest.runs.filter((r) => TASK_OF(r.experiment) === g.task && generation(r) === g.gen);
  for (const run of runs) {
    const id = run.agent.replace("agent_", "");
    const file = captures.find((n) => n.includes(id));
    if (!file) continue;
    try {
      const rows = fs
        .readFileSync(path.join(here, "io-captures", file), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
      const inputs = rows.map((r) => r.response?.usage?.inputTokens ?? 0).filter(Boolean);
      if (inputs.length) g.peaks.push(Math.max(...inputs));
    } catch {
      /* повреждённый снимок пропускаем */
    }
  }
}

const rows = Object.values(groups).sort((a, b) => a.task.localeCompare(b.task) || a.gen.localeCompare(b.gen));
const fmtTok = (v) => (v === null ? "—" : v.toLocaleString("ru-RU"));
const fmtSec = (v) => (v === null ? "—" : (v / 1000).toFixed(1));

console.log("=== Итог всех репликаций (медианы; A — без плагина) ===");
console.log("задача        режим   прогонов  токены (harness)  время, с  пик контекста  верных");
for (const g of rows) {
  const med = median(g.tokens);
  const best = g.tokens.length ? Math.min(...g.tokens) : null;
  console.log(
    `${g.task.padEnd(13)} ${g.gen.padEnd(7)} ${String(g.n).padEnd(9)} ${fmtTok(med).padEnd(17)} ${String(fmtSec(median(g.dur))).padEnd(9)} ${fmtTok(median(g.peaks)).padEnd(14)} ${g.ok}/${g.n}` +
      (best !== null && best !== med ? `  (лучший: ${fmtTok(best)})` : ""),
  );
}

const byTask = {};
for (const g of rows) byTask[g.task] = byTask[g.task] || {};
for (const g of rows) byTask[g.task][g.gen] = median(g.tokens);

console.log("\n=== Дельта к базовой линии (меньше = лучше) ===");
for (const [task, gens] of Object.entries(byTask)) {
  const a = gens["A"];
  const parts = [];
  for (const gen of ["C-v1", "C-v2", "C-v2*"]) {
    if (gens[gen] === undefined || a === undefined) continue;
    const d = ((gens[gen] - a) / a) * 100;
    parts.push(`${gen}: ${d > 0 ? "+" : ""}${d.toFixed(0)}%`);
  }
  console.log(`${task.padEnd(13)} ${parts.join("   ")}`);
}

if (process.argv.includes("--json")) {
  fs.writeFileSync(path.join(here, "final-summary.json"), JSON.stringify({ generatedAt: new Date().toISOString(), groups: rows, byTask }, null, 2) + "\n", "utf8");
  console.log("\nзаписано: experiments/final-summary.json");
}
