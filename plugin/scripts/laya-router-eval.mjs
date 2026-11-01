#!/usr/bin/env node
// laya-router-eval.mjs — измерение шума TaskRouter на размеченном наборе.
//
// Зачем: в отчёте по интеграции `task_class` показал слабость («Отрефактори модуль
// парсинга…» → fast). Этот скрипт превращает наблюдение в число: точность на
// размеченных промптах, матрица ошибок, и сравнение двух формулировок критериев.
// Вывод — на каких формулировках останавливаться (версия набора router-vN).
//
// Использование: node scripts/laya-router-eval.mjs

import { loadConfig } from "../src/config.mjs";
import { decide, health, questions, choice, noul } from "../src/laya-client.mjs";

const cfg = loadConfig();

// Размеченный набор: 12 реальных по духу задач разработки (русский — язык владельца).
// fast = один факт/одна правка/один файл; balanced = обычная задача; deep = многошаговое.
const CASES = [
  { p: "Какой флаг у git показывает сокращённый статус?", want: "fast" },
  { p: "Переименуй переменную tmp в temp в файле src/utils.ts", want: "fast" },
  { p: "Покажи версию Node.js", want: "fast" },
  { p: "Что делает команда npm ci?", want: "fast" },
  { p: "Добавь валидацию email в форму регистрации и тест на неё", want: "balanced" },
  { p: "Почини падающий тест test_parse_dates", want: "balanced" },
  { p: "Обнови README: добавь раздел про установку", want: "balanced" },
  { p: "Отрефактори модуль парсинга, добавь тесты и обнови документацию", want: "balanced" },
  { p: "Разберись, почему в проде падает синхронизация заказов, найди причину и предложи миграцию", want: "deep" },
  { p: "Спроектируй и реализуй систему плагинов с обратной совместимостью API", want: "deep" },
  { p: "Проведи аудит безопасности всего бэкенда и исправь найденное", want: "deep" },
  { p: "Перенеси проект с Express на Fastify, сохранив все тесты зелёными", want: "deep" },
];

/** Вариант A — текущие формулировки из decision-policy.routerQuestions(). */
const VARIANT_A = {
  version: "router-v1",
  criteria: {
    fast: "Короткий вопрос, факт, одна простая правка",
    balanced: "Обычная задача разработки в один-два шага",
    deep: "Сложная многошаговая задача: архитектура, расследование, миграция",
  },
};

/** Вариант B — конкретные якоря: что именно делает задачу быстрой/глубокой. */
const VARIANT_B = {
  version: "router-v2",
  criteria: {
    fast: "Ответ известен сразу или правка в одном файле, проверять нечего",
    balanced: "Правки в нескольких файлах одного модуля, нужен обычный прогон тестов",
    deep: "Нужно исследовать неизвестное, принять архитектурные решения или мигрировать систему",
  },
};

/** Вариант C — с явным перечислением триггеров deep в инструкции. */
const VARIANT_C = {
  version: "router-v3",
  criteria: {
    fast: "Один факт, одна команда или правка в одном файле",
    balanced: "Несколько правок в одном модуле с обычной проверкой",
    deep: "Расследование причины, архитектура, миграция, аудит или многошаговый план",
  },
};

/**
 * Вариант D — те же критерии, что v1, но порядок вариантов ОБРАТНЫЙ.
 * Гипотеза: модель выбирает первый/последний вариант (позиционное смещение),
 * а не оценивает смысл. Если точность не изменится — дело не в порядке.
 */
const VARIANT_D = {
  version: "router-v4-rev",
  criteria: {
    deep: "Сложная многошаговая задача: архитектура, расследование, миграция",
    balanced: "Обычная задача разработки в один-два шага",
    fast: "Короткий вопрос, факт, одна простая правка",
  },
};

/**
 * Вариант E — БИНАРНАЯ ДЕКОМПОЗИЦИЯ вместо трёхстороннего выбора.
 * Малые модели заметно лучше отвечают на вопросы «да/нет» с порогом 0.5, чем
 * выбирают одну из трёх категорий. Класс выводится правилом:
 *   trivial → fast; investigation → deep; иначе balanced.
 */
const VARIANT_E = {
  version: "router-v5-binary",
  questions: {
    is_trivial: ["trivial", { type: "noul", instructions: "Это одна команда, один факт или правка ровно в одном файле без проверок?" }],
    needs_investigation: ["investigation", { type: "noul", instructions: "Нужно ли исследовать неизвестную причину, проектировать архитектуру или мигрировать систему?" }],
  },
};

function deriveFromBinary(a) {
  const trivial = a.trivial?.noul ?? 0;
  const invest = a.investigation?.noul ?? 0;
  if (invest >= 0.5) return "deep";
  if (trivial >= 0.5) return "fast";
  return "balanced";
}

const h = await health({ cfg });
if (!h.ok) {
  console.error(`Laya недоступна: ${h.error.message}`);
  process.exit(2);
}

const l3 = (id, criteria) => questions([choice("task_class", "К какому классу относится задача пользователя по требуемым ресурсам?", criteria)]);
const variants = [
  { version: VARIANT_A.version, ask: () => ({ qs: l3("task_class", VARIANT_A.criteria), pick: (r) => r.answers.task_class }) },
  { version: VARIANT_B.version, ask: () => ({ qs: l3("task_class", VARIANT_B.criteria), pick: (r) => r.answers.task_class }) },
  { version: VARIANT_C.version, ask: () => ({ qs: l3("task_class", VARIANT_C.criteria), pick: (r) => r.answers.task_class }) },
  { version: VARIANT_D.version, ask: () => ({ qs: l3("task_class", VARIANT_D.criteria), pick: (r) => r.answers.task_class }) },
  {
    version: VARIANT_E.version,
    ask: () => ({
      qs: questions([VARIANT_E.questions.is_trivial, VARIANT_E.questions.needs_investigation]),
      pick: (r) => ({ type: "binary", choice: deriveFromBinary(r.answers), answer_confidence: Math.max(r.answers.trivial.noul, r.answers.investigation.noul), probabilities: [] }),
    }),
  },
];
const results = {};

for (const v of variants) {
  results[v.version] = { correct: 0, rows: [], latencies: [] };
  for (const c of CASES) {
    const { qs, pick } = v.ask();
    const t0 = Date.now();
    const res = await decide(c.p, qs, { cfg });
    const dt = Date.now() - t0;
    if (!res.ok) {
      results[v.version].rows.push({ ...c, got: `ОШИБКА ${res.error.code}`, conf: null });
      continue;
    }
    const a = typeof pick === "function" ? pick(res) : pick;
    const conf = a.answer_confidence;
    const correct = a.choice === c.want;
    if (correct) results[v.version].correct++;
    results[v.version].latencies.push(dt);
    results[v.version].rows.push({ ...c, got: a.choice, conf, correct, probs: (a.probabilities || []).map((p) => `${p.label}=${p.value.toFixed(2)}`).join(" ") });
  }
}

const className = { fast: "fast ", balanced: "balan", deep: "deep " };
for (const v of variants) {
  const r = results[v.version];
  const acc = ((r.correct / CASES.length) * 100).toFixed(0);
  const lat = r.latencies.sort((a, b) => a - b);
  console.log(`\n=== ${v.version}: точность ${r.correct}/${CASES.length} (${acc}%), latency p50=${lat[Math.floor(lat.length / 2)]} мс ===`);
  console.log("ожидание  получено  p      верно  промпт");
  for (const row of r.rows) {
    console.log(
      `${className[row.want]}     ${className[row.got] ?? "ошибка"}   ${row.conf === null ? "  -  " : row.conf.toFixed(2)}   ${row.correct ? "да" : "НЕТ"}    ${row.p.slice(0, 52)}`,
    );
  }
  // Матрица ошибок: куда утекают классы
  const conf = {};
  for (const row of r.rows) {
    if (!row.correct) conf[`${row.want}→${row.got}`] = (conf[`${row.want}→${row.got}`] || 0) + 1;
  }
  const errs = Object.entries(conf);
  console.log(errs.length ? `ошибки: ${errs.map(([k, n]) => `${k} (${n})`).join(", ")}` : "ошибок нет");
}

// Сводка по классам: где именно шумит
console.log("\n=== Сводка: точность по классам ===");
for (const v of variants) {
  const per = {};
  for (const cls of ["fast", "balanced", "deep"]) {
    const subset = results[v.version].rows.filter((r) => r.want === cls);
    per[cls] = `${subset.filter((r) => r.correct).length}/${subset.length}`;
  }
  console.log(`${v.version}: fast ${per.fast}, balanced ${per.balanced}, deep ${per.deep}`);
}

process.exit(0);
