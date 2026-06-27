# CLI TUI 全面改造 — 设计规范

**日期：** 2026-06-08  
**分支：** feat/pr16-cli-repl  
**范围：** 单个 PR — 先做终端可靠性，再做布局/主题优化

---

## 1. 目标

打造一个稳定、清晰、可恢复的终端界面，适合长时间 agent coding session。不追求花哨，追求可靠。优先级顺序：

1. 终端可靠性（resize、busy 状态、工具输出过滤、外部编辑器）
2. 布局（四层底部 chrome：状态栏 + 输入框架 + 滚动式 REPL）
3. 主题系统（语义色彩 token + 颜色能力探测）
4. 交互设计（slash 命令、快捷键集中注册）

---

## 2. 架构决策

**ADR-1：不引入 TUI 框架。** 纯 Node.js + ANSI escape，零新运行时依赖。完全可控，无框架 bug 干扰。

**ADR-2：滚动式 REPL + 固定底部 chrome。** Transcript 正常打印进 scrollback 历史，用终端滚动条查看。状态栏 + 输入框架通过 cursor save/restore（ESC 7 / ESC 8）固定在最底部。不使用 alt screen —— 保留 scrollback 历史，resize 最自然。

**ADR-3：只做 dark 主题。** 本 PR 不做 light/自动探测，只出一套 dark token。主题切换基础设施已接好，但只有一个预设。

---

## 3. 文件结构

```
packages/cli/src/
  repl.ts            ← 主 REPL 协调器（大幅精简）
  input-frame.ts     ← InputFrame（从 repl.ts 提取出来）
  status-bar.ts      ← 新：状态栏渲染 + 宽度断点
  theme.ts           ← 新：语义 token + 颜色能力探测
  transcript.ts      ← 新：各类 card 渲染函数
  sanitize.ts        ← 新：工具输出 ANSI 过滤器
  state-machine.ts   ← 新：turn 状态机
  keybindings.ts     ← 新：快捷键集中注册
  editor.ts          ← 新：外部编辑器 suspend/resume
  paste.ts           ← 不变
```

---

## 4. 主题系统

### 4.1 颜色能力探测（启动时执行一次）

探测优先级：
1. 环境变量 `NO_COLOR` → no-color（只用 bold/dim/reset）
2. `FORCE_COLOR=0` → no-color
3. `FORCE_COLOR=1` → ansi16
4. `FORCE_COLOR=2` → ansi256
5. `FORCE_COLOR=3` → truecolor
6. `COLORTERM=truecolor` 或 `COLORTERM=24bit` → truecolor
7. `$TERM` 含 `256color` 或 `COLORTERM=256` → ansi256
8. `$TERM` 有值 → ansi16
9. 兜底 → no-color

### 4.2 语义 Token 接口

```typescript
interface Theme {
  text: Painter;        // 正文
  textMuted: Painter;   // 次要文字、时间戳
  border: Painter;      // 主边框（Composer rule）
  borderMuted: Painter; // 弱边框（卡片分隔）
  accent: Painter;      // 高亮元素（spinner、caret）
  success: Painter;     // 工具成功
  warning: Painter;     // context 50-80%、警告提示
  error: Painter;       // 工具失败、错误卡片
  info: Painter;        // 系统通知
  user: Painter;        // 用户消息 bullet
  assistant: Painter;   // 助手回复 bullet（●）
  tool: Painter;        // 工具调用行
  diffAdded: Painter;   // diff + 行
  diffRemoved: Painter; // diff - 行
  diffContext: Painter; // diff 上下文行
}
type Painter = (s: string) => string;
```

所有模块的颜色都通过 `theme.X(text)` 调用，`theme.ts` 之外禁止硬编码 ANSI 码。

### 4.3 Dark 预设

| Token | Truecolor | ansi256 降级 | ansi16 降级 |
|---|---|---|---|
| text | white | 255 | default |
| textMuted | #6b7280 | 242 | dim |
| border | #f97316 | 208 | yellow |
| borderMuted | #374151 | 237 | dim |
| accent | #f97316 | 208 | yellow |
| success | #22c55e | 76 | green |
| warning | #eab308 | 178 | yellow |
| error | #ef4444 | 196 | red |
| info | #60a5fa | 75 | cyan |
| user | #a78bfa | 141 | magenta |
| assistant | #f97316 | 208 | yellow |
| tool | #6b7280 | 242 | dim |
| diffAdded | #22c55e | 76 | green |
| diffRemoved | #ef4444 | 196 | red |
| diffContext | #6b7280 | 242 | dim |

---

## 5. 布局

### 5.1 底部 Chrome（固定 4 行）

```
[scrollback — transcript cards 滚入历史]
━━━ 状态栏（1 行）━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
─── Composer 顶部规则线（1 行）────────────────
› 用户输入（readline 管这一行）
─── Composer 底部规则线（1 行）────────────────
```

每次 resize 都重绘这 4 行；其上方的 scrollback 内容不动。

### 5.2 Composer 输入框架

- 顶部规则线：提示符打开时打印一次，不再重绘（readline 只往下清除）
- 底部规则线：用 ESC 7 / cursor-down / 绘制 / ESC 8 画（不产生滚动，无 CJK 字符宽度问题）
- 两条规则线：`theme.border("─".repeat(frameWidth()))`，`frameWidth() = max(8, cols - 1)`
- 输入提示符：`theme.accent("› ")`
- Resize 时：用 `setImmediate` 合并事件，只重绘底部规则线

### 5.3 状态栏

通过 cursor 定位画在 Composer 顶部规则线上方一行。以下情况触发重绘：
- resize
- turn 状态变化
- token 用量更新（每次 turn 结束最多触发一次）

**宽度断点：**

```
≥100 列：{model} │ {mode⚠} │ ctx {pct}% │ ⚙ {tool} │ {bg}bg │ ~${cost} │ {dur}s
80–99：  {model-短} │ {mode⚠} │ {pct}% │ ⚙ {tool} │ {dur}s
60–79：  {model-短} │ {pct}% │ {dur}s
<60：    {model-缩写} │ {pct}% │ {dur}s
```

**Context 颜色阈值：**
- `<50%` → `theme.text`（正常）
- `50–80%` → `theme.warning`（黄色）
- `80–95%` → `theme.warning` 加粗
- `≥95%` → `theme.error`（红色）

**特殊状态：**
- `auto-approve` 模式 → `theme.error("⚠ auto-approve")`，醒目显示，不可忽视
- cost 无法准确计算 → 显示 `n/a`；估算值 → 显示 `~$X.XXX`
- 有后台任务 → 显示 `Nbg`（0 个时隐藏）
- 有正在执行的工具 → 显示 `⚙ tool_name`（idle 时隐藏）

---

## 6. Transcript Cards

所有 card 打印进 scrollback。格式：

```
用户消息：
  ▸ 消息内容

助手回复：
  ● 回复内容（Markdown 渲染）
  ✻ Cooked for 3s

工具调用（默认折叠）：
  ⚙ read_file  src/repl.ts  ✓ 142 lines  [120ms]

工具结果（大输出默认折叠）：
  ⚙ bash  npm test  ✗ exit 1  [2.3s]
  └ 245 lines — 输入 /expand 3 查看

错误卡片：
  ✗ Error: connection refused

Approval 提示：
  ⚠ 需要权限确认
    bash("rm -rf /tmp/foo")  [HIGH]
    Allow? [y/N]

系统通知：
  ℹ Compaction: 42 msgs → 8 msgs
```

**工具输出限制：**
- stdout/stderr 超过 200 行 → 自动折叠，显示前 5 行 + `└ 共 N 行`
- binary 输出 → 显示 `[Binary output: N KB]`
- 所有工具输出都先过 `sanitize.ts` 过滤

---

## 7. 工具输出过滤器（`sanitize.ts`）

**过滤掉（完全删除）：**
- 光标移动：`ESC[A/B/C/D/H/f/s/u`
- 清屏/擦除：`ESC[J`、`ESC[K`、`ESC[2J`
- Alt screen 切换：`ESC[?1049h/l`
- 鼠标上报：`ESC[?1000h/l`、`ESC[?1002h/l`、`ESC[?1003h/l`
- OSC 序列：`ESC]0;...BEL`（标题）、`ESC]8;...BEL`（超链接）
- Bracketed paste 开关：`ESC[?2004h/l`

**保留：**
- 纯文本
- SGR 颜色/样式：`ESC[Nm`，N 在 `{0-9, 1, 2, 3, 4, 22, 23, 24, 30-37, 39, 40-47, 49, 90-97, 100-107, 38;5;N, 38;2;R;G;B, 48;5;N, 48;2;R;G;B}` 范围内

---

## 8. Turn 状态机（`state-machine.ts`）

```
idle（空闲）
  → queued（已入队）    ← turn 运行中用户再次提交
  → sending（发送中）   ← AgentLoop.run() 被调用

sending（发送中）
  → running（运行中）   ← 收到第一个 token 或工具调用
  → failed（失败）      ← 发送错误
  → cancelled（已取消） ← Ctrl+C

running（运行中）
  → waiting_approval（等待审批） ← 工具需要确认
  → cancelling（取消中）         ← Ctrl+C
  → failed（失败）               ← 工具错误 / 循环错误
  → completed（已完成）          ← 循环正常返回

waiting_approval（等待审批）
  → running（运行中）   ← 用户批准
  → cancelling（取消中）← 用户拒绝 / Ctrl+C

cancelling（取消中）
  → idle ← abort 处理完毕

failed（失败）
  → idle ← 错误 card 渲染完毕

completed（已完成）
  → idle ← 回复 card 渲染完毕

queued（已入队）
  → sending ← 上一个 turn 到达 idle
```

**规则：**
- 状态栏只从这个状态机读取状态，不允许各自维护
- AgentLoop 任何未处理异常都必须先转为 `failed` 再 re-throw
- `failed` 和 `completed` 都在同一 event loop tick 内转为 `idle`
- 入队输入：只保留最后一条（用户重复提交时替换，不追加）

---

## 9. 外部编辑器（`editor.ts`）

执行顺序：
1. 暂停 `InputFrame`，停止状态栏定时器
2. `rl.pause()` — 停止 readline 键盘监听
3. 将当前 `rl.line` 内容写入 `$TMPDIR/helm-edit-XXXX.md`
4. flush stdout，恢复终端 cooked mode（`process.stdin.setRawMode(false)`）
5. `spawnSync(process.env.VISUAL ?? process.env.EDITOR ?? 'vi', [tmpfile], { stdio: 'inherit' })`
6. 编辑器退出后：flush stdin 缓冲区（清除残留字节）
7. 重新启用 raw mode（`process.stdin.setRawMode(true)`）
8. 读取 tmpfile 内容 → 设为 `rl.line` + `rl.cursor`
9. 调用 `rl._refreshLine()` 重绘输入行
10. 恢复 `InputFrame`，重启状态栏定时器
11. 全量重绘底部 chrome

---

## 10. 快捷键（`keybindings.ts`）

集中注册，默认绑定：

| 按键 | 行为 |
|---|---|
| `Enter` | 提交输入 |
| `Ctrl+C` | 中断当前 turn（idle 时退出）|
| `Ctrl+D` | 退出 REPL |
| `Ctrl+J` | 插入换行（多行输入）|
| `Ctrl+X Ctrl+E` | 打开外部编辑器 |
| `Tab` | slash 命令补全 |
| `↑` / `↓` | 历史导航 |
| `Esc` | 取消 pending 按键序列 |

用户自定义：`~/.helm/keybindings.json`，启动时与默认值 merge，用户可覆盖任意绑定；文件中未知的 key 忽略并给出警告。

---

## 11. Slash 命令

集中注册到一个 map（不散落在 `repl.ts`）：

| 命令 | 说明 |
|---|---|
| `/help` | 显示命令列表 |
| `/clear` | 清空对话历史 |
| `/stats` | 显示 session 统计 |
| `/mode <strategy>` | 切换权限策略 |
| `/theme dark` | 切换主题（本 PR 只有 dark）|
| `/compact` | 手动触发 compaction |
| `/tools` | 列出已注册工具 |
| `/exit` `/quit` `/q` | 退出 REPL |

Tab 补全：输入以 `/` 开头时按 Tab，行内显示匹配的命令。

---

## 12. 终端可靠性检查清单

- [ ] Resize：`setImmediate` 合并，失效 `termCols()` 缓存，重绘状态栏 + composer frame
- [ ] 无 stale 宽度：`termCols()` 每次调用都读 `process.stdout.columns`，不缓存在模块级变量
- [ ] 工具输出：全部经过 `sanitize.ts` 再显示
- [ ] Binary 检测：Buffer 含 null 字节或 >30% 不可打印字符，视为 binary
- [ ] Busy state：状态机是唯一真相来源，所有错误路径都转为 `failed`/`idle`
- [ ] Post-turn：turn 结束后 200ms 内 composer 可输入，后台 bookkeeping 异步化
- [ ] 外部编辑器：完整的 suspend/resume 序列，含 stdin flush
- [ ] Ctrl+C：中断 turn，不退出 REPL；Ctrl+D 才退出
- [ ] Ctrl+D 空输入时：干净退出，保存历史 + 关闭 journal
- [ ] SIGINT 竞态：每次 turn 结束后恢复之前的 SIGINT 监听器

---

## 13. 视觉回归测试计划

测试终端尺寸：60×20、80×24、100×30、120×40

测试用例（快照测试，`packages/cli/bin/snap.test.ts`）：
- 欢迎框在每个宽度下的渲染
- 状态栏在每个宽度断点的渲染
- Composer frame 打开/关闭
- 工具调用 card（折叠状态）
- 工具结果 card（大输出，折叠状态）
- 错误 card
- Approval 提示
- 系统通知（compaction）
- CJK 文字在 transcript 中的渲染
- Emoji 在 transcript 中的渲染
- 超长单行（换行处理）

实现方式：渲染函数接受 `cols` 参数，快照测试直接用固定宽度调用渲染函数对比输出字符串，不需要 TTY。

---

## 14. 本 PR 不做的内容

- Light 主题 / 自动主题探测
- `@file` 模糊文件引用
- `!shell` 行内 shell 命令
- 鼠标支持
- Windows VT 兼容
- 多 provider UI
- Session 恢复 UI（`/sessions`）
- `/undo` 命令
