// admin-cli.test.mjs — офлайн-проверки CLI управления режимами.
//
// Живой сбой, ради которого они добавлены (2026-10-19): /laya-all с неизвестным
// аргументом («почему так») включал максимальный режим, потому что CLI считал
// включением всё, кроме явного off; ZCODE_PLUGIN_ROOT и ARGUMENTS в Bash не
// задавались. Здесь фиксируем строгий контракт on|off, отсутствие записи при
// ошибке и валидацию mode (включая sessionContext).

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { group, test, assert, assertEq, summary, makeTempDataDir, cleanupTempDataDir } from "./helpers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const admin = path.join(here, "..", "scripts", "laya-admin.mjs");
const dir = makeTempDataDir("admin");
const config = path.join(dir, "config.json");

// Исходное состояние — наблюдение; каждый тест проверяет свой переход.
fs.writeFileSync(
  config,
  JSON.stringify(
    {
      riskGate: { mode: "shadow" },
      doneGate: { mode: "report" },
      router: { mode: "log" },
      sessionContext: false,
      layaAll: false,
    },
    null,
    2,
  ) + "\n",
  "utf8",
);

function run(...args) {
  const r = spawnSync(process.execPath, [admin, ...args], {
    encoding: "utf8",
    env: { ...process.env, DAVINCI_LAYA_DATA: dir },
  });
  return { code: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function readConfig() {
  return JSON.parse(fs.readFileSync(config, "utf8"));
}

function modes() {
  const c = readConfig();
  return {
    risk: c.riskGate?.mode,
    done: c.doneGate?.mode,
    router: c.router?.mode,
    sessionContext: c.sessionContext === true ? "on" : c.sessionContext === false ? "off" : undefined,
    layaAll: c.layaAll === true ? "on" : c.layaAll === false ? "off" : undefined,
  };
}

group("all: строгий контракт on|off");
await test("all без аргумента включает экономию, не меняя разрешения", () => {
  const r = run("all");
  assertEq(r.code, 0, `exit code: ${r.stderr}`);
  assertEq(modes(), { risk: "shadow", done: "report", router: "log", sessionContext: "on", layaAll: "on" }, "режимы");
  assert(/Подтверждено по файлу/.test(r.stdout), "нет подтверждения записи");
});

await test("all off возвращает наблюдение", () => {
  const r = run("all", "off");
  assertEq(r.code, 0, `exit code: ${r.stderr}`);
  assertEq(modes(), { risk: "shadow", done: "report", router: "log", sessionContext: "off", layaAll: "off" }, "режимы");
});

await test("all без аргумента после off снова включает режим", () => {
  const r = run("all");
  assertEq(r.code, 0, `exit code: ${r.stderr}`);
  assertEq(modes(), { risk: "shadow", done: "report", router: "log", sessionContext: "on", layaAll: "on" }, "режимы");
});

await test("неизвестное значение отклоняется без записи", () => {
  const before = fs.readFileSync(config, "utf8");
  const r = run("all", "почему так");
  assertEq(r.code, 2, `exit code: ${r.stderr}`);
  assertEq(fs.readFileSync(config, "utf8"), before, "конфигурация изменилась");
  assert(/Недопустимое значение/.test(r.stdout), "нет объяснения");
});

await test("лишние аргументы отклоняются без записи", () => {
  const before = fs.readFileSync(config, "utf8");
  const r = run("all", "on", "лишнее");
  assertEq(r.code, 2, `exit code: ${r.stderr}`);
  assertEq(fs.readFileSync(config, "utf8"), before, "конфигурация изменилась");
});

await test("status показывает Laya-first", () => {
  const r = run("status");
  assert(/Laya-first \(laya-all\):\s+вкл/.test(r.stdout), `нет строки Laya-first: ${r.stdout}`);
});

group("mode: валидация значения и лишних аргументов");
await test("sessionContext off записывается и подтверждается", () => {
  const r = run("mode", "sessionContext", "off");
  assertEq(r.code, 0, `exit code: ${r.stderr}`);
  assertEq(readConfig().sessionContext, false, "sessionContext");
  assert(/Подтверждено по файлу: да/.test(r.stdout), "нет подтверждения записи");
});

await test("неверный sessionContext не меняет файл", () => {
  const before = fs.readFileSync(config, "utf8");
  const r = run("mode", "sessionContext", "junk");
  assertEq(r.code, 2, `exit code: ${r.stderr}`);
  assertEq(fs.readFileSync(config, "utf8"), before, "конфигурация изменилась");
});

await test("неверное значение risk отклоняется", () => {
  const before = fs.readFileSync(config, "utf8");
  const r = run("mode", "risk", "bogus");
  assertEq(r.code, 2, `exit code: ${r.stderr}`);
  assertEq(fs.readFileSync(config, "utf8"), before, "конфигурация изменилась");
});

await test("лишние аргументы mode отклоняются", () => {
  const before = fs.readFileSync(config, "utf8");
  const r = run("mode", "risk", "ask", "extra");
  assertEq(r.code, 2, `exit code: ${r.stderr}`);
  assertEq(fs.readFileSync(config, "utf8"), before, "конфигурация изменилась");
});

await test("mode risk ask записывается и подтверждается", () => {
  const r = run("mode", "risk", "ask");
  assertEq(r.code, 0, `exit code: ${r.stderr}`);
  assertEq(readConfig().riskGate.mode, "ask", "riskGate.mode");
});

cleanupTempDataDir(dir);
process.exit(summary("admin-cli.test"));
