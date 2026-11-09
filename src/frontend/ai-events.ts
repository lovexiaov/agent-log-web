/**
 * AI 交互生命周期事件（要点 2 的「前端也要可观测」核心）。
 * 记录 Agent 到底做了什么，便于事后复盘与调试那些「人类看不到、Agent 不会重试」的问题。
 * 对应事件名遵循 aivoid.dev 建议的 AI UI 可观测五类事件。
 */
import type { Logger } from '../logger.js';

export interface AiContext {
  userId?: string;
  sessionId: string;
  model?: string;
  [key: string]: unknown;
}

export function logAiRequest(logger: Logger, ctx: AiContext, promptText: string) {
  logger.info('ai request initiated', { ...ctx, promptText, event: 'ai_request_initiated' });
}

export function logAiToolCall(logger: Logger, ctx: AiContext, toolName: string, toolArguments: unknown) {
  logger.info('ai tool call initiated', { ...ctx, toolName, toolArguments, event: 'ai_tool_call_initiated' });
}

export function logAiToolResult(logger: Logger, ctx: AiContext, toolName: string, latencyMs: number, ok: boolean) {
  logger.info('ai tool call completed', { ...ctx, toolName, toolCallLatency: latencyMs, ok, event: 'ai_tool_call_completed' });
}

export function logAiResponse(logger: Logger, ctx: AiContext, responseLength: number, tokenUsage?: number) {
  logger.info('ai response received', { ...ctx, responseLength, tokenUsage, event: 'ai_response_received' });
}

export function logAiGuardrail(logger: Logger, ctx: AiContext, guardrailType: string, reason: string) {
  logger.warn('ai guardrail triggered', { ...ctx, guardrailType, reason, event: 'ai_guardrail_triggered' });
}

export function logAiError(logger: Logger, ctx: AiContext, errorType: string, errorMessage: string, stack?: string) {
  logger.error('ai interaction error', {
    ...ctx,
    errorType,
    errorMessage,
    exception: errorType,
    exception_message: errorMessage,
    stack,
    mechanism: 'handled',
    event: 'ai_error',
  });
}
