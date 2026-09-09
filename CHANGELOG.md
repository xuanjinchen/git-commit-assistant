# Changelog

本文件记录 `git-commit-assistant` 的公开版本变化。版本遵循 Semantic Versioning。

## [Unreleased]

### Version 7 精简重构

- 将 Skill 目标收敛为根据最终确切 staged diff 生成一条最佳 Conventional Commit 候选说明。
- 默认使用简体中文，并保留用户显式语言要求的覆盖能力。
- 将明确提交流程拆为检查、准备、绑定和精确二次确认，确认文本为 `确认提交 <标识>`。
- 保留当前任务 hunk 隔离、原子单元停止、取消恢复、hook 失败恢复和无关 staged 内容恢复能力。
- 明确禁止 push、tag、release、amend、历史改写、签名、hook 绕过和配置写入。

## [0.1.0] - 2026-08-19

### Added

- 提供 Node.js 22+、零第三方依赖的 Skill 运行时。
- 提供基于 staged diff 的提交说明生成、明确暂存准备和二次确认提交流程。
- 提供确定性检查、安全审计和交付门禁。
