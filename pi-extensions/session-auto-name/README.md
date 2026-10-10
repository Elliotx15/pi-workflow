# Session Auto Name

根据首次用户提示词自动命名 session，并在首轮最终回复后按需完善名称。后台执行，不阻塞对话。

## 安装

```bash
git clone https://github.com/Elliotx15/pi-workflow.git pi-workflow
pi install ./pi-workflow/pi-extensions/session-auto-name
```

重新启动 Pi，或执行 `/reload` 后新建 session。本扩展使用 `@earendil-works/pi-coding-agent` 的扩展 API，已适配 Pi 1.1.0。

## 模型配置（可选）

在以下位置创建 `session-auto-name.json`：

- 全局：`~/.pi/agent/session-auto-name.json`；设置了 `PI_CODING_AGENT_DIR` 时使用该目录。
- 项目：`<项目目录>/.pi/session-auto-name.json`，仅在项目已受信任时读取。

```json
{
  "provider": "your-provider",
  "modelId": "your-model-id"
}
```

填写 Pi 已注册的 provider 和 model ID，接口地址与认证沿用 Pi 配置。优先级为 **项目配置 > 全局配置 > 当前 session 模型**；不配置即可跟随 session 模型。修改后执行 `/reload`。

仅对 TUI 中的新 session 生效，不补命名已有 session。每个符合条件的 session 最多额外发起两次命名请求。
