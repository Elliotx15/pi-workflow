# Warp Status

在 Warp 标签栏显示 Pi 的运行状态和加载动画，并在任务结束或需要人工操作时发送通知。

## 安装

```bash
git clone https://github.com/Elliotx15/pi-workflow.git pi-workflow
pi install ./pi-workflow/pi-extensions/warp-status
```

重新启动 Pi，或执行 `/reload` 启用，无需额外配置。本扩展使用 `@earendil-works/pi-coding-agent` 的扩展 API，已适配 Pi 1.1.0。

仅支持 macOS 下在 Warp 中直接运行 Pi TUI，需使用支持 CLI agent 状态通知的 Warp 版本，不支持 tmux／SSH。

通知内容仅包含会话名和状态；未命名时使用项目目录名。系统通知需要允许 Warp 发送通知，并遵循 Warp 的窗口焦点规则与 macOS 的通知设置。

可与 `session-auto-name` 同时使用。请勿同时启用其他终端标题动画或 Warp 状态通知扩展，以免标题冲突或重复通知。

手动取消任务也显示绿色结束徽标，通知文字为“已取消”。

## 更新记录

参见 [CHANGELOG.md](./CHANGELOG.md)。
