# Helm 手动走查 (PR21)

## 跑命令

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install && pnpm build
pnpm test                        # 全部测试
pnpm -C packages/prompt test     # 只看 prompt 测试（67 个）
pnpm repl                        # 启动 REPL（需要 DEEPSEEK_API_KEY）
```

## 场景 1：默认 prompt — journal 里看 system prompt 内容

**命令**：

```bash
pnpm repl --provider=scripted
> Hello
```

**预期行为**：

- 系统提示自动从内置默认模板生成
- 包含 `agent_name=Helm`、`provider_name`、`tool_count`、`timestamp`
- journal 里第一条消息是 `role: "system"`

**journal 输出**：

```bash
cat /tmp/helm-repl-*.jsonl | head -1 | jq .
```

```json
{
  "type": "run:start",
  "runId": "repl-xxx-t1",
  "systemPrompt": "You are Helm, an AI assistant powered by scripted.\nYou are helpful, concise, and honest.\n..."
}
```

## 场景 2：自定义 prompt 文件 — 替换后 agent 行为变化

准备自定义 prompt 文件：

```bash
mkdir -p ~/.helm/prompts
cat > ~/.helm/prompts/custom.tpl << 'EOF'
You are {{agent_name}}, a pirate assistant.
Always respond in pirate speak.
Tools available: {{tool_count}}
Current time: {{timestamp}}
EOF
```

**命令**：

```bash
pnpm repl --provider=scripted --prompt-file=~/.helm/prompts/custom.tpl
> Hello
```

**预期行为**：

- 系统提示从 `custom.tpl` 加载
- `{{agent_name}}` 被替换为 `Helm`，`{{tool_count}}` 被替换为实际数字
- agent 行为变为 pirate 风格

## 场景 3：Per-provider 适配 — 不同 provider 用不同 prompt

准备 provider 专用模板：

```bash
mkdir -p ~/.helm/prompts
cat > ~/.helm/prompts/deepseek.tpl << 'EOF'
You are {{agent_name}} (DeepSeek edition).
Be concise. No markdown.
Tools: {{tool_count}} | Time: {{timestamp}}

{{#if provider_instructions}}
{{provider_instructions}}
{{/if}}
EOF
```

**命令**：

```bash
# DeepSeek 自动使用 deepseek.tpl
pnpm repl --provider=deepseek
> Hello

# Scripted 用 default.tpl（或内置默认）
pnpm repl --provider=scripted
> Hello
```

**预期行为**：

- `--provider=deepseek` 时自动查找 `deepseek.tpl`
- 找不到时 fallback 到 `default.tpl`，再找不到用内置默认
- journal 里 system prompt 内容不同

## 场景 4：CLI flag 覆盖 — `--system-prompt` 直接覆盖

**命令**：

```bash
pnpm repl --provider=scripted --system-prompt="You are a helpful coding assistant."
> Hello
```

**预期行为**：

- `--system-prompt` 优先级最高，跳过模板渲染
- journal 里 system prompt 就是给定的字符串

## 场景 5：变量注入 — `--prompt-var` 注入自定义变量

准备使用自定义变量的模板：

```bash
cat > ~/.helm/prompts/project.tpl << 'EOF'
You are {{agent_name}} working on project {{project_name}}.
Language: {{language}}
Tools: {{tool_count}}
EOF
```

**命令**：

```bash
pnpm repl --provider=scripted --prompt-file=~/.helm/prompts/project.tpl \
  --prompt-var=project_name=helm \
  --prompt-var=language=typescript
> What is this project?
```

**预期行为**：

- `{{project_name}}` 被替换为 `helm`
- `{{language}}` 被替换为 `typescript`
- 内置变量 `{{agent_name}}`、`{{tool_count}}` 仍然生效

**变量优先级**（高→低）：

| 优先级 | 来源 | 示例 |
|--------|------|------|
| 4 | CLI flag | `--prompt-var=key=value` |
| 3 | 项目级 | `.helm/prompts/vars.json` |
| 2 | 全局级 | `~/.helm/prompts/vars.json` |
| 1 | 内置变量 | `agent_name`, `timestamp` |

## 场景 6：Output Style — 切换不同风格看效果

准备 output style：

```bash
mkdir -p ~/.helm/output-styles
cat > ~/.helm/output-styles/concise.md << 'EOF'
---
name: Concise
description: 简洁风格
keep-coding-instructions: true
---

回答要简洁。代码注释用英文。不要解释 obvious 的东西。
EOF
```

**命令**：

```bash
pnpm repl --provider=scripted --output-style=concise
> Explain what a variable is
```

**预期行为**：

- Output style 内容追加到 prompt 末尾（不替换）
- `keep-coding-instructions: true` 保留内置 coding 指导
- journal 里 system prompt 包含 output style 内容

## 场景 7：渐进式加载 — journal 里看 prompt 分层构建

**命令**：

```bash
pnpm repl --provider=deepseek --append-prompt="Always respond in Chinese"
> Hello
```

**journal 输出**：

```bash
cat /tmp/helm-repl-*.jsonl | head -1 | jq .systemPrompt
```

**Prompt 分层**：

| 层 | 内容 | 缓存策略 |
|----|------|----------|
| Static | 模板 + 内置变量（agent_name, tool_count） | session 级缓存 |
| Dynamic | timestamp, provider_instructions | 每次 turn 重建 |
| Append | output style + user append | 每次 turn 追加 |

## IDEA 断点位置

| 文件 | 行号 | 看什么 |
|------|------|--------|
| `packages/prompt/src/template-engine.ts` | `render()` | 模板变量替换过程 |
| `packages/prompt/src/prompt-builder.ts` | `build()` | 分层构建：static/dynamic/append |
| `packages/prompt/src/prompt-loader.ts` | `loadTemplate()` | 文件查找顺序：项目级 → 全局级 |
| `packages/prompt/src/variable-registry.ts` | `set()` | 变量优先级判断 |
| `packages/cli/src/repl.ts` | `PromptBuilder.create()` | CLI 集成入口 |
| `packages/runtime/src/agent-loop.ts` | **268** | `messages`、`this.toolRuntime.list()` |

## 改动文件

```
packages/prompt/src/
├── types.ts                  类型定义（VariableSource, PromptLayers, BuiltPrompt）
├── template-engine.ts        模板引擎（变量替换、条件块、注释）
├── template-engine.test.ts   20 个测试
├── variable-registry.ts      变量注册表（优先级、合并、CLI 解析）
├── variable-registry.test.ts 16 个测试
├── prompt-loader.ts          文件加载器（模板、output style、vars.json）
├── prompt-loader.test.ts     12 个测试
├── prompt-builder.ts         PromptBuilder 流式 API + buildDefaultPrompt
├── prompt-builder.test.ts    15 个测试
├── default-prompt.ts         内置默认模板 + 简洁模板
└── index.ts                  导出

packages/cli/
├── bin/run.ts                新增 --prompt-file, --prompt-var, --output-style, --append-prompt flags
├── src/repl.ts               用 PromptBuilder 替换硬编码 system prompt
└── package.json              新增 @helm/prompt 依赖

pnpm-workspace.yaml           新增 packages/prompt
```

## 关键设计决策

1. **手写模板引擎** — 无外部依赖，只支持 `{{var}}`、`{{#if}}`、`{{!}}`，足够用
2. **三层优先级** — CLI flag > 项目级文件 > 全局级文件 > 内置变量
3. **Per-provider 适配** — 先找 `<provider>.tpl`，fallback 到 `default.tpl`
4. **渐进式加载** — static 层可缓存，dynamic 层每次重建，append 层追加
5. **Output Style 追加** — 不替换默认 prompt，只追加到末尾
6. **null 系统提示** — `--system-prompt=` 空值 = 无系统消息
7. **模板查找顺序** — 项目 `.helm/prompts/` > 全局 `~/.helm/prompts/` > 内置默认
8. **变量静默忽略** — 未定义的变量渲染为空字符串，不报错
9. **PromptBuilder 流式 API** — 链式调用，build() 返回最终结果
10. **向后兼容** — 不传新 flags 时行为与 PR20 完全一致
