# Session Auto Name

根据首次用户提示词自动命名 session，并在首轮最终回复后按需完善名称。后台执行，不阻塞对话。

## 安装

```bash
git clone https://github.com/Elliotx15/pi-workflow.git pi-workflow
pi install ./pi-workflow/pi-extensions/session-auto-name
```

重新启动 Pi，或执行 `/reload` 后新建 session。本扩展使用 `@earendil-works/pi-coding-agent` 的扩展 API，已适配 Pi 1.1.0。

## 命名与名称保护

仅对 TUI 中的新 session 生效，不补命名已有 session。每个符合条件的 session 最多额外发起两次命名请求。

**外部命名优先，自动命名不会覆盖外部设置的名称：**

- 新 session 启动时已有名称（例如通过 `pi --name "自定义名称"` 设置），直接跳过自动命名，不发起命名请求。
- 会话中途通过 `/name`、其他扩展或 API 设置名称，停止该 session 后续自动命名，取消进行中的命名请求并忽略迟到结果。即使外部设置的名称与当前名称相同，也视为外部接管。
- 仅本扩展自己生成的名称，仍允许在首轮最终回复后自动完善。

名称保护固定启用，无需配置。一旦外部接管，即使之后清空名称，也不会在该 session 内重新启用自动命名。

## 模型与推理级别配置（可选）

在以下位置创建 `session-auto-name.json`：

- 全局：`~/.pi/agent/session-auto-name.json`；设置了 `PI_CODING_AGENT_DIR` 时使用该目录。
- 项目：`<项目目录>/.pi/session-auto-name.json`，仅在项目已受信任时读取。

```json
{
  "provider": "your-provider",
  "modelId": "your-model-id",
  "thinkingLevel": "low"
}
```

填写 Pi 已注册的 provider 和 model ID，两者必须成对填写，接口地址与认证沿用 Pi 配置。`thinkingLevel` 可选，支持 `off`、`minimal`、`low`、`medium`、`high`、`xhigh`、`max`；省略时保持原有行为，不显式指定推理级别。该设置仅影响两次命名请求，不修改主会话的模型或推理级别。

优先级为 **项目配置 > 全局配置 > 当前 session 模型**；配置整组覆盖，不合并字段。不配置即可跟随 session 模型。修改后执行 `/reload`，再新建 session。

## 更新记录

参见 [CHANGELOG.md](./CHANGELOG.md)。
