# Helm 手动走查 (PR24)

## 跑命令

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install && pnpm build
pnpm test                       # 全部测试
pnpm -C packages/usage test     # 只看 usage 测试（76 个）
pnpm repl                       # 启动 REPL
```

## 场景 1：实时成本 — 看 session 中的成本变化

**命令**：

```bash
pnpm repl --provider=deepseek
> Hello, how are you?
> /usage
```

**预期行为**：

- `/usage` 显示当前 session 的 token 使用和成本
- 格式化显示 input/output tokens 和总成本

**输出示例**：

```
╭─ Session Usage ─────────────────────────────╮
│ Model:         deepseek-chat                │
│ Input tokens:           150 (cached:        0) │
│ Output tokens:                           42 │
│ Total cost:    $0.000063                    │
│ Duration:      5s                           │
╰──────────────────────────────────────────────╯

╭─ Daily Usage ───────────────────────────────╮
│ Sessions:                                  1 │
│ Total cost:  $0.0001                        │
│ Budget:      No limit                       │
╰──────────────────────────────────────────────╯
```

## 场景 2：/usage 命令 — 看 token 和成本统计

**命令**：

```bash
pnpm repl --provider=deepseek
> What is 2+2?
> What is the capital of France?
> /usage
```

**预期行为**：

- 显示累积的 token 使用量
- 显示总成本
- 显示 session 时长

## 场景 3：Budget 设置 — 设置 session 预算

**命令**：

```bash
pnpm repl --provider=deepseek --budget-session=0.01
> Hello
> /usage
```

**预期行为**：

- 设置 session 预算为 $0.01
- `/usage` 显示预算使用百分比

## 场景 4：Budget 警告 — 达到阈值时的警告

**命令**：

```bash
pnpm repl --provider=deepseek --budget-session=0.001 --budget-warning=0.5
> [发送多条消息直到接近预算]
```

**预期行为**：

- 当成本达到预算的 50% 时显示警告
- 警告格式：`Session budget warning: $X / $Y (Z%)`

## 场景 5：超预算处理 — 超出预算时的行为

**命令**：

```bash
pnpm repl --provider=deepseek --budget-session=0.0001
> [发送消息直到超预算]
```

**预期行为**：

- 超出预算时显示错误消息
- 格式：`Session budget exceeded: $X / $Y (Z%)`
- 用户可选择继续或停止

## 场景 6：自定义价格 — 修改价格表

**创建自定义价格文件**：

```bash
cat > ~/.helm/prices.json << 'EOF'
{
  "deepseek": {
    "deepseek-chat": {
      "input": 0.20,
      "cached": 0.10,
      "output": 0.40
    }
  }
}
EOF
```

**命令**：

```bash
pnpm repl --provider=deepseek
> Hello
> /usage
```

**预期行为**：

- 使用自定义价格计算成本
- 成本应高于默认价格

## 场景 7：Usage 文件 — 检查 ~/.helm/usage/

**命令**：

```bash
ls -la ~/.helm/usage/
cat ~/.helm/usage/2026-07-12.jsonl
```

**预期行为**：

- 每天一个 JSONL 文件
- 每条记录包含 session_id, tokens, cost, duration

**JSONL 格式**：

```json
{
  "session_id": "session-1234567890",
  "timestamp": "2026-07-12T10:30:00.000Z",
  "model": "deepseek-chat",
  "provider": "deepseek",
  "tokens": {
    "input_tokens": 150,
    "cached_tokens": 0,
    "output_tokens": 42,
    "reasoning_tokens": 0
  },
  "cost": {
    "input_cost": 0.000021,
    "cached_cost": 0,
    "output_cost": 0.000012,
    "reasoning_cost": 0,
    "total_cost": 0.000033
  },
  "duration_ms": 5000
}
```

## CLI Flags

| Flag | 说明 |
|------|------|
| `--budget-session=X` | Session 预算上限（USD） |
| `--budget-daily=X` | 每日预算上限（USD） |
| `--budget-monthly=X` | 每月预算上限（USD） |
| `--budget-warning=X` | 警告阈值（0-1，默认 0.8） |
| `--no-budget` | 禁用预算检查 |

## 环境变量

| 变量 | 说明 |
|------|------|
| `HELM_BUDGET_SESSION` | Session 预算上限 |
| `HELM_BUDGET_DAILY` | 每日预算上限 |
| `HELM_BUDGET_MONTHLY` | 每月预算上限 |
| `HELM_BUDGET_WARNING` | 警告阈值 |
| `HELM_PRICES_FILE` | 自定义价格文件路径 |

## 断点位置

| 文件 | 行号 | 看什么 |
|------|------|--------|
| `packages/usage/src/cost.ts` | `calculateCost()` | 成本计算逻辑 |
| `packages/usage/src/budget.ts` | `checkBudget()` | 预算检查逻辑 |
| `packages/usage/src/tracker.ts` | `recordTokens()` | Token 记录 |
| `packages/usage/src/tracker.ts` | `checkBudget()` | 预算状态检查 |
| `packages/usage/src/tracker.ts` | `formatSessionStatus()` | 格式化输出 |
| `packages/cli/src/repl.ts` | `const usageTracker` | UsageTracker 创建 |

## 改动文件

```
packages/usage/src/
├── types.ts          类型定义（TokenUsage, CostBreakdown, BudgetConfig 等）
├── cost.ts           成本计算（calculateCost, formatCost, formatTokens）
├── cost.test.ts      10 个测试
├── prices.ts         价格表（默认价格 + 自定义加载）
├── prices.test.ts    5 个测试
├── budget.ts         预算检查（checkBudget, loadBudgetConfig）
├── budget.test.ts    10 个测试
├── storage.ts        Usage 存储（JSONL 文件）
├── storage.test.ts   5 个测试
├── tracker.ts        UsageTracker 主类
├── tracker.test.ts   8 个测试
└── index.ts          导出

packages/skill/src/
└── builtins.ts       新增 /usage 命令

packages/cli/src/
└── repl.ts           集成 UsageTracker + getUsageStatus

packages/cli/bin/
└── run.ts            新增 --budget-* flags
```

## 关键设计决策

1. **按模型定价** — 不同模型不同价格，支持自定义价格表
2. **缓存折扣** — cached tokens 有折扣（默认 50%）
3. **预算分层** — session/daily/monthly 三级预算
4. **警告阈值** — 默认 80% 时警告，不阻止
5. **超预算处理** — 默认软警告，用户可选择继续
6. **Usage 存储** — JSONL 按天分割，便于分析
7. **向后兼容** — 不传 budget flags 时行为与 PR23 完全一致
