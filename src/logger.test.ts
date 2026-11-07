import { describe, it, expect } from "vitest";
import { createLogger, normalizeSpanId } from "./logger.js";
import {
  generateTraceId,
  runWithTrace,
  outgoingHeaders,
  traceIdFromHeaders,
} from "./trace.js";
import { record, snapshot } from "./metrics.js";
import { LOG_LEVELS, type LoggerOptions } from "./types.js";

function parse(line: string | undefined): Record<string, unknown> {
  return JSON.parse(line ?? "{}") as Record<string, unknown>;
}

/** Schema v1.1 允许的顶层字段（docs/logging-framework/schema/log-event.schema.json） */
const SCHEMA_REQUIRED = [
  "ts",
  "level",
  "service",
  "event_type",
  "session_id",
  "agent_auto",
  "message",
] as const;
const SCHEMA_OPTIONAL = [
  "trace_id",
  "span_id",
  "subsystem",
  "category",
  "env",
  "user_id",
  "payload",
] as const;

function makeLogger(overrides: Partial<LoggerOptions> = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    service: "test",
    env: "test",
    level: "trace",
    sink: (l) => lines.push(l),
    ...overrides,
  });
  return { logger, lines };
}

describe("Logger", () => {
  it("输出单行 JSON 且携带 service / message", () => {
    const { logger, lines } = makeLogger();
    logger.info("hello", { userId: "u1" });

    expect(lines).toHaveLength(1);
    const evt = parse(lines[0]);
    expect(evt.message).toBe("hello");
    expect(evt.service).toBe("test");
    expect(typeof evt.ts).toBe("string");
  });

  it("低于 minLevel 的日志被丢弃", () => {
    const { logger, lines } = makeLogger({ level: "warn" });
    logger.debug("dropped");
    expect(lines).toHaveLength(0);
    logger.error("kept");
    expect(lines).toHaveLength(1);
  });

  it("默认按 C6 脱敏键脱敏，且路径相对 payload", () => {
    const { logger, lines } = makeLogger({ redactPaths: ["nested.token"] });
    logger.info("x", {
      password: "secret",
      api_key: "sk-1",
      nested: { token: "abc", ok: 1 },
    });

    const evt = parse(lines[0]);
    const payload = evt.payload as Record<string, unknown>;
    expect(payload.password).toBe("[REDACTED]");
    expect(payload.api_key).toBe("[REDACTED]");
    const nested = payload.nested as Record<string, unknown>;
    expect(nested.token).toBe("[REDACTED]");
    expect(nested.ok).toBe(1);
  });
});

describe("Schema v1（线格式）", () => {
  it("顶层字段集严格等于 schema，不泄漏内部 camelCase 命名", () => {
    const { logger, lines } = makeLogger({ subsystem: "com.test.web" });
    logger.info("hello", {
      userId: "u1",
      traceId: "t1",
      category: "auth",
      extraField: 1,
    });

    const evt = parse(lines[0]);
    const allowed = new Set<string>([...SCHEMA_REQUIRED, ...SCHEMA_OPTIONAL]);
    for (const key of Object.keys(evt)) {
      expect(allowed.has(key), `非 schema 顶层字段: ${key}`).toBe(true);
    }
    for (const key of SCHEMA_REQUIRED) {
      expect(evt, `缺少必填字段 ${key}`).toHaveProperty(key);
    }
    // 历史命名不得回流
    for (const legacy of [
      "timestamp",
      "event",
      "eventType",
      "sessionId",
      "traceId",
      "agentAuto",
      "userId",
    ]) {
      expect(evt).not.toHaveProperty(legacy);
    }
    // 映射结果正确
    expect(evt.event_type).toBe("log");
    expect(evt.session_id).toBeTruthy();
    expect(evt.trace_id).toBe("t1");
    expect(evt.user_id).toBe("u1");
    expect(evt.category).toBe("auth");
    expect(evt.subsystem).toBe("com.test.web");
    expect(evt.agent_auto).toBe(false);
    expect(evt.env).toBe("test");
    // 非保留键进 payload
    expect((evt.payload as Record<string, unknown>).extraField).toBe(1);
  });

  it("event_type 可来自上下文或显式参数，缺省为 log", () => {
    const { logger, lines } = makeLogger();
    logger.info("a", { event: "ai_request_initiated" });
    logger.info("b", {}, "http_request");
    logger.info("c");

    expect(parse(lines[0]).event_type).toBe("ai_request_initiated");
    expect(parse(lines[1]).event_type).toBe("http_request");
    expect(parse(lines[2]).event_type).toBe("log");
  });

  it("session_id 在同一 logger 内稳定，可通过上下文覆盖", () => {
    const { logger, lines } = makeLogger();
    logger.info("a");
    logger.info("b");
    logger.info("c", { sessionId: "s-custom" });

    expect(parse(lines[0]).session_id).toBe(parse(lines[1]).session_id);
    expect(parse(lines[2]).session_id).toBe("s-custom");
  });

  it("child 绑定的 trace_id 会带到后续事件", () => {
    const { logger, lines } = makeLogger();
    logger.child({ traceId: "t-child" }).info("a");
    expect(parse(lines[0]).trace_id).toBe("t-child");
  });

  it("child 绑定的 span_id 归一化为小写并带到后续事件", () => {
    const { logger, lines } = makeLogger();
    const bound = logger.child({
      traceId: "0123456789abcdef0123456789abcdef",
      spanId: "A1B2C3D4E5F60718",
    });
    bound.info("inside span");
    bound.warn("still inside");

    for (const line of lines) {
      const evt = parse(line);
      expect(evt.span_id).toBe("a1b2c3d4e5f60718");
      expect(evt.trace_id).toBe("0123456789abcdef0123456789abcdef");
    }
  });

  it("非法 span_id 被丢弃而不是写出", () => {
    const { logger, lines } = makeLogger();
    for (const bad of ["not-a-span", "a1b2c3d4e5f6071", "zzzzzzzzzzzzzzzz"]) {
      logger.child({ spanId: bad }).info("bad");
    }
    expect(lines).toHaveLength(3);
    for (const line of lines) {
      expect(parse(line)).not.toHaveProperty("span_id");
    }
  });

  it("span_id 不会被当成普通字段塞进 payload", () => {
    const { logger, lines } = makeLogger();
    logger.child({ spanId: "a1b2c3d4e5f60718" }).info("x");
    const evt = parse(lines[0]);
    expect(evt.payload ?? {}).not.toHaveProperty("spanId");
    expect(evt.payload ?? {}).not.toHaveProperty("span_id");
  });

  it("normalizeSpanId 只接受 16 位十六进制", () => {
    expect(normalizeSpanId("A1B2C3D4E5F60718")).toBe("a1b2c3d4e5f60718");
    expect(normalizeSpanId(" a1b2c3d4e5f60718 ")).toBe("a1b2c3d4e5f60718");
    expect(normalizeSpanId("a1b2c3d4e5f6071")).toBeUndefined();
    expect(normalizeSpanId("g1b2c3d4e5f60718")).toBeUndefined();
    expect(normalizeSpanId(undefined)).toBeUndefined();
  });

  it("level 词表与 schema 一致，warning 不再作为写入值", () => {
    expect(LOG_LEVELS).toEqual([
      "trace",
      "debug",
      "info",
      "warn",
      "error",
      "critical",
    ]);
    expect(LOG_LEVELS).not.toContain("warning");

    const { logger, lines } = makeLogger();
    logger.trace("m");
    logger.debug("m");
    logger.info("m");
    logger.warn("m");
    logger.error("m");
    logger.critical("m");
    expect(lines.map((l) => parse(l).level)).toEqual([...LOG_LEVELS]);
  });

  it("自动埋点标记 agent_auto=true（供 Agent 筛机器视角时间线）", () => {
    const { logger, lines } = makeLogger({ agentAuto: true });
    logger.info("auto", {}, "ui_interaction");
    expect(parse(lines[0]).agent_auto).toBe(true);
  });
});

describe("trace", () => {
  it("generateTraceId 生成非空 id", () => {
    expect(generateTraceId()).toBeTruthy();
  });

  it("runWithTrace 在回调内提供上下文", () => {
    const id = generateTraceId();
    runWithTrace(id, () => {
      expect(traceIdFromHeaders({ "x-request-id": id })).toBe(id);
    });
  });

  it("outgoingHeaders 注入 x-request-id 与 traceparent", () => {
    const h = outgoingHeaders({ a: "1" });
    expect(h.a).toBe("1");
    const rid = h["x-request-id"] ?? "";
    expect(rid).toBeTruthy();
    expect(h.traceparent).toContain(rid);
  });
});

describe("metrics", () => {
  it("record + snapshot 产出 RED 指标", () => {
    record("/health", 10);
    record("/health", 20, true);
    const s = snapshot();
    const m = s["/health"];
    expect(m?.rate).toBe(2);
    expect(m?.errors).toBe(1);
    expect(m?.p50).toBeGreaterThan(0);
  });
});
