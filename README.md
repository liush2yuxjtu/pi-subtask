# pi-subtask

Pi 扩展：使用 `/subtask` 创建非阻塞子会话，并把最终结果插回当前会话。

## 安装

```bash
pi install npm:pi-subtask
```

也可以临时测试：

```bash
pi -e npm:pi-subtask
```

## 使用

```text
/subtask 检查认证流程并报告问题
```

同时运行多个子任务时，重复提交多条 `/subtask`。状态栏显示运行中的任务，最多逐行显示 5 条。

```text
/subtask
```

不带参数时列出当前运行中的子任务。

## 行为

- 每个子任务拥有独立 Pi session 文件和 session ID；
- 子任务并行运行，父会话不等待子进程；
- 结果通过队列逐条插回父会话，避免多个完成事件竞争；
- 子任务完成前保持状态栏记录；
- 子 Pi 不允许嵌套调用 `/subtask`；
- 需要等待时，子 Pi 被要求使用前台同步 `bash` 命令完成等待；
- 扩展和子 Pi 继承当前工作目录、模型、思考级别和活动工具。

## 安全

Pi 扩展拥有当前用户的完整系统权限。只从可信来源安装，并在发布前审查代码。

## 开发

```bash
npm test
```

本包使用 Pi 内置的 `@earendil-works/pi-coding-agent`，不捆绑该依赖。
