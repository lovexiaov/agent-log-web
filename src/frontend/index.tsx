/**
 * 前端可观测：React ErrorBoundary + 浏览器结构化上报。
 * 让「看不见的」前端崩溃与 AI 交互可被捕获、回放、复盘。
 */
import React from "react";
import { Logger, createLogger, type LoggerOptions } from "../logger.js";
import { getTraceId, generateTraceId } from "../trace.js";

/** 浏览器侧 logger：默认把结构化日志 POST 到后端日志端点 */
export function createBrowserLogger(
  options: LoggerOptions & { endpoint?: string; sampleRate?: number },
): Logger {
  const { endpoint, sampleRate = 1, sink, ...rest } = options;
  const trace = getTraceId() ?? generateTraceId();
  const browserSink =
    sink ??
    ((line: string) => {
      if (Math.random() > sampleRate) return;
      if (endpoint && typeof fetch !== "undefined") {
        fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: line,
        }).catch(() => {});
      } else if (typeof console !== "undefined") {
        // 浏览器端无日志端点时的最后兜底（非生产日志通道），仅作本地调试可见性。
        // 使用 console.warn（no-console 规则放行 warn/error），避免误用 console.log。
        console.warn(line);
      }
    });
  return createLogger({ ...rest, sink: browserSink }).child({ traceId: trace });
}

interface BoundaryProps {
  logger: Logger;
  fallback?: React.ReactNode;
  children: React.ReactNode;
}

interface BoundaryState {
  hasError: boolean;
}

/** 捕获渲染崩溃并上报（含 traceId 与组件栈），避免异常被静默吞掉 */
export class ErrorBoundary extends React.Component<
  BoundaryProps,
  BoundaryState
> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    this.props.logger.error("react_render_error", {
      event: "react_error",
      exception: error.name,
      exception_message: error.message,
      error_message: error.message,
      stack: error.stack,
      componentStack: info.componentStack,
      mechanism: "uncaught",
    });
  }

  override render(): React.ReactNode {
    if (this.state.hasError) return this.props.fallback ?? null;
    return this.props.children;
  }
}
