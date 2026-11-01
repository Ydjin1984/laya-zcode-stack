// router-cases.mjs — размеченный набор промптов и бинарные вопросы TaskRouter.
//
// Единый источник для policy, eval-скриптов и тестов: набор и формулировки не
// должны расходиться между кодом и замерами, иначе «до/после» несравнимы.
//
// История формулировок (подробности — docs/CALIBRATION.md):
//   router-v1..v4 — трёхсторонний choice fast/balanced/deep: точность 25–50%,
//                   класс deep — 0/4 во всех вариантах (модель выбирала первый
//                   вариант, а после перестановки всё равно не различала deep);
//   router-v5     — бинарная пара «тривиально?» + «нужно исследование?»:
//                   deep впервые распознаётся, пороги подбираются на замерах.

/**
 * Размеченный набор: fast = один факт/одна правка в одном файле; balanced =
 * обычная задача разработки; deep = исследование/архитектура/миграция/аудит.
 *
 * Оговорка о метках: «Отрефактори модуль парсинга…» — пограничный кейс
 * (balanced↔deep), размечен как balanced. Метки — предмет обсуждения, числа
 * точности зависят от них, поэтому набор и версия фиксируются вместе.
 */
export const ROUTER_CASES = [
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

/** router-v5: тривиальный запрос? Порог задаётся в policy (trivialThreshold). */
export const ROUTER_TRIVIAL_Q = {
  type: "noul",
  instructions: "Это одна команда, один факт или правка ровно в одном файле без проверок?",
};

/** router-v5: нужен ли исследовательский/архитектурный этап? */
export const ROUTER_INVESTIGATION_Q = {
  type: "noul",
  instructions: "Нужно ли исследовать неизвестную причину, проектировать архитектуру или мигрировать систему?",
};

/** Пороги по умолчанию — из подбора на замерах (scripts/laya-router-thresholds.mjs). */
export const ROUTER_THRESHOLDS = { trivial: 0.7, investigation: 0.7 };

/** Класс задачи по ответам бинарной пары. */
export function deriveTaskClass(answers, thresholds = ROUTER_THRESHOLDS) {
  const invest = answers?.investigation?.noul ?? 0;
  const trivial = answers?.trivial?.noul ?? 0;
  if (invest >= thresholds.investigation) return { taskClass: "deep", basis: `investigation=${invest.toFixed(2)}` };
  if (trivial >= thresholds.trivial) return { taskClass: "fast", basis: `trivial=${trivial.toFixed(2)}` };
  return { taskClass: "balanced", basis: `trivial=${trivial.toFixed(2)}, investigation=${invest.toFixed(2)}` };
}
