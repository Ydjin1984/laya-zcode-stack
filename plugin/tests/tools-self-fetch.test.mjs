// tools-self-fetch.test.mjs — новые инструменты сами получают данные:
// laya_search, laya_read_relevant, laya_run_check; плюс token-aware бюджет.
//
// Laya намеренно недоступна (порт 9), чтобы проверить детерминированную часть
// и degraded-контракт без GPU. Для бюджета используется фиктивный клиент.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { group, test, assert, assertEq, summary, makeTempDataDir, cleanupTempDataDir } from "./helpers.mjs";

const dataDir = makeTempDataDir("self-fetch");
process.env.DAVINCI_LAYA_URL = "http://127.0.0.1:9";
process.env.DAVINCI_LAYA_TIMEOUT_MS = "200";

const { findTool } = await import("../src/tools.mjs");
const { getChunk } = await import("../src/chunk-store.mjs");
const { fitState, decideFitted } = await import("../src/budget.mjs");

const project = fs.mkdtempSync(path.join(os.tmpdir(), "laya-self-fetch-"));
process.env.DAVINCI_LAYA_PROJECT_DIR = project;
fs.mkdirSync(path.join(project, "src"), { recursive: true });
const longLines = Array.from({ length: 45 }, (_, i) => `export const v${i} = ${i};`);
longLines[19] = "// needle here";
longLines[35] = "export const beta = 2;";
fs.writeFileSync(path.join(project, "src", "a.mjs"), longLines.join("\n") + "\n");
fs.writeFileSync(path.join(project, "src", "b.mjs"), "// needle in b\nconst x = 1;\n");
fs.writeFileSync(path.join(project, "README.md"), "# demo\nneedle in docs\n");
fs.writeFileSync(
  path.join(project, "package.json"),
  JSON.stringify({ name: "self-fetch", version: "1.0.0", scripts: { test: "node check.mjs" } }),
);
// Намеренно падающая проверка: проверяем, что провал и exit 3 не скрываются.
fs.writeFileSync(path.join(project, "check.mjs"), 'console.error("INTENTIONAL_FAILURE: exit 3"); process.exit(3);\n');

group("laya_search: сам ищет, дедуплицирует, сохраняет полный результат");
await test("поиск без Laya возвращает выдержки и chunk со всеми хитами", async () => {
  const r = await findTool("laya_search").handler({
    query: "needle",
    root: project,
    budget: 2000,
    top_k: 3,
    max_candidates: 3,
  });
  assertEq(r.isError, false, "инструмент не падает без Laya");
  assert(r.structuredContent?.results?.length >= 2, "есть результаты");
  assert(r.structuredContent?.stats?.degraded === true, "ранжирование помечено degraded");
  const all = getChunk(r.structuredContent.chunk_id);
  assert(all.ok, "полный результат доступен по chunk_id");
  const parsed = JSON.parse(all.text);
  assert(parsed.hits.length >= 3, "в chunk все найденные хиты");
  assert(parsed.query === "needle", "chunk относится к этому запросу");
});

group("laya_read_relevant: сам читает файл и отмечает пропуски");
await test("блоки вокруг совпадений и полный файл в chunk", async () => {
  const r = await findTool("laya_read_relevant").handler({
    path: "src/a.mjs",
    query: "needle",
    root: project,
    budget: 1200,
    max_blocks: 4,
    use_laya: false,
  });
  assertEq(r.isError, false, "инструмент не падает");
  assert(r.structuredContent?.blocks?.length >= 1, "есть блок");
  assert(/── строки \d+-\d+/.test(r.content[0].text), "видны номера строк");
  assert(/пропущены/.test(r.content[0].text), "пропуски отмечены");
  const full = getChunk(r.structuredContent.chunk_id);
  assert(full.ok && full.text.includes("export const beta = 2"), "полный файл восстановлен");
});

await test("laya_get_chunk: страницы + явный full восстанавливает источник", async () => {
  const big = Array.from({ length: 1000 }, (_, i) => `line ${i} ${"x".repeat(35)}`).join("\n");
  const fullSource = `needle first\n${big}\n`;
  fs.writeFileSync(path.join(project, "big.txt"), fullSource);
  const rr = await findTool("laya_read_relevant").handler({ path: "big.txt", query: "needle", budget: 500, use_laya: false });
  const chunkTool = findTool("laya_get_chunk");
  const p1 = await chunkTool.handler({ id: rr.structuredContent.chunk_id, limit: 100 });
  assertEq(p1.isError, false, "страница читается");
  assertEq(p1.structuredContent.has_more, true, "есть продолжение");
  assertEq(p1.structuredContent.returned_chars, 100, "страница ограничена");
  assertEq(p1.structuredContent.next_offset, 100, "next_offset");
  const p2 = await chunkTool.handler({ id: rr.structuredContent.chunk_id, offset: 100, limit: 50 });
  assertEq(p2.structuredContent.offset, 100, "вторая страница с offset");
  const got = await chunkTool.handler({ id: rr.structuredContent.chunk_id, full: true });
  assertEq(got.content[0].text, fullSource, "полный источник восстановлен");
  assert(got.content[0].text.length > 20000, "текст больше прежнего лимита 20k");
});

group("laya_run_check: запускает проверку, не скрывает провал");
await test("провал: exit code, ошибки и полный вывод в chunk", async () => {
  const r = await findTool("laya_run_check").handler({ check_id: "auto", root: project, budget: 1200 });
  assertEq(r.isError, false, "инструмент выполнился");
  assertEq(r.structuredContent.success, false, "success=false");
  assertEq(r.structuredContent.exit_code, 3, "exit code передан");
  assert(r.content[0].text.includes("ПРОВАЛ"), "провал виден в тексте");
  const full = getChunk(r.structuredContent.chunk_id);
  assert(full.ok && full.text.includes("INTENTIONAL_FAILURE: exit 3"), "полный stdout/stderr сохранён");
});
await test("успех: exit 0 и итог", async () => {
  fs.writeFileSync(path.join(project, "check.mjs"), 'console.log("ok"); process.exit(0);\n');
  const r = await findTool("laya_run_check").handler({ check_id: "auto", root: project, budget: 1200 });
  assertEq(r.structuredContent.success, true, "success=true");
  assertEq(r.structuredContent.exit_code, 0, "exit 0");
  assert(r.content[0].text.includes("ПРОЙДЕНА"), "успех подтверждён фактом");
});

group("бюджет: /count, а не символьный лимит");
const q = { q: { type: "noul", instructions: "Верно ли?" } };
await test("state сокращается по данным /count с маркером", async () => {
  let n = 0;
  const client = {
    async count() {
      n += 1;
      if (n === 1) {
        return { ok: true, state_tokens: 1000, max_len: 1024, head_max_len: 256, fits: false, questions: [{ state_kept: 100, state_dropped: 900, head_truncated: false, collapsed: false }] };
      }
      return { ok: true, state_tokens: 100, max_len: 1024, head_max_len: 256, fits: true, questions: [{ state_kept: 100, state_dropped: 0, head_truncated: false, collapsed: false }] };
    },
  };
  const r = await fitState("x".repeat(5000), q, { cfg: {}, client });
  assert(r.ok, "после сокращения помещается");
  assert(r.truncated, "сокращение отмечено");
  assert(r.text.length < 2000, `state короче (${r.text.length})`);
  assert(r.text.includes("выпущено"), "маркер потери");
  assertEq(n, 2, "два замера /count");
});

await test("обрезанная инструкция/схлопнутые варианты → ошибка без /decide", async () => {
  let decided = 0;
  const client = {
    async count() {
      return { ok: true, state_tokens: 10, max_len: 1024, head_max_len: 256, fits: false, questions: [{ state_kept: 10, state_dropped: 0, head_truncated: true, collapsed: true }] };
    },
    async decide() {
      decided += 1;
      return { ok: true, answers: {} };
    },
  };
  const r = await decideFitted("короткий state", q, { cfg: {}, client, onOverflow: "error" });
  assertEq(r.ok, false, "ответ не принят");
  assertEq(r.error.code, "question_too_long", "понятная причина");
  assertEq(decided, 0, "/decide не вызывался");
});

cleanupTempDataDir(dataDir);
fs.rmSync(project, { recursive: true, force: true });
process.exit(summary("tools-self-fetch.test"));
