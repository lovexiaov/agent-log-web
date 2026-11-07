/**
 * AgentLog Web 示例演示
 *
 * 覆盖契约能力：
 *  - createLogger 引导（service / env / level / format / redactPaths）
 *  - 6 档级别：trace / debug / info / warn / error / critical
 *  - child：合并 scope 上下文（userId / traceId），返回新实例，不污染原实例
 *  - redact：默认敏感键（password / token / secret / authorization …）不可关闭，可追加自定义键
 *  - pretty / json 两种线格式，以及 setLevel 等价过滤
 *
 * 运行（仓库根目录）：
 *   npx tsx example/demo.ts
 *
 * 默认 sink 把结构化 JSONL 写入 stdout（error 级走 stderr），
 * 每行即 Schema v1 合规记录，可直接被 Agent 按行消费。
 */
import { createLogger } from "../src/index.js";

// 主 logger：dev 环境，debug 起步；pretty 便于肉眼阅读（仍会附带完整 JSON）。
// 默认脱敏键已内置且不可关闭，这里再追加一个业务敏感键 customerSsn。
const log = createLogger({
  service: "demo-web-app",
  env: "dev",
  level: "trace", // 设为最低级别，6 档全部发出；过滤效果见第 4 步
  format: "pretty",
  redactPaths: ["customerSsn"],
});

// 1) 各档级别
log.info("应用启动");
log.debug("调试细节", { step: "init" });
log.warn("磁盘空间偏低", { freeMb: 42 });
log.error("接口请求失败", { host: "api.example.com", status: 503 });
log.trace("细粒度追踪", { span: "boot" });
log.critical("核心服务不可用", { region: "cn" });

// 2) child：合并 scope 上下文（userId / traceId），返回新实例，不污染原实例
const userLog = log.child({ userId: "u-1234", traceId: "trace_abc" });
userLog.info("用户完成下单", { orderId: "INV-9" });

// 3) 脱敏：默认键 password / token 与自定义键 customerSsn 都会被自动打码
log.error("登录失败", {
  password: "hunter2",
  token: "topsecret",
  customerSsn: "123-45-6789",
  username: "alice",
});

// 4) 切换为 json 线格式 + 调高到 warn：info 被过滤，warn 写出
const strict = createLogger({ service: "demo-web-app", env: "dev", level: "warn" });
strict.info("这条不会写出（被 warn 过滤）");
strict.warn("这条会写出");
