/**
 * Agent 进度可观测（要点 4）：把「Agent 在做什么、做到哪了、为什么换人、做了什么决策」
 * 以结构化事件写入同一套日志（带 traceId），使进度既有人读的交接文档，也有机查的日志流。
 */
import type { Logger } from './logger.js';

export interface AgentStepCtx {
  feature: string;
  taskId?: string;
  agentId?: string;
  [key: string]: unknown;
}

/** 记录 Agent 在某任务上的进度推进 */
export function logAgentStep(logger: Logger, ctx: AgentStepCtx, progress: number, note: string): void {
  logger.info('agent step', { ...ctx, progress, note, event: 'agent_step' });
}

/** 记录换人接手（为何从 A 换到 B）——进度可跟踪、可审计 */
export function logAgentHandoff(logger: Logger, ctx: AgentStepCtx, fromAgent: string, toAgent: string, reason: string): void {
  logger.warn('agent handoff', { ...ctx, fromAgent, toAgent, reason, event: 'agent_handoff' });
}

/** 记录关键决策及其理由，沉淀进日志避免后人重蹈覆辙 */
export function logAgentDecision(logger: Logger, ctx: AgentStepCtx, decision: string, rationale: string): void {
  logger.info('agent decision', { ...ctx, decision, rationale, event: 'agent_decision' });
}

/** 记录阻塞，便于新 Agent 一接手就知道卡点 */
export function logAgentBlocked(logger: Logger, ctx: AgentStepCtx, blocker: string): void {
  logger.warn('agent blocked', { ...ctx, blocker, event: 'agent_blocked' });
}
