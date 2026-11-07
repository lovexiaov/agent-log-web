import { describe, it, expect } from "vitest";
import {
  SDK_VERSION,
  SPAN_KIND_CLIENT,
  STATUS_CODE_ERROR,
  createOtlpSink,
  eventToLogRecord,
  eventToSpan,
  levelToSeverity,
  parseTimestampNanos,
  spanIdHex,
  spanTraceId,
  toAnyValue,
  toOtlp,
  toOtlpJSON,
  toOtlpLogs,
  toOtlpSpans,
  traceIdHex,
  type OtlpKeyValue,
  type OtlpLogRecord,
  type OtlpSpan,
} from "./otlp.js";
import { sha256Hex } from "./sha256.js";
import type { LogEvent } from "./types.js";

const TRACE = "0123456789abcdef0123456789abcdef";
const SPAN = "a1b2c3d4e5f60718";
const TS = "2026-11-07T10:00:00.123456789Z";

function makeEvent(overrides: Partial<LogEvent> = {}): LogEvent {
  return {
    ts: TS,
    level: "info",
    service: "web-app",
    event_type: "log",
    session_id: "sess-1",
    agent_auto: false,
    message: "hello",
    ...overrides,
  };
}

function attr(attributes: OtlpKeyValue[], key: string): unknown {
  return attributes.find((kv) => kv.key === key)?.value;
}

function stringAttr(attributes: OtlpKeyValue[], key: string): string | undefined {
  const value = attr(attributes, key) as { stringValue?: string } | undefined;
  return value?.stringValue;
}

describe("sha256（OTLP id 派生的底座）", () => {
  it("matches standard test vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(sha256Hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
  });

  it("matches Python hashlib for the id-derivation seeds", () => {
    // 交叉验证：python3 -c "import hashlib; hashlib.sha256(b'agentlog:trace:opaque-trace').hexdigest()"
    expect(sha256Hex("agentlog:trace:opaque-trace")).toBe(
      "29185376a1eb5a4899c364f83ffdb7e3be344bc9cf9d2b0225887f700ac64dce",
    );
  });

  it("handles multi-block and unicode input", () => {
    const long = "x".repeat(200);
    expect(sha256Hex(long)).toHaveLength(64);
    // 中文消息会进入 span 派生种子，必须按 UTF-8 编码参与哈希。
    expect(sha256Hex("订单开票")).toBe(sha256Hex("订单开票"));
    expect(sha256Hex("订单开票")).not.toBe(sha256Hex("订单开票 "));
  });
});

describe("值转换（protobuf JSON 映射）", () => {
  it("maps primitives, with int64 as a string", () => {
    expect(toAnyValue(true)).toEqual({ boolValue: true });
    expect(toAnyValue(42)).toEqual({ intValue: "42" });
    expect(toAnyValue(-7)).toEqual({ intValue: "-7" });
    expect(toAnyValue(0.5)).toEqual({ doubleValue: 0.5 });
    expect(toAnyValue("hi")).toEqual({ stringValue: "hi" });
    expect(toAnyValue(10n)).toEqual({ intValue: "10" });
  });

  it("keeps integral numbers as intValue so status codes stay ints", () => {
    expect(toAnyValue(200)).toEqual({ intValue: "200" });
    expect(toAnyValue(200.0)).toEqual({ intValue: "200" });
    expect(toAnyValue(200.5)).toEqual({ doubleValue: 200.5 });
  });

  it("degrades non-finite numbers instead of emitting invalid JSON", () => {
    expect(toAnyValue(Number.NaN)).toEqual({ stringValue: "NaN" });
    expect(toAnyValue(Number.POSITIVE_INFINITY)).toEqual({ stringValue: "Infinity" });
  });

  it("keeps containers structured", () => {
    expect(toAnyValue([1, "two"])).toEqual({
      arrayValue: { values: [{ intValue: "1" }, { stringValue: "two" }] },
    });
    expect(toAnyValue({ a: 1 })).toEqual({
      kvlistValue: { values: [{ key: "a", value: { intValue: "1" } }] },
    });
    expect(toAnyValue(new Date("2026-11-07T10:00:00Z"))).toEqual({
      stringValue: "2026-11-07T10:00:00.000Z",
    });
  });
});

describe("时间戳（BigInt，纳秒精度不能丢）", () => {
  it("parses UTC, ±offset and space-separated stamps to the same instant", () => {
    const utc = parseTimestampNanos("2026-11-07T10:00:00Z");
    expect(parseTimestampNanos("2026-11-07T18:00:00+08:00")).toBe(utc);
    expect(parseTimestampNanos("2026-11-07T18:00:00+0800")).toBe(utc);
    expect(parseTimestampNanos("2026-11-07 10:00:00")).toBe(utc);
  });

  it("keeps full nanosecond precision (beyond Number.MAX_SAFE_INTEGER)", () => {
    const nanos = parseTimestampNanos(TS);
    // 1.79e18 > 2^53: a `number` would silently lose the last digits.
    expect(nanos).toBe(1_794_045_600_123_456_789n);
    expect(nanos.toString()).toBe("1794045600123456789");
  });

  it("truncates sub-nanosecond digits instead of rounding", () => {
    expect(parseTimestampNanos("2026-11-07T10:00:00.1234567899Z")).toBe(
      parseTimestampNanos("2026-11-07T10:00:00.123456789Z"),
    );
  });

  it("rejects non-RFC3339 input", () => {
    expect(() => parseTimestampNanos("not-a-time")).toThrow(/not an RFC3339 timestamp/);
  });
});

describe("级别映射", () => {
  it("maps the six levels to the OTel severity table", () => {
    const expected: [string, string, number][] = [
      ["trace", "TRACE", 1],
      ["debug", "DEBUG", 5],
      ["info", "INFO", 9],
      ["warn", "WARN", 13],
      ["error", "ERROR", 17],
      ["critical", "FATAL", 21],
    ];
    for (const [level, text, number] of expected) {
      expect(levelToSeverity(level)).toEqual({ text, number });
    }
  });

  it("normalizes the warning alias and degrades unknown levels to INFO", () => {
    expect(levelToSeverity("warning")).toEqual({ text: "WARN", number: 13 });
    expect(levelToSeverity("nonsense")).toEqual({ text: "INFO", number: 9 });
    expect(levelToSeverity(undefined)).toEqual({ text: "INFO", number: 9 });
  });
});

describe("id 派生（确定性、可重放）", () => {
  it("passes a 32-hex trace id through, lowercased", () => {
    expect(traceIdHex(makeEvent({ trace_id: TRACE.toUpperCase() }))).toBe(TRACE);
  });

  it("hashes opaque trace ids deterministically", () => {
    const event = makeEvent({ trace_id: "opaque-trace" });
    const derived = traceIdHex(event);
    expect(derived).toMatch(/^[0-9a-f]{32}$/);
    expect(traceIdHex(event)).toBe(derived);
    // 与 Python/Java 同一派生规则
    expect(derived).toBe(sha256Hex("agentlog:trace:opaque-trace").slice(0, 32));
  });

  it("returns undefined when the event has no trace id", () => {
    expect(traceIdHex(makeEvent())).toBeUndefined();
  });

  it("prefers an explicit Schema v1.1 span id", () => {
    expect(spanIdHex(makeEvent({ span_id: SPAN.toUpperCase() }))).toBe(SPAN);
  });

  it("derives a stable span id and ignores malformed values", () => {
    const event = makeEvent();
    const derived = spanIdHex(event);
    expect(derived).toMatch(/^[0-9a-f]{16}$/);
    expect(spanIdHex(event)).toBe(derived);
    expect(spanIdHex(makeEvent({ span_id: "not-a-span-id" }))).toBe(derived);
  });

  it("falls back to one synthetic trace per session", () => {
    const event = makeEvent({ event_type: "network_request" });
    expect(traceIdHex(event)).toBeUndefined();
    expect(spanTraceId(event)).toBe(sha256Hex("agentlog:session:sess-1").slice(0, 32));
    // 同一会话的另一个操作事件共用同一条合成 trace
    expect(spanTraceId(makeEvent({ event_type: "db_query" }))).toBe(spanTraceId(event));
  });
});

describe("LogRecord", () => {
  it("carries the spec fields", () => {
    const record: OtlpLogRecord = eventToLogRecord(
      makeEvent({
        level: "error",
        message: "boom",
        subsystem: "auth",
        category: "app",
        user_id: "u-1",
        env: "prod",
        trace_id: TRACE,
        span_id: SPAN,
        payload: { attempt: 2, ok: false },
      }),
    );

    expect(record.timeUnixNano).toBe("1794045600123456789");
    expect(record.observedTimeUnixNano).toBe(record.timeUnixNano);
    expect(record.severityNumber).toBe(17);
    expect(record.severityText).toBe("ERROR");
    expect(record.body).toEqual({ stringValue: "boom" });
    expect(record.traceId).toBe(TRACE);
    expect(record.spanId).toBe(SPAN);

    expect(stringAttr(record.attributes, "agent.event.type")).toBe("log");
    expect(attr(record.attributes, "agent.auto")).toEqual({ boolValue: false });
    expect(stringAttr(record.attributes, "agent.subsystem")).toBe("auth");
    expect(stringAttr(record.attributes, "agent.category")).toBe("app");
    expect(stringAttr(record.attributes, "enduser.id")).toBe("u-1");
    expect(attr(record.attributes, "payload.attempt")).toEqual({ intValue: "2" });
    expect(attr(record.attributes, "payload.ok")).toEqual({ boolValue: false });
  });

  it("omits ids when the event has no trace", () => {
    const record = eventToLogRecord(makeEvent());
    expect(record.traceId).toBeUndefined();
    expect(record.spanId).toBeUndefined();
  });

  it("shares its spanId with the span it emits", () => {
    const event = makeEvent({
      event_type: "db_query",
      trace_id: TRACE,
      span_id: SPAN,
      payload: { statement: "SELECT 1" },
    });
    expect(eventToLogRecord(event).spanId).toBe(SPAN);
    expect(eventToSpan(event)?.spanId).toBe(SPAN);
  });

  it("never references a span that is not emitted", () => {
    // 非操作事件 + 无显式 span_id：不给 spanId，避免指向不存在的 span
    const record = eventToLogRecord(makeEvent({ trace_id: TRACE }));
    expect(record.traceId).toBe(TRACE);
    expect(record.spanId).toBeUndefined();
  });
});

describe("Span", () => {
  it("maps network_request onto the HTTP semantic conventions", () => {
    const span = eventToSpan(
      makeEvent({
        event_type: "network_request",
        agent_auto: true,
        trace_id: TRACE,
        payload: {
          method: "GET",
          url: "https://api.example.com:8443/orders?page=1",
          status_code: 200,
          duration_ms: 12,
        },
      }),
    ) as OtlpSpan;

    expect(span.name).toBe("GET https://api.example.com:8443/orders?page=1");
    expect(span.kind).toBe(SPAN_KIND_CLIENT);
    expect(span.traceId).toBe(TRACE);
    expect(span.startTimeUnixNano).toBe("1794045600123456789");
    expect(span.endTimeUnixNano).toBe("1794045600135456789");
    expect(span.status).toBeUndefined();

    expect(stringAttr(span.attributes, "http.request.method")).toBe("GET");
    expect(attr(span.attributes, "http.response.status_code")).toEqual({ intValue: "200" });
    expect(stringAttr(span.attributes, "server.address")).toBe("api.example.com");
    expect(attr(span.attributes, "error.type")).toBeUndefined();
  });

  it("keeps sub-millisecond durations (42.5ms, not 42ms)", () => {
    const span = eventToSpan(
      makeEvent({
        event_type: "network_request",
        payload: { method: "GET", url: "https://x/y", duration_ms: 42.5 },
      }),
    ) as OtlpSpan;
    expect(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)).toBe(42_500_000n);
  });

  it("marks HTTP failures with an error status and error.type", () => {
    const span = eventToSpan(
      makeEvent({
        event_type: "network_request",
        payload: { method: "POST", url: "http://localhost:8080/pay", status_code: 503 },
      }),
    ) as OtlpSpan;

    expect(span.status).toEqual({ code: STATUS_CODE_ERROR, message: "POST http://localhost:8080/pay" });
    expect(stringAttr(span.attributes, "error.type")).toBe("503");
  });

  it("maps db_query onto the Database conventions, preferring `statement`", () => {
    const span = eventToSpan(
      makeEvent({
        event_type: "db_query",
        payload: { operation: "select", statement: "SELECT 1", sql: "SELECT legacy", db_system: "postgresql" },
      }),
    ) as OtlpSpan;

    expect(span.name).toBe("select SELECT 1");
    expect(stringAttr(span.attributes, "db.statement")).toBe("SELECT 1");
    expect(stringAttr(span.attributes, "db.operation")).toBe("select");
    expect(stringAttr(span.attributes, "db.system")).toBe("postgresql");
  });

  it("reads legacy `sql` / `query` keys for old events", () => {
    expect(
      eventToSpan(makeEvent({ event_type: "db_query", payload: { operation: "exec", sql: "INSERT 1" } }))?.name,
    ).toBe("exec INSERT 1");
    expect(
      eventToSpan(makeEvent({ event_type: "db_query", payload: { operation: "exec", query: "INSERT 2" } }))?.name,
    ).toBe("exec INSERT 2");
  });

  it("emits no span for non-operation events", () => {
    for (const eventType of ["log", "ui_interaction", "screen_view", "crash", "hang"]) {
      expect(eventToSpan(makeEvent({ event_type: eventType }))).toBeUndefined();
    }
  });

  it("maps crash payload onto exception.* attributes", () => {
    const record = eventToLogRecord(
      makeEvent({
        event_type: "crash",
        agent_auto: true,
        payload: {
          exception: "TypeError",
          message: "undefined is not a function",
          stack: "at onClick (app.js:1)",
        },
      }),
    );
    expect(stringAttr(record.attributes, "exception.type")).toBe("TypeError");
    expect(stringAttr(record.attributes, "exception.message")).toBe("undefined is not a function");
    expect(stringAttr(record.attributes, "exception.stacktrace")).toBe("at onClick (app.js:1)");
    expect(attr(record.attributes, "agent.auto")).toEqual({ boolValue: true });
  });
});

describe("批次与 resource", () => {
  it("groups by service/env/session and preserves order", () => {
    const body = toOtlpLogs([
      makeEvent({ message: "a", env: "prod" }),
      makeEvent({ message: "b", env: "prod" }),
      makeEvent({ message: "c", env: "dev", session_id: "sess-2" }),
    ]);
    expect(body.resourceLogs).toHaveLength(2);

    const first = body.resourceLogs[0]!;
    expect(stringAttr(first.resource.attributes, "service.name")).toBe("web-app");
    expect(stringAttr(first.resource.attributes, "deployment.environment")).toBe("prod");
    expect(stringAttr(first.resource.attributes, "session.id")).toBe("sess-1");
    expect(stringAttr(first.resource.attributes, "telemetry.sdk.name")).toBe("agent-log");
    expect(stringAttr(first.resource.attributes, "telemetry.sdk.language")).toBe("web");
    expect(stringAttr(first.resource.attributes, "telemetry.sdk.version")).toBe(SDK_VERSION);

    expect(first.scopeLogs[0]!.scope).toEqual({ name: "agentlog.otlp", version: SDK_VERSION });
    expect(first.scopeLogs[0]!.logRecords.map((r) => r.body.stringValue)).toEqual(["a", "b"]);
  });

  it("lets agent-log's own resource keys win over extraResource", () => {
    const body = toOtlpLogs([makeEvent()], { "service.name": "hijacked", "service.version": "2.1.0" });
    const attrs = body.resourceLogs[0]!.resource.attributes;
    expect(stringAttr(attrs, "service.name")).toBe("web-app");
    expect(stringAttr(attrs, "service.version")).toBe("2.1.0");
    expect(attrs.filter((kv) => kv.key === "service.name")).toHaveLength(1);
  });

  it("skips resource groups without operation events in the traces signal", () => {
    const body = toOtlpSpans([
      makeEvent({ message: "plain" }),
      makeEvent({ event_type: "network_request", payload: { method: "GET", url: "http://a/b" } }),
    ]);
    // 同一 resource 组里含 span，只出现一次
    expect(body.resourceSpans).toHaveLength(1);
    expect(body.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(1);

    expect(toOtlpSpans([makeEvent()]).resourceSpans).toHaveLength(0);
  });

  it("returns both signals and serializes compactly", () => {
    const batch = toOtlp([makeEvent({ event_type: "db_query", payload: { statement: "SELECT 1" } })]);
    expect(batch.logs.resourceLogs).toHaveLength(1);
    expect(batch.traces.resourceSpans).toHaveLength(1);

    const json = toOtlpJSON(batch.logs);
    expect(json).not.toContain(", ");
    expect(json).not.toContain(": ");
    expect(JSON.parse(json)).toEqual(batch.logs);
  });

  it("keeps timestamps as strings so backends see int64", () => {
    const json = toOtlpJSON(toOtlp([makeEvent()]).logs);
    expect(json).toContain('"timeUnixNano":"1794045600123456789"');
    expect(json).not.toContain('"timeUnixNano":1794045600123456789');
  });
});

describe("sink", () => {
  it("buffers logger lines and drains an OTLP batch", () => {
    const sink = createOtlpSink();
    sink.sink(
      JSON.stringify(
        makeEvent({ event_type: "network_request", payload: { method: "GET", url: "http://h/x" } }),
      ),
    );
    sink.sink(JSON.stringify(makeEvent({ message: "plain" })));
    expect(sink.size()).toBe(2);

    const batch = sink.drain();
    expect(sink.size()).toBe(0);
    expect(batch.logs.resourceLogs[0]!.scopeLogs[0]!.logRecords).toHaveLength(2);
    expect(batch.traces.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(1);
  });

  it("passes extraResource through to the drained batch", () => {
    const sink = createOtlpSink({ extraResource: { "service.version": "9.9.9" } });
    sink.sink(JSON.stringify(makeEvent()));
    const attrs = sink.drain().logs.resourceLogs[0]!.resource.attributes;
    expect(stringAttr(attrs, "service.version")).toBe("9.9.9");
  });
});
