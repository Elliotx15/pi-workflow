# Dev Workflow

软件开发工作流 skills：

- [pw-spec](pw-spec/SKILL.md)：对齐需求与方案，生成 spec，并按需拆分 tickets，交给用户审阅，不自动实现。
- [pw-impl](pw-impl/SKILL.md)：基于 spec 和可选 tickets，在任务专属 worktree 中实现、验收并提交代码；有 tickets 时，审阅编排后委派子 Pi 执行。

## 安装

在本仓库根目录执行：

```bash
pi install ./skills/dev-workflow
```

重新启动 Pi，或执行 `/reload`。

安装会加载 `pw-spec`、`pw-impl`，以及 vendor 中的 `grilling`、`to-spec`、`to-tickets`、`tdd`、`using-git-worktrees`。如果已从其他来源安装同名 skill，请避免重复加载，以免使用到不同版本。

执行有 tickets 的 `pw-impl` 流程还需安装 [pi-warp-delegate](../../tools/pi-warp-delegate/README.md)。

## 使用

```text
/skill:pw-spec <需求描述或 issue 引用>
/skill:pw-impl <task name>
/skill:pw-impl <spec 文件路径>
```

skill 正文中的 `/grilling`、`/tdd` 等表示调用对应 skill；在 Pi 中显式调用时使用 `/skill:<name>`，例如 `/skill:tdd`、`/skill:using-git-worktrees`。

产物位于目标项目的 `.issues/<task name>/`：spec 默认为 `spec.md`，按需生成的 tickets 及状态说明位于 `tickets/`，实现使用的 worktree 位于 `worktrees/wt-<repo name>`。

审阅 `pw-spec` 的产物后，调用 `pw-impl` 开始实现。有 tickets 时，每票验收并提交代码成功后，由子 Pi 将原始 ticket 的 `Status` 改为 `done`；没有 tickets 时，主 Pi 直接实现、验收并提交代码。

完整约定见 [pw-spec/SKILL.md](pw-spec/SKILL.md) 和 [pw-impl/SKILL.md](pw-impl/SKILL.md)。

## 上游依赖

- [mattpocock/skills v1.3.1](https://github.com/mattpocock/skills/tree/v1.3.1)：`grilling`、`to-spec`、`to-tickets`、`tdd`。
- [obra/superpowers v7.0.0](https://github.com/obra/superpowers/tree/v7.0.0)：`using-git-worktrees`。

副本均原样保存在 `vendor/`，来源、固定 commit 和许可证见 [vendor/README.md](vendor/README.md)。
