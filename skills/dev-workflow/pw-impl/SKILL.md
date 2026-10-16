---
name: pw-impl
description: 基于 spec 和可选 tickets 实现任务，按依赖图委派 subagent 并按需集成成果，或直接使用 TDD 完成实现。
---

# PW Impl

## 步骤

1. 接受 spec 文件路径或 task name。提供 task name 时，从当前目录的 `.issues/` 定位；无法确定时让用户决定。
2. 检查 spec、tickets 是否符合下方路径约束且属于同一 task，不符合则说明理由并结束。tickets 目录可以不存在。读取 spec、tickets 及状态说明，确认涉及 repo、依赖与验收要求。
3. 根据 tickets 情况执行：
   - 有未完成 tickets：执行下方“tickets 编排与集成”。
   - 全部 tickets 为 `done`：结束。
   - 没有 tickets：基于 spec，使用 `/using-git-worktrees` 创建或复用 worktree，再使用 `/tdd` 实现。测试 seam 已预先批准。通过测试与验收后，在各相关 worktree 中仅提交本次实现改动，汇总并结束。说明文件不计为 ticket。

## tickets 编排与集成

subagent 仅在同一 task 内复用，续接原会话上下文；无法续接时让用户决定。

首次建立 worktree 布局时，按整个 task 的所有 tickets（含 `done`）统计会修改各 repo 的票数；仅阅读或引用该 repo 的票不计入：

- 直接实现模式：只有一张 ticket 修改该 repo，直接在任务分支和任务 worktree 中实现，不另建 ticket 分支与 worktree，不派发合并 subagent。
- 独立集成模式：多张 tickets 修改该 repo，各票使用独立分支和 worktree，再合入任务集成分支。

同一张 ticket 涉及的不同 repo 可以采用不同模式。
续跑沿用已确定的模式和布局，不因剩余票数减少而切换，已有双层布局也不自动折叠。
若 tickets 变更使直接实现模式不再满足单票条件，暂停受影响 repo 的派发，让用户决定如何调整；模式或修改范围无法确定时，同样让用户决定。

1. 主 Pi 使用 `/using-git-worktrees` 创建或复用各 repo 的任务分支与 `wt-<repo name>`。直接实现模式下，将其交给唯一的实现 subagent；独立集成模式下，将其作为集成分支与集成 worktree，仅为各 ticket 分配独立分支名和 worktree 路径，由实现 subagent 创建或复用。
2. 按依赖图派发：全部前置票为 `done` 后，每张 ticket 使用一个实现 subagent，续跑或修复时复用原 subagent。无依赖的 tickets 可以并行，包括同 repo 的 tickets。执行中、待集成或已阻塞的票不重复派发。
3. 实现成功后，仅对独立集成模式的 repo 派发对应的合并 subagent。同一 repo 的各票合并复用同一个 subagent，串行执行。
4. 主 Pi 核对结果：直接实现模式的 repo 均已提交并通过验收，独立集成模式的 repo 均已提交、集成并通过验收后，将原始 ticket 的 `Status` 改为 `done`，立即派发新解锁的票。全部完成后汇总各 repo 的模式、任务分支、worktree、提交及验收结果。
5. 失败或需用户决策时，该票保持 `ready`，保留成果并汇报阻塞原因。其依赖票等待，其他可安全推进的票继续；无可推进任务且无运行中的 subagent 时，汇总阻塞项，等待用户处理。

## 路径与 worktree 约束

- spec：`.issues/<task name>/<spec 文件>`，默认 `spec.md`。
- tickets：`.issues/<task name>/tickets/`。
- worktrees：`.issues/<task name>/worktrees/`。

路径统一锚定已确定的任务目录：

- 每个 repo 使用一个任务分支，对应 worktree 为 `wt-<repo name>`。
- 有 tickets 时，直接实现模式在任务分支和任务 worktree 中实现；独立集成模式将其作为集成分支与集成 worktree。
- 仅在独立集成模式下，每张 ticket 在该 repo 中使用独立分支和 worktree，基于对应集成分支创建；worktree 按创建顺序命名为 `wt-<repo name>-02`、`wt-<repo name>-03`……
- 无 tickets 时，直接使用 `wt-<repo name>` 实现。
- 分支与 worktree 首次创建，续跑时仅复用同一任务、同一 repo、同一用途的分支与 worktree；供 ticket 实现使用的分支与 worktree 还须分配给同一张票。复用时保留已有成果。
- 无法确定归属或按规定路径创建、复用时，让用户决定，不改到其他位置实现。
- 仅在任务 worktree 中实现与合并，不夹带其他任务或用户的改动。完成后保留分支和 worktrees，不自动合入 repo 原来的分支。

## 派发提示词

首次派发使用以下固定模板，仅替换占位符；续接时补充本轮任务和必要指针。路径使用绝对路径；实现可填写多个 repo，按模式分别列出，没有对应 repo 的列表填“无”；合并仅用于独立集成模式，每次只填写对应 repo。

### 实现 subagent

```text
基于 spec（<文件绝对路径>）和 tickets（<目录绝对路径>），
使用 /tdd 实现并验收 ticket <编号>。测试 seam 已预先批准。

直接实现模式的 repo：
<repo 来源绝对路径 → 任务 worktree 绝对路径；任务分支：<分支名>>

复用主 Pi 已准备的任务分支与 worktree，在其中实现、测试与验收，
仅提交本票改动，不另建 ticket 分支或 worktree。

独立集成模式的 repo：
<repo 来源绝对路径 → ticket worktree 绝对路径；ticket 分支：<分支名>；集成分支：<分支名>>

使用 /using-git-worktrees 创建或复用指定的 ticket worktree，并在其中实现。
首次创建 ticket 分支与 worktree，分支基于对应集成分支。
验收后仅提交本票改动，再将最新集成分支合入 ticket 分支，
重新测试与验收，并提交必要修复。
不将 ticket 分支合入集成分支。

仅使用分配给本票的分支与 worktree；
续跑复用同一任务、同一 repo 下已分配给本票的分支与 worktree，保留已有成果。
归属不明时报告阻塞。

返回各 repo 的模式、分支、提交及测试验收结果。
遇到阻塞或需用户决策时，保留成果并报告。
不修改 ticket 状态，不将任务分支合入 repo 原来的分支。
```

### 合并 subagent

```text
基于 spec（<文件绝对路径>）和 tickets（<目录绝对路径>），
将 ticket <编号> 在以下 repo 中的成果集成到指定分支：
<repo 来源绝对路径；ticket 分支：<分支名>；待集成提交：<提交标识> → 集成分支：<分支名>；集成 worktree：<绝对路径>>

在指定集成 worktree 中合并，依据 spec 和本票要求处理冲突，
运行相关测试与验收，仅提交本次集成改动。

返回该 repo 的集成提交及测试验收结果。
遇到阻塞或需用户决策时，保留成果并报告。
不修改 ticket 状态，不将集成分支合入 repo 原来的分支。
```
