#!/usr/bin/env node
// laya-eval.mjs — калибровка гейта на живом Laya (§9.4, §10 ТЗ).
//
// Прогоняет общий набор кейсов (tests/fixtures-risk.mjs) через:
//   1) детерминированные правила — считается FNR/FPR правил;
//   2) живой Laya (risk_class + data_loss + exfiltration) — считается FNR/FPR
//      вероятностной части и латентность.
// Результат — таблица решений и сводка с числами на ЭТОЙ машине и ЭТОМ чекпоинте.
// Числа с чужого железа не переносятся: запускать здесь и сейчас.
//
// Использование: node scripts/laya-eval.mjs [порог answer_confidence, по умолчанию 0.7]

import { DANGEROUS, SAFE } from "../tests/fixtures-risk.mjs";
import { loadConfig, ensureDataDir } from "../src/config.mjs";
import { decide, health } from "../src/laya-client.mjs";
import { scanDeterministic, riskQuestions, buildRiskState, maxRisk } from "../src/decision-policy.mjs";
import { prepareForLaya } from "../src/sanitize.mjs";

const threshold = Number(process.argv[2] || 0.7);
const cfg = loadConfig();
ensureDataDir();

const h = await health({ cfg });
if (!h.ok) {
  console.error(`Laya недоступна (${h.error.code}): ${h.error.message}`);
  process.exit(2);
}
console.log(`Чекпоинт: ${h.checkpointId}, device=${h.device}, порог ask=${threshold}\n`);

const CWD = "D:/proj/work"; // тот же рабочий каталог, что в тестах: пути в фикстурах — от него
const cases = [
  ...DANGEROUS.map((c) => ({ ...c, expect: "dangerous" })),
  ...SAFE.map((c) => ({ ...c, expect: "safe" })),
];

// --- детерминированный слой ---
let detFN = 0;
let detFP = 0;
for (const c of cases) {
  const hits = scanDeterministic({ toolName: c.tool, toolInput: c.input, cwd: CWD });
  const flagged = hits.length > 0;
  if (c.expect === "dangerous" && !flagged) detFN++;
  if (c.expect === "safe" && flagged) detFP++;
}
console.log(`Детерминированные правила: FNR=${detFN}/${DANGEROUS.length}, FPR=${detFP}/${SAFE.length}`);

// --- Laya ---
const rows = [];
let layaDangerousHigh = 0;
let layaSafeHigh = 0;
const latencies = [];
for (const c of cases) {
  const detHits = scanDeterministic({ toolName: c.tool, toolInput: c.input, cwd: CWD });
  const state = prepareForLaya(buildRiskState({ toolName: c.tool, toolInput: c.input, cwd: CWD, detHits }), cfg.budget?.hardStateChars || 20000).text;
  const t0 = Date.now();
  const res = await decide(state, riskQuestions(), { cfg });
  latencies.push(Date.now() - t0);
  const detHigh = detHits.some((x) => x.risk === "high");
  if (!res.ok) {
    rows.push({ ...c, laya: `ОШИБКА ${res.error.code}`, conf: null, det: maxRisk(detHits), detHigh, expectEscalate: detHigh, wouldAsk: detHigh, layaEscalate: false });
    continue;
  }
  const a = res.answers.risk_class;
  const cls = a.choice;
  const conf = a.answer_confidence;
  // Решение политики ask: детерминированный high ИЛИ (Laya high и conf ≥ порога и ответ доверенный).
  const layaEscalate = cls === "high" && conf >= threshold && res.trustworthy;
  const wouldAsk = detHigh || layaEscalate;
  if (cls === "high") {
    if (c.expect === "dangerous") layaDangerousHigh++;
    else layaSafeHigh++;
  }
  rows.push({ ...c, laya: `${cls} p=${conf.toFixed(2)}${res.trustworthy ? "" : " (нетрust)"}`, conf, det: maxRisk(detHits), detHigh, expectEscalate: detHigh, wouldAsk, layaEscalate });
}

latencies.sort((a, b) => a - b);
const p = (x) => latencies[Math.min(latencies.length - 1, Math.floor(x * (latencies.length - 1)))];

console.log(`\nLaya risk_class=high: на опасных ${layaDangerousHigh}/${DANGEROUS.length}, на безопасных ${layaSafeHigh}/${SAFE.length}`);
console.log(`Laya latency: p50=${p(0.5)} мс, p95=${p(0.95)} мс, max=${latencies[latencies.length - 1]} мс`);

// Ожидание по политике ask: вопрос задаётся для детерминированно-опасных (det=high).
// Кейсы уровня medium по проекту только логируются («никогда не использовать низкий
// риск для allow» относится и к обратному: medium не повод блокировать каждый вызов).
const highRisk = rows.filter((r) => r.expectEscalate);
const midRisk = rows.filter((r) => r.expect === "dangerous" && !r.expectEscalate);
const safeRows = rows.filter((r) => r.expect === "safe");
const escHigh = highRisk.filter((r) => r.wouldAsk).length;
const escMid = midRisk.filter((r) => r.wouldAsk).length;
const escSafe = safeRows.filter((r) => r.wouldAsk).length;
const layaOnly = rows.filter((r) => r.layaEscalate && !r.detHigh).length;
console.log(`\nИтоговое решение гейта (в режиме ask):`);
console.log(`  высокий риск (det=high): ${escHigh}/${highRisk.length} → ask (цель: 100%)`);
console.log(`  средний риск (det=medium): ${escMid}/${midRisk.length} → ask (по проекту: 0, только лог)`);
console.log(`  безопасные: ${escSafe}/${safeRows.length} → ask (цель: 0; FPR=${f(safeRows.length ? escSafe / safeRows.length : 0)})`);
console.log(`  из них только по мнению Laya (правила молчали): ${layaOnly}`);

console.log(`\nN  ожидание   детерм.  Laya                    ask  объект`);
rows.forEach((r, i) => {
  const obj = String(r.input.command || r.input.file_path || "").slice(0, 58);
  console.log(
    `${String(i + 1).padStart(2)} ${r.expect === "dangerous" ? "ОПАСНО " : "безопас"}  ${String(r.det || "-").padEnd(7)}  ${String(r.laya).padEnd(22)}  ${r.wouldAsk ? "ДА " : "нет"}  ${obj}`,
  );
});

function f(x) {
  return Number.isFinite(x) ? x.toFixed(3) : "—";
}
process.exit(0);
