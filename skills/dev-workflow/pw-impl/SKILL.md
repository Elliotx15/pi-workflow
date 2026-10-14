---
name: pw-impl
description: 基于 spec 和可选 tickets 实现任务，审阅编排后委派子 Pi，或直接使用 TDD 完成实现。
---

# PW Impl

## 步骤

0. 确定任务并检查路径：
   - 接受 spec 文件路径或 task name。提供 task name 时，从当前目录下的 `.issues/` 定位；无法抉择时让用户决定。
   - 检查 spec、tickets 是否符合下方路径约束，且属于同一 task。任一不符合，说明理由并结束。
   - tickets 目录不存在不算路径违规。
1. 读取 spec、tickets 及其状态说明，梳理当前代码事实、涉及 repo、依赖与验收要求。
2. 判断是否有 ticket：
   - 有未完成 tickets：进入步骤 3。
   - 全部 tickets 已为 `done`：结束。
   - 没有 tickets，包括目录不存在或没有实际票：进入步骤 5。说明文件不计为 ticket。
3. 给出任务编排建议，包含依赖、涉及 repo、worktree 路径及串并行安排。请用户审阅，通过后进入步骤 4。
4. 使用 `pi-warp-delegate` 按批准的编排派发，一张 ticket 交给一个子 Pi 实现、验收并提交代码，首次提示词见下节。主 Pi 查询委派状态、读取原始 ticket 文件并推进后续任务；所有 tickets 的 `Status` 都为 `done` 时结束。
5. 基于 spec，先使用 `/using-git-worktrees` 创建或复用 worktree，再使用 `/tdd` 实现。测试 seam 已预先批准。完成测试与验收后，在各相关 worktree 中提交本次实现改动，不夹带其他任务或用户的改动；全部提交成功后汇总并结束。

## 产物路径与 worktree 约束

- spec：`.issues/<task name>/<spec 文件>`，默认 `spec.md`。
- tickets：`.issues/<task name>/tickets/`。
- worktree：`.issues/<task name>/worktrees/wt-<repo name>`。

同一任务的路径统一锚定已确定的任务目录：

- 每个 task 内，每个 repo 只有一个 worktree；不同 task 可以分别拥有。
- 同 repo 的 tickets 复用 worktree，串行实现。
- 跨 repo ticket 整体派发，执行期间占用全部相关 repo；其他涉及任一相同 repo 的 ticket 必须等待。
- 无依赖且 repo 不重叠的 tickets 可以并行。
- 复用时保留已有成果。无法确定归属或按规定路径创建、复用时，让用户决定，不改到其他位置实现。

## pi-warp-delegate 目录约束

- `launch` 的 `--workspace` 和 `--cwd` 均显式指定为主工作区根目录（本任务 `.issues/` 的父目录），使用绝对路径。
- `status` 显式使用派发时相同的 `--workspace`。

## 派发任务实现提示词

严格使用以下固定模板，仅填写占位符要求的信息；路径使用绝对路径，repo/worktree 映射按实际涉及的 repo 逐行填写。其余内容保持不变，不得改写、删减或追加说明。

```text
基于 spec（<文件绝对路径>）和 tickets（<目录绝对路径>），
使用 /tdd 实现并验收 ticket <编号>。
测试 seam 已预先批准。

实现前使用 /using-git-worktrees 创建或复用以下 worktree，并在其中实现：
<repo 来源绝对路径 → worktree 绝对路径>

验收通过后，在各相关 worktree 中提交本票改动，
再按 tickets 中的状态约定更新本票状态。

实现过程中使用 pi-warp-delegate 命令行工具更新任务状态。
```
