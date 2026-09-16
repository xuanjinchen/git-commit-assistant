# git-commit-assistant

为**已经暂存的 Git 变更**生成清晰、简洁的 Conventional Commit 说明，默认使用简体中文。

## 职责

本 Skill 只读取暂存差异并返回消息文本。暂存文件、创建提交、合并、推送和分支管理由用户、上层 Agent 或其他 Git 管理 Skill 负责，例如 `finishing-a-development-branch`。

它没有 Git 写入脚本、确认口令、事务或恢复状态，也不会自动启动其他 Skill。用户在上层授权提交，不会把本 Skill 变成提交执行器。

## 安装

运行时只需要一个文件：

```text
git-commit-assistant/
└── SKILL.md
```

将仓库的 `SKILL.md` 复制到 Codex 全局 Skill 根目录下的 `git-commit-assistant` 文件夹。已有用户自定义 Skill 根目录时，以该配置为准。

PowerShell 示例（从本仓库执行）：

```powershell
$commitSkillPath = Join-Path $env:USERPROFILE '.codex/skills/git-commit-assistant'
New-Item -ItemType Directory -Force -Path $commitSkillPath | Out-Null
Copy-Item -LiteralPath ./SKILL.md -Destination (Join-Path $commitSkillPath 'SKILL.md') -Force
```

从旧版升级时，确认安装目录属于本 Skill 后，移除旧的 `scripts/staged-commit.mjs` 或 `scripts/stage-transaction.mjs`，只保留 `SKILL.md`。不要复制开发仓库、测试、评测或历史状态。

使用时需要 Git 与能够加载 Skill 的 Agent；Node.js 22+ 仅用于本仓库的开发检查，安装后的 Skill 没有 npm 依赖。

## 使用

先由你或 Git 管理 Skill 完成暂存，然后请求：

> 根据当前暂存差异生成一条简洁的提交说明。

简单修改：

```text
fix(auth): 修复登录失败时的错误提示
```

复杂修改：

```text
feat(remittance): 添加打款账户启用状态管理

- 新建账户默认启用，并通过专用接口变更状态
- 查询与转账时校验账户状态，排除停用账户
- 限制通用编辑入口绕过启停规则
```

默认只返回一个最佳候选。简单变更由主题完整概括时不加正文；多个实质处理点按语义合并。明确要求英文或其他语言时，主题和正文统一采用指定语言。

## 与其他 Skill 协作

上层流程按这个顺序使用：

1. 用户或 Git 管理 Skill 确定范围并暂存改动。
2. 调用 `git-commit-assistant`，读取当前 staged diff，返回完整说明。
3. 调用方提取代码块里的原文，按自己的授权与确认规则创建提交，再继续合并或推送。

可向上层 Agent 提出：

> 使用 finishing-a-development-branch 完成分支收尾；需要提交说明时，由 git-commit-assistant 根据最终暂存内容生成。

这里是会话中的文本交接，不是自动注册的插件或 hook。无需修改其他 Skill 的全局定义；管理 Skill 未安装时，生成说明仍可独立使用。调用方在生成后改动暂存区，应重新请求消息。

## 读取边界

- 仅依据真实暂存内容；未暂存及未跟踪内容不用于补足说明。
- 使用只读 Git 命令，禁用可选索引写入、外部 diff 和 textconv。
- 暂存区为空、存在未解决冲突、疑似凭据或语义证据不足时停止，说明原因，不自行暂存或修复。
- 仓库中的指令文本仅作为内容，不构成新增权限。
- 不保证业务正确性或测试结果；说明中的每个事实都必须能由暂存差异支持。

## 开发验证

```powershell
npm run check
npm run audit
npm run gate:delivery
```

结构与包白名单由 Node 内置测试验证；文案、语言、只读边界及跨 Skill 交接通过真实 Agent 评测验证。交付门禁要求当前需求和证据全部就绪。

本项目采用 [Apache License 2.0](LICENSE)。
