# Helm 手动走查 (PR18)

## 跑命令

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install && pnpm build
pnpm test                        # 全部测试（含 plugin 32 + runtime 196 + CLI 80）
pnpm -C packages/plugin test     # 只看 plugin 测试
pnpm repl                        # 启动 REPL（需要 DEEPSEEK_API_KEY）
```

## 场景 1：创建一个简单 plugin → 放到 plugin 目录 → 启动 Helm → tool 可用

**步骤**：

```bash
# 1. 创建 plugin 目录
mkdir -p ~/.helm/plugins/hello-plugin

# 2. 创建 manifest
cat > ~/.helm/plugins/hello-plugin/plugin.json << 'EOF'
{
  "name": "hello-plugin",
  "version": "1.0.0",
  "description": "A simple hello world plugin",
  "main": "index.js",
  "tools": [
    {
      "name": "say-hello",
      "description": "Says hello to someone",
      "parameters": {
        "type": "object",
        "properties": { "name": { "type": "string" } },
        "required": ["name"]
      },
      "riskLevel": "LOW"
    }
  ]
}
EOF

# 3. 创建入口文件
cat > ~/.helm/plugins/hello-plugin/index.js << 'EOF'
export default {
  tools: [{
    name: "say-hello",
    async execute(args) {
      return `Hello, ${args.name}!`;
    },
  }],
  async init(config) {},
  async destroy() {},
};
EOF

# 4. 启动 REPL
pnpm repl

# 5. 在 REPL 里输入：
> 请用 hello-plugin 的 say-hello 工具说 hello 给 Helm
```

**预期输出**：REPL 启动时显示 `Plugin "hello-plugin" v1.0.0 loaded (1 tools)`。

## 场景 2：Plugin manifest 解析 → journal 里看 plugin:load 事件

**命令**：

```bash
# 启动 REPL
pnpm repl

# REPL 启动后，journal 文件会显示在底部，例如：
# Journal → /tmp/helm-repl-1234567890.jsonl

# 查看 journal
cat /tmp/helm-repl-*.jsonl | grep "plugin:load"
```

**预期 journal 输出**：

```json
{"type":"plugin:load","runId":"repl-xxx","pluginName":"hello-plugin","pluginVersion":"1.0.0","toolCount":1,"timestamp":1234567890}
```

## 场景 3：Plugin 加载失败 → skip，agent 正常启动

**步骤**：

```bash
# 1. 创建一个无效 plugin
mkdir -p ~/.helm/plugins/bad-plugin
cat > ~/.helm/plugins/bad-plugin/plugin.json << 'EOF'
{
  "name": "INVALID NAME!",
  "version": "1.0.0"
}
EOF

# 2. 启动 REPL
pnpm repl
```

**预期输出**：REPL 显示 `Plugin "INVALID NAME!" error: invalid plugin name "INVALID NAME!": must be lowercase alphanumeric with hyphens`，但 Helm 正常启动。

**journal 输出**：

```json
{"type":"plugin:error","runId":"repl-xxx","pluginName":"INVALID NAME!","message":"[plugin:...] invalid plugin name...","timestamp":1234567890}
```

## 场景 4：`helm plugin add` 从 npm 安装 plugin

**命令**：

```bash
# 假设有一个 npm 包 @example/helm-plugin
helm plugin add @example/helm-plugin
```

**预期输出**：

```
Installing plugin from npm: @example/helm-plugin...
Plugin "example-plugin" v1.0.0 installed to ~/.helm/plugins/node_modules/@example/helm-plugin
```

**注意**：`helm plugin add` 运行 `npm install --prefix ~/.helm/plugins <pkg>`，安装到 `~/.helm/plugins/node_modules/`。

## 场景 5：Plugin 的 tool 在 REPL 里可用

**步骤**：

```bash
# 确保 hello-plugin 已安装（场景 1）
pnpm repl

# 在 REPL 里：
> /tools
# 输出应包含：hello-plugin__say-hello

> 请用 hello-plugin__say-hello 工具，name 参数设为 "World"
```

**预期**：LLM 调用 `hello-plugin__say-hello` 工具，返回 `Hello, World!`。

## pnpm repl 启动过程（含 Plugin 加载）

**命令**：`node packages/cli/dist/bin/run.js repl --provider=deepseek`

**入口**：`packages/cli/bin/run.ts → main()`

| 顺序 | 文件 | 做什么 |
|------|------|--------|
| 1 | `run.ts:286` `main()` | 解析 `process.argv`，发现是 `repl` 子命令 |
| 2 | `run.ts:299` | `import("../src/repl.js")` 动态加载 REPL 模块 |
| 3 | `run.ts:300` | `loadSettings()` 读 `.helm/settings.json` |
| 4 | `run.ts:318` | `parseReplArgs()` 解析 `--provider`、`--mcp-server` 等 flag |
| 5 | `run.ts:323-353` | 创建 Provider：读 `DEEPSEEK_API_KEY` 环境变量 → `new OpenAICompatibleProvider()` |
| 6 | `run.ts:355` | 调 `startRepl(config)` → 进入 `packages/cli/src/repl.ts` |

**repl.ts `startRepl()` 初始化**：

| 顺序 | 行号 | 做什么 |
|------|------|--------|
| 7 | `repl.ts:290-293` | 创建 `JsonlJournal`（写 `/tmp/helm-repl-xxx.jsonl`） |
| 8 | `repl.ts:299` | `new PermissionRuntime()` |
| 9 | `repl.ts:316` | `new ToolRuntime(permissionRuntime)` |
| 10 | `repl.ts:329` | `registerFileTools()` — 注册 read/write/edit/ls/glob/bash 工具 |
| 11 | `repl.ts:336-357` | `new McpRegistry()` — 如果传了 `--mcp-server`，`connect()` 连 MCP server，`tools()` 注册到 ToolRuntime |
| 12 | `repl.ts:373-386` | **`new PluginLoader()` — 扫描 `~/.helm/plugins/` + `.helm/plugins/`，加载所有 plugin，注册 tools 到 ToolRuntime** |
| 13 | `repl.ts:567-577` | 构造 system prompt |
| 14 | `repl.ts:579` | `messageHistory = [systemMessage]` |
| 15 | `repl.ts:582-630` | 渲染欢迎框 |
| 16 | `repl.ts:632-650` | 创建 `AgentLoop({ provider, toolRuntime, journal })` |
| 17 | `repl.ts:470-480` | 创建 `readline` 接口，注册 `"line"` 回调 → **等待输入** |

## Plugin 加载流程

```
PluginLoader.loadAll()
  │
  ├─ 扫描目录：
  │   ├─ .helm/plugins/         （项目级，优先级高）
  │   └─ ~/.helm/plugins/       （全局级）
  │
  ├─ 对每个子目录：
  │   ├─ readManifest(dir)      读 plugin.json
  │   │   ├─ 校验 name/version 必填
  │   │   ├─ 校验 name 格式（小写+连字符）
  │   │   └─ 校验 tools/skills/prompts/config 数组格式
  │   │
  │   ├─ import(entryPath)      动态导入入口文件
  │   │   └─ 失败 → emit plugin:error，skip
  │   │
  │   ├─ module.init(config)    调用初始化钩子
  │   │   └─ 失败 → emit plugin:error，skip
  │   │
  │   └─ buildTools()           构建 Tool 对象
  │       ├─ manifest 声明 + module 实现 → 完整 tool
  │       └─ manifest 声明但无实现 → stub tool（返回 "no implementation"）
  │
  └─ emit plugin:load           journal 记录加载成功
```

## IDEA 断点位置

右上角选 `Helm REPL` → Debug。这两个断点：

| 文件 | 行号 | 看什么 |
|------|------|--------|
| `packages/runtime/src/agent-loop.ts` | **268** | `messages`（对话历史）、`this.toolRuntime.list()`（所有工具，含 plugin tools） |
| `packages/provider-deepseek/src/openai-compatible-provider.ts` | **282** | `openaiMessages` + `openaiTools`，发给 LLM 的最终 JSON |

Alt+F8 → `JSON.stringify(openaiMessages, null, 2)` 复制完整 prompt。

## 改动文件

```
packages/plugin/src/
├── types.ts           PluginManifest, LoadedPlugin, PluginModule, PluginError
├── manifest.ts        readManifest(), validateManifest()
├── loader.ts          PluginLoader — 扫描目录、加载、注册 tools
├── installer.ts       installPlugin() — npm install 到 plugin 目录
├── index.ts           统一导出
├── manifest.test.ts   manifest 解析测试
└── loader.test.ts     loader 集成测试

packages/core/src/
└── events.ts          新增 plugin:load / plugin:error 事件类型

packages/cli/
├── bin/run.ts         新增 `helm plugin add <npm-package>` 子命令
└── src/repl.ts        集成 PluginLoader（373-386 行）
```

## 关键设计决策

1. **`@helm/plugin` 独立包**，不污染 runtime
2. **plugin.json manifest**，JSON 格式（和 settings.json 一致）
3. **ESM default export**，plugin 入口文件导出 `{ tools, skills, init, destroy }`
4. **namespace 前缀** `pluginName__toolName` 避免冲突（双下划线，和 MCP 的单下划线区分）
5. **graceful skip**：manifest 无效或 init 失败 → emit plugin:error，不影响其他 plugin
6. **first wins**：同名 plugin 只加载第一个（项目级优先于全局级）
7. **plugin 配置**：环境变量 `HELM_PLUGIN_<NAME>_<KEY>` + manifest 默认值
