#!/usr/bin/env node
// laya-router-thresholds.mjs — подбор правила и порогов для TaskRouter.
//
// Контекст: эксперимент (scripts/laya-router-eval.mjs) показал, что трёхсторонний
// choice у этой модели почти не работает (25–50% точности, класс deep — 0/4 даже
// при обратном порядке критериев), а бинарная пара вопросов («тривиально?»,
// «нужно исследование?») deep распознаёт. Здесь сырые вероятности бинарной пары
// собираются ОДИН раз, а затем правило выводится перебором порогов на этих же
// числах — без дополнительных вызовов модели.
//
// Внимание к методологии: набор 12 кейсов мал, единичный максимум легко
// переобучен. Поэтому печатается «плато» (диапазон порогов с результатом в
// пределах одного кейса от максимума) и выбирается середина плато, а не пик.
//
// Использование: node scripts/laya-router-thresholds.mjs

import { loadConfig } from "../src/config.mjs";
import { decide, health, questions, noul } from "../src/laya-client.mjs";
import { ROUTER_CASES, ROUTER_TRIVIAL_Q, ROUTER_INVESTIGATION_Q } from "../src/router-cases.mjs";

const cfg = loadConfig();
const h = await health({ cfg });
if (!h.ok) {
  console.error(`Laya недоступна: ${h.error.message}`);
  process.exit(2);
}

const raw = [];
for (const c of ROUTER_CASES) {
  const res = await decide(
    c.p,
    questions([
      ["trivial", ROUTER_TRIVIAL_Q],
      ["investigation", ROUTER_INVESTIGATION_Q],
    ]),
    { cfg },
  );
  if (!res.ok) {
    raw.push({ ...c, err: res.error.code });
    continue;
  }
  raw.push({
    ...c,
    trivial: res.answers.trivial.noul,
    invest: res.answers.investigation.noul,
    trust: res.trustworthy,
  });
}

console.log("ожидание  trivial  invest  промпт");
const cls = { fast: "fast ", balanced: "balan", deep: "deep " };
for (const r of raw) {
  console.log(`${cls[r.want]}     ${r.err ? "  -  " : r.trivial.toFixed(2)}    ${r.err ? "  -  " : r.invest.toFixed(2)}    ${r.p.slice(0, 52)}`);
}

/** Правило: invest ≥ ti → deep; trivial ≥ tt → fast; иначе balanced. */
function ruleAcc(tt, ti) {
  let ok = 0;
  for (const r of raw) {
    if (r.err) continue;
    const got = r.invest >= ti ? "deep" : r.trivial >= tt ? "fast" : "balanced";
    if (got === r.want) ok++;
  }
  return ok;
}

const grid = [];
for (let tt = 0.5; tt <= 0.95 + 1e-9; tt += 0.05) {
  for (let ti = 0.5; ti <= 0.95 + 1e-9; ti += 0.05) {
    grid.push({ tt: Number(tt.toFixed(2)), ti: Number(ti.toFixed(2)), acc: ruleAcc(tt, ti) });
  }
}
grid.sort((a, b) => b.acc - a.acc || b.tt - a.tt);
console.log("\nлучшие пороги (trivial≥tt → fast, invest≥ti → deep, иначе balanced):");
for (const g of grid.slice(0, 8)) console.log(`  tt=${g.tt} ti=${g.ti}: ${g.acc}/12`);

const best = grid[0];
const plateau = grid.filter((g) => g.acc >= best.acc - 1);
const range = (key) => [Math.min(...plateau.map((g) => g[key])), Math.max(...plateau.map((g) => g[key]))];
const [ttMin, ttMax] = range("tt");
const [tiMin, tiMax] = range("ti");
// Середина плато по каждому порогу: устойчивее любого края.
const ttMid = Number(((ttMin + ttMax) / 2).toFixed(2));
const tiMid = Number(((tiMin + tiMax) / 2).toFixed(2));
console.log(`плато: tt ${ttMin}..${ttMax}, ti ${tiMin}..${tiMax}`);
console.log(`рекомендация (середина плато): trivialThreshold=${ttMid}, investigationThreshold=${tiMid} → ${ruleAcc(ttMid, tiMid)}/12`);

// Детальный разбор рекомендованного правила: что именно ошибётся.
console.log("\nразбор рекомендованного правила:");
for (const r of raw) {
  if (r.err) continue;
  const got = r.invest >= tiMid ? "deep" : r.trivial >= ttMid ? "fast" : "balanced";
  const mark = got === r.want ? "верно" : `ОШИБКА (${got})`;
  console.log(`  ${cls[r.want]}  trivial=${r.trivial.toFixed(2)} invest=${r.invest.toFixed(2)}  ${mark}  ${r.p.slice(0, 46)}`);
}
process.exit(0);
