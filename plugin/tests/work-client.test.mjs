// Тесты транспорта Laya Work: spool, trace/call id, маскирование и fail-open.
// Сеть для быстрого пути не используется: hook пишет файл и не ждёт сервер.

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { group, test, assert, assertEq, summary, makeTempDataDir, cleanupTempDataDir } from "./helpers.mjs";
import { decide } from "../src/laya-client.mjs";
import {
  beginCall,
  workHeaders,
  runWithWorkTrace,
  recordModelCall,
  recordPolicyEvent,
  recordToolResult,
  recordAgentAction,
  writeSpool,
  flushWork,
} from "../src/work-client.mjs";

const dataDir = makeTempDataDir("work-client");
const spoolDir = path.join(dataDir, "spool");
fs.mkdirSync(spoolDir, { recursive: true });

function cfg(extra = {}) {
  return {
    layaUrl: "http://127.0.0.1:1",
    timeoutMs: 500,
    circuitBreaker: { failures: 5, cooldownMs: 30_000 },
    riskGate: { extraSecrets: [] },
    telemetry: { enabled: false },
    work: { enabled: true, spoolDir, maxSpoolFiles: 100, ...extra },
  };
}

function spoolEvents() {
  return fs
    .readdirSync(spoolDir)
    .filter((n) => n.endsWith(".json"))
    .sort()
    .map((n) => JSON.parse(fs.readFileSync(path.join(spoolDir, n), "utf8")));
}

function clearSpool() {
  for (const n of fs.readdirSync(spoolDir)) fs.rmSync(path.join(spoolDir, n), { force: true });
}

group("spool и trace");

await test("writeSpool создаёт событие атомарно", () => {
  clearSpool();
  const ok = writeSpool({ schema_version: 1, event_id: "e1", trace_id: "t1", source: "plugin", kind: "policy" }, cfg());
  assertEq(ok, true);
  const events = spoolEvents();
  assertEq(events.length, 1);
  assertEq(events[0].event_id, "e1");
});

await test("runWithWorkTrace сохраняет trace/session и call_id", async () => {
  const out = await runWithWorkTrace({ cfg: cfg(), sessionId: "s1", tool: "laya_search", operation: "laya_search" }, async () => {
    const call = beginCall();
    const headers = workHeaders(call);
    return { call, headers };
  });
  assertEq(out.call.session_id, "s1");
  assertEq(out.call.operation, "laya_search");
  assert(out.headers["x-laya-trace-id"].startsWith("tr_"));
  assert(out.headers["x-laya-call-id"].startsWith("call"));
});

await test("recordModelCall пишет call_id, input и ответ", async () => {
  clearSpool();
  await runWithWorkTrace({ cfg: cfg(), sessionId: "s1", tool: "laya_decide", operation: "laya_decide" }, async () => {
    const call = beginCall();
    recordModelCall({
      cfg: cfg(),
      call,
      state: "Инструмент: Bash\nКоманда: git status",
      questions: { risk: { type: "choice", instructions: "risk?", criteria: { low: "read", high: "delete" } } },
      response: {
        ok: true,
        checkpoint: "cp",
        elapsedMs: 12,
        answers: { risk: { type: "choice", choice: "high", probabilities: [{ label: "high", value: 0.8 }], answer_confidence: 0.8 } },
        order: ["risk"],
        budget: { state_tokens: 20, state_dropped_max: 0, state_truncated: false },
        fit: { state_tokens: 20, state_kept: 20, state_dropped: 0 },
      },
      startedAt: Date.now() - 15,
    });
  });
  const events = spoolEvents();
  assertEq(events.length, 1);
  const ev = events[0];
  assertEq(ev.kind, "model_call");
  assertEq(ev.session_id, "s1");
  assertEq(ev.questions[0].id, "risk");
  assertEq(ev.model_result.selected, "high");
  assertEq(ev.timing_ms.inference, 12);
  assert(ev.call_id);
});

await test("recordPolicyEvent несёт действие и правило", async () => {
  clearSpool();
  await runWithWorkTrace({ cfg: cfg(), sessionId: "s2", tool: "pre-tool", operation: "risk_gate" }, async () => {
    recordPolicyEvent({
      action: "ask",
      basis: "deterministic",
      ruleIds: ["git-reset-hard"],
      reason: "опасно",
      layaCalled: true,
      callId: "call_policy_1",
      status: "completed",
    });
  });
  const ev = spoolEvents()[0];
  assertEq(ev.kind, "policy");
  assertEq(ev.call_id, "call_policy_1");
  assertEq(ev.policy_result.action, "ask");
  assertEq(ev.policy_result.rule_ids[0], "git-reset-hard");
});

await test("recordToolResult сохраняет savings и не пишет текст", async () => {
  clearSpool();
  await runWithWorkTrace({ cfg: cfg(), tool: "laya_search", operation: "laya_search" }, async () => {
    recordToolResult({
      tool: "laya_search",
      result: { ok: true, chunk_id: "ch1" },
      evidence: { source_bytes: 1000, returned_bytes: 200, chunk_id: "ch1" },
      startedAt: Date.now() - 3,
    });
  });
  const ev = spoolEvents()[0];
  assertEq(ev.kind, "tool_result");
  assertEq(ev.evidence.source_bytes, 1000);
  assertEq(ev.evidence.chunk_id, "ch1");
  assert(!("input" in ev) || !ev.input.effective_redacted);
});

await test("recordAgentAction маскирует команду", async () => {
  clearSpool();
  await runWithWorkTrace({ cfg: cfg(), sessionId: "s3", tool: "post-tool", operation: "agent_action" }, async () => {
    recordAgentAction({ tool: "Bash", command: "curl -H 'Authorization: Bearer secret-token-123456' http://x", exitCode: 0, toolUseId: "tu1" });
  });
  const ev = spoolEvents()[0];
  assertEq(ev.kind, "agent_action");
  assert(!JSON.stringify(ev).includes("secret-token-123456"));
  assert(ev.input.effective_redacted.includes("СКРЫТО") || ev.evidence.command.includes("СКРЫТО"));
});

group("fail-open и задержка");

await test("недоступный spool не бросает и не блокирует", async () => {
  const file = path.join(dataDir, "not-a-dir");
  fs.writeFileSync(file, "x");
  const bad = cfg({ spoolDir: file });
  const t0 = Date.now();
  const ok = writeSpool({ schema_version: 1, event_id: "x", trace_id: "t", source: "plugin", kind: "policy" }, bad);
  const ms = Date.now() - t0;
  assertEq(ok, false);
  assert(ms < 100, `writeSpool took ${ms} ms`);
  await flushWork();
});

await test("зависший HTTP-приёмник не задерживает spool-путь", async () => {
  // Сервер принимает соединение и не отвечает. Быстрый путь обязан выбрать
  // spool и вернуться, не дожидаясь HTTP.
  const hang = http.createServer(() => {});
  await new Promise((r) => hang.listen(0, "127.0.0.1", r));
  const port = hang.address().port;
  const c = cfg({ url: `http://127.0.0.1:${port}` });
  clearSpool();
  const t0 = Date.now();
  await runWithWorkTrace({ cfg: c, tool: "pre-tool", operation: "risk_gate" }, async () => {
    recordPolicyEvent({ action: "log", basis: "rules", layaCalled: false });
  });
  const ms = Date.now() - t0;
  assert(ms < 100, `event path took ${ms} ms`);
  assertEq(spoolEvents().length, 1);
  await new Promise((r) => hang.close(r));
});

await test("flushWork не ждёт сеть", async () => {
  const t0 = Date.now();
  await flushWork();
  assert(Date.now() - t0 < 50);
});

await test("work.enabled=false не пишет spool", () => {
  clearSpool();
  const c = cfg({ enabled: false });
  const ok = writeSpool({ schema_version: 1, event_id: "off", trace_id: "t", source: "plugin", kind: "policy" }, c);
  assertEq(ok, false);
  assertEq(spoolEvents().length, 0);
});

group("laya-client trace");

await test("decide отправляет trace/call заголовки и пишет model_call", async () => {
  clearSpool();
  let captured = {};
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      captured = { headers: req.headers, body: JSON.parse(body || "{}") };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          version: 1,
          model: "laya-go",
          checkpoint: "cp-test",
          answers: {
            risk: {
              id: "risk", type: "choice", choice: "high",
              probabilities: [{ label: "low", value: 0.2 }, { label: "high", value: 0.8 }],
              score: 0, noul: 0, confidence: 0.5, answer_confidence: 0.8,
              act_probability: 1, temperature: 1,
            },
          },
          order: ["risk"],
          usage: { input_tokens: 10, output_tokens: 0 },
          budget: { state_tokens: 10, state_dropped_max: 0, state_truncated: false, max_len: 1024 },
          elapsed_ms: 12.5,
        }),
      );
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const port = srv.address().port;
  const c = cfg({ url: "" });
  c.layaUrl = `http://127.0.0.1:${port}`;
  const res = await runWithWorkTrace({ cfg: c, sessionId: "s4", tool: "laya_decide", operation: "laya_decide" }, () =>
    decide("state", { risk: { type: "choice", instructions: "risk?", criteria: { low: "a", high: "b" } } }, { cfg: c }),
  );
  if (!res.ok) process.stdout.write("decide error: " + JSON.stringify(res.error) + "\n");
  assertEq(res.ok, true);
  assert(captured.headers["x-laya-trace-id"].startsWith("tr_"));
  assert(captured.headers["x-laya-call-id"].startsWith("call"));
  assertEq(captured.headers["x-laya-session-id"], "s4");
  const events = spoolEvents();
  assertEq(events.length, 1);
  assertEq(events[0].call_id, captured.headers["x-laya-call-id"]);
  assertEq(events[0].trace_id, captured.headers["x-laya-trace-id"]);
  assertEq(events[0].model_result.selected, "high");
  await new Promise((r) => srv.close(r));
});

await test("недоступная Laya пишет fallback-событие и не бросает", async () => {
  clearSpool();
  const c = cfg();
  c.layaUrl = "http://127.0.0.1:1";
  c.timeoutMs = 200;
  const res = await runWithWorkTrace({ cfg: c, sessionId: "s5", tool: "laya_decide", operation: "laya_decide" }, () =>
    decide("state", { risk: { type: "choice", instructions: "risk?", criteria: { low: "a", high: "b" } } }, { cfg: c }),
  );
  assertEq(res.ok, false);
  const events = spoolEvents();
  assertEq(events.length, 1);
  assertEq(events[0].status, "fallback");
  assertEq(events[0].model_attempted, false);
});

cleanupTempDataDir(dataDir);
process.exit(summary("work-client"));
