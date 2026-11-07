/**
 * Schema v1.1 标识符工具（零依赖、无平台 API，浏览器与 Node 通用）。
 *
 * 单独成模块的原因：`logger.ts` 依赖 `node:crypto`（会话 id），而 OTLP 适配器
 * 是纯计算、应该能在浏览器里独立打包 —— 二者共用的归一化逻辑放在这里，
 * 谁也不用拖谁。
 */

/**
 * 归一化 span id：16 位 hex（大小写不敏感）→ 小写；其他一律返回 `undefined`。
 *
 * 返回 `undefined` 而不是抛错，是为了让调用方**丢弃**非法值而不是写出去 ——
 * 坏值永远不会产生违反 Schema 的行，也不会污染 OTLP 的 `spanId`。
 */
export function normalizeSpanId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return /^[0-9a-fA-F]{16}$/.test(trimmed) ? trimmed.toLowerCase() : undefined;
}
