// run-check.mjs — запуск настроенной проверки проекта для laya_run_check.
//
// Принципы:
//   • Команда берётся только из конфигурации/автопоиска проекта, НЕ из аргумента
//     модели (модель передаёт только check_id).
//   • Полный stdout/stderr пишется на диск (chunk) даже если он огромный;
//     в ответ агенту идут exit code, уникальные ошибки, итог и chunk_id.
//   • Ненулевой exit code и таймаут никогда не скрываются.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { discoverChecks, firstCheckOfKind } from "./project.mjs";
import { openChunk } from "./chunk-store.mjs";
import { recordProjectCheck } from "./evidence-ledger.mjs";

const ERROR_LINE_RE = /(\b\w*Error\b|\bExceptions?\b|Traceback|\bfatal\b|\bpanic\b|\berror\b|\bfailed\b|\bfailure\b|\bdenied\b|\brefused\b|\btimeout\b|\btimed out\b|ENOENT|EACCES|ECONNREFUSED|MODULE_NOT_FOUND|exit\s*(code|status)[:=]?\s*[1-9]\d*)/i;
const PASS_LINE_RE = /^\s*(\[ok\]|ok([:\s]|$)|✓|✔|PASS\b)|\bпровалено\s*[:=]?\s*0\b|\bfailures?[:=]\s*0\b/i;
const SUMMARY_RE = /^(test suites|tests?[:\s]|snapshots?[:\s]|time[:\s]|duration[:\s]|build (failed|succeeded)|\d+\s+(passed|failed|error))/i;

function signature(line) {
  return String(line || "")
    .toLowerCase()
    .replace(/[a-zа-я]?:?[\\/][^\s:"']+/gi, "<p>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/["'`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);
}

/** Уникальные ошибки с количеством вхождений; ничего не «сглаживает». */
export function extractErrors(text, max = 20) {
  const groups = new Map();
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length < 4) continue;
    if (PASS_LINE_RE.test(line)) continue;
    if (!ERROR_LINE_RE.test(line)) continue;
    const key = signature(line);
    if (!key) continue;
    const g = groups.get(key);
    if (g) g.count += 1;
    else groups.set(key, { text: line.slice(0, 240), count: 1 });
  }
  return [...groups.values()].sort((a, b) => b.count - a.count).slice(0, max);
}

function lastSummary(text, max = 6) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const summary = lines.filter((l) => SUMMARY_RE.test(l));
  const chosen = (summary.length ? summary : lines).slice(-max);
  return chosen.map((l) => l.slice(0, 240));
}

function resolveCheck(checkId, root, cfg) {
  const checks = discoverChecks(root, cfg);
  const id = String(checkId || "auto");
  if (id === "auto") {
    const pick = firstCheckOfKind(checks);
    if (!pick) return { ok: false, error: "в проекте не найдено доступных проверок", available: checks };
    return { ok: true, id: pick.id, check: pick, available: checks };
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(id)) {
    return { ok: false, error: "check_id: допустимы только буквы, цифры, точка, дефис и подчёркивание", available: checks };
  }
  if (!checks[id]) {
    return {
      ok: false,
      error: `проверка «${id}» не настроена и не найдена`,
      available: checks,
    };
  }
  return { ok: true, id, check: checks[id], available: checks };
}

function killTree(child) {
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(-child.pid, "SIGKILL");
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

/**
 * Запускает проверку. Возвращает факты:
 * { ok, success, exit_code, timed_out, duration_ms, chunk_id, bytes,
 *   errors, summary, stdout_tail, command, check_id, available }
 */
export async function runCheck({ checkId = "auto", root, cfg = {}, budget = 6000, timeoutMs } = {}) {
  const projectRoot = path.resolve(root || process.env.DAVINCI_LAYA_PROJECT_DIR || process.cwd());
  let st;
  try {
    st = fs.statSync(projectRoot);
  } catch {
    return { ok: false, error: `project root не найден: ${projectRoot}` };
  }
  if (!st.isDirectory()) return { ok: false, error: `project root не каталог: ${projectRoot}` };

  const resolved = resolveCheck(checkId, projectRoot, cfg);
  if (!resolved.ok) return { ok: false, ...resolved, root: projectRoot };

  const effectiveTimeout = Math.max(5000, Math.min(600_000, timeoutMs ?? cfg.runChecks?.timeoutMs ?? 180_000));
  const started = Date.now();
  const chunkId = `check-${resolved.id}-${started.toString(36)}`;
  const stream = openChunk(chunkId, "check_output");

  return await new Promise((resolve) => {
    let child;
    let timedOut = false;
    let spawnError = null;
    const timer = setTimeout(() => {
      timedOut = true;
      if (child) killTree(child);
    }, effectiveTimeout);

    try {
      child = spawn(resolved.check.command, {
        cwd: projectRoot,
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32",
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", CI: "1" },
      });
    } catch (err) {
      clearTimeout(timer);
      stream.close();
      resolve({
        ok: true,
        success: false,
        check_id: resolved.id,
        command: resolved.check.command,
        root: projectRoot,
        exit_code: null,
        timed_out: false,
        duration_ms: Date.now() - started,
        chunk_id: chunkId,
        bytes: 0,
        errors: [{ text: String(err.message || err), count: 1 }],
        summary: [],
        stdout_tail: "",
        error: String(err.message || err),
        available: resolved.available,
      });
      return;
    }

    child.stdout.on("data", (b) => stream.write(b));
    child.stderr.on("data", (b) => stream.write(b));
    child.on("error", (err) => {
      spawnError = String(err.message || err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      const chunk = stream.close();
      const text = chunk.text || allText(chunk);
      const errors = extractErrors(text, 20);
      const summary = lastSummary(text, 6);
      const success = !timedOut && !spawnError && code === 0;
      const result = {
        ok: true,
        success,
        check_id: resolved.id,
        command: resolved.check.command,
        kind: resolved.check.kind,
        root: projectRoot,
        exit_code: code,
        signal: signal || null,
        timed_out: timedOut,
        duration_ms: Date.now() - started,
        chunk_id: chunk.id,
        bytes: chunk.bytes,
        errors,
        summary,
        stdout_tail: tailLines(text, 40, budget),
        available: resolved.available,
      };
      if (spawnError) result.error = spawnError;
      try {
        recordProjectCheck(projectRoot, {
          checkId: resolved.id,
          kind: resolved.check.kind,
          command: resolved.check.command,
          exitCode: timedOut ? null : code,
          timedOut,
          ts: Date.now(),
        });
      } catch {
        /* ledger — вспомогательный */
      }
      resolve(result);
    });
  });
}

function allText(chunk) {
  return chunk.text || `${chunk.head || ""}\n${chunk.tail || ""}`;
}

function tailLines(text, n, budget) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim().length > 0);
  const tail = lines.slice(-n);
  let out = "";
  for (let i = tail.length - 1; i >= 0; i--) {
    const next = tail[i] + (out ? "\n" + out : "");
    if (next.length > budget) break;
    out = next;
  }
  return out;
}
