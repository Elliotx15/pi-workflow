# Warp Status

在 Warp 标签栏显示 Pi 的运行状态和加载动画，并在任务结束或需要人工操作时发送通知。

## 安装

```bash
git clone https://github.com/Elliotx15/pi-workflow.git pi-workflow
pi install ./pi-workflow/pi-extensions/warp-status
```

重新启动 Pi，或执行 `/reload` 启用，无需额外配置。本扩展使用 `@earendil-works/pi-coding-agent` 的扩展 API，已适配 Pi 1.2.0。

仅支持 macOS 下在 Warp 中直接运行 Pi TUI，需使用支持 CLI agent 状态通知的 Warp 版本，不支持 tmux／SSH。

通知内容仅包含会话名和状态；未命名时使用项目目录名。系统通知需要允许 Warp 发送通知，并遵循 Warp 的窗口焦点规则与 macOS 的通知设置。

可与 `session-auto-name` 同时使用。请勿同时启用其他终端标题动画或 Warp 状态通知扩展，以免标题冲突或重复通知。

手动取消任务也显示绿色结束徽标，通知文字为“已取消”。如果异步子任务仍在运行，则继续显示加载动画，直到主 agent 和子任务都结束。

## 与 pi-subagents 配合

`pi-subagents` 是可选扩展，无需为 Warp Status 安装它，也不需要额外配置：

- **未安装或版本不支持接口**：主 agent 的加载动画、心跳和通知保持原有行为，不启动周期性子任务查询。
- **已安装兼容版本**：当前会话有活跃子任务时，即使主 agent 已空闲，仍保持加载动画和 Warp working 心跳。多个任务中只结束一部分不会发送整体结束通知。
- **子任务唤醒主 agent**：子任务归零后保留约 1.5 秒交接窗口并再次确认状态，避免默认完成通知批处理期间动画闪断；主 agent 仍在工作时不会结束。若自定义了更长的唤醒延迟，可能仍会出现两段独立的活动。
- **需要用户操作**：继续显示等待操作状态并暂停动画；子任务事件本身不会被当作需要用户操作。
- **恢复与清理**：`/reload`、恢复会话时重新查询当前会话的活跃任务；退出或切换会话时清理订阅、查询和定时器。

兼容层仅通过 `pi.events` 使用 pi-subagents 公开的 v1 RPC，需要 `fleetStatus.version = 1` 和 `statusProjection.version = 1`（`untargeted = "in-memory-when-ready"`）。不导入 pi-subagents 包、不调用执行工具，也不扫描任务目录。任务数量取自 `status` 返回的 `fleet.totalActive`，而不是对启动、完成事件做加减计数；通常每 2 秒刷新，相关事件和主 agent 结束时会提前刷新。

单次 RPC 超时为 1 秒。短暂查询失败保留上次状态；连续 3 次失败后停止监测、退回主 agent 状态，不把接口失联报告为子任务成功完成。后续接口就绪或子任务事件可触发重新探测。通知不包含子任务的任务文本或输出，结束结果沿用主 agent 的完成、失败或取消状态，不根据活跃数量判断子任务是否执行成功。

## 更新记录

参见 [CHANGELOG.md](./CHANGELOG.md)。
