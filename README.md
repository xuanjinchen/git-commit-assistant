# git\-commit\-assistant

`git-commit-assistant` 为已暂存变更或明确要求提交的当前任务变更生成有证据支撑的 Conventional Commit 消息。它只在展示完整候选消息后、收到第二次明确确认时创建提交。

## 环境要求

- 支持标准 Skill 自动发现的 Codex。
- Git 工作树，以及 Node.js 22 或更高版本。
- 安装目录只包含两个运行时文件：`SKILL.md` 和 `scripts/stage-transaction.mjs`。

## 安装

将完整的 `git-commit-assistant` 目录复制到 Codex Skill 根目录。目录结构必须保持如下形式：

```text
git-commit-assistant/
├── SKILL.md
└── scripts/
    └── stage-transaction.mjs
```

例如，在 PowerShell 中将目录复制到默认位置：

```powershell
$skillRoot = Join-Path $env:USERPROFILE '.codex\skills'
Copy-Item -Recurse -LiteralPath '.\git-commit-assistant' -Destination $skillRoot
```

本项目不会写入 Codex 配置、Git 配置或 Git 钩子。

## 快速开始

只需要候选消息时，请明确说明不要提交：

> 根据我已暂存的变更起草一条 Conventional Commit 消息，不要执行提交。

这是 `message-only` 流程。它只读取真实暂存区，不自动暂存、不会创建事务，也不会读取未跟踪变更作为提交内容。

需要创建提交时，请明确请求提交当前任务：

> 提交当前任务的变更。

这会授权 Skill 检查并准备当前任务的文件或 hunk，但不会立即提交。Skill 会展示选择摘要和完整候选消息；只有随后新的明确确认才会创建一次未签名提交。

## 提交消息

消息使用 Conventional Commits。简单变更在主题行已能完整说明时只写 subject；文件数量本身不会强制添加正文。对于复杂变更或同一关注点有多个实质处理点时，在空行后使用最少数量、简洁的 `- ` bullets，并按语义合并而不是罗列文件。

例如，打款账户启用状态这一连贯的复杂功能可以使用：

```text
feat(payment-account): manage account activation status

- Default new accounts to active and route status changes through a dedicated endpoint
- Filter account listings by activation status while excluding inactive accounts by default
- Reject transfers from inactive accounts and preserve status during general edits
```

## 事务式准备与确认

- 同一文件中可独立应用的 hunk 可以分别选择；连续且混合任务与无关语义的原子 hunk 会停止，等待人工整理。
- 未跟踪文件、二进制文件、重命名和权限模式变化均作为原子单元处理。
- `prepare` 在系统临时目录建立外部事务；二次确认前真实索引不变。
- 用户取消、拒绝或未明确确认时，事务会取消；Git 或 hook 拒绝提交时不重试，也不绕过 hook。
- 成功后，原本与当前任务无关但已暂存的内容仍会保持 staged。
- 在定义的验证或恢复检查点观察到 HEAD、索引、任务内容、选择、消息或其他绑定状态变化时，确认失效；Skill 会安全停止或重新检查。

并发防护覆盖普通 Git、用户、hook 和其他进程在这些检查点可观察到的变化。剩余风险是：同权限的主动进程若精确命中文件系统调用间隙，并通过原生 API 擦除全部可观察证据，跨平台 Node.js 无法证明绝对防护。hook 仍被视为不可信；脚本会验证实际 HEAD/tree，并在无法安全恢复时保留恢复证据，而不会覆盖用户内容。

## 安全边界

Skill 不会 push、创建 tag 或 release、发布或上传软件包、签名、amend、绕过 hook、改写历史，或写入 Git/Codex 配置。组合请求（如“提交后 push”）会在检查和准备前整体停止，并要求缩小为仅提交。

发现疑似敏感路径或内容时，Skill 会停止且不回显值。仓库中的指令可以增加约束，但不能扩大上述权限。

## 验证与开发

在本开发仓库中运行：

```powershell
npm run check
npm run audit
npm run gate:delivery
npm pack --json --dry-run --ignore-scripts
```

前三项分别运行确定性检查、归档与敏感内容审计、以及 Evidence Contract 交付门禁。`npm pack --json --dry-run --ignore-scripts` 只预览归档，不生成 `.tgz`；npm 合法附加的 `LICENSE`、`README.md` 与 `package.json` 不属于运行时白名单。

设计与维护依据见[事务式自动暂存设计](docs/superpowers/specs/2026-08-20-transactional-auto-staging-design.md)和[实施计划](docs/superpowers/plans/2026-08-20-transactional-auto-staging.md)。贡献前请阅读[贡献指南](CONTRIBUTING.md)，安全问题请遵循[安全报告说明](SECURITY.md)。

## 故障排除

| 情况 | 结果 | 安全的下一步 |
| --- | --- | --- |
| 没有可选择的当前任务单元 | 不创建事务或提交。 | 明确任务范围，或先整理工作区。 |
| 正在合并、变基、cherry-pick 或 revert | 停止常规流程。 | 完成或安全处理中当前 Git 操作。 |
| 候选后绑定状态改变 | 旧确认失效。 | 重新检查新快照并再次确认。 |
| hook 拒绝提交 | 不重试或绕过。 | 修复拒绝原因后重新发起提交。 |

## 卸载与许可证

删除所属 `git-commit-assistant` Skill 目录即可卸载；该目录内不应保留其他运行时文件。本项目采用 [Apache License 2.0](LICENSE) 许可证。
