/**
 * OTLP 导出适配器：Schema v1 事件 → OpenTelemetry OTLP/JSON。
 *
 * 这是 D3「OTel 对齐」能力：**不改线格式**，只做单向翻译，把已经写出的事件
 * 变成 OTLP，从而能通过任意 OTLP Collector 送往 Jaeger / Tempo / Loki / Datadog。
 *
 * 映射总览（规范真源：`docs/logging-framework/OTLP-MAPPING.md`）：
 * - 每条事件 → 一条 OTLP `LogRecord`；
 * - `network_request` → 额外一条 `SPAN_KIND_CLIENT` span（HTTP 语义约定）；
 * - `db_query` → 额外一条 `SPAN_KIND_CLIENT` span（Database 语义约定）；
 * - `crash` / `hang` → 只发 logs，附 `exception.*` 属性；
 * - 其余事件类型 → 只发 logs。
 *
 * 两个 JS 特有的坑，这里已处理好：
 * 1. **纳秒必须用 BigInt**。epoch 纳秒约 1.8e18，远超 `Number.MAX_SAFE_INTEGER`
 *    （9.007e15），用 number 会静默丢精度；所有 `*UnixNano` 都以 BigInt 计算、
 *    再按 OTLP/JSON 的 int64 规则**以字符串输出**。
 * 2. **没有同步 SHA-256**。id 派生要求确定性（重试/重放幂等），
 *    `crypto.subtle` 是异步的、`node:crypto` 浏览器里没有，
 *    因此这里用零依赖的同步实现（`./sha256.js`，已用标准向量 + Python 交叉验证）。
 */

import { normalizeSpanId, normalizeTraceId } from "./ids.js";
import { sha256Hex } from "./sha256.js";
import type { LogEvent } from "./types.js";

/** 与项目版本保持一致（测试断言）。 */
export const SDK_VERSION = "1.0.0";

/** OTel `SpanKind.SPAN_KIND_CLIENT`。 */
export const SPAN_KIND_CLIENT = 3;

/** OTel `Status.StatusCode.STATUS_CODE_ERROR`。 */
export const STATUS_CODE_ERROR = 2;

/** 每条批次上报的 `InstrumentationScope`。 */
export const SCOPE = { name: "agentlog.otlp", version: SDK_VERSION } as const;

// OTel 语义约定键（部分仍是 Experimental，统一收口在这里）。
const SEMCONV = {
  serviceName: "service.name",
  serviceVersion: "service.version",
  deploymentEnv: "deployment.environment",
  sessionId: "session.id",
  enduserId: "enduser.id",
  httpMethod: "http.request.method",
  urlFull: "url.full",
  httpStatus: "http.response.status_code",
  serverAddress: "server.address",
  dbSystem: "db.system",
  dbOperation: "db.operation",
  dbStatement: "db.statement",
  errorType: "error.type",
  exceptionType: "exception.type",
  exceptionMessage: "exception.message",
  exceptionStacktrace: "exception.stacktrace",
} as const;

// agent-log 自己的属性命名空间（避免与 semconv 撞键）。
const ATTR_EVENT_TYPE = "agent.event.type";
const ATTR_AUTO = "agent.auto";
const ATTR_SUBSYSTEM = "agent.subsystem";
const ATTR_CATEGORY = "agent.category";

// 操作类 span 的 payload 键候选（兼容历史写法）。
const HTTP_METHOD_KEYS = ["method", "http_method", "http.method"] as const;
const URL_KEYS = ["url", "url_full", "url.full"] as const;
const STATUS_KEYS = ["status_code", "status", "statusCode", "http.status_code"] as const;
const DURATION_KEYS = ["duration_ms", "durationMs", "duration"] as const;
/** 规范键是 `statement`；无历史别名。 */
const SQL_KEYS = ["statement"] as const;
const DB_SYSTEM_KEYS = ["db_system", "db.system", "system"] as const;
const DB_OPERATION_KEYS = ["operation", "op"] as const;

const TS_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/;
const URL_HOST_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/;

// ---------------------------------------------------------------------------
// 类型（OTLP/JSON 形状）
// ---------------------------------------------------------------------------

export type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpAnyValue[] } }
  | { kvlistValue: { values: OtlpKeyValue[] } };

export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export interface OtlpScope {
  name: string;
  version: string;
}

export interface OtlpResource {
  attributes: OtlpKeyValue[];
}

export interface OtlpLogRecord {
  timeUnixNano: string;
  observedTimeUnixNano: string;
  severityNumber: number;
  severityText: string;
  body: { stringValue: string };
  attributes: OtlpKeyValue[];
  traceId?: string;
  spanId?: string;
}

export interface OtlpSpanStatus {
  code: number;
  message: string;
}

export interface OtlpSpan {
  traceId: string;
  spanId: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: OtlpKeyValue[];
  status?: OtlpSpanStatus;
}

export interface OtlpScopeLogs {
  scope: OtlpScope;
  logRecords: OtlpLogRecord[];
}

export interface OtlpScopeSpans {
  scope: OtlpScope;
  spans: OtlpSpan[];
}

export interface ExportLogsServiceRequest {
  resourceLogs: { resource: OtlpResource; scopeLogs: OtlpScopeLogs[] }[];
}

export interface ExportTraceServiceRequest {
  resourceSpans: { resource: OtlpResource; scopeSpans: OtlpScopeSpans[] }[];
}

/** 一次导出同时产出两种信号（OTLP 一次请求只承载一种，见规范 §9.1）。 */
export interface OtlpBatch {
  logs: ExportLogsServiceRequest;
  traces: ExportTraceServiceRequest;
}

export type ExtraResource = Record<string, unknown>;

// ---------------------------------------------------------------------------
// 值转换
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && !(value instanceof Date);
}

/**
 * 转成 OTLP `AnyValue`（protobuf JSON 形式）。
 *
 * JS 只有一种 number：这里用「整数值 → `intValue`（字符串），否则 → `doubleValue`」
 * 的规则，与 Python/Java 对 JSON 整数/浮点字面量的处理一致。
 * `int64` 必须字符串化——JSON 数字是 double，装不下 64 位整数。
 */
export function toAnyValue(value: unknown): OtlpAnyValue {
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "bigint") {
    return { intValue: value.toString() };
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      // NaN / Infinity 不是合法 JSON 数字，降级成字符串而不是产出坏 body。
      return { stringValue: String(value) };
    }
    return Number.isInteger(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER
      ? { intValue: String(value) }
      : { doubleValue: value };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map((item) => toAnyValue(item)) } };
  }
  if (value instanceof Date) {
    return { stringValue: value.toISOString() };
  }
  if (isPlainObject(value)) {
    return { kvlistValue: { values: toKeyValues(value) } };
  }
  // undefined / symbol / function：兜底成字符串，宁可丢类型也不丢事件。
  return { stringValue: String(value) };
}

/** 构造一个 OTLP `KeyValue`。 */
export function toKeyValue(key: string, value: unknown): OtlpKeyValue {
  return { key, value: toAnyValue(value) };
}

/** 把对象铺平成 `KeyValue` 列表（`null` / `undefined` 跳过）。 */
function toKeyValues(mapping: Record<string, unknown>, prefix = ""): OtlpKeyValue[] {
  const out: OtlpKeyValue[] = [];
  for (const [key, value] of Object.entries(mapping)) {
    if (value === null || value === undefined) {
      continue;
    }
    out.push(toKeyValue(prefix + key, value));
  }
  return out;
}

// ---------------------------------------------------------------------------
// 时间
// ---------------------------------------------------------------------------

/**
 * RFC3339 / ISO8601 → epoch 纳秒（BigInt）。
 *
 * 超过纳秒的精度直接截断（不四舍五入）；无偏移的时间戳按 UTC 处理。
 */
export function parseTimestampNanos(ts: string): bigint {
  const match = TS_RE.exec(String(ts).trim());
  if (!match) {
    throw new Error(`not an RFC3339 timestamp: ${String(ts)}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const frac = match[7] ?? "";
  const offset = match[8];

  // 补/截到 9 位，全程不经过浮点。
  const nanos = BigInt((frac + "000000000").slice(0, 9));
  const wallMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const wallSeconds = BigInt(Math.floor(wallMs / 1000));

  let offsetSeconds = 0;
  if (offset && offset !== "Z" && offset !== "z") {
    const sign = offset.startsWith("-") ? -1 : 1;
    const digits = offset.slice(1).replace(":", "");
    const hours = Number(digits.slice(0, 2));
    const minutes = digits.length >= 4 ? Number(digits.slice(2, 4)) : 0;
    offsetSeconds = sign * (hours * 3600 + minutes * 60);
  }

  return (wallSeconds - BigInt(offsetSeconds)) * 1_000_000_000n + nanos;
}

// ---------------------------------------------------------------------------
// id（确定性派生）
// ---------------------------------------------------------------------------

/**
 * 事件的 OTLP `traceId`（32 位 hex），没有 `trace_id` 时返回 `undefined`。
 *
 * 32 位 hex 原样（转小写）使用；其他字符串按 `sha256("agentlog:trace:" + raw)`
 * 确定性派生，保证共享同一逻辑 trace 的事件落进同一条 OTLP trace。
 */
export function traceIdHex(event: LogEvent): string | undefined {
  // Schema v1.2：trace_id 必须是 32 位 hex（大写归一）。非法值不派生、不变形
  // —— 写入边界已丢弃，到这里的非法值只能来自手工构造的字典，同样按无 trace 处理。
  return normalizeTraceId(event.trace_id);
}

/**
 * 事件的 OTLP `spanId`（16 位 hex）。
 *
 * Schema v1.1 的 `span_id` 合法时**优先透传**，这样日志行与链路节点指向同一个真实
 * span；缺失或非法时按确定性规则派生（重试幂等）。
 */
export function spanIdHex(event: LogEvent): string {
  const explicit = normalizeSpanId(event.span_id);
  if (explicit) {
    return explicit;
  }
  const seed = [
    "agentlog:span",
    event.session_id ?? "",
    event.trace_id ?? "",
    event.event_type ?? "",
    event.ts ?? "",
    event.message ?? "",
  ].join("|");
  return sha256Hex(seed).slice(0, 16);
}

/**
 * span 的 trace id：无 `trace_id` 时回退到会话级合成 trace。
 *
 * span 不能脱离 trace 存在；同一会话的多个 span 归入同一条合成 trace，
 * 否则在 Jaeger 里会变成一堆孤立单 span 链路。
 */
export function spanTraceId(event: LogEvent): string {
  const resolved = traceIdHex(event);
  if (resolved) {
    return resolved;
  }
  return sha256Hex(`agentlog:session:${event.session_id ?? ""}`).slice(0, 32);
}

// ---------------------------------------------------------------------------
// 级别
// ---------------------------------------------------------------------------

const SEVERITY: Record<string, { text: string; number: number }> = {
  trace: { text: "TRACE", number: 1 },
  debug: { text: "DEBUG", number: 5 },
  info: { text: "INFO", number: 9 },
  warn: { text: "WARN", number: 13 },
  error: { text: "ERROR", number: 17 },
  critical: { text: "FATAL", number: 21 },
};

/**
 * agent-log level → `severityText` / `severityNumber`。
 *
 * 未知 level（含非规范的 `warning`）**降级为 INFO**，
 * 不让一次导出因为脏数据整体失败。
 */
export function levelToSeverity(level: string | undefined): { text: string; number: number } {
  const canonical = level ?? "info";
  return SEVERITY[canonical] ?? SEVERITY["info"]!;
}

// ---------------------------------------------------------------------------
// Resource
// ---------------------------------------------------------------------------

function resourceAttributes(event: LogEvent): OtlpKeyValue[] {
  const attrs: OtlpKeyValue[] = [toKeyValue(SEMCONV.serviceName, event.service || "app")];
  if (event.env) {
    attrs.push(toKeyValue(SEMCONV.deploymentEnv, event.env));
  }
  if (event.release) {
    // Schema v1.3: release -> OTel service.version.
    attrs.push(toKeyValue(SEMCONV.serviceVersion, event.release));
  }
  if (event.session_id) {
    attrs.push(toKeyValue(SEMCONV.sessionId, event.session_id));
  }
  attrs.push(
    toKeyValue("telemetry.sdk.name", "agent-log"),
    toKeyValue("telemetry.sdk.language", "web"),
    toKeyValue("telemetry.sdk.version", SDK_VERSION),
  );
  return attrs;
}

/** 按 (service, env, session_id) 分组，保持输入顺序。 */
function groupByResource(events: readonly LogEvent[]): LogEvent[][] {
  const groups = new Map<string, LogEvent[]>();
  for (const event of events) {
    const key = `${event.service || "app"}\u0000${event.env ?? ""}\u0000${event.session_id ?? ""}`;
    const bucket = groups.get(key);
    if (bucket) {
      bucket.push(event);
    } else {
      groups.set(key, [event]);
    }
  }
  return [...groups.values()];
}

/**
 * 追加调用方资源属性，但**跳过 agent-log 已占用的键**。
 *
 * OTLP 里重复键由后端随意裁决（通常后者胜），所以「自身字段优先」必须在
 * 这里靠直接丢弃冲突键来保证。
 */
function mergeExtraResource(
  resource: OtlpKeyValue[],
  extraResource: ExtraResource | undefined,
): OtlpKeyValue[] {
  if (!extraResource) {
    return resource;
  }
  const taken = new Set(resource.map((kv) => kv.key));
  for (const kv of toKeyValues(extraResource)) {
    if (taken.has(kv.key)) {
      continue;
    }
    resource.push(kv);
    taken.add(kv.key);
  }
  return resource;
}

// ---------------------------------------------------------------------------
// LogRecord
// ---------------------------------------------------------------------------

/** 把事件的非 resource 字段翻译成 OTLP 属性。 */
export function eventAttributes(event: LogEvent): OtlpKeyValue[] {
  const attrs: OtlpKeyValue[] = [];
  if (event.event_type !== undefined && event.event_type !== null) {
    attrs.push(toKeyValue(ATTR_EVENT_TYPE, event.event_type));
  }
  attrs.push(toKeyValue(ATTR_AUTO, Boolean(event.agent_auto)));
  if (event.subsystem) {
    attrs.push(toKeyValue(ATTR_SUBSYSTEM, event.subsystem));
  }
  if (event.category) {
    attrs.push(toKeyValue(ATTR_CATEGORY, event.category));
  }
  if (event.user_id) {
    // 只放间接标识 —— Schema v1 禁止在这里放直接 PII。
    attrs.push(toKeyValue(SEMCONV.enduserId, event.user_id));
  }
  const payload = event.payload ?? {};
  attrs.push(...toKeyValues(payload, "payload."));
  if (event.event_type === "crash" || event.event_type === "hang") {
    attrs.push(...exceptionAttributes(payload));
  }
  return attrs;
}

function exceptionAttributes(payload: Record<string, unknown>): OtlpKeyValue[] {
  const attrs: OtlpKeyValue[] = [];
  const excType = firstOf(payload, ["exception", "exception_type"]);
  if (excType !== undefined) {
    attrs.push(toKeyValue(SEMCONV.exceptionType, excType));
  }
  // crash 的 payload 用 `message` 装异常文本；两种写法都认。
  const excMessage = firstOf(payload, ["exception_message", "message"]);
  if (excMessage !== undefined) {
    attrs.push(toKeyValue(SEMCONV.exceptionMessage, excMessage));
  }
  const stack = firstOf(payload, ["stack", "stacktrace", "trace"]);
  if (stack !== undefined) {
    attrs.push(toKeyValue(SEMCONV.exceptionStacktrace, stack));
  }
  return attrs;
}

/** 一条 Schema v1 事件 → 一条 OTLP `LogRecord`。 */
export function eventToLogRecord(event: LogEvent): OtlpLogRecord {
  const severity = levelToSeverity(event.level);
  const timeNanos = parseTimestampNanos(event.ts).toString();

  const record: OtlpLogRecord = {
    timeUnixNano: timeNanos,
    observedTimeUnixNano: timeNanos,
    severityNumber: severity.number,
    severityText: severity.text,
    body: { stringValue: event.message ?? "" },
    attributes: eventAttributes(event),
  };

  const traceId = traceIdHex(event);
  if (traceId) {
    record.traceId = traceId;
    // 优先用事件自带的（v1.1）span id —— 它指向真实 span。否则只给操作类事件
    // 配 id，与它产出的 span 对齐，日志行永远不会引用一个不存在的 span。
    const explicitSpan = normalizeSpanId(event.span_id);
    if (explicitSpan) {
      record.spanId = explicitSpan;
    } else if (spanKind(event) !== null) {
      record.spanId = spanIdHex(event);
    }
  }
  return record;
}

// ---------------------------------------------------------------------------
// Span
// ---------------------------------------------------------------------------

function firstOf(
  payload: Record<string, unknown>,
  keys: readonly string[],
): unknown {
  for (const key of keys) {
    const value = payload[key];
    if (value === null || value === undefined || value === "") {
      continue;
    }
    return value;
  }
  return undefined;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function durationMs(payload: Record<string, unknown>): number {
  return toNumber(firstOf(payload, DURATION_KEYS)) ?? 0;
}

/** 只有 `network_request` / `db_query` 是「调用跨度」。 */
function spanKind(event: LogEvent): number | null {
  return event.event_type === "network_request" || event.event_type === "db_query"
    ? SPAN_KIND_CLIENT
    : null;
}

function httpSpanName(payload: Record<string, unknown>): string {
  const method = firstOf(payload, HTTP_METHOD_KEYS);
  const url = firstOf(payload, URL_KEYS);
  return `${method ? String(method) : "HTTP"} ${url ? String(url) : ""}`;
}

function httpError(payload: Record<string, unknown>, status: number | undefined): string | undefined {
  if (status !== undefined && status >= 400) {
    return String(Math.trunc(status));
  }
  const raw = payload["error"];
  if (raw !== undefined && raw !== null && String(raw) !== "") {
    return String(raw);
  }
  return undefined;
}

function httpSpanAttributes(payload: Record<string, unknown>): OtlpKeyValue[] {
  const attrs: OtlpKeyValue[] = [];
  const method = firstOf(payload, HTTP_METHOD_KEYS);
  const url = firstOf(payload, URL_KEYS);
  const status = toNumber(firstOf(payload, STATUS_KEYS));

  if (method !== undefined) {
    attrs.push(toKeyValue(SEMCONV.httpMethod, method));
  }
  if (url !== undefined) {
    attrs.push(toKeyValue(SEMCONV.urlFull, url));
    const host = hostOf(String(url));
    if (host) {
      attrs.push(toKeyValue(SEMCONV.serverAddress, host));
    }
  }
  if (status !== undefined) {
    // 状态码是整数：始终 intValue，即使 payload 里写成 200.0。
    attrs.push(toKeyValue(SEMCONV.httpStatus, Math.trunc(status)));
  }
  const error = httpError(payload, status);
  if (error !== undefined) {
    attrs.push(toKeyValue(SEMCONV.errorType, error));
  }
  return attrs;
}

/** 取绝对 URL 的 host 部分（`server.address`）。 */
function hostOf(url: string): string | undefined {
  const match = URL_HOST_RE.exec(url);
  if (!match) {
    return undefined;
  }
  let host = match[1] ?? "";
  const at = host.lastIndexOf("@");
  if (at >= 0) {
    host = host.slice(at + 1);
  }
  if (host.startsWith("[")) {
    const close = host.indexOf("]");
    return close > 0 ? host.slice(1, close) : host;
  }
  const colon = host.indexOf(":");
  return colon >= 0 ? host.slice(0, colon) : host;
}

function dbSpanName(payload: Record<string, unknown>): string {
  const operation = firstOf(payload, DB_OPERATION_KEYS);
  const statement = firstOf(payload, SQL_KEYS);
  return `${operation ? String(operation) : "SQL"} ${statement ? String(statement) : ""}`;
}

function dbError(payload: Record<string, unknown>): string | undefined {
  const error = payload["error"];
  if (error !== undefined && error !== null && String(error) !== "") {
    return String(error);
  }
  const errorType = payload["error_type"];
  if (errorType !== undefined && errorType !== null && String(errorType) !== "") {
    return String(errorType);
  }
  return undefined;
}

function dbSpanAttributes(payload: Record<string, unknown>): OtlpKeyValue[] {
  const attrs: OtlpKeyValue[] = [];
  const system = firstOf(payload, DB_SYSTEM_KEYS);
  const operation = firstOf(payload, DB_OPERATION_KEYS);
  const statement = firstOf(payload, SQL_KEYS);

  if (system !== undefined) {
    attrs.push(toKeyValue(SEMCONV.dbSystem, system));
  }
  if (operation !== undefined) {
    attrs.push(toKeyValue(SEMCONV.dbOperation, operation));
  }
  if (statement !== undefined) {
    attrs.push(toKeyValue(SEMCONV.dbStatement, statement));
  }
  const error = dbError(payload);
  if (error !== undefined) {
    attrs.push(toKeyValue(SEMCONV.errorType, error));
  }
  return attrs;
}

/**
 * 一条操作事件 → 一条 OTLP `Span`；非操作事件返回 `undefined`。
 */
export function eventToSpan(event: LogEvent): OtlpSpan | undefined {
  const kind = spanKind(event);
  if (kind === null) {
    return undefined;
  }
  const payload = event.payload ?? {};
  const name = event.event_type === "network_request" ? httpSpanName(payload) : dbSpanName(payload);
  const attributes =
    event.event_type === "network_request" ? httpSpanAttributes(payload) : dbSpanAttributes(payload);
  const failed =
    event.event_type === "network_request"
      ? httpError(payload, toNumber(firstOf(payload, STATUS_KEYS))) !== undefined
      : dbError(payload) !== undefined;

  const start = parseTimestampNanos(event.ts);
  // duration_ms × 1e6：先取整再转 BigInt，避免浮点尾差。
  const end = start + BigInt(Math.round(durationMs(payload) * 1_000_000));

  const span: OtlpSpan = {
    traceId: spanTraceId(event),
    spanId: spanIdHex(event),
    name,
    kind,
    startTimeUnixNano: start.toString(),
    endTimeUnixNano: end.toString(),
    attributes,
  };
  if (failed) {
    span.status = { code: STATUS_CODE_ERROR, message: name };
  }
  return span;
}

// ---------------------------------------------------------------------------
// 批次
// ---------------------------------------------------------------------------

/** 构造 OTLP/JSON `ExportLogsServiceRequest`。 */
export function toOtlpLogs(
  events: readonly LogEvent[],
  extraResource?: ExtraResource,
): ExportLogsServiceRequest {
  const resourceLogs: ExportLogsServiceRequest["resourceLogs"] = [];
  for (const group of groupByResource(events)) {
    const first = group[0];
    if (!first) {
      continue;
    }
    resourceLogs.push({
      resource: { attributes: mergeExtraResource(resourceAttributes(first), extraResource) },
      scopeLogs: [{ scope: { ...SCOPE }, logRecords: group.map((event) => eventToLogRecord(event)) }],
    });
  }
  return { resourceLogs };
}

/** 构造 OTLP/JSON `ExportTraceServiceRequest`。 */
export function toOtlpSpans(
  events: readonly LogEvent[],
  extraResource?: ExtraResource,
): ExportTraceServiceRequest {
  const resourceSpans: ExportTraceServiceRequest["resourceSpans"] = [];
  for (const group of groupByResource(events)) {
    const spans = group
      .map((event) => eventToSpan(event))
      .filter((span): span is OtlpSpan => span !== undefined);
    if (spans.length === 0) {
      // 没有操作事件：整组跳过，而不是发一个空的 resource 块（以及一个空请求）。
      continue;
    }
    const first = group[0];
    if (!first) {
      continue;
    }
    resourceSpans.push({
      resource: { attributes: mergeExtraResource(resourceAttributes(first), extraResource) },
      scopeSpans: [{ scope: { ...SCOPE }, spans }],
    });
  }
  return { resourceSpans };
}

/**
 * 一次产出两种信号。
 *
 * OTLP 一次请求只承载一种信号：`logs` POST 到 `/v1/logs`，
 * `traces` POST 到 `/v1/traces`。
 */
export function toOtlp(
  events: readonly LogEvent[],
  extraResource?: ExtraResource,
): OtlpBatch {
  return {
    logs: toOtlpLogs(events, extraResource),
    traces: toOtlpSpans(events, extraResource),
  };
}

/** 序列化为紧凑 JSON（UTF-8 安全，不转义中文）。 */
export function toOtlpJSON(payload: unknown): string {
  return JSON.stringify(payload);
}

// ---------------------------------------------------------------------------
// Sink
// ---------------------------------------------------------------------------

/** 缓冲事件行、按需产出 OTLP 批次的 sink。 */
export interface OtlpSink {
  /** 直接作为 `LoggerOptions.sink` 使用。 */
  sink: (line: string) => void;
  /** 当前缓冲的行（不消费）。 */
  lines: () => string[];
  size: () => number;
  /** 取出 OTLP 批次并清空缓冲。 */
  drain: () => OtlpBatch;
}

/**
 * 创建一个缓冲型 OTLP sink。
 *
 * ```ts
 * const sink = createOtlpSink();
 * const logger = new Logger({ service: 'web', env: 'prod', sink: sink.sink });
 * logger.info('hi');
 * const batch = sink.drain();          // { logs, traces }
 * fetch(`${endpoint}/v1/logs`, { method: 'POST', body: toOtlpJSON(batch.logs) });
 * ```
 *
 * 存的是**已序列化**的行，因此脱敏与 minLevel 过滤都已由 logger 完成。
 */
export function createOtlpSink(options: { extraResource?: ExtraResource } = {}): OtlpSink {
  let buffer: string[] = [];
  return {
    sink: (line: string) => {
      buffer.push(line);
    },
    lines: () => [...buffer],
    size: () => buffer.length,
    drain: () => {
      const drained = buffer;
      buffer = [];
      const events = drained.map((line) => JSON.parse(line) as LogEvent);
      return toOtlp(events, options.extraResource);
    },
  };
}
