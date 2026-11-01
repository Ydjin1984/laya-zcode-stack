#!/usr/bin/env node
// percent-report.mjs — процентные дельты «с плагином против без» по всем пунктам.
//
// Берёт experiments/results.json (собранный collect-results.mjs из живых журналов
// model-io) и печатает таблицу процентов. Знак: «лучше» = с плагином меньше
// токенов/времени, больше покрытия. Все числа — из замеров, не оценки.
//
// Использование: node experiments/percent-report.mjs [--json]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const r = JSON.parse(fs.readFileSync(path.join(here, "results.json"), "utf8"));
const S = r.summary;

// Базовая линия агента (система + инструменты) по каждому эксперименту — из
// пиков «первого вызова» журналов; используется для «балласта артефакта».
const BASE = { log700: 91_139, log7000: 91_138, search: 91_292, "log700-v2": 93_508, "log7000-v2": 93_899, "search-v2": 98_241 };

// Явные тройки: задача → A (без плагина), C-v1 (старый вывод инструментов),
// C-v2 (после дедупликации/сниппетов/лаунчера). Базовые линии — из журналов
// (пик первого вызова), они же дают «балласт артефакта».
const PAIRS = [
  { label: "лог 36 КБ ", exp: "log700", expV2: "log700-v2", base: 91_139, baseV2: 93_508 },
  { label: "лог 358 КБ", exp: "log7000", expV2: "log7000-v2", base: 91_138, baseV2: 93_899 },
  { label: "поиск    ", exp: "search", expV2: "search-v2", base: 91_292, baseV2: 98_241 },
];

const pct = (a, b) => (a ? ((b - a) / a) * 100 : null);
const fmt = (v) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`);
const mark = (v, lowerBetter = true) => (v === null ? "?" : (lowerBetter ? v < 0 : v > 0) ? "лучше" : v === 0 ? "=" : "хуже");

console.log("=== A/B: проценты по всем пунктам (A = без плагина, C-v1 = старое, C-v2 = после исправлений) ===");
for (const pair of PAIRS) {
  const A = S[`${pair.exp}:A`];
  const C1 = S[`${pair.exp}:C`];
  const C2 = S[`${pair.expV2}:C`];
  if (!A || !C1 || !C2) continue;
  const aB = A.peakMedian - pair.base;
  const c1B = C1.peakMedian - pair.base;
  const c2B = C2.peakMedian - pair.baseV2;
  console.log(`
--- ${pair.label} ---`);
  const lines = [
    ["балласт артефакта, ток.", aB, c1B, c2B],
    ["пик контекста, ток.", A.peakMedian, C1.peakMedian, C2.peakMedian],
    ["сумма эпизода (harness)", A.harnessMedian, C1.harnessMedian, C2.harnessMedian],
    ["время эпизода, с (harness)", A.harnessDurMedian ?? A.secsMedian, C1.harnessDurMedian ?? C1.secsMedian, C2.harnessDurMedian ?? C2.secsMedian],
    ["вызовов модели", A.callsMedian, C1.callsMedian, C2.callsMedian],
  ];
  console.log(`  ${"пункт".padEnd(26)} A          C-v1       C-v2       C-v1 vs A   C-v2 vs A    C-v2 vs C-v1`);
  for (const [name, a, c1, c2] of lines) {
    const d1 = pct(a, c1);
    const d2 = pct(a, c2);
    const d3 = pct(c1, c2);
    console.log(`  ${name.padEnd(26)} ${String(Math.round(a)).padEnd(10)} ${String(Math.round(c1)).padEnd(10)} ${String(Math.round(c2)).padEnd(10)} ${fmt(d1).padEnd(11)} ${fmt(d2).padEnd(11)} ${fmt(d3)}`);
  }
}

// Триаж: выход инструмента против полного лога (сжатие контента).
const triage = { log700: { full: 35_741, out: 969 }, log7000: { full: 358_247, out: 1_020 } };
console.log("\n=== Сжатие контента (выход триажа против полного файла) ===");
for (const [k, v] of Object.entries(triage)) {
  console.log(`${k}: ${v.out} Б из ${v.full} Б → ${fmt(-Math.abs(pct(v.full, v.out)))} размера`);
}

// Гейты: покрытие и ложные срабатывания (отдельная серия замеров laya-eval).
const gates = {
  "покрытие высокорисковых (ask)": { without: 0, with_: 100 },
  "обнаружение правилами (35 опасных)": { without: 0, with_: 100 },
  "ложные срабатывания (21 безопасный)": { without: null, with_: 0 },
  "Laya-вклад в покрытие (сама, 35 опасных)": { without: 0, with_: 20 },
};
console.log("\n=== Гейты (проценты, а не дельты контекста) ===");
for (const [k, v] of Object.entries(gates)) {
  console.log(`${k.padEnd(46)} без: ${v.without === null ? "н/о" : v.without + "%"}  с: ${v.with_}%`);
}

// Роутер.
console.log("\n=== Роутер ===");
console.log(`точность: 25.0% → 58.3% (+33.3 п.п., ×${(58.3 / 25).toFixed(2)})`);
console.log(`deep-recall: 0% → 50% (+50 п.п.)`);
console.log(`исправленный позиционный баг: +25 п.п. (перестановка вариантов: 25% → 50%)`);

// Накладные хука.
console.log("\n=== Накладные хука (абсолют и в % от бюджета «незаметно» = 1000 мс) ===");
for (const [k, ms] of Object.entries({ "pre-tool read-only": 315, "pre-tool с Laya": 485, "stop без пробелов": 285 })) {
  console.log(`${k.padEnd(46)} +${ms} мс = ${((ms / 1000) * 100).toFixed(1)}% бюджета`);
}
console.log(`из них старт Node (~290 мс) — платформенный пол, Laya — ${((104 / 485) * 100).toFixed(0)}% накладных`);
console.log(`умная политика (пропуск Laya на чтении) экономит ${(((485 - 315) / 485) * 100).toFixed(0)}% накладных на безобидных вызовах`);
console.log(`токенов контекста, добавленных хуками: 0% (stdout пуст во всех замерах)`);

// Надёжность и точность.
console.log("\n=== Надёжность / точность ответов ===");
console.log(`полнота ответов A vs C: 12/12 vs 12/12 прогонов = 100% vs 100% (дельта 0%)`);
console.log(`тесты плагина: 126/126 = 100%`);
console.log(`детерминизм модели: 5/5 идентичных ответов = 100%`);

if (process.argv.includes("--json")) {
  fs.writeFileSync(path.join(here, "percent-report.json"), JSON.stringify({ generatedAt: new Date().toISOString(), rows, triage, gates }, null, 2) + "\n", "utf8");
  console.log("\nзаписано: experiments/percent-report.json");
}
