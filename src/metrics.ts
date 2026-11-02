/**
 * 轻量 RED 指标 + 健康检查辅助。
 * RED = Rate（请求数）、Errors（错误数）、Duration（耗时 p50/p95/p99）。
 * 生产可替换为 OpenTelemetry/Prometheus；这里提供零依赖起步实现。
 */

interface Bucket {
  count: number;
  errors: number;
  durations: number[];
}

const buckets = new Map<string, Bucket>();

export function record(
  route: string,
  durationMs: number,
  errored = false,
): void {
  const b = buckets.get(route) ?? { count: 0, errors: 0, durations: [] };
  b.count += 1;
  if (errored) b.errors += 1;
  b.durations.push(durationMs);
  buckets.set(route, b);
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(
    sorted.length - 1,
    Math.floor((p / 100) * sorted.length),
  );
  return sorted[idx] ?? 0;
}

export function snapshot(): Record<
  string,
  { rate: number; errors: number; p50: number; p95: number; p99: number }
> {
  const out: Record<
    string,
    { rate: number; errors: number; p50: number; p95: number; p99: number }
  > = {};
  for (const [route, b] of buckets) {
    const d = [...b.durations].sort((a, c) => a - c);
    out[route] = {
      rate: b.count,
      errors: b.errors,
      p50: percentile(d, 50),
      p95: percentile(d, 95),
      p99: percentile(d, 99),
    };
  }
  return out;
}

export interface DepCheck {
  name: string;
  ok: () => Promise<boolean> | boolean;
}

/** 框架无关的健康端点逻辑，交给具体 HTTP 框架包装成 GET /health、GET /ready */
export function liveness() {
  return { status: "ok", timestamp: new Date().toISOString() };
}

export async function readiness(deps: DepCheck[]) {
  const results = await Promise.all(
    deps.map(async (d) => ({ name: d.name, ok: await d.ok() })),
  );
  const allOk = results.every((r) => r.ok);
  return {
    status: allOk ? "ok" : "degraded",
    checks: results,
    timestamp: new Date().toISOString(),
  };
}
