# agent-log-web

面向 **Agent（AI 调试/排障）** 的 Web 可观测底座。**零业务依赖**，一处初始化，业务侧不写埋点代码即可获得结构化日志、追踪串联、前端崩溃捕获与 AI 交互事件。

> 仓库名 `agent-log-web` 是品牌（与 macOS 端 `agent-log-macos` 成对）；npm 包名沿用 `@scaffold/observability`，**接入方 import 路径不受仓库拆分影响**。
> 独立仓库，由 `ai-dev-spec` 以 git submodule 挂在 `logging-framework/web/Observability`。

## 状态

日志线格式遵循 **Schema v1**，规范真源在宿主仓库：
`ai-dev-spec/docs/logging-framework/schema/log-event.schema.json`。
本包的 `src/logger.test.ts` 里「Schema v1（线格式）」用例断言输出字段集与 schema 一致——**改字段先改 schema，否则测试会红**。

## 能力

| 模块 | 文件 | 说明 |
|---|---|---|
| 结构化日志 | `src/logger.ts` `src/types.ts` | 产出 Schema v1 线格式（JSONL），logger 层强制脱敏 |
| 追踪串联 | `src/trace.ts` | traceId 生成 / 传播，W3C `traceparent` 注入，前后端通用 |
| RED 指标 | `src/metrics.ts` | Rate / Errors / Duration(p50/p95/p99) + 健康检查辅助 |
| 前端 | `src/frontend/` | React `ErrorBoundary`（崩溃捕获上报）、`createBrowserLogger` |
| Agent 进度事件 | `src/agent-events.ts` | `agent_step / agent_handoff / agent_decision / agent_blocked` |
| AI 交互事件 | `src/frontend/ai-events.ts` | `ai_request_initiated / ai_tool_call_* / ai_response_received / ai_error` |
| OTLP 适配 | `src/otlp.ts` | Schema v1 → OTLP/JSON（LogRecord + Client Span），浏览器可用 |

## OTLP 导出

`src/otlp.ts` 把 Schema v1 事件映射成 OTLP/JSON，可直接 POST 给任何 OTLP/HTTP 后端
（映射规则真源：`ai-dev-spec/docs/logging-framework/OTLP-MAPPING.md`）。

```ts
import { toOtlp, toOtlpJSON, createOtlpSink, createLogger } from "@scaffold/observability";

// 1) 直接把事件转成 OTLP/JSON，自己发请求
const batch = toOtlp(events);
await fetch("/v1/logs", { method: "POST", body: toOtlpJSON(batch.logs) });

// 2) 或者挂成 sink 缓冲，攒批后 drain 出两个信号
const otlp = createOtlpSink({ extraResource: { "deployment.environment": "prod" } });
const logger = createLogger({ service: "web-api", env: "prod", sink: otlp.sink });
// ...业务写日志...
const { logs, traces } = otlp.drain(); // 缓冲区清空，返回可序列化的批次
```

实现要点（都是浏览器里真实会踩的坑）：

- **纳秒必须用 `BigInt`**：epoch 纳秒约 1.8e18，超过 `Number.MAX_SAFE_INTEGER`，用 number 会丢精度；
  对外统一以字符串输出（`timeUnixNano` 是 int64）。
- **同步 SHA-256 自实现**（`src/sha256.ts`）：浏览器只有异步 `crypto.subtle`，而 id 派生必须在
  `toOtlp()` 里同步完成，故内置纯 TS 实现，已用标准向量 + Python `hashlib` 交叉验证。
- **零第三方依赖**：不引入 OTel JS SDK，产出的是 OTLP/JSON 结构体，传输交回宿主 `fetch`。

## 快速接入

```ts
import { createLogger } from "@scaffold/observability";

const logger = createLogger({
  service: "web-api",
  env: "prod",
  subsystem: "com.example.web",
  level: "info",
});

logger.info("订单查询完成", { userId: "u_1", traceId: "trace_abc" }, "http_request");
// -> {"ts":"...","level":"info","service":"web-api","event_type":"http_request",
//     "session_id":"...","agent_auto":false,"message":"订单查询完成",
//     "trace_id":"trace_abc","subsystem":"com.example.web","env":"prod","user_id":"u_1"}
```

调用侧写 camelCase（`event / traceId / userId / sessionId / agentAuto / category`），
logger 在序列化边界映射为 snake_case；**其余键一律进 `payload`**（顶层字段集封闭）。

### 追踪串联

```ts
import { runWithTrace, traceIdFromHeaders, outgoingHeaders } from "@scaffold/observability";

app.use((req, res, next) => runWithTrace(traceIdFromHeaders(req.headers), () => next()));
fetch("https://downstream", { headers: outgoingHeaders() }); // 自动带 x-request-id + traceparent
```

### 前端（React）

```tsx
import { ErrorBoundary, createBrowserLogger } from "@scaffold/observability/frontend";
import { logAiRequest, logAiResponse } from "@scaffold/observability/frontend/ai-events";

const logger = createBrowserLogger({ service: "web", env: "production", endpoint: "/api/log" });
logAiRequest(logger, { sessionId: "s1", model: "gpt-4o" }, "总结这段对话");

<ErrorBoundary logger={logger} fallback={<p>出错了</p>}>
  <App />
</ErrorBoundary>;
```

## 开发（独立于宿主）

```bash
pnpm install
pnpm lint        # ESLint（no-console 为 error，配置损坏会立刻暴露）
pnpm typecheck   # src + 测试都过 tsc
pnpm test        # vitest
pnpm build       # tsc -> dist
```

## 作为 submodule 被宿主消费

宿主 `ai-dev-spec` 里路径为 `logging-framework/web/Observability`，并在 `pnpm-workspace.yaml` 注册为 workspace 成员：

- 依赖由**宿主根 lockfile** 统一解析（本仓库自带的 `pnpm-lock.yaml` 仅服务独立开发，被宿主安装时忽略）；
- 包名仍是 `@scaffold/observability`，workspace 内 import 与目录名无关；
- 宿主侧 `pnpm -r typecheck|test` 会连带跑本包的门禁。

## 设计边界

- **脱敏在 logger 层**：默认键（`password/token/authorization/cookie/secret/api_key/...`）不可关闭，`redactPaths` 只能追加（路径相对 `payload`）。
- **不锁死后端**：默认 stdout / 浏览器 fetch，换成 Sentry、OTLP 只需换 `sink`。
- **薄封装**：业务不直连底层日志库，避免"每端一套日志方言"。
