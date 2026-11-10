# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/); this project adheres to
Schema v1 (frozen 2026-11-02).

## [1.4.0] - 2026-11-11

Schema v1.4（向后兼容增量）：六端统一的 AI 交互事件。不改变任何既有字段语义与必填约束。

### Added

- `src/types.ts` 新增 `AI_EVENT_TYPES` / `AiEventType`；`package.json` 补
  `./frontend/ai-events` 导出（此前 README 示例的导入路径无法解析）。
- `logAi*` 每个函数新增可选末尾 `extra`，用于追加标准词表字段（`request_id` /
  `provider` / token 明细）或业务键；6 个标准 `event_type` 与其余五端逐字对齐。

### Changed（AI 事件 payload 字段名迁移）

- **保留** `logAi*` 函数名与既有参数顺序，payload 改用 INTERFACE.md §4.4 的标准
  snake_case 词表，并显式写 `category: "ai"` / `agentAuto: false`；level 为
  request / response / tool = info，guardrail = warn，error = error。
- 迁移对照：`promptText` → `prompt_text`、`toolName` → `tool_name`、
  `toolArguments` → `tool_arguments`、`toolCallLatency` → `tool_call_latency_ms`、
  `responseLength` → `response_length`、`tokenUsage` → `total_tokens`、
  `guardrailType` → `guardrail_type`、`errorType` / `errorMessage` →
  `exception` / `exception_message`。旧 camelCase 键不再写出。
- OTLP：AI 事件只产 LogRecord，**不产 Span**；可挂 `span_id` 供下游组 span。
  `ai_error` 复用 v1.3 异常词表，映射为 `exception.*` 属性。

## [1.3.0] - 2026-11-10

Schema v1.3（向后兼容增量）。

### Added

- 顶层可选 `release`：`createLogger({ release: "1.4.2" })` 配置后由 logger 统一盖章到
  **每条**事件（含 `ErrorBoundary` / `logAiError`），不校验格式、仅限非空且 ≤128 字符；
  未配置则不写该键。
- OTLP：`release` 映射为 resource 的 `service.version`。

### Changed（异常 payload 标准词表）

- 未捕获异常 / 崩溃事件统一按标准词表写 `payload`：`exception`（类型名）、
  `exception_message`（原始消息）、`stack`（单字符串）、`mechanism`
  （`uncaught` / `handled` / `reported`）。`ErrorBoundary` 记 `uncaught`、`logAiError` 记 `handled`；旧 `error_message` 保留兜底。
- OTLP 适配器读取侧继续兼容历史键（`message` / `stacktrace` / `trace`），老日志
  映射行为不变。

### Docs

- 与 `ai-dev-spec` 的 Schema v1.3 / `INTERFACE.md` §4「异常与版本」对齐；
  说明框架只产出数据，不做上报 / APM 集成 / 崩溃落盘。

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
