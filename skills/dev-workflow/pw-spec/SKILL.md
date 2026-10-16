---
name: pw-spec
description: 对齐需求与方案，生成本地 spec，并按需拆分 tickets，供用户审阅。
---

# PW Spec

## 步骤

1. 使用 `/grilling` 对齐需求与方案。收尾时总结测试方案与 Acceptance criteria 设计，包括整体验收目标、关键场景、范围边界及验证方式；只给出设计摘要，不逐条展开具体规则。请用户确认后再调用 `/to-spec`。
2. 使用 `/to-spec` 生成 spec，将已确认的设计落实为整体需求的测试要求与 Acceptance criteria，不重复确认测试方案与验收设计。
3. 基于 spec 判断任务能否在一个新上下文中完成实现与验证：
   - 能：跳过第 4 步，进入第 5 步。
   - 不能：进入第 4 步。
4. 使用 `/to-tickets` 基于 spec 生成 tickets，为拆分后的需求细化本票测试要求与 Acceptance criteria；跳过拆分方案确认，在第 5 步统一审阅。
5. 汇总说明，给出 spec 路径、拆票判断及理由；若生成 tickets，列出其路径和依赖关系。请用户审阅产物中的具体测试要求、验收规则及待确认项，然后结束，不自动实现。

## 测试与验收内容约束

- spec 使用 `Testing Decisions` 记录整体测试方案与验证方式，增加 `Acceptance criteria` 章节，记录整体需求的可验证完成条件。
- 每张 ticket 包含 `Acceptance criteria` 章节，记录拆分后需求的本票验收标准，并写明本票测试要求与验证方式；承接并细化 spec，不自行新增需求。
- 设计摘要的确认不等于批准生成后的所有细节，具体测试要求与验收标准以用户审阅后的文档为准。生成时若需新增业务决策，明确标为待确认并在审阅时指出，不视为已批准。

## 产物路径约束

路径相对于目标项目根目录：

- spec：`.issues/<task name>/spec.md`
- tickets：`.issues/<task name>/tickets/<NN>-<short-name>.md`，每张 ticket 一个文件，按依赖顺序编号。
- ticket 状态说明：`.issues/<task name>/tickets/README.md`

`task name` 命名规则：

- Linear issue：使用完整 ID，例如 `ENG-123`。
- GitHub / GitLab issue：使用纯编号，例如 `123`，不加平台前缀。
- 无 issue ID：使用简短需求描述。
- 存在多个候选 ID 时，询问用户确定主任务。

## 状态约束

- spec 不维护状态；待确认项解决后，用户确认开始实现，即视为产物中的具体规则审阅通过。
- 每张 ticket 使用 `Status` 字段记录状态，初始化为 `ready`。
- 不在每张 ticket 中重复写入状态维护说明。生成 tickets 时，在其目录下创建 `README.md`，内容如下：

```markdown
# Ticket 状态

每张 ticket 通过 `Status` 记录执行进度：

- `ready`：初始化状态，尚未实现完成；实施过程中保持此状态。
- `done`：实现完成，并按本票文档通过测试与验收。

完成后，由执行 agent 将该 ticket 的 `Status` 从 `ready` 改为 `done`。
```
