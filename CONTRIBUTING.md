# Contributing

## 范围

本仓库维护 `git-commit-assistant` Skill。变更应聚焦于 staged diff 提交说明、明确暂存/提交、hunk 隔离、恢复安全、测试、评测和用户文档。

不要把未实现的命令、发布流程或外部服务写入文档。涉及 push、tag、release、包发布、amend、历史改写、签名、hook 绕过或配置写入的能力不属于当前 Skill 范围。

## 开发环境

使用 Node.js 22 或更高版本。安装依赖时不要运行生命周期脚本：

```powershell
npm ci --ignore-scripts
```

运行时文件必须保持精简：`SKILL.md` 和 `scripts/staged-commit.mjs`。新增依赖、生成文件或发布包内容变化都需要明确验证其必要性。

## 开发流程

确定性行为遵循 TDD。先写能暴露目标行为缺失的测试，再做最小实现。对 Skill 行为变更，先固定正向、负向和边界评测，再更新实现或说明。

常用验证命令：

```powershell
npm run check
npm run audit
```

`npm run check` 必须在提交前通过。`npm run audit` 用于检查发布包内容、敏感信息和运行时边界。交付阶段还需要运行项目计划指定的行为评测和最终门禁。

## 提交与 Pull Request

提交消息使用 Conventional Commits，例如：

```text
docs: 更新中文使用说明
```

Pull Request 应说明变更目标、兼容性影响和验证结果。涉及行为变化时，列出更新过的测试或评测；只改文档时，说明文档如何对应现有实现。

## 敏感信息与完整 diff 审查

提交前必须审查完整 diff 和新增文件，确认没有凭据、令牌、私有路径、个人邮箱、客户数据、日志或本地状态。测试 fixture 使用 `tester@example.invalid` 等中性值。

代码写入任务结束前还要按项目规则检查中文注释：保留准确注释，修正失真注释，只在复杂维护意图需要时新增注释。

安全漏洞不要通过公开 issue 或 PR 报告，请按 [SECURITY.md](SECURITY.md) 使用私密报告流程。
