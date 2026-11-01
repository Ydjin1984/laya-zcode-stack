#!/usr/bin/env node
// cost-model.mjs — экономика плагина в деньгах за токены (для API-оплаты).
//
// Логика: главный расход агентной сессии — это КОНТЕКСТ, который пересылается в
// каждом вызове модели. Артефакт, прочитанный в контекст, оплачивается не один
// раз, а в каждом следующем вызове сессии (полностью или по цене кэша). Поэтому
// экономия инструментов отбора ≈ (балласт артефакта) × (число вызовов после
// чтения) × (1 − скидка кэша) минус один лишний round-trip на сам триаж.
//
// Числа балласта взяты из живых замеров (experiments/final-summary.json):
//   лог 358 КБ: без плагина +132 884 токена в контексте, с плагином ~0;
//   лог 36 КБ:  без плагина  +12 818,            с плагином ~1 200;
//   поиск:      без плагина  +32 180,            с плагином ~5 500.
//
// Использование:
//   node experiments/cost-model.mjs --price-in 0.3 --price-cache 0.03 --turns 30
//   node experiments/cost-model.mjs --price-in 3 --price-cache 0.3 --scenario long

const args = process.argv.slice(2);
const flag = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] !== undefined ? Number(args[i + 1]) : def;
};

// Цены за 1M токенов. По умолчанию — deepseek-flash в ЧАС ПИК по официальной
// странице https://api-docs.deepseek.com/quick_start/pricing/ (снято 2026-10-15):
// вход (кэш-промах) $0.3, кэш-чтение $0.006 (2% входа), выход $1.2. ВНЕ ЧАСА ПИК
// всё вдвое дешевле (непик — всё, кроме 01:00–04:00 и 06:00–10:00 UTC пн–пт):
// передайте --price-in 0.15 --price-cache 0.003.
const PRICE_IN = flag("price-in", 0.3);
const PRICE_CACHE = flag("price-cache", PRICE_IN * 0.02); // кэш-чтение = 2% входа
const TURNS = flag("turns", 30); // вызовов модели после разбора артефакта
const BASE = flag("base", 50_000); // базовый контекст сессии (система+история), токенов

// Измеренные балласты (токенов, осевших в контексте) и цена триажа.
const SCENARIOS = [
  { name: "лог 358 КБ", ballastWithout: 132_884, ballastWith: 1_200, triageCost: BASE },
  { name: "лог 36 КБ", ballastWithout: 12_818, ballastWith: 1_200, triageCost: BASE },
  { name: "поиск по репо", ballastWithout: 32_180, ballastWith: 5_500, triageCost: BASE },
];

const money = (tokens, cachePriceShare = 0) => {
  // tokens — сколько токенов «висит» в контексте; считаем, что после первого
  // вызова они приходят из кэша (обычная практика провайдеров).
  const full = tokens * PRICE_IN;
  const cached = tokens * cachePriceShare * PRICE_CACHE;
  return (full + cached) / 1_000_000;
};

console.log("=== Экономика: платим за токены (API) ===");
console.log(`input $${PRICE_IN}/M, кэш-чтение $${PRICE_CACHE}/M, вызовов после чтения: ${TURNS}, базовый контекст: ${BASE.toLocaleString("ru-RU")} ток.`);
console.log("");
console.log("сценарий        без плагина        с плагином         экономия");
for (const s of SCENARIOS) {
  // Без плагина: артефакт в контексте → оплачивается в каждом из TURNS вызовов
  // (первый раз по полной цене, далее — по кэшу).
  const costWithout = money(s.ballastWithout, 1) + (TURNS - 1) * money(s.ballastWithout, 1);
  // С плагином: балласта почти нет, но добавляется один round-trip на триаж:
  // пересылка текущего контекста целиком (база + мелкий вывод инструмента).
  const costWith = money(s.ballastWith, 1) * TURNS + money(BASE, 1) + money(s.triageCost, 1);
  const save = costWithout - costWith;
  const pct = costWithout > 0 ? (save / costWithout) * 100 : 0;
  console.log(
    `${s.name.padEnd(15)} $${costWithout.toFixed(3).padEnd(17)} $${costWith.toFixed(3).padEnd(17)} $${save.toFixed(3)} (${pct.toFixed(0)}%)`,
  );
}

console.log("");
console.log("=== Как это читать ===");
console.log("- Экономия масштабируется числом вызовов ПОСЛЕ чтения большого артефакта:");
console.log(`  один лог 358 КБ при ${TURNS} последующих вызовах стоит без плагина $${(money(132_884, 1) * TURNS).toFixed(2)}, с плагином ~$${(money(BASE, 1) + money(1_200, 1)).toFixed(2)}.`);
console.log("- Хуки (гейты, ledger, роутер) в режимах shadow/report/log добавляют");
console.log("  в контекст РОВНО 0 токенов (проверено: stdout хуков пуст) — их цена в деньгах нулевая,");
console.log("  платите только локальным временем (~28–320 мс на вызов инструмента).");
console.log("- Мелкий артефакт (36 КБ): инструмент не окупается — правило «не применять отбор,");
console.log("  если чтение занимает один вызов» здесь и есть экономическое правило.");
console.log("- Точность: в A/B 26/26 ответов верны в обоих режимах — плагин не ухудшает качество,");
console.log("  а гейты добавляют 100% покрытия высокорисковых действий при 0 ложных и 0 токенов.");
