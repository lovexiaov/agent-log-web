/**
 * 统一日志 Schema v1（线格式）。
 * 定义见 docs/logging-framework/schema/log-event.schema.json —— 这里是它在 TS 侧的唯一实现。
 *
 * 约定：`LogEvent` 即"线上 JSON 的形状"（snake_case），不再额外转译。
 * 调用侧仍用 camelCase 书写（`event / traceId / userId / sessionId / agentAuto`），
 * 由 logger 在序列化边界映射到本结构；其余自定义键一律收进 `payload`。
 */

export type LogLevelName =
  "trace" | "debug" | "info" | "warn" | "error" | "critical";

/** 写入端只允许的 level 词表（与 schema 的 enum 一致） */
export const LOG_LEVELS: readonly LogLevelName[] = [
  "trace",
  "debug",
  "info",
  "warn",
  "error",
  "critical",
] as const;

/**
 * 调用侧上下文（authoring 形态，camelCase）。
 * 保留键会被提升为顶层字段，其余键全部进 `payload`。
 */
export interface LogContext {
  /** -> 顶层 `user_id` */
  userId?: string;
  /** -> 顶层 `session_id`（缺省用 logger 的会话 id） */
  sessionId?: string;
  /** -> 顶层 `trace_id` */
  traceId?: string;
  /** -> 顶层 `span_id`（Schema v1.1：16 位小写 hex，与 W3C traceparent span-id 同构） */
  spanId?: string;
  /** -> 顶层 `event_type`（缺省 `log`） */
  event?: string;
  /** -> 顶层 `category` */
  category?: string;
  /** -> 顶层 `agent_auto` */
  agentAuto?: boolean;
  /** 其余键 -> `payload` */
  [key: string]: unknown;
}

/**
 * Schema v1.4：六端统一的 AI 交互事件类型（见 INTERFACE.md §4.4）。
 * `event_type` 本身是开放 string，这里只列出框架承认的 6 个标准值。
 */
export const AI_EVENT_TYPES = [
  "ai_request_initiated",
  "ai_response_received",
  "ai_tool_call_initiated",
  "ai_tool_call_completed",
  "ai_guardrail_triggered",
  "ai_error",
] as const;

export type AiEventType = (typeof AI_EVENT_TYPES)[number];

/** Schema v1 线格式：所有端输出的 JSON 必须长这样，顶层禁止扩展 */
export interface LogEvent {
  ts: string;
  level: LogLevelName;
  service: string;
  event_type: string;
  session_id: string;
  agent_auto: boolean;
  message: string;
  trace_id?: string;
  span_id?: string;
  subsystem?: string;
  category?: string;
  env?: string;
  /** 发布标识（Schema v1.3，可选）：semver / git sha / build number */
  release?: string;
  user_id?: string;
  payload?: Record<string, unknown>;
}

/** C6：默认脱敏键（各端可加不可减） */
export const DEFAULT_REDACT_PATHS: readonly string[] = [
  "password",
  "passwd",
  "pwd",
  "token",
  "authorization",
  "cookie",
  "secret",
  "apiKey",
  "api_key",
  "accessToken",
  "access_token",
  "refreshToken",
  "refresh_token",
] as const;

export type LogSink = (line: string) => void;

export interface LoggerOptions {
  service: string;
  env: string;
  /** 发布标识（可选）：写入每条事件的顶层 `release` */
  release?: string;
  /** 子系统标识（反向域名等），写入顶层 `subsystem` */
  subsystem?: string;
  level?: LogLevelName;
  format?: "json" | "pretty";
  /** 额外的脱敏字段点分路径（相对 `payload`），如 'user.email'；会与默认键合并 */
  redactPaths?: string[];
  /** 该 logger 写出的事件是否标记为自动埋点（默认 false） */
  agentAuto?: boolean;
  /** 自定义输出（默认 stdout；浏览器可传 fetch 上报） */
  sink?: LogSink;
}
