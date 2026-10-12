# Pi Warp Delegate

在 Warp 新标签页中启动独立、可交互的 Pi 会话执行委派任务，并查询子会话主动上报的任务状态。

## 安装

需要 macOS、支持 Tab Configs 的 Warp Stable、Node.js ≥ 22.19，以及已安装并可正常使用的 Pi。初始兼容目标为 Pi 1.1.0。

```bash
git clone https://github.com/Elliotx15/pi-workflow.git pi-workflow
cd pi-workflow/tools/pi-warp-delegate
npm ci --ignore-scripts
npm run build
npm link
```

`npm link` 将命令链接到当前 Node/npm 环境的全局命令目录，请保留仓库目录。这是独立 CLI，无需使用 `pi install` 或重新加载 Pi。

## 使用

```bash
pi-warp-delegate --help
```

主 Pi 通过 bash 工具调用 `launch` 创建委派，保存返回的子 session ID，再通过 `status` 查询状态。子 Pi 按启动时附带的协议调用 `report`，无需手工配置上报。

任务名称由主 Pi 拟定，用户指定的名称优先；模型和 thinking 由用户选择。缺少模型或 thinking 时返回 `needs_input`，不会启动任务。

完整参数、调用示例和状态协议见 `--help`。

## 注意事项

- 一个子 session 对应一个任务；`completed`、`failed`、`cancelled` 为不可变终态，后续聊天不会改变原任务状态。
- 仅上报状态，不回传结果、不自动调度、不检测进程退出。子 Pi 漏报或异常退出后保留最后状态，等待超时不代表任务结束。
- 子 Pi 在指定目录中运行，不自动创建 worktree 或隔离文件，并发修改冲突由调用方规避。
- 委派数据保存在 `~/.pi-warp-delegate/`，Warp 启动配置保存在 `~/.warp/tab_configs/`。
