// telemetry.mjs — локальные метрики решений и гейтов.
//
// Формат: JSONL, день на файл, в каталоге данных плагина. Записываются только
// факты, нужные для калибровки и A/B (§9.7, §10 ТЗ):
//   session_id, tool, mode, latency_ms, checkpoint, question_set_version,
//   state_hash (не сам текст!), scores, action, reason, inference_error.
// Полный prompt и содержимое файлов не сохраняются никогда.
//
// Запись best-effort: сбой телеметрии не должен влиять на решения гейтов.

import fs from "node:fs";
import path from "node:path";
import { loadConfig, paths } from "./config.mjs";

function dayFile(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return path.join(paths().metricsDir, `decisions-${y}-${m}-${d}.jsonl`);
}

/**
 * Пишет одно событие. Поля фиксированы: свободные метаданные допускаются только
 * в `extra` (и туда нельзя класть текст пользователя).
 */
export function recordEvent(event, cfg = loadConfig()) {
  if (!cfg.telemetry.enabled) return;
  const row = {
    ts: new Date().toISOString(),
    kind: event.kind || "decision",
    session_id: event.sessionId || null,
    tool: event.tool || null,
    source: event.source || null, // hook:pre-tool | hook:stop | mcp:laya_decide ...
    mode: event.mode || null,
    action: event.action || null,
    reason: event.reason ? String(event.reason).slice(0, 300) : null,
    latency_ms: event.latencyMs ?? null,
    elapsed_ms: event.elapsedMs ?? null,
    checkpoint: event.checkpoint || null,
    question_set_version: event.questionSetVersion || null,
    state_hash: event.stateHash || null,
    state_chars: event.stateChars ?? null,
    state_truncated: event.stateTruncated ?? null,
    scores: event.scores || null, // {id: {choice|score|noul, answer_confidence}}
    inference_error: event.inferenceError || null,
    det_hits: event.detHits || null,
    extra: event.extra || null,
  };
  try {
    fs.mkdirSync(path.dirname(dayFile()), { recursive: true });
    fs.appendFileSync(dayFile(), JSON.stringify(row) + "\n", "utf8");
  } catch {
    /* телеметрия — вспомогательный канал */
  }
  // Ротация: файлы старше keepDays удаляются при записи (редко и дёшево).
  try {
    const keep = (cfg.telemetry.keepDays || 14) * 86_400_000;
    const dir = paths().metricsDir;
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith("decisions-")) continue;
      const full = path.join(dir, name);
      if (Date.now() - fs.statSync(full).mtimeMs > keep) fs.unlinkSync(full);
    }
  } catch {
    /* ignore */
  }
}

/** Собирает агрегаты по всем сохранённым метрикам — для /laya-status. */
export function summarizeMetrics() {
  const dir = paths().metricsDir;
  const out = {
    events: 0,
    byKind: {},
    byAction: {},
    errors: 0,
    truncated: 0,
    latencies: [],
    checkpoints: {},
    since: null,
    until: null,
  };
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((n) => n.startsWith("decisions-") && n.endsWith(".jsonl")).sort();
  } catch {
    return out;
  }
  for (const name of files) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      out.events += 1;
      out.since = out.since || row.ts;
      out.until = row.ts;
      out.byKind[row.kind] = (out.byKind[row.kind] || 0) + 1;
      if (row.action) out.byAction[row.action] = (out.byAction[row.action] || 0) + 1;
      if (row.inference_error) out.errors += 1;
      if (row.state_truncated) out.truncated += 1;
      if (typeof row.latency_ms === "number") out.latencies.push(row.latency_ms);
      if (row.checkpoint) out.checkpoints[row.checkpoint] = (out.checkpoints[row.checkpoint] || 0) + 1;
    }
  }
  out.latencies.sort((a, b) => a - b);
  const q = (p) => (out.latencies.length ? out.latencies[Math.min(out.latencies.length - 1, Math.floor(p * (out.latencies.length - 1)))] : null);
  out.p50 = q(0.5);
  out.p95 = q(0.95);
  delete out.latencies;
  return out;
}
