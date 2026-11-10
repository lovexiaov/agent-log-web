import { describe, it, expect } from "vitest";
import { createLogger, type Logger } from "../logger.js";
import { AI_EVENT_TYPES, type LogEvent } from "../types.js";
import { eventToSpan } from "../otlp.js";
import {
  logAiRequest,
  logAiResponse,
  logAiToolCall,
  logAiToolResult,
  logAiGuardrail,
  logAiError,
} from "./ai-events.js";

function harness(agentAuto = false) {
  const lines: string[] = [];
  const logger: Logger = createLogger({
    service: "web",
    env: "test",
    level: "trace",
    agentAuto,
    sink: (l) => lines.push(l),
  });
  const parse = (i: number): Record<string, unknown> =>
    JSON.parse(lines[i] ?? "{}") as Record<string, unknown>;
  const payload = (i: number): Record<string, unknown> =>
    (parse(i).payload ?? {}) as Record<string, unknown>;
  return { logger, lines, parse, payload };
}

const ctx = { sessionId: "s1", model: "gpt-4o" };

describe("AI 交互事件（Schema v1.4）", () => {
  it("request 使用标准 event_type / snake_case payload / agent_auto=false", () => {
    const h = harness();
    logAiRequest(h.logger, ctx, "summarize this", { request_id: "r1", provider: "openai" });
    const l = h.parse(0);
    expect(l.event_type).toBe("ai_request_initiated");
    expect(l.level).toBe("info");
    expect(l.agent_auto).toBe(false);
    expect(l.category).toBe("ai");
    const p = h.payload(0);
    expect(p.model).toBe("gpt-4o");
    expect(p.prompt_text).toBe("summarize this");
    expect(p.request_id).toBe("r1");
    expect(p.provider).toBe("openai");
    expect(p.promptText).toBeUndefined();
  });

  it("response 用 response_length / total_tokens，不泄漏 tokenUsage", () => {
    const h = harness();
    logAiResponse(h.logger, ctx, 1280, 530, { request_id: "r1", prompt_tokens: 320 });
    const l = h.parse(0);
    expect(l.event_type).toBe("ai_response_received");
    expect(l.level).toBe("info");
    const p = h.payload(0);
    expect(p.response_length).toBe(1280);
    expect(p.total_tokens).toBe(530);
    expect(p.prompt_tokens).toBe(320);
    expect(p.request_id).toBe("r1");
    expect(p.tokenUsage).toBeUndefined();
    expect(p.responseLength).toBeUndefined();
  });

  it("tool call / result 用 tool_name / tool_arguments / tool_call_latency_ms", () => {
    const h = harness();
    logAiToolCall(h.logger, ctx, "search", { q: "x" }, { request_id: "r2" });
    expect(h.parse(0).event_type).toBe("ai_tool_call_initiated");
    expect(h.payload(0).tool_name).toBe("search");
    expect(h.payload(0).tool_arguments).toEqual({ q: "x" });
    expect(h.payload(0).request_id).toBe("r2");

    logAiToolResult(h.logger, ctx, "search", 12, true, { request_id: "r2" });
    const l = h.parse(1);
    expect(l.event_type).toBe("ai_tool_call_completed");
    expect(h.payload(1).tool_call_latency_ms).toBe(12);
    expect(h.payload(1).ok).toBe(true);
    expect(h.payload(1).request_id).toBe("r2");
    expect(h.payload(1).toolCallLatency).toBeUndefined();
  });

  it("guardrail 是 warn", () => {
    const h = harness();
    logAiGuardrail(h.logger, ctx, "toxicity", "blocked");
    const l = h.parse(0);
    expect(l.event_type).toBe("ai_guardrail_triggered");
    expect(l.level).toBe("warn");
    expect(l.agent_auto).toBe(false);
    expect(h.payload(0).guardrail_type).toBe("toxicity");
    expect(h.payload(0).reason).toBe("blocked");
    expect(h.payload(0).guardrailType).toBeUndefined();
  });

  it("ai_error 复用 v1.3 异常词表", () => {
    const h = harness();
    logAiError(h.logger, ctx, "RateLimitError", "429 too many requests", "stack...", { request_id: "r9" });
    const l = h.parse(0);
    expect(l.event_type).toBe("ai_error");
    expect(l.level).toBe("error");
    expect(l.agent_auto).toBe(false);
    const p = h.payload(0);
    expect(p.exception).toBe("RateLimitError");
    expect(p.exception_message).toBe("429 too many requests");
    expect(p.stack).toBe("stack...");
    expect(p.mechanism).toBe("handled");
    expect(p.request_id).toBe("r9");
    expect(p.errorType).toBeUndefined();
    expect(p.errorMessage).toBeUndefined();
  });

  it("未提供的可选字段不写出 undefined", () => {
    const h = harness();
    logAiResponse(h.logger, ctx, 10);
    logAiError(h.logger, ctx, "E", "msg");
    expect(h.payload(0).total_tokens).toBeUndefined();
    expect(h.payload(1).stack).toBeUndefined();
  });

  it("即使 logger 配了 agentAuto=true，AI 事件仍是显式埋点", () => {
    const h = harness(true);
    logAiRequest(h.logger, ctx, "hi");
    expect(h.parse(0).agent_auto).toBe(false);
  });

  it("6 个 AI event_type 都被承认，且都不产 span", () => {
    expect(AI_EVENT_TYPES).toHaveLength(6);
    const h = harness();
    logAiRequest(h.logger, ctx, "p");
    logAiResponse(h.logger, ctx, 1, 1);
    logAiToolCall(h.logger, ctx, "t", {});
    logAiToolResult(h.logger, ctx, "t", 1, true);
    logAiGuardrail(h.logger, ctx, "g", "r");
    logAiError(h.logger, ctx, "E", "m");
    expect(h.lines).toHaveLength(6);
    for (let i = 0; i < 6; i++) {
      const l = h.parse(i);
      expect(AI_EVENT_TYPES).toContain(l.event_type);
      expect(eventToSpan(l as unknown as LogEvent)).toBeUndefined();
    }
  });
});
