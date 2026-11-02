import { randomUUID } from "node:crypto";
import {
  DEFAULT_REDACT_PATHS,
  type LogContext,
  type LogEvent,
  type LogLevelName,
  type LoggerOptions,
  type LogSink,
} from "./types.js";

/** 重新导出类型，便于调用方从 logger 直接取用（如 frontend 的 createBrowserLogger）。 */
export type { LoggerOptions } from "./types.js";

const LEVEL_WEIGHT: Record<LogLevelName, number> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
  critical: 5,
};

/** 保留键：从调用方上下文里提升为顶层字段，其余键一律收进 payload（Schema v1 封闭顶层）。 */
const RESERVED_CONTEXT_KEYS = [
  "userId",
  "sessionId",
  "traceId",
  "event",
  "category",
  "agentAuto",
] as const;

/** 进程 / 页面级会话 id：一次运行 = 一个 session_id，与 macOS 端 Session.id 语义一致。 */
const PROCESS_SESSION_ID = randomUUID();

/** 深拷贝并就地脱敏：按点分路径（相对 payload）把敏感字段替换成 [REDACTED] */
function redact(value: unknown, paths: string[], prefix = ""): unknown {
  if (value === null || typeof value !== "object") return value;
  // 数组与对象分别复制，保持原结构；用 Record 视图统一做键遍历与写回。
  const out: Record<string, unknown> | unknown[] = Array.isArray(value)
    ? [...(value as unknown[])]
    : { ...(value as Record<string, unknown>) };
  const view = out as unknown as Record<string, unknown>;
  for (const key of Object.keys(view)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (paths.includes(full)) {
      view[key] = "[REDACTED]";
    } else if (typeof view[key] === "object" && view[key] !== null) {
      view[key] = redact(view[key], paths, full);
    }
  }
  return out;
}

const defaultSink: LogSink = (line) => {
  // 错误级别走 stderr，便于容器/平台分流采集；
  // 直接用 stdout/stderr 写入，避免引入 console（生产日志须由本框架统一管控）
  if (line.includes('"level":"error"')) process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
};

interface ResolvedOptions {
  service: string;
  env: string;
  subsystem?: string;
  level: LogLevelName;
  format: "json" | "pretty";
  redactPaths: string[];
  agentAuto: boolean;
  sink: LogSink;
  sessionId: string;
}

export class Logger {
  private readonly opts: ResolvedOptions;
  private readonly bound: LogContext;

  constructor(options: LoggerOptions, bound: LogContext = {}) {
    this.opts = {
      service: options.service,
      env: options.env,
      ...(options.subsystem ? { subsystem: options.subsystem } : {}),
      level: options.level ?? "info",
      format: options.format ?? "json",
      // 默认脱敏键不可关闭，只能追加（C6）
      redactPaths: [
        ...new Set([...DEFAULT_REDACT_PATHS, ...(options.redactPaths ?? [])]),
      ],
      agentAuto: options.agentAuto ?? false,
      sink: options.sink ?? defaultSink,
      sessionId: PROCESS_SESSION_ID,
    };
    this.bound = bound;
  }

  /** 绑定上下文（典型：traceId / userId / sessionId），返回新实例，不污染原实例 */
  child(ctx: LogContext): Logger {
    return new Logger(this.opts, { ...this.bound, ...ctx });
  }

  /** 按 Schema v1 组装线格式事件：保留键提升为顶层，其余进 payload。 */
  private emit(
    level: LogLevelName,
    message: string,
    event: string | undefined,
    extra: LogContext,
  ) {
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[this.opts.level]) return;

    const merged: LogContext = { ...this.bound, ...extra };
    // 非保留键一律进 payload（Schema v1 顶层封闭）
    const reserved: readonly string[] = RESERVED_CONTEXT_KEYS;
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(merged)) {
      if (!reserved.includes(key)) rest[key] = value;
    }

    const cleanPayload =
      Object.keys(rest).length > 0
        ? (redact(rest, this.opts.redactPaths) as Record<string, unknown>)
        : undefined;

    const ctxEvent = merged.event;
    const sessionId = merged.sessionId;
    const traceId = merged.traceId;
    const userId = merged.userId;
    const category = merged.category;
    const agentAuto = merged.agentAuto;

    const evt: LogEvent = {
      ts: new Date().toISOString(),
      level,
      service: this.opts.service,
      event_type:
        event ?? (typeof ctxEvent === "string" ? ctxEvent : undefined) ?? "log",
      session_id:
        typeof sessionId === "string" ? sessionId : this.opts.sessionId,
      agent_auto:
        typeof agentAuto === "boolean" ? agentAuto : this.opts.agentAuto,
      message,
      ...(typeof traceId === "string" ? { trace_id: traceId } : {}),
      ...(this.opts.subsystem ? { subsystem: this.opts.subsystem } : {}),
      ...(typeof category === "string" ? { category } : {}),
      env: this.opts.env,
      ...(typeof userId === "string" ? { user_id: userId } : {}),
      ...(cleanPayload ? { payload: cleanPayload } : {}),
    };

    const line =
      this.opts.format === "pretty"
        ? `${evt.ts} ${level.toUpperCase()} [${evt.service}] ${message} ${JSON.stringify(evt)}`
        : JSON.stringify(evt);
    this.opts.sink(line);
  }

  trace(message: string, extra: LogContext = {}, event?: string) {
    this.emit("trace", message, event, extra);
  }
  debug(message: string, extra: LogContext = {}, event?: string) {
    this.emit("debug", message, event, extra);
  }
  info(message: string, extra: LogContext = {}, event?: string) {
    this.emit("info", message, event, extra);
  }
  warn(message: string, extra: LogContext = {}, event?: string) {
    this.emit("warn", message, event, extra);
  }
  error(message: string, extra: LogContext = {}, event?: string) {
    this.emit("error", message, event, extra);
  }
  critical(message: string, extra: LogContext = {}, event?: string) {
    this.emit("critical", message, event, extra);
  }
}

/** 工厂函数：项目入口处用 config/logging.config.ts 注入即可 */
export function createLogger(options: LoggerOptions): Logger {
  return new Logger(options);
}
