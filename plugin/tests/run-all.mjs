#!/usr/bin/env node
// run-all.mjs — запуск всех тестов плагина одной командой.
//
// Порядок: офлайн-тесты (гейты, replay) → live-контракт и MCP (могут SKIP при
// недоступной Laya). Итоговый код возврата — максимум по файлам, чтобы CI/приёмка
// не пропустили провал в середине списка.

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const files = ["gate-fixtures.test.mjs", "launcher.test.mjs", "replay.test.mjs", "tools-validation.test.mjs", "tools-self-fetch.test.mjs", "admin-cli.test.mjs", "laya-all-policy.test.mjs", "contract.test.mjs", "mcp-smoke.test.mjs"];

let failed = 0;
const started = Date.now();
process.stdout.write("DaVinci × Laya: тесты плагина\n");
for (const f of files) {
  process.stdout.write(`\n>>> ${f}\n`);
  const r = spawnSync(process.execPath, [path.join(here, f)], { stdio: "inherit" });
  if (r.status !== 0) failed++;
}
process.stdout.write(`\nИтог: ${files.length - failed}/${files.length} файлов тестов пройдено за ${((Date.now() - started) / 1000).toFixed(1)} с\n`);
process.exit(failed === 0 ? 0 : 1);
