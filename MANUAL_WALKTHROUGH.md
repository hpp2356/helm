# Helm 手动走查 (PR23)

## 跑命令

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install && pnpm build
pnpm test                           # 全部测试
pnpm -C packages/telemetry test     # 只看 telemetry 测试（78 个）
```

## 场景 1：Console 导出 — 看 stderr 输出的 metrics

**命令**：

```bash
HELM_TELEMETRY_ENABLED=1 HELM_METRICS_EXPORTER=console HELM_LOGS_EXPORTER=console pnpm repl --provider=scripted
> Hello
> /exit
```

**预期行为**：

- stderr 输出 metrics 和 logs
- 输出格式：`[telemetry] metric helm.session.count=1`
- 输出格式：`[telemetry] info [session:start] — Session repl-xxx started`

**stderr 输出示例**：

```
[telemetry] metric helm.session.count=1 {"model":"scripted","provider":"scripted"}
[telemetry] info [session:start] — Session repl-1234 started
[telemetry] info [session:end] — Session repl-1234 ended
[telemetry] metric helm.session.duration=5234
```

## 场景 2：File 导出 — 检查 ~/.helm/telemetry/ 文件

**命令**：

```bash
HELM_TELEMETRY_ENABLED=1 pnpm repl --provider=scripted
> Hello
> /exit
ls -la ~/.helm/telemetry/
cat ~/.helm/telemetry/metrics-*.jsonl
cat ~/.helm/telemetry/logs-*.jsonl
cat ~/.helm/telemetry/usage.jsonl
```

**预期行为**：

- `~/.helm/telemetry/` 目录自动创建
- `metrics-YYYY-MM-DD.jsonl` 包含 metrics 数据
- `logs-YYYY-MM-DD.jsonl` 包含 logs 数据
- `usage.jsonl` 包含会话汇总

**usage.jsonl 示例**：

```json
{"session_id":"repl-1234","start_time":"2026-07-12T10:00:00Z","end_time":"2026-07-12T10:00:05Z","token_input":0,"token_output":0,"tool_calls":0,"tool_errors":0,"api_requests":0,"hook_executions":0}
```

## 场景 3：Token 统计 — 看 token 使用量

**命令**：

```bash
HELM_TELEMETRY_ENABLED=1 pnpm repl --provider=deepseek
> Tell me a joke
> /exit
cat ~/.helm/telemetry/usage.jsonl | jq '.token_input, .token_output'
```

**预期行为**：

- `token_input` 记录输入 token 数
- `token_output` 记录输出 token 数
- metrics 文件包含 `helm.api.token.input` 和 `helm.api.token.output`

## 场景 4：工具调用统计 — 看工具调用次数和延迟

**命令**：

```bash
HELM_TELEMETRY_ENABLED=1 pnpm repl --provider=deepseek
> Read the file package.json
> /exit
cat ~/.helm/telemetry/usage.jsonl | jq '.tool_calls, .tool_errors'
cat ~/.helm/telemetry/metrics-*.jsonl | grep "tool.call"
```

**预期行为**：

- `tool_calls` 记录工具调用次数
- `tool_errors` 记录工具调用错误数
- metrics 包含 `helm.tool.call.duration` 带延迟数据

## 场景 5：会话汇总 — 看 usage.jsonl 内容

**命令**：

```bash
HELM_TELEMETRY_ENABLED=1 pnpm repl --provider=deepseek
> Hello
> /exit
cat ~/.helm/telemetry/usage.jsonl | jq .
```

**预期字段**：

| 字段 | 说明 |
|------|------|
| `session_id` | 会话 ID |
| `start_time` | 开始时间 |
| `end_time` | 结束时间 |
| `token_input` | 输入 token 总数 |
| `token_output` | 输出 token 总数 |
| `tool_calls` | 工具调用次数 |
| `tool_errors` | 工具调用错误数 |
| `api_requests` | API 请求次数 |
| `hook_executions` | Hook 执行次数 |

## 场景 6：隐私控制 — 验证 prompt 不被记录

**命令**：

```bash
# 默认不记录 prompt
HELM_TELEMETRY_ENABLED=1 HELM_LOGS_EXPORTER=file pnpm repl --provider=deepseek
> Tell me a secret: my password is 12345
> /exit
cat ~/.helm/telemetry/logs-*.jsonl | grep -i "password"
```

**预期行为**：

- 默认 `HELM_LOG_USER_PROMPTS=0` — prompt 内容不出现在 logs
- 默认 `HELM_LOG_TOOL_CONTENT=0` — 工具输出内容不出现在 logs
- grep 无结果

**启用 prompt 记录**：

```bash
HELM_TELEMETRY_ENABLED=1 HELM_LOG_USER_PROMPTS=1 pnpm repl
# 现在 prompt 内容会出现在 logs
```

## CLI Flags

| Flag | 环境变量 | 说明 |
|------|----------|------|
| `--no-telemetry` | `HELM_TELEMETRY_ENABLED=0` | 禁用 telemetry |
| `--telemetry-verbose` | `HELM_TELEMETRY_VERBOSE=1` | 详细日志（debug 级别） |
| — | `HELM_METRICS_EXPORTER=console` | Metrics 导出器 |
| — | `HELM_LOGS_EXPORTER=file` | Logs 导出器 |
| — | `HELM_TRACES_EXPORTER=none` | Traces 导出器 |
| — | `HELM_LOG_USER_PROMPTS=1` | 记录 prompt 内容 |
| — | `HELM_LOG_TOOL_CONTENT=1` | 记录工具输出内容 |

## IDEA 断点位置

| 文件 | 行号 | 看什么 |
|------|------|--------|
| `packages/telemetry/src/telemetry.ts` | `startSession()` | 会话开始 metrics |
| `packages/telemetry/src/telemetry.ts` | `recordApiRequest()` | API 请求 metrics |
| `packages/telemetry/src/telemetry.ts` | `recordToolCall()` | 工具调用 metrics |
| `packages/telemetry/src/telemetry.ts` | `flush()` | 导出触发 |
| `packages/telemetry/src/telemetry.ts` | `exportUsage()` | usage.jsonl 写入 |
| `packages/telemetry/src/exporters/file.ts` | `exportMetrics()` | 文件写入 |

## 改动文件

```
packages/telemetry/src/
├── types.ts                    类型定义（MetricEntry, LogEntry, SpanEntry, UsageEntry）
├── config.ts                   环境变量配置加载
├── config.test.ts              5 个测试
├── metrics.ts                  MetricsCollector（counter, histogram）
├── metrics.test.ts             5 个测试
├── logs.ts                     LogsCollector（debug/info/warn/error）
├── logs.test.ts                5 个测试
├── traces.ts                   TracesCollector（span 生命周期）
├── traces.test.ts              5 个测试
├── telemetry.ts                TelemetryManager 主类
├── telemetry.test.ts           8 个测试
├── exporters/
│   ├── console.ts              ConsoleExporter（stderr）
│   ├── console.test.ts         4 个测试
│   ├── file.ts                 FileExporter（JSONL 文件）
│   ├── file.test.ts            5 个测试
│   └── noop.ts                 NoopExporter
└── index.ts                    导出

packages/cli/
├── bin/run.ts                  新增 --no-telemetry, --telemetry-verbose flags
├── src/repl.ts                 TelemetryManager 集成
└── package.json                新增 @helm/telemetry 依赖

pnpm-workspace.yaml             新增 packages/telemetry
```

## 关键设计决策

1. **手写轻量实现** — 不引入 OTel SDK，自己实现 metrics/logs/traces 收集
2. **环境变量配置** — `HELM_*` 环境变量控制行为，兼容 12-factor app
3. **分层导出器** — console/file/noop 三种导出器，可独立配置
4. **隐私优先** — 默认不记录 prompt 和工具输出
5. **非阻塞** — telemetry 操作不阻塞 AgentLoop 执行
6. **容错** — 导出失败不影响 Helm 运行
7. **文件格式** — JSONL 按天分割，usage.jsonl 汇总会话数据
8. **向后兼容** — 不传 telemetry flags 时行为与 PR22 完全一致
