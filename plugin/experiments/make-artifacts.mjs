#!/usr/bin/env node
// make-artifacts.mjs — генерация артефактов для A/B-экспериментов.
//
// Артефакты детерминированы (без Math.random): один и тот же лог при каждом
// запуске, поэтому замеры «до/после» и повторные прогоны сравнимы.
//
//   log-700.txt   700 строк «сборка + тесты» с тремя зарытыми реальными ошибками
//                 (TS2345, TypeError в тесте, ENOENT конфига) среди шума.
//   search-hits.txt  вывод rg по репозиторию движка — вход для search-relevant.
//
// Запуск: node experiments/make-artifacts.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = (name) => path.join(here, name);

const lines = [];
const push = (s = "") => lines.push(s);

// --- Шум: прогресс сборки (типичный npm/vite-вывод) ---
push("$ npm run build");
push("");
push("> app@1.4.2 build");
push("> tsc -p tsconfig.build.json && vite build");
push("");
for (let i = 1; i <= 120; i++) {
  push(`transforming (${i * 37}/2441) node_modules/${["lodash", "react", "zod", "date-fns", "axios"][i % 5]}/esm/${i}.js`);
}
push("✓ 2441 modules transformed.");
push("dist/assets/index-4f2a1c.js   412.55 kB │ gzip: 128.90 kB");
push("dist/assets/vendor-9b1d2e.js 1,204.11 kB │ gzip: 341.02 kB");
push("");
push("(!) Some chunks are larger than 500 kB after minification. Consider:");
push("- Using dynamic import() to code-split the application");
push("- Use build.rollupOptions.output.manualChunks to improve chunking");
push("");

// --- Ошибка 1: TypeScript (зарыта среди предупреждений) ---
push("$ npx tsc --noEmit -p tsconfig.json");
for (let i = 0; i < 25; i++) push(`src/generated/api-types-${i}.ts: skipLibCheck enabled, skipping`);
push("src/domain/cart.ts:118:34 - error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.");
push("  118   const total = applyDiscount(cart.id, itemPrice);");
push("                                       ~~~~~~~");
push("  Found 1 error in the same file. Further diagnostics suppressed.");
push("");

// --- Шум: прогон тестов, много проходящих ---
push("$ npm test -- --reporter=verbose");
for (let i = 1; i <= 180; i++) {
  if (i % 17 === 0) push(`⚠ slow test (${(i / 3).toFixed(1)}s): suites/legacy/group-${i}.test.ts`);
  push(`  ✓ suite ${Math.ceil(i / 9)} › case ${i} parses payload (${(i % 40) + 3} ms)`);
}
push("");
push("  ✗ suites/checkout/checkout.test.ts > applies coupon to cart");
push("    TypeError: Cannot read properties of undefined (reading 'map')");
push("      at applyCoupon (src/domain/discounts.ts:77:31)");
push("      at suites/checkout/checkout.test.ts:44:12");
push("");
for (let i = 181; i <= 320; i++) push(`  ✓ suite ${Math.ceil(i / 9)} › case ${i} serializes state (${(i % 30) + 2} ms)`);
push("");
for (let i = 0; i < 40; i++) push(`DeprecationWarning: util.isArray is deprecated (node:${14000 + i})`);
push("");

// --- Ошибка 3: отсутствующий конфиг в шаге деплоя ---
push("$ node scripts/prepare-config.mjs --env production");
push("reading config/prod.json ...");
push("node:internal/fs/promises:640");
push("  throw err;");
push("  ^");
push("Error: ENOENT: no such file or directory, open 'config/prod.json'");
push("    at async readFile (node:internal/fs/promises:640:14)");
push("    at async loadConfig (scripts/prepare-config.mjs:12:18)");
push("");

// --- Шум: итоги и посторонние предупреждения ---
push("Test Suites: 1 failed, 43 passed, 44 total");
push("Tests:       1 failed, 512 passed, 513 total");
push("Snapshots:   0 total");
push("Time:        38.412 s");
push("");
for (let i = 0; i < 60; i++) push(`[warn] lint: unused import in src/legacy/helper-${i}.ts`);
for (let i = 0; i < 40; i++) push(`[info] cache hit for node_modules/.vite/deps/chunk-${i}.js`);
push("");
push("Build failed with 2 errors and 1 failing test. See details above.");

// Добиваем до ровно 700 строк нейтральным шумом (детерминированно).
let n = 0;
while (lines.length < 700) {
  push(`[progress] keepalive packet ${n++} ok`);
}
const logText = lines.slice(0, 700).join("\n") + "\n";
fs.writeFileSync(out("log-700.txt"), logText, "utf8");

// Большой лог — тот же сценарий ×10 (7010 строк, ~358 КБ): проверка триажа на
// объёме, где полное чтение стоит сотни тысяч токенов контекста.
const big = [];
for (let rep = 0; rep < 10; rep++) {
  for (const line of logText.split("\n")) {
    big.push(line.replace(/packet (\d+)/, (m, n) => `packet ${Number(n) + rep * 1000}`));
  }
}
const bigText = big.join("\n");
fs.writeFileSync(out("log-7000.txt"), bigText, "utf8");

const stats = {
  lines: logText.split("\n").length - 1,
  bytes: Buffer.byteLength(logText, "utf8"),
  bigLines: big.length,
  bigBytes: Buffer.byteLength(bigText, "utf8"),
  plantedErrors: [
    "TS2345 src/domain/cart.ts:118 (string → number)",
    "TypeError map undefined — checkout.test.ts / discounts.ts:77",
    "ENOENT config/prod.json (prepare-config.mjs)",
  ],
};
fs.writeFileSync(out("log-700.stats.json"), JSON.stringify(stats, null, 2) + "\n", "utf8");
console.log(`log-700.txt: ${stats.lines} строк, ${stats.bytes} байт`);
console.log(`log-7000.txt: ${stats.bigLines} строк, ${stats.bigBytes} байт`);
console.log(`зарыто ошибок: ${stats.plantedErrors.length}`);
