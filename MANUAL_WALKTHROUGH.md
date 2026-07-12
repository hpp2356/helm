# Helm 手动走查 (PR22)

## 跑命令

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install && pnpm build
pnpm test                        # 全部测试
pnpm -C packages/hooks test      # 只看 hooks 测试（50 个）
pnpm repl                        # 启动 REPL（需要 DEEPSEEK_API_KEY）
```

## 场景 1：Session Start Hook — 启动时加载自定义上下文

准备 hook 脚本：

```bash
mkdir -p .helm
cat > .helm/hooks.json << 'EOF'
{
  "hooks": {
    "session:start": [
      {
        "handlers": [
          {
            "type": "command",
            "command": "echo '{\"system_message\":\"Session started at $(date)\"}'",
            "timeout": 3000
          }
        ]
      }
    ]
  }
}
EOF
```

**命令**：

```bash
pnpm repl --provider=scripted
> Hello
```

**预期行为**：

- session 启动时执行 hook
- `system_message` 注入到上下文
- journal 里有 `hook:execute` 事件

**journal 输出**：

```bash
cat /tmp/helm-repl-*.jsonl | grep "hook:"
```

```json
{"type":"hook:execute","runId":"repl-xxx-t1","turnIndex":0,"hookEvent":"session:start","status":"success","durationMs":50,"timestamp":...}
```

## 场景 2：Pre-tool Hook — bash 命令安全检查

准备安全检查 hook：

```bash
cat > .helm/check-bash.sh << 'EOF'
#!/bin/sh
# Read stdin (HookInput JSON)
INPUT=$(cat)
COMMAND=$(echo "$INPUT" | grep -o '"command":"[^"]*"' | head -1 | cut -d'"' -f4)

# Block rm -rf
case "$COMMAND" in
  *"rm -rf"*)
    echo '{"decision":"deny","reason":"rm -rf is blocked by safety hook"}'
    ;;
  *)
    echo '{"decision":"allow"}'
    ;;
esac
EOF
chmod +x .helm/check-bash.sh
```

更新 hooks.json：

```json
{
  "hooks": {
    "pre:tool": [
      {
        "matcher": "bash",
        "handlers": [
          {
            "type": "command",
            "command": ".helm/check-bash.sh",
            "timeout": 5000,
            "statusMessage": "Checking bash command safety"
          }
        ]
      }
    ]
  }
}
```

**命令**：

```bash
pnpm repl --provider=deepseek --dangerously-bypass-hook-trust
> Run: echo hello       # 应该 allow
> Run: rm -rf /tmp/test # 应该 deny
```

**预期行为**：

- `echo hello` → hook allow → 正常执行
- `rm -rf /tmp/test` → hook deny → 工具不执行，显示 deny 原因

**journal 输出**：

```json
{"type":"hook:execute","hookEvent":"pre:tool","toolName":"bash","status":"success",...}
{"type":"hook:deny","hookEvent":"pre:tool","toolName":"bash","reason":"rm -rf is blocked by safety hook",...}
{"type":"tool:result","toolName":"bash","output":"Error: hook denied — rm -rf is blocked by safety hook",...}
```

## 场景 3：Post-tool Hook — 工具调用审计日志

```json
{
  "hooks": {
    "post:tool": [
      {
        "matcher": ".*",
        "handlers": [
          {
            "type": "command",
            "command": "echo '{\"system_message\":\"[AUDIT] Tool executed successfully\"}'"
          }
        ]
      }
    ]
  }
}
```

**命令**：

```bash
pnpm repl --provider=scripted --dangerously-bypass-hook-trust
> Hello
```

**预期行为**：

- 每次工具调用后执行审计 hook
- `system_message` 追加到 tool output

## 场景 4：Hook Deny — 阻止危险命令

见场景 2。核心：`decision: "deny"` 阻止工具执行，reason 显示给用户。

## 场景 5：Hook Modify — 修改工具参数

准备修改 hook：

```bash
cat > .helm/modify-bash.sh << 'EOF'
#!/bin/sh
echo '{"decision":"modify","modified_input":{"command":"echo [MODIFIED] hello"}}'
EOF
chmod +x .helm/modify-bash.sh
```

```json
{
  "hooks": {
    "pre:tool": [
      {
        "matcher": "bash",
        "handlers": [
          { "type": "command", "command": ".helm/modify-bash.sh" }
        ]
      }
    ]
  }
}
```

**命令**：

```bash
pnpm repl --provider=deepseek --dangerously-bypass-hook-trust
> Run: echo hello
```

**预期行为**：

- 原始命令 `echo hello` 被修改为 `echo [MODIFIED] hello`
- journal 记录修改后的参数

## 场景 6：信任机制 — hook 信任流程

首次运行未信任的 hook：

```bash
pnpm repl --provider=scripted
> Hello
```

**预期行为**：

- 未信任的 hook 被跳过（不执行）
- journal 里有 `hook:error` 事件，error 包含 "not trusted"
- `hadUntrusted: true` 在 aggregate result 中

信任一个 hook：

```bash
# 通过代码信任（CLI 命令未来可扩展）
# 目前通过 TrustRegistry API 信任
```

信任后再次运行 → hook 正常执行。

## 场景 7：Journal 输出 — 看 hook 相关事件

**命令**：

```bash
pnpm repl --provider=scripted --dangerously-bypass-hook-trust
> Hello
> /stats
```

**journal 输出**：

```bash
cat /tmp/helm-repl-*.jsonl | jq 'select(.type | startswith("hook:"))'
```

Hook 事件类型：

| 事件 | 说明 |
|------|------|
| `hook:execute` | hook 执行成功 |
| `hook:deny` | hook 返回 deny 决策 |
| `hook:error` | hook 执行出错（超时、脚本失败等） |

## CLI Flags

| Flag | 说明 |
|------|------|
| `--no-hooks` | 禁用所有 hook |
| `--disable-hook=pre:tool` | 禁用特定事件的 hook |
| `--dangerously-bypass-hook-trust` | 跳过信任检查（CI/CD 用） |

## IDEA 断点位置

| 文件 | 行号 | 看什么 |
|------|------|--------|
| `packages/hooks/src/executor.ts` | `spawnCommand()` | hook 脚本执行、stdin/stdout |
| `packages/hooks/src/runtime.ts` | `execute()` | 聚合决策逻辑 |
| `packages/hooks/src/trust.ts` | `isTrusted()` | 信任检查 |
| `packages/hooks/src/matcher.ts` | `matchesTool()` | tool name 正则匹配 |
| `packages/runtime/src/agent-loop.ts` | `pre:tool hook` 注释 | hook 集成点 |
| `packages/runtime/src/agent-loop.ts` | `post:tool hook` 注释 | hook 集成点 |

## 改动文件

```
packages/hooks/src/
├── types.ts                  类型定义（HookEvent, HookConfig, HookResult）
├── config.ts                 配置加载器（.helm/hooks.json，项目级 + 全局级）
├── config.test.ts            8 个测试
├── matcher.ts                tool name 正则匹配
├── matcher.test.ts           11 个测试
├── executor.ts               hook 脚本执行（spawn + JSON I/O + timeout）
├── executor.test.ts          10 个测试
├── trust.ts                  信任注册表（hash-based，持久化到 trust.json）
├── trust.test.ts             9 个测试
├── runtime.ts                HookRuntime 主类（聚合决策）
├── runtime.test.ts           12 个测试
└── index.ts                  导出

packages/core/src/
└── events.ts                 新增 hook:execute, hook:deny, hook:error 事件

packages/runtime/src/
├── agent-loop.ts             新增 HookRuntimeLike 接口 + pre:tool/post:tool hook 集成
└── index.ts                  导出 HookRuntimeLike

packages/cli/
├── bin/run.ts                新增 --no-hooks, --disable-hook, --dangerously-bypass-hook-trust flags
├── src/repl.ts               创建 HookRuntime 并传给 AgentLoop
└── package.json              新增 @helm/hooks 依赖

pnpm-workspace.yaml           新增 packages/hooks
```

## 关键设计决策

1. **HookRuntimeLike 接口** — AgentLoop 定义最小接口，避免硬依赖 @helm/hooks
2. **串行执行** — 同一事件的多个 hook 按顺序执行，保持可预测性
3. **Deny 优先** — 任何 hook 返回 deny 都阻止工具执行
4. **Modify 累积** — 最后一个 modify 的 modifiedInput 生效
5. **宽容 JSON 解析** — 非 JSON stdout 当作 system_message
6. **Trust 基于 hash** — 文件内容变化后需要重新信任
7. **默认超时 5s** — 防止 hook 脚本挂起
8. **错误不崩溃** — hook 脚本失败时默认 allow，记录错误
9. **分层配置** — 项目级覆盖全局级，同事件替换
10. **向后兼容** — 不传 hookRuntime 时行为与 PR21 完全一致
