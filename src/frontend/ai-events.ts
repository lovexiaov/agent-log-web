/**
 * AI 交互事件（Schema v1.4，六端统一契约）。
 *
 * 契约真源：docs/logging-framework/INTERFACE.md §4.4。
 * - 6 个标准 `event_type`，payload 只用 snake_case 标准词表；
 * - 业务**显式埋点**（`agentAuto: false`），框架只准备数据，不自动 hook LLM SDK；
 * - level：request / response / tool = info，guardrail = warn，error = error；
 * - OTLP 层只作 log 信号，不产 span（可挂 `spanId` 供下游组 span）；
 * - `request_id` 由调用方在「请求→响应→工具→错误」同一轮内保持一致，用于下游串联。
 *
 * D7：保留 `logAi*` 函数名与既有参数顺序，仅把 payload 字段名改为标准词表；
 * 每个函数新增可选的末尾 `extra`，用于追加标准词表字段（如 `provider` / `request_id`
 * / `prompt_tokens`）或业务键。
 */
import type { Logger } from "../logger.js";
import type { AiEventType } from "../types.js";

export interface AiContext {
  userId?: string;
  sessionId: string;
  model?: string;
  /** 其余键一律写入 `payload`；请只用 §4.4 的 snake_case 标准词表。 */
  [key: string]: unknown;
}

/** 追加的标准词表字段 / 业务键（snake_case）。 */
export type AiExtra = Record<string, unknown>;

/** 统一走 Logger 的写入入口，盖章 event_type / level / category / agent_auto。 */
function emitAi(
  logger: Logger,
  level: "info" | "warn" | "error",
  event: AiEventType,
  message: string,
  ctx: AiContext,
  extra: AiExtra,
  fields: Record<string, unknown>,
): void {
  const merged: Record<string, unknown> = { ...ctx, ...extra };
  // 缺省即不写，不产生 `key: undefined`（标准词表字段全部可选）。
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) merged[key] = value;
  }
  // 框架拥有的保留键最后覆盖，避免调用方 context 篡改契约。
  merged.event = event;
  merged.category = "ai";
  merged.agentAuto = false;
  if (level === "info") logger.info(message, merged);
  else if (level === "warn") logger.warn(message, merged);
  else logger.error(message, merged);
}

/** `ai_request_initiated`：一次 LLM 调用的请求发起。 */
export function logAiRequest(
  logger: Logger,
  ctx: AiContext,
  promptText: string,
  extra: AiExtra = {},
): void {
  emitAi(logger, "info", "ai_request_initiated", "ai request initiated", ctx, extra, {
    prompt_text: promptText,
  });
}

/** `ai_response_received`：收到模型响应，带 token 用量。 */
export function logAiResponse(
  logger: Logger,
  ctx: AiContext,
  responseLength: number,
  tokenUsage?: number,
  extra: AiExtra = {},
): void {
  emitAi(logger, "info", "ai_response_received", "ai response received", ctx, extra, {
    response_length: responseLength,
    total_tokens: tokenUsage,
  });
}

/** `ai_tool_call_initiated`：模型发起一次工具调用。 */
export function logAiToolCall(
  logger: Logger,
  ctx: AiContext,
  toolName: string,
  toolArguments: unknown,
  extra: AiExtra = {},
): void {
  emitAi(logger, "info", "ai_tool_call_initiated", "ai tool call initiated", ctx, extra, {
    tool_name: toolName,
    tool_arguments: toolArguments,
  });
}

/** `ai_tool_call_completed`：工具调用完成。 */
export function logAiToolResult(
  logger: Logger,
  ctx: AiContext,
  toolName: string,
  latencyMs: number,
  ok: boolean,
  extra: AiExtra = {},
): void {
  emitAi(logger, "info", "ai_tool_call_completed", "ai tool call completed", ctx, extra, {
    tool_name: toolName,
    tool_call_latency_ms: latencyMs,
    ok,
  });
}

/** `ai_guardrail_triggered`（warn）：护栏 / 合规拦截触发。 */
export function logAiGuardrail(
  logger: Logger,
  ctx: AiContext,
  guardrailType: string,
  reason: string,
  extra: AiExtra = {},
): void {
  emitAi(logger, "warn", "ai_guardrail_triggered", "ai guardrail triggered", ctx, extra, {
    guardrail_type: guardrailType,
    reason,
  });
}

/** `ai_error`（error）：复用 v1.3 异常词表。 */
export function logAiError(
  logger: Logger,
  ctx: AiContext,
  errorType: string,
  errorMessage: string,
  stack?: string,
  extra: AiExtra = {},
): void {
  emitAi(logger, "error", "ai_error", "ai interaction error", ctx, extra, {
    exception: errorType,
    exception_message: errorMessage,
    stack,
    mechanism: "handled",
  });
}
