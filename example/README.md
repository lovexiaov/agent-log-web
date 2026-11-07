# Web 示例演示

演示 [@scaffold/observability](../README.md)（TypeScript）的端到端用法，对应契约要求的全部能力：

- `createLogger` 引导（`service` / `env` / `level` / `format` / `redactPaths`）
- 6 档级别：`trace / debug / info / warn / error / critical`
- `child`：合并作用域上下文（`userId` / `traceId`），返回新实例，父级不变
- `redact`：默认敏感键不可关闭，可追加自定义键
- `pretty` / `json` 两种线格式

## 运行

在仓库根目录执行（无需安装额外依赖，`tsx` 会临时拉取）：

```bash
npx tsx example/demo.ts
```

默认 sink 把结构化 JSONL 写入 **stdout**（`error` 级走 stderr），每行即 Schema v1 合规记录，
可直接被 Agent 按行消费。浏览器侧可用 `src/frontend` 的 `createBrowserLogger`（默认把日志 POST 到后端日志端点）作对照。
