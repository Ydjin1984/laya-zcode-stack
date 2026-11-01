#!/usr/bin/env node
// launcher.test.mjs — проверка безопасности и корректности Go-лаунчера хуков.
//
// Главное утверждение, которое здесь проверяется: лаунчер НИКОГДА не пропускает
// потенциально опасный вызов. Проверка идёт на том же наборе кейсов, что и
// политика (tests/fixtures-risk.mjs): каждый «опасный» вызов обязан пройти в Node,
// и только явно читающие команды могут быть пропущены.
//
// Как детектируется пропуск: лаунчеру в качестве хук-скрипта подаётся заглушка
// (launcher-stub.mjs), которая печатает маркер. Если маркера нет — лаунчер
// пропустил событие (Node не запускался).

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { group, test, assert, assertEq, summary, makeTempDataDir, cleanupTempDataDir } from "./helpers.mjs";
import { DANGEROUS, SAFE } from "./fixtures-risk.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const launcher = path.join(here, "..", "bin", "laya-hook.exe");
const stub = path.join(here, "launcher-stub.mjs");
const dataDir = makeTempDataDir("launcher");
const MARKER = "passed_through";

if (!fs.existsSync(launcher)) {
  console.error(`лаунчер не собран: ${launcher}\nСоберите: build-launcher.cmd (или go build -o bin\\laya-hook.exe .)`);
  process.exit(2);
}

function runLauncher(input, { mode = "pre", script = stub, env = {} } = {}) {
  const r = spawnSync(launcher, [mode, script], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, DAVINCI_LAYA_DATA: dataDir, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  return { stdout: r.stdout || "", stderr: r.stderr || "", status: r.status };
}

const CWD = "D:/proj/work";
const asBash = (input) => ({ session_id: "launcher-s1", cwd: CWD, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: input } });

group("безопасность: опасное не пропускается НИКОГДА");
for (const c of DANGEROUS) {
  await test(`проброс: ${String(c.input.command || c.input.file_path).slice(0, 58)}`, () => {
    const r = runLauncher({ session_id: "launcher-s1", cwd: CWD, tool_name: c.tool, tool_input: c.input });
    assert(r.stdout.includes(MARKER), `лаунчер ПРОПУСТИЛ опасный вызов ${c.tool}: ${JSON.stringify(c.input)}`);
  });
}
await test("все опасные кейсы проверены", () => {
  process.stdout.write(`     проверено опасных вызовов: ${DANGEROUS.length}\n`);
});

group("пропуск: только явно читающие команды");
const skipCandidates = [
  "ls -la src",
  "cat package.json",
  "head -n 20 README.md",
  "tail -n 5 logs/app.log",
  "rg -n \"TODO\" src/",
  "grep -rn \"state\" engine/",
  "wc -l file.txt",
  "pwd",
  "echo hello",
  "node --version",
  "go version",
  "git log --oneline -20",
  "git diff HEAD --stat",
  "git show HEAD",
  "git branch -a",
  "npm ls --depth=0",
  "find . -name '*.go'",
  'cat "file name with spaces.txt"',
];
for (const cmd of skipCandidates) {
  await test(`пропуск: ${cmd.slice(0, 56)}`, () => {
    const r = runLauncher(asBash(cmd));
    assertEq(r.stdout.trim(), "", `ожидался пропуск «${cmd}», но событие ушло в Node`);
    assertEq(r.status, 0, "код выхода");
  });
}

group("пропуск запрещён: цепочки, перенаправления, подстановки, не-чтение");
const mustPass = [
  "ls && rm -rf /",
  "cat file.txt > out.txt",
  "cat file.txt | tee copy.txt",
  "echo $(rm -rf /)",
  "ls `whoami`",
  "git status",
  "git ls-files -z | xargs rm",
  "npm test",
  "npm run build",
  "node -e 'console.log(1)'",
  "python script.py",
  "find . -name '*.log' -delete",
  "find . -exec rm {} ;",
  "go test ./...",
  "npx tsc --noEmit",
  "pytest -q",
  "make build",
  "curl https://example.com",
  "rm -rf ./src",
];
for (const cmd of mustPass) {
  await test(`проброс: ${cmd.slice(0, 56)}`, () => {
    const r = runLauncher(asBash(cmd));
    assert(r.stdout.includes(MARKER), `лаунчер пропустил «${cmd}» — это недопустимо`);
  });
}

group("инструменты записи и не-Bash события");
for (const tool of ["Write", "Edit", "MultiEdit", "ApplyPatch"]) {
  await test(`проброс: инструмент ${tool}`, () => {
    const r = runLauncher({ session_id: "launcher-s1", cwd: CWD, tool_name: tool, tool_input: { file_path: "D:/proj/work/a.ts", content: "x" } });
    assert(r.stdout.includes(MARKER), `${tool} не должен пропускаться`);
  });
}
await test("Read-событие (не наш matcher) — тоже проброс", () => {
  const r = runLauncher({ session_id: "launcher-s1", cwd: CWD, tool_name: "Read", tool_input: { file_path: "D:/proj/work/a.ts" } });
  assert(r.stdout.includes(MARKER), "Read должен уходить в Node (там gate его отфильтрует)");
});

group("конфигурация влияет на пропуск");
await test("layaPolicy=always отключает пропуск", () => {
  const dir = makeTempDataDir("launcher-always");
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ riskGate: { mode: "shadow", layaPolicy: "always" } }), "utf8");
  const r = runLauncher(asBash("ls -la"), { env: { DAVINCI_LAYA_DATA: dir } });
  cleanupTempDataDir(dir);
  assert(r.stdout.includes(MARKER), "при layaPolicy=always read-only команда должна идти в Node");
});
await test("layaPolicy=smart (по умолчанию) пропускает чтение", () => {
  const r = runLauncher(asBash("ls -la"));
  assertEq(r.stdout.trim(), "", "при smart чтение пропускается");
});

group("устойчивость и протокол");
await test("мусор на stdin → проброс без падения", () => {
  const r = spawnSync(launcher, ["pre", stub], {
    input: "{не json",
    encoding: "utf8",
    env: { ...process.env, DAVINCI_LAYA_DATA: dataDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  assertEq(r.status, 0, "код выхода 0");
  assert((r.stdout || "").includes(MARKER), "мусор уходит в Node, где есть диагностика");
});
await test("пустой stdin → проброс, не падение", () => {
  const r = spawnSync(launcher, ["pre", stub], {
    input: "",
    encoding: "utf8",
    env: { ...process.env, DAVINCI_LAYA_DATA: dataDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  assertEq(r.status, 0, "код выхода 0");
});
await test("код выхода Node пробрасывается", () => {
  const r = spawnSync(launcher, ["pre", path.join(here, "launcher-exit2.mjs")], {
    input: JSON.stringify(asBash("rm -rf /")),
    encoding: "utf8",
    env: { ...process.env, DAVINCI_LAYA_DATA: dataDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  assertEq(r.status, 2, "блокирующий код 2 должен дойти до ZCode");
});
await test("диагностика лаунчера не идёт в stdout", () => {
  const r = runLauncher(asBash("ls -la"), { mode: "pre" });
  assertEq(r.stdout, "", "stdout строго пуст при пропуске");
});

group("permission mode: PreToolUse пропускается, PostToolUse — никогда");
fs.writeFileSync(
  path.join(dataDir, "config.json"),
  JSON.stringify({
    riskGate: { mode: "ask", activeModes: ["guarded"], layaPolicy: "always" },
    doneGate: { mode: "block", activeModes: ["guarded"] },
  }),
);
const preYolo = (cmd = "rm -rf ./src") =>
  runLauncher({ session_id: "launcher-perm", cwd: CWD, mode: "yolo", permission_mode: "yolo", tool_name: "Bash", tool_input: { command: cmd } });
const preGuarded = (cmd = "rm -rf ./src") =>
  runLauncher({ session_id: "launcher-perm", cwd: CWD, mode: "guarded", permission_mode: "guarded", tool_name: "Bash", tool_input: { command: cmd } });

await test("yolo PreToolUse: Node не запускается", () => {
  const r = preYolo();
  assertEq(r.stdout.trim(), "", "пропуск без Node");
  assertEq(r.status, 0, "код 0");
});
await test("yolo PreToolUse: лёгкая метрика skip_mode записана", () => {
  const metrics = path.join(dataDir, "metrics");
  const files = fs.readdirSync(metrics).filter((n) => n.startsWith("decisions-"));
  assert(files.length > 0, "файл метрик создан");
  const rows = fs
    .readFileSync(path.join(metrics, files.sort().pop()), "utf8")
    .trim()
    .split(/\r?\n/)
    .map((l) => JSON.parse(l));
  const row = rows.find((r) => r.source === "hook:launcher");
  assert(row, "есть запись лаунчера");
  assertEq(row.action, "skip_mode", "действие");
  assertEq(row.extra?.permission_mode, "yolo", "режим");
  assertEq(row.extra?.launcher, true, "источник");
});
await test("guarded PreToolUse: идёт в Node", () => {
  const r = preGuarded();
  assert(r.stdout.includes(MARKER), "guarded не пропускается");
});
await test("yolo PostToolUse: всегда идёт в Node (evidence)", () => {
  const r = runLauncher(
    { session_id: "launcher-perm", cwd: CWD, mode: "yolo", permission_mode: "yolo", tool_name: "Bash", tool_input: { command: "echo x" } },
    { mode: "post" },
  );
  assert(r.stdout.includes(MARKER), "PostToolUse нельзя пропускать: evidence нужен и в yolo");
});
await test("неизвестный режим: не пропускается по догадке", () => {
  const r = runLauncher({ session_id: "launcher-perm", cwd: CWD, tool_name: "Bash", tool_input: { command: "rm -rf ./src" } });
  assert(r.stdout.includes(MARKER), "без permission mode — проброс");
});

cleanupTempDataDir(dataDir);
process.exit(summary("launcher.test"));
