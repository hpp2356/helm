# Helm 手动走查 (PR19)

## 跑命令

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install && pnpm build
pnpm test                        # 全部测试（含 skill 31 + plugin 32 + runtime 196 + CLI 80）
pnpm -C packages/skill test      # 只看 skill 测试
pnpm repl                        # 启动 REPL（需要 DEEPSEEK_API_KEY）
```

## 场景 1：/help 列出所有 skills

**命令**：

```bash
pnpm repl
> /help
```

**预期输出**：

```
Skills (11):
  /help  — List all available skills
  /tools  — List all available tools
  /clear  — Clear conversation history
  /exit  — Exit REPL
  /stats  — Show session statistics
  /plugins  — List loaded plugins
  /analyze  — Analyze current conversation   ← 如果有 user skill 文件

Ctrl-C interrupt  |  Ctrl-D exit  |  Ctrl-X Ctrl-E external editor
```

## 场景 2：/tools 列出所有 tools（包括 MCP tools）

**命令**：

```bash
pnpm repl
> /tools
```

**预期输出**：

```
Tools (7):
  • read
  • write
  • edit
  • ls
  • glob
  • bash
  • hello-plugin__say-hello    ← 如果有 plugin 提供的 tool
```

## 场景 3：创建自定义 skill 文件 → /my-skill 可用

**步骤**：

```bash
# 1. 创建 skill 目录
mkdir -p ~/.helm/skills

# 2. 创建 skill 文件
cat > ~/.helm/skills/analyze.js << 'EOF'
export default {
  name: "analyze",
  description: "Analyze current conversation",
  handler: async (input, ctx) => {
    return `Conversation has ${ctx.messages.length} messages. Input: "${input}"`;
  },
};
EOF

# 3. 启动 REPL
pnpm repl
> /analyze hello world
```

**预期输出**：

```
Conversation has 1 messages. Input: "hello world"
```

## 场景 4：Skill 调用 tool → 看 journal 里 skill:call + tool:call 事件

**步骤**：

```bash
# 创建一个调用 tool 的 skill
cat > ~/.helm/skills/read-file.js << 'EOF'
export default {
  name: "read-file",
  description: "Read a file using the read tool",
  handler: async (input, ctx) => {
    const readTool = ctx.tools.get("read");
    if (!readTool) return "No read tool available";
    const result = await readTool.execute({ path: input });
    return result;
  },
};
EOF

pnpm repl
> /read-file /tmp/test.txt
```

**查看 journal**：

```bash
cat /tmp/helm-repl-*.jsonl | grep -E "skill:call|tool:call"
```

**预期 journal 输出**：

```json
{"type":"skill:call","runId":"repl-xxx","skillName":"read-file","input":"/tmp/test.txt","timestamp":1234567890}
{"type":"tool:call","runId":"repl-xxx","turnIndex":0,"toolName":"read","args":{"path":"/tmp/test.txt"},"timestamp":1234567890}
```

## 场景 5：Plugin 提供的 skill → 自动出现在 /help 里

**步骤**：

```bash
# 确保有 plugin 提供了 skill（参考 PR18 walkthrough）
# 在 plugin.json 里声明 skill，在 index.js 里实现 handler

pnpm repl
> /help
```

**预期**：plugin 声明的 skill（如 `/greet`）会出现在 `/help` 列表里。

## 场景 6：/clear + /exit 从 PR16 迁移为 skills

**命令**：

```bash
pnpm repl

# /clear 清空对话历史
> hello
> /clear
# 输出: Conversation history cleared. (1 messages removed)

# /exit 退出 REPL
> /exit
# 输出: Goodbye.
```

**注意**：`/quit` 和 `/q` 是 `/exit` 的别名，同样可用。

## pnpm repl 启动过程（含 Skill 加载）

**命令**：`node packages/cli/dist/bin/run.js repl --provider=deepseek`

**入口**：`packages/cli/bin/run.ts → main()`

| 顺序 | 文件 | 做什么 |
|------|------|--------|
| 1 | `run.ts:286` `main()` | 解析 `process.argv`，发现是 `repl` 子命令 |
| 2 | `run.ts:299` | `import("../src/repl.js")` 动态加载 REPL 模块 |
| 3 | `run.ts:300` | `loadSettings()` 读 `.helm/settings.json` |
| 4 | `run.ts:318` | `parseReplArgs()` 解析 `--provider`、`--mcp-server` 等 flag |
| 5 | `run.ts:323-353` | 创建 Provider |
| 6 | `run.ts:355` | 调 `startRepl(config)` → 进入 `packages/cli/src/repl.ts` |

**repl.ts `startRepl()` 初始化**：

| 顺序 | 行号 | 做什么 |
|------|------|--------|
| 7 | `repl.ts:290-293` | 创建 `JsonlJournal` |
| 8 | `repl.ts:299` | `new PermissionRuntime()` |
| 9 | `repl.ts:316` | `new ToolRuntime(permissionRuntime)` |
| 10 | `repl.ts:329` | `registerFileTools()` |
| 11 | `repl.ts:336-357` | MCP server 连接 |
| 12 | `repl.ts:373-386` | Plugin 加载 |
| 13 | `repl.ts:393-435` | **`new SkillRegistry()` — 注册内置 skills、plugin skills、user skills** |
| 14 | `repl.ts:567-577` | 构造 system prompt |
| 15 | `repl.ts:582-630` | 渲染欢迎框 |
| 16 | `repl.ts:632-650` | 创建 `AgentLoop` |
| 17 | `repl.ts:743+` | 创建 `readline` 接口 → **等待输入** |

## Skill 执行流程

```
用户输入 "/analyze hello"
  │
  ├─ repl.ts processInput()
  │     ├─ trimmed.startsWith("/") → true
  │     ├─ parseSkillInput("/analyze hello") → { name: "analyze", input: "hello" }
  │     ├─ skillRegistry.execute("analyze", "hello", ctx)
  │     │     ├─ emit skill:call event → journal
  │     │     ├─ skill.handler("hello", ctx)
  │     │     │     └─ 可以调用 ctx.tools.get("read").execute(...)
  │     │     └─ return result text
  │     └─ console.log(result)
  │
  └─ 终端显示结果
```

## IDEA 断点位置

| 文件 | 行号 | 看什么 |
|------|------|--------|
| `packages/skill/src/registry.ts` | `execute()` 方法 | skill name、input、handler 返回值 |
| `packages/runtime/src/agent-loop.ts` | **268** | `messages`、`this.toolRuntime.list()` |
| `packages/provider-deepseek/src/openai-compatible-provider.ts` | **282** | 发给 LLM 的最终 JSON |

## 改动文件

```
packages/skill/src/              (new)
├── types.ts                     Skill, SkillContext, parseSkillInput, SkillError
├── registry.ts                  SkillRegistry — 注册、查找、执行 skills
├── builtins.ts                  createBuiltinSkills — /help, /tools, /clear, /exit, /stats, /plugins
├── loader.ts                    loadUserSkills — 从 ~/.helm/skills/ 加载 .ts/.js 文件
├── index.ts                     统一导出
├── types.test.ts                parseSkillInput 测试
├── registry.test.ts             SkillRegistry 测试
├── builtins.test.ts             内置 skills 测试
└── loader.test.ts               user skill 加载测试

packages/core/src/events.ts      新增 skill:call / skill:error 事件类型
packages/plugin/src/loader.ts    新增 skipDefaultDirs 选项（修复测试隔离问题）
packages/cli/src/repl.ts         集成 SkillRegistry，替换硬编码 switch
packages/cli/package.json        新增 @helm/skill 依赖
packages/cli/tsconfig.json       新增 skill 引用
```

## 关键设计决策

1. **`@helm/skill` 独立包**，不污染 runtime
2. **SkillRegistry** — 注册、查找、执行 skills，first wins 兼容
3. **内置 skills** — `/help`, `/tools`, `/clear`, `/exit`, `/stats`, `/plugins` 从硬编码迁移到 skill 系统
4. **Plugin skills** — 从 plugin module 的 `skills` 字段自动注册
5. **User skill files** — `~/.helm/skills/*.ts|*.js`，ESM default export
6. **SkillContext 隔离** — skill 通过 `ctx.tools` 调 tools，不能直接访问 AgentLoop
7. **graceful error** — handler 抛异常 → emit skill:error，显示错误，不 crash
8. **动态命令列表** — COMMANDS 数组从 skillRegistry.list() 动态构建，Tab 补全自动生效
