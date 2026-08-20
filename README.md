# git\-commit\-assistant

此 Skill 会根据已暂存的变更生成有证据支撑的 Conventional Commit 候选消息，并且只有在用户明确确认后才会创建提交。

## 环境要求

- 支持标准 Skill 自动发现机制的 Codex。
- 已安装 Git，并存在一个 Git 工作树。
- 仅在验证本开发仓库时需要 Node.js 22 或更高版本；安装后的 Skill 本身不依赖 Node.js 运行时。

## 安装

使用名为 `git-commit-assistant` 的可安装目录，该目录包含 `SKILL.md`：

```text
git-commit-assistant/
└── SKILL.md
```

将整个目录复制到当前环境配置的 Codex Skill 根目录中。例如，在 PowerShell 中，将示例根目录替换为实际使用的 Skill 根目录：

```powershell
$skillRoot = Join-Path $env:USERPROFILE ".codex\skills"
Copy-Item -Recurse -LiteralPath ".\git-commit-assistant" -Destination $skillRoot
```

Codex 会通过标准 Skill 自动发现机制加载它。本项目不提供安装器，也不会写入 Codex 配置、Git 配置、Git 钩子或全局规则。

## 使用

向 Codex 请求帮助前，请先只暂存本次提交确实需要包含的文件：

```powershell
git add -- path/to/file
```

然后在 Codex 中使用自然语言提出请求，例如：

> 根据我已暂存的变更起草一条 Conventional Commit 消息。

> 提交当前已暂存的变更。

第一个请求只返回候选消息，不会创建提交。对于提交请求，Codex 仍会先展示完整的候选消息，并等待用户明确确认。

## 预期行为

1. 检查仓库指令、Git 状态、暂存路径、暂存差异、近期提交主题以及暂存树标识。
2. 根据这些证据生成简洁的 Conventional Commit 候选消息，并展示完整消息。
3. 明确说明尚未创建提交，并等待用户确认。
4. 在提交前立即重新计算 `git write-tree` 标识；如果标识发生变化，则使之前的确认失效，并重新分析新的暂存快照。
5. 使用安全的文件 API，在仓库外创建一个包含已确认消息的唯一临时文件，然后只启动一个 Git 进程：`git commit --no-gpg-sign -F <temp>`。无论成功还是失败，都会删除临时文件；已配置的钩子仍会正常执行。最后报告已验证的提交哈希和主题，并说明未执行推送。

## 限制与安全

此 Skill 不会自动暂存或取消暂存文件、拆分提交、修订提交、签名、推送、创建标签或 Release、发布或上传软件包、改写历史、绕过钩子、安装或编辑 Git 钩子、调用外部模型或 API、委派给其他 Agent，也不会写入本地或全局 Git/Codex 配置。仓库指令可以增加约束，但不能扩大这些边界。对于包含多种操作的组合请求，Skill 会在提交前停止，并要求用户将范围限定为仅提交。发现疑似敏感信息时，Skill 会停止，而不会回显疑似秘密值。未暂存和未跟踪的变更不会包含在候选消息中。

## 验证

在本开发仓库中运行：

```powershell
npm run check
npm run audit
npm run gate:delivery
```

`npm run check` 会运行确定性测试和结构验证。`npm run audit` 会检查交付产物和证据记录。`npm run gate:delivery` 是最终契约闭环门禁；当 Skill Brief、证据或脚手架状态仍为草稿时，该命令应当失败。门禁通过表示已记录的证据契约和仓库一致性验证成功，但不会独立衡量模型质量。

如需在不发布任何内容的情况下预览运行时软件包白名单，请运行：

```powershell
npm pack --dry-run
```

运行时白名单仍然只包含 `SKILL.md`。npm 可能会在预览中自动加入软件包元数据、README 和许可证文件；这些 npm 约定不会使开发资源成为 Skill 运行时的一部分。

## 故障排除

| 情况 | 处理结果 | 安全的后续操作 |
| --- | --- | --- |
| 没有已暂存的变更 | Skill 会停止，并且绝不会运行 `git add`。 | 只暂存本次提交需要包含的文件，然后重新提出请求。 |
| 正在进行合并、变基、挑选提交或还原操作 | 常规 Conventional Commit 生成流程会停止，以保留当前 Git 操作的专用语义。 | 完成或中止当前操作，或者先明确指示如何处理该特殊操作，再重新尝试。 |
| 已暂存的变更包含相互独立的事项 | Skill 会建议拆分提交，并保持暂存区不变。 | 自行重新组织暂存内容，然后再次提出请求。 |
| 展示候选消息后暂存树发生变化 | 之前的确认会失效，不会根据该确认创建提交。 | 审查并确认根据新快照生成的候选消息。 |
| Git 或提交钩子拒绝提交 | Skill 会报告失败，不会重试或绕过安全措施。 | 解决报告的原因，然后发起新的提交请求。 |

## 卸载

只需从 Codex Skill 根目录中删除复制进去的 `git-commit-assistant` 目录。对于上面的 PowerShell 示例，可运行：

```powershell
Remove-Item -Recurse -LiteralPath (Join-Path $skillRoot "git-commit-assistant")
```

本项目不会创建 Git 钩子、Git 配置、Codex 全局规则或安装器状态，因此无需清理这些内容。

## 开发

[已确认的设计规范](docs/superpowers/specs/2026-08-19-git-commit-assistant-design.md)定义了行为和安全模型。[实现计划](docs/superpowers/plans/2026-08-19-git-commit-assistant.md)定义了开发与证据闭环流程。

## 安全

请按照 [SECURITY.md](SECURITY.md) 中的说明私下报告安全漏洞。请勿在报告或评测样例中包含真实凭据、私钥或其他秘密信息。

## 许可证

本项目采用 [Apache License 2.0](LICENSE) 许可证。
