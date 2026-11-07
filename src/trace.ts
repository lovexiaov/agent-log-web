/**
 * 追踪（Trace）传播：在边缘生成/接受 traceId，注入每条日志并向下游传递。
 * 同时支持 W3C traceparent 标准，便于跨服务串联 frontend -> API -> DB。
 * 不依赖 AsyncLocalStorage，浏览器/Node 通用。
 */

import { normalizeTraceId } from './ids.js';
import { randomUUID } from 'node:crypto';

const TRACE_HEADER = 'x-request-id';
const TRACEPARENT_HEADER = 'traceparent';

/** 模块级当前 traceId 载体；请求处理时 runWithTrace 包裹即可 */
let currentTraceId: string | undefined;
const listeners = new Set<(id: string | undefined) => void>();

/** 生成 Schema v1.2 合法的 trace id：32 位小写 hex（UUID 去横线）。 */
export function generateTraceId(): string {
  return randomUUID().replace(/-/g, '');
}

export function getTraceId(): string | undefined {
  return currentTraceId;
}

/** 在回调执行期间把 traceId 设为当前上下文（嵌套会正确还原） */
export function runWithTrace<T>(traceId: string, fn: () => T): T {
  const prev = currentTraceId;
  currentTraceId = traceId;
  listeners.forEach((l) => l(traceId));
  try {
    return fn();
  } finally {
    currentTraceId = prev;
    listeners.forEach((l) => l(prev));
  }
}

export function onTraceChange(cb: (id: string | undefined) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * 从入站请求头解析 traceId（优先 x-request-id，其次 traceparent）。
 *
 * Schema v1.2 要求 32 位 hex：非 hex 的自定义请求 id 无法作为 trace id
 * 使用（写入边界会丢弃），此时回退 traceparent，再回退新生成。上游自定义
 * id 与本系统 trace 的关联应由调用方在业务层显式维护。
 */
export function traceIdFromHeaders(headers: Record<string, string | undefined>): string {
  const rid = headers[TRACE_HEADER];
  if (rid && normalizeTraceId(rid)) return normalizeTraceId(rid)!;
  const tp = headers[TRACEPARENT_HEADER];
  if (tp) {
    const fromTp = normalizeTraceId(tp.split('-')[1]);
    if (fromTp) return fromTp;
  }
  return generateTraceId();
}

/** 把当前 traceId 注入到出站请求头，使下游调用链串联 */
export function outgoingHeaders(existing: Record<string, string> = {}): Record<string, string> {
  const id = currentTraceId ?? generateTraceId();
  return { ...existing, [TRACE_HEADER]: id, [TRACEPARENT_HEADER]: `00-${id}-00-01` };
}

export const TRACE_HEADERS = { TRACE_HEADER, TRACEPARENT_HEADER } as const;
