# pi-subtask

A lightweight Pi subagent extension that runs non-blocking `/subtask` child sessions in parallel and inserts their final results back into the current session while the parent stays responsive.

[中文说明](#中文说明)

## Quick start

```bash
pi install npm:pi-subtask
```

```text
/subtask Inspect the authentication flow and report problems
```

Submit multiple `/subtask` commands to run children in parallel. The parent session stays responsive while each child works in an independent Pi session. Run `/subtask` without a prompt to list active children.

## Demo

![Manual pi-subtask demo](assets/pi-subtask-hello-world-demo-manual.gif)

## Language

Set `PI_SUBTASK_LOCALE` to `en-US` or `zh-CN`. The extension checks the process environment first, then reads `.env` from the current working directory.

```bash
cp .env.example .env
PI_SUBTASK_LOCALE=en-US pi
```

Accepted aliases: `en`, `en-US`, `zh`, and `zh-CN`. Default: `zh-CN`.

## Behavior

- Each child has an independent Pi session file and session ID.
- Children run in parallel while the parent session remains responsive.
- Results are inserted through a FIFO queue to avoid concurrent-turn races.
- Active children remain in the status widget until their processes close.
- Child Pi processes cannot nest `/subtask`.
- Waiting tasks are instructed to use foreground synchronous `bash` commands.
- Child processes inherit the current working directory, model, thinking level, and active tools.
- Child processes run with other extensions disabled for a clean runtime.

## Security

Pi extensions run with the current user's full system permissions. Review source before installing third-party packages.

## Development

```bash
npm install
npm test
npx tsc --noEmit
```

The package uses Pi's built-in `@earendil-works/pi-coding-agent` as a peer dependency.

---

## 中文说明

Pi 扩展：使用 `/subtask` 创建非阻塞子会话，并把最终结果插回当前会话。

### 为什么是手动 Context Offload？

`pi-subtask` 故意不做完整的 Subagent 编排框架。

| Surface | pi-subtask | 完整 Subagent 编排器 |
| --- | --- | --- |
| 父 Agent tool schema | **0** | 通常暴露 `subagent` tool |
| 父 Prompt 注入 | **0** 个 `before_agent_start` hook | 可能注入 delegation / agent discovery |
| 触发方式 | 显式 `/subtask <任务>` | 模型或用户触发 delegation |
| Child prompt | 英文版 5 行，约 375 字符 | 通常有角色 / workflow prompt |
| Persona / Workflow engine | 无 | 经常包含 |
| 目标 | 低开销、手动 Context Isolation | 更丰富的自动编排 |

这是刻意的取舍：由你决定哪些工作离开主 Context。它特别适合会制造大量噪声的 repo exploration、搜索、review 等独立任务，同时避免给每个父 Agent turn 永久增加 delegation tool。

多个 `/subtask` 仍然可以并行运行，完成后结果会回到父会话。

## 安装

```bash
pi install npm:pi-subtask
```

也可以临时测试：

```bash
pi -e npm:pi-subtask
```

### 使用

```text
/subtask 检查认证流程并报告问题
```

同时运行多个子任务时，重复提交多条 `/subtask`。状态栏显示运行中的任务，最多逐行显示 5 条。

```text
/subtask
```

不带参数时列出当前运行中的子任务。

### 语言

设置 `PI_SUBTASK_LOCALE` 为 `zh-CN` 或 `en-US`。扩展优先读取进程环境变量，然后读取当前工作目录中的 `.env`。

```bash
cp .env.example .env
PI_SUBTASK_LOCALE=zh-CN pi
```

支持别名：`zh`、`zh-CN`、`en`、`en-US`。默认语言：`zh-CN`。

### 行为

- 每个子任务拥有独立 Pi session 文件和 session ID；
- 子任务并行运行，父会话不等待子进程；
- 结果通过队列逐条插回父会话，避免多个完成事件竞争；
- 子任务完成前保持状态栏记录；
- 子 Pi 不允许嵌套调用 `/subtask`；
- 需要等待时，子 Pi 被要求使用前台同步 `bash` 命令完成等待；
- 扩展和子 Pi 继承当前工作目录、模型、思考级别和活动工具；
- 子 Pi 运行时禁用其他扩展，保持干净运行环境。

### 安全

Pi 扩展拥有当前用户的完整系统权限。只从可信来源安装，并在发布前审查代码。

### 开发

```bash
npm test
```

本包使用 Pi 内置的 `@earendil-works/pi-coding-agent`，不捆绑该依赖。
