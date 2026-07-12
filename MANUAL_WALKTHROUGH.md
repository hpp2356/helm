# Helm 手动走查 (PR25)

## 跑命令

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install && pnpm build
pnpm test                       # 全部测试
pnpm -C packages/memory test    # 只看 memory 测试（35 个）
pnpm repl                       # 启动 REPL
```

## 场景 1：项目指令 — 创建 .helm/memory/project.md

**创建 memory 文件**：

```bash
mkdir -p .helm/memory
cat > .helm/memory/project.md << 'EOF'
---
type: instruction
project: helm
created: 2026-07-12
updated: 2026-07-12
---

## 构建命令

- `pnpm install` 安装依赖
- `pnpm test` 运行测试
- `pnpm build` 构建项目

## 编码规范

- 使用 TypeScript strict 模式
- 优先用 interface 而不是 type
- 函数返回值必须显式声明类型
EOF
```

**启动 REPL**：

```bash
pnpm repl
> /memory show
```

**预期输出**：

```
── Instructions ──
  [project] 构建命令
    - `pnpm install` 安装依赖 | - `pnpm test` 运行测试 | - `pnpm build` 构建项目
  [project] 编码规范
    - 使用 TypeScript strict 模式 | - 优先用 interface 而不是 type
```

## 场景 2：Auto Memory — agent 自动记录学习

**创建 auto memory**：

```bash
cat > .helm/memory/auto.md << 'EOF'
---
type: auto
project: helm
created: 2026-07-12
updated: 2026-07-12
---

### discovery: 2026-07-12

vitest 测试失败时，先运行 `pnpm typecheck` 检查类型错误。

### correction: 2026-07-12

用户偏好中文回复，代码注释用英文。
EOF
```

**启动 REPL**：

```bash
pnpm repl
> /memory show
```

**预期输出**：

```
── Instructions ──
  [project] 构建命令
    ...

── Auto Memory ──
  discovery: 2026-07-12
    vitest 测试失败时，先运行 `pnpm typecheck` 检查类型错误。
  correction: 2026-07-12
    用户偏好中文回复，代码注释用英文。
```

## 场景 3：Memory 规则 — 创建 rules/typescript.md

**创建规则文件**：

```bash
mkdir -p .helm/memory/rules
cat > .helm/memory/rules/typescript.md << 'EOF'
---
description: TypeScript 编码规范
globs: **/*.ts
---

- 使用 strict 模式
- 优先用 interface 而不是 type
- 函数返回值必须显式声明类型
- 使用 async/await 而不是 .then()
EOF
```

**启动 REPL**：

```bash
pnpm repl
> /memory show
```

**预期输出**（在 Rules 部分）：

```
── Rules ──
  TypeScript 编码规范  globs=[**/*.ts]
```

## 场景 4：Memory 命令 — list/show/search

**命令**：

```bash
pnpm repl
> /memory list
> /memory show
> /memory search pnpm
```

**预期输出**：

`/memory list`:
```
Memory summary:
  Instructions: 2 section(s)
  Auto memory:  2 section(s)
  Rules:        1 rule(s)
  Total lines:  25
```

`/memory search pnpm`:
```
Found 1 match(es) for "pnpm":
  /path/to/.helm/memory/project.md: - `pnpm install` 安装依赖
```

## 场景 5：跨 Session — 新 session 中看到之前的 memory

**步骤**：

1. 创建 memory 文件（如场景 1）
2. 启动 REPL：`pnpm repl`
3. 退出 REPL：`/exit`
4. 再次启动 REPL：`pnpm repl`
5. 运行 `/memory show`

**预期行为**：

- 新 session 自动加载之前的 memory
- Agent 知道之前的构建命令和编码规范
- 无需重新创建 memory 文件

## 场景 6：Memory 导出导入 — 备份和恢复

**导出**：

```bash
pnpm repl
> /memory export
```

**预期输出**：

```markdown
# Helm Memory Export

## Instructions

### 构建命令

- `pnpm install` 安装依赖
...

## Auto Memory

### discovery: 2026-07-12
...
```

**导入**（在新项目中恢复）：

```bash
# 在新项目中
mkdir -p .helm/memory
pnpm repl
> /memory import ## 构建命令\n\n- pnpm test
```

## 场景 7：Journal 输出 — 看 memory 相关事件

**命令**：

```bash
pnpm repl
> /stats
# 查看 journal 路径
# 退出后查看 journal 文件
cat /tmp/helm-repl-*.jsonl | grep memory
```

**预期 Journal 事件**：

```json
{"type":"memory:load","runId":"repl-...","source":"/path/.helm/memory/project.md","scope":"project","lines":15,"timestamp":...}
{"type":"memory:load","runId":"repl-...","source":"/path/.helm/memory/auto.md","scope":"project","lines":8,"timestamp":...}
```

## CLI Flags

| Flag | 说明 |
|------|------|
| `--no-memory` | 禁用所有 memory 加载 |
| `--no-auto-memory` | 禁用 auto memory 写入 |

## 环境变量

| 变量 | 说明 |
|------|------|
| `HOME` | 用户级 memory 目录（~/.helm/memory/） |

## 断点位置

| 文件 | 行号 | 看什么 |
|------|------|--------|
| `packages/memory/src/store.ts` | `load()` | Memory 加载逻辑 |
| `packages/memory/src/store.ts` | `getInstructionText()` | 指令文本组装 |
| `packages/memory/src/store.ts` | `writeAutoMemory()` | Auto memory 写入 |
| `packages/memory/src/rules.ts` | `matchGlob()` | Glob 匹配逻辑 |
| `packages/cli/src/repl.ts` | `const memoryStore` | MemoryStore 创建 |
| `packages/cli/src/repl.ts` | `memoryStore.load()` | Session 启动加载 |

## 改动文件

```
packages/memory/src/
├── types.ts          类型定义（MemoryEntry, MemoryRule, MemoryLoadResult 等）
├── store.ts          MemoryStore 主类（load, write, search, clear, export/import）
├── store.test.ts     20 个测试
├── rules.ts          Glob 匹配（matchGlob, matchesGlobs, filterRulesForFile）
├── rules.test.ts     9 个测试
├── auto-memory.ts    Auto memory 触发检测
├── auto-memory.test.ts  6 个测试
└── index.ts          导出

packages/skill/src/
└── builtins.ts       新增 /memory 命令（list/show/search/clear/export/import）

packages/core/src/
└── events.ts         新增 memory:load/memory:write/memory:clear 事件

packages/cli/src/
└── repl.ts           集成 MemoryStore + 加载 memory 到 system prompt

packages/cli/bin/
└── run.ts            新增 --no-memory/--no-auto-memory flags
```

## 关键设计决策

1. **Markdown 优先** — 人类可读、可编辑、可版本控制
2. **YAML frontmatter** — 元数据（type, project, globs）与内容分离
3. **三级作用域** — user/project/session，按需加载
4. **Glob 规则** — rules/*.md 按文件路径匹配加载
5. **大小限制** — 默认 25KB / 200 行，超限警告不阻止
6. **Session 启动加载** — memory 注入 system prompt，不阻塞启动
7. **Auto memory** — 可通过 --no-auto-memory 禁用
8. **向后兼容** — 不创建 memory 文件时行为与 PR24 完全一致
