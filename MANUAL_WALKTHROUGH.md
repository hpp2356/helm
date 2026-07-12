# Helm 手动走查 (PR26)

## 跑命令

```bash
cd ~/projects-ai/helm/helm-dev
pnpm install && pnpm build
pnpm test                            # 全部测试
pnpm -C packages/checkpoint test     # 只看 checkpoint 测试（64 个）
pnpm repl                            # 启动 REPL
```

## 场景 1：自动创建 — 文件编辑后看 checkpoint

**启动 REPL，让 agent 编辑文件**：

```bash
pnpm repl
> create a file called hello.txt with content "hello world"
```

**预期输出**：

```
Checkpoint cp-002 (file_edit)
● Created hello.txt
  ✶ Done.
```

**查看 checkpoint 列表**：

```
> /checkpoint list
```

**预期输出**：

```
Checkpoints (2):
  cp-001 [session_start] Session start 14:30:00 (0 files)
  cp-002 [file_edit] /path/to/hello.txt 14:30:15 (1 files)
```

## 场景 2：Rewind 菜单 — /rewind 查看 checkpoint 列表

**创建几个 checkpoint 后查看**：

```bash
pnpm repl
> create file a.txt with "version 1"
> edit a.txt to say "version 2"
> /rewind
```

**预期输出**：

```
╭─ Rewind ─────────────────────────────────────────╮
│ > cp-003     /path/to/a.txt                       14:30:30 │
│   cp-002     /path/to/a.txt                       14:30:25 │
│   cp-001     Session start                         14:30:00 │
╰──────────────────────────────────────────────────────────────╯

Select action:
  1. Restore code and conversation
  2. Restore conversation only
  3. Restore code only
  4. Summarize from here
  5. Summarize up to here
  6. Cancel

Usage: /rewind <checkpoint-id> <1-6>
```

## 场景 3：Restore code — 恢复文件到之前状态

```bash
pnpm repl
> create file test.txt with "original content"
# agent creates the file
> /checkpoint list
# 看到 cp-002 是 file_edit checkpoint
> /checkpoint restore cp-002 code
```

**预期输出**：

```
Restored 1 files to cp-002
```

**验证**：

```bash
cat test.txt
# 应显示 "original content"
```

## 场景 4：Restore conversation — 恢复对话到之前位置

```bash
pnpm repl
> what is 2+2?
# agent responds
> /checkpoint restore cp-002 conversation
```

**预期行为**：

- 对话历史恢复到 cp-002 对应的位置
- 文件内容不变
- 下次 agent 回答时从该位置继续

## 场景 5：Summarize — 压缩对话历史

```bash
pnpm repl
> explain TypeScript generics
> explain TypeScript decorators
> explain TypeScript modules
> /checkpoint list
# 找到要 summarize 的 checkpoint
> /checkpoint restore cp-003 summarize_from
```

**预期行为**：

- cp-003 之后的消息被压缩为摘要
- 释放 context 空间
- 原始消息保留在 transcript 中

## 场景 6：Git checkpoint — 自动 stash/commit

```bash
pnpm repl --git-checkpoint
> refactor the main function
```

**预期行为**：

- 编辑前自动 `git stash push -m "helm-checkpoint: ..."`
- 编辑后自动 `git commit -m "helm-checkpoint: ..."`
- 可通过 `git stash list` 和 `git log` 查看

## 场景 7：Journal 输出 — 看 checkpoint 相关事件

**命令**：

```bash
pnpm repl
> create a file demo.txt
> /stats
# 查看 journal 路径
# 退出后查看 journal 文件
cat /tmp/helm-repl-*.jsonl | grep checkpoint
```

**预期 Journal 事件**：

```json
{"type":"checkpoint:create","runId":"repl-...","checkpointId":"cp-001","checkpointType":"session_start","files":[],"conversationIndex":0,"timestamp":...}
{"type":"checkpoint:create","runId":"repl-...","checkpointId":"cp-002","checkpointType":"file_edit","files":["/path/to/demo.txt"],"conversationIndex":2,"timestamp":...}
{"type":"checkpoint:create","runId":"repl-...","checkpointId":"cp-003","checkpointType":"prompt","files":[],"conversationIndex":3,"timestamp":...}
```

## CLI Flags

| Flag | 说明 |
|------|------|
| `--no-checkpoint` | 禁用 checkpoint 自动创建 |
| `--checkpoint-retention=N` | checkpoint 保留天数（默认 30） |
| `--checkpoint-dir=PATH` | 自定义 checkpoint 目录（默认 ~/.helm/checkpoints） |
| `--git-checkpoint` | 启用 git stash/commit checkpoint |

## Slash 命令

| 命令 | 说明 |
|------|------|
| `/checkpoint list` | 列出当前 session 的所有 checkpoint |
| `/checkpoint restore <id> [action]` | 恢复到指定 checkpoint |
| `/checkpoint clean` | 清理过期 checkpoint |
| `/rewind` | 显示 rewind 菜单 |

## Restore 操作

| 操作 | 代码 | 对话 | 用途 |
|------|------|------|------|
| `code+conversation` | ✅ 恢复 | ✅ 恢复 | 完全回退 |
| `conversation` | ❌ 保持 | ✅ 恢复 | 重试不同代码 |
| `code` | ✅ 恢复 | ❌ 保持 | 保留对话，撤销代码 |
| `summarize_from` | ❌ 保持 | ✅ 压缩后续 | 释放 context |
| `summarize_up_to` | ❌ 保持 | ✅ 压缩之前 | 保留近期细节 |

## 断点位置

| 文件 | 行号 | 看什么 |
|------|------|--------|
| `packages/checkpoint/src/store.ts` | `save()` | checkpoint 持久化 |
| `packages/checkpoint/src/store.ts` | `load()` | checkpoint 加载 |
| `packages/checkpoint/src/store.ts` | `clean()` | 过期清理逻辑 |
| `packages/checkpoint/src/manager.ts` | `createFromFileEdit()` | 文件编辑 checkpoint |
| `packages/checkpoint/src/manager.ts` | `restore()` | 恢复逻辑 |
| `packages/cli/src/repl.ts` | `const checkpointMgr` | CheckpointManager 创建 |
| `packages/cli/src/repl.ts` | `case "tool:call"` | pre-edit 快照 |
| `packages/cli/src/repl.ts` | `case "tool:result"` | post-edit checkpoint 创建 |
| `packages/cli/src/repl.ts` | `case "/rewind"` | rewind 菜单 |

## 改动文件

```
packages/checkpoint/src/
├── types.ts           类型定义（Checkpoint, FileSnapshot, RestoreAction 等）
├── store.ts           CheckpointStore 持久化（save/load/list/delete/clean）
├── store.test.ts      12 个测试
├── manager.ts         CheckpointManager 高层 API（create/restore/git checkpoint）
├── manager.test.ts    16 个测试
└── index.ts           导出

packages/core/src/
└── events.ts          新增 checkpoint:create/checkpoint:restore/checkpoint:summarize/checkpoint:clean 事件

packages/cli/src/
└── repl.ts            集成 CheckpointManager + /rewind + /checkpoint 命令

packages/cli/bin/
└── run.ts             新增 --no-checkpoint/--checkpoint-retention/--checkpoint-dir/--git-checkpoint flags
```

## 关键设计决策

1. **自动跟踪** — 文件编辑（write/edit）自动创建 checkpoint，无需手动操作
2. **JSON 存储** — 每个 checkpoint 一个 JSON 文件，人类可读、可调试
3. **索引文件** — `index.json` 记录所有 checkpoint 元数据，快速列表
4. **文件快照** — 全量存储文件内容，简单可靠
5. **大小限制** — 默认 1MB 以上文件不快照，防止磁盘爆满
6. **Git 集成** — `--git-checkpoint` 启用 stash/commit 自动化
7. **向后兼容** — `--no-checkpoint` 禁用时行为与 PR25 完全一致
8. **非阻塞** — checkpoint 创建不阻塞文件编辑操作
