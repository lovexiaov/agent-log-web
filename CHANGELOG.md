# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/); this project adheres to
Schema v1 (frozen 2026-11-02).

## [1.2.0] - 2026-11-07

### Changed（Schema v1.2，破坏性）

- `trace_id` 收紧为 **32 位小写 hex**（8 字节，与 OTLP `traceId` / W3C traceparent
  trace-id 同构）。大写自动归一；非法值在序列化边界**丢弃该字段、事件照写**，与
  `span_id` 策略一致。适配器不再对非 hex 值做 `sha256("agentlog:trace:"+raw)` 派生。
  发布时尚无生产使用方（Schema v1.2 描述内已注明）。
- session id 默认生成值改为 32 位小写 hex：`trace_id = session_id` 这个最自然的
  绑定永远合法。

### Added

- `newTraceId()`：生成 Schema 合法的 trace id（uuid4 去横线）。

### Added
- OTLP/JSON adapter (`src/otlp.ts`): one `LogRecord` per event, plus a
  `SPAN_KIND_CLIENT`(3) span for `network_request` / `db_query` (HTTP and database
  semantic conventions). Severity 6→6 (`critical` → `FATAL`=21), `payload.*` flattened
  one level, int64 (nanos / counts) emitted as strings.
  Entry points: `toOtlp`, `toOtlpLogs`, `toOtlpSpans`, `eventToLogRecord`, `eventToSpan`,
  `toOtlpJSON`, and the buffering `createOtlpSink`.
- Deterministic OTLP ids (retry-safe, no randomness): 32-hex `trace_id` passes through
  lowercased, otherwise `sha256("agentlog:trace:"+raw)[:32]`; a span without a trace falls
  back to `sha256("agentlog:session:"+session_id)[:32]`; a missing `span_id` is derived from
  `session_id|trace_id|event_type|ts|message`, while a schema-valid event `span_id` is
  passed through as-is.
- `src/sha256.ts`: zero-dependency **synchronous** SHA-256 (browsers only expose async
  `crypto.subtle`, but id derivation must be synchronous inside `toOtlp()`). Verified
  against the standard vectors and cross-checked with Python `hashlib`.
- Nanosecond timestamps via `BigInt`: epoch nanos (~1.8e18) exceed
  `Number.MAX_SAFE_INTEGER`, so `timeUnixNano` is computed and emitted as an exact string.
- `src/ids.ts`: `normalizeSpanId` moved out of `logger.ts` so `otlp.ts` does not pull in
  `node:crypto` (keeps the module browser-safe).
- `src/otlp.test.ts` (37 cases): SHA-256 vectors + Python cross-check, AnyValue typing,
  BigInt precision, level table, id derivation, LogRecord shape, HTTP/DB spans (including
  sub-millisecond durations), batch layout, and the sink.
