# git-commit-assistant

## 目标

`git-commit-assistant` 帮助 Codex 根据 Git 中最终、确切的暂存差异生成一条 Conventional Commit 提交说明。未指定语言时，提交主题和正文默认使用简体中文。

它默认只给出一个最佳候选，不提供多个备选。只有在用户明确授权暂存或提交，并在看到完整候选后输入精确的 `确认提交 <标识>` 时，才会创建提交。它不会执行 `push`。

## 安装

安装目录只需要两个运行时文件：`SKILL.md` 和 `scripts/staged-commit.mjs`。不要把开发仓库、测试、文档或本地状态目录整体复制到 Codex Skill 根目录。

推荐结构如下：

```text
git-commit-assistant/
|-- SKILL.md
`-- scripts/
    `-- staged-commit.mjs
```

在 PowerShell 中，从已裁剪的运行时目录复制：

```powershell
$skillRoot = Join-Path $env:USERPROFILE '.codex\skills'
$runtimeSource = Resolve-Path '.\git-commit-assistant-runtime'
$installRoot = Join-Path $skillRoot 'git-commit-assistant'

New-Item -ItemType Directory -Force -Path (Join-Path $installRoot 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $runtimeSource 'SKILL.md') -Destination (Join-Path $installRoot 'SKILL.md')
Copy-Item -LiteralPath (Join-Path $runtimeSource 'scripts\staged-commit.mjs') -Destination (Join-Path $installRoot 'scripts\staged-commit.mjs')
```

运行时依赖 Git 和 Node.js 22 或更高版本，不需要第三方 npm 依赖。

## 仅生成说明

只需要提交说明时，先由你自己暂存要提交的内容，然后提出只生成说明的请求，例如：

```text
根据我已暂存的变更起草一条 Conventional Commit 消息，不要提交。
```

该流程只读取 Git 规则、状态、已暂存路径、`git diff --cached --no-ext-diff`、统计信息和近期提交主题。它不会自动暂存，不会读取未暂存或未跟踪内容作为提交依据，也不会修改工作区、索引或 HEAD。

如果暂存区为空、处于合并/变基/cherry-pick/revert 等特殊 Git 状态，或发现内容不连贯、疑似敏感，Skill 会停止并说明原因。

## 明确暂存/提交

只有明确要求暂存或提交时，Skill 才会修改 Git 索引。它会先根据对话和 `git status` 的路径级信息识别当前任务候选路径，再调用 `scripts/staged-commit.mjs inspect` 检查这些路径中的可选单元。路径级 `git status` 可能把未跟踪目录折叠成 `tests/` 这类目录项；helper 需要具体文件路径，目录候选不会自动递归包含未跟踪文件。提交前应核对完整路径，必要时使用 `git status --short --untracked-files=all` 展开。

提交流程分为三步：

1. `prepare` 使用检查快照和所选单元准备当前任务的暂存视图。
2. `bind` 绑定完整提交说明，返回 12 位确认标识。
3. 只有你在新的回复中输入精确的 `确认提交 <标识>`，才会执行一次 `commit`。

除这条精确确认外，任何修改、追问、拒绝、取消或不完整确认都不会创建提交。Skill 会取消准备状态，或在无法安全覆盖当前索引时保留恢复数据并停止。

## 消息规范

提交说明使用 Conventional Commits：

```text
TYPE[(SCOPE)][!]: SUBJECT
```

scope 只在有可靠依据时使用。主题通常不超过 72 个字符，末尾不加句号。简单变更只写主题行；复杂变更或多项实质处理点才在空行后添加最少数量的 `- ` 列表。

消息只根据最终暂存差异生成。不要罗列文件名，不重复主题，不编造动机、业务背景或测试结果。用户明确指定英文或其他语言时按请求输出；否则默认使用简体中文。

示例：

```text
fix(auth): 修复登录失败时的错误提示
```

复杂示例：

```text
feat(profile): 添加用户资料可见性设置

- 新增资料可见性字段并保存用户选择
- 查询资料时按可见性过滤公开内容
```

## hunk 隔离与恢复

同一文件中相互独立的 hunk 可以分别选择。未跟踪文件、二进制文件、重命名、删除、权限变化和混合语义的原子 hunk 不能拆分；未跟踪目录必须先展开为具体文件路径后再判断是否属于当前任务。

如果一个原子单元同时包含当前任务和无关修改，Skill 会停止，要求你先手动整理。它不会猜测或部分提交无法安全拆开的内容。

准备、取消和提交会在关键检查点验证 HEAD、索引树、选择单元和消息绑定。成功提交后，原本与当前任务无关但已暂存的内容会恢复为 staged。hook 拒绝提交时，Skill 不会重试或绕过 hook；它会尝试恢复可安全恢复的索引状态，并报告是否保留了恢复数据。

## 安全边界

Skill 不会执行以下操作：

- `push`、tag、release、包发布或上传。
- amend、历史改写、签名提交、跳过 hook 或写入 Git/Codex 配置。
- 在只生成说明时修改索引、工作区或 HEAD。
- 回显识别到的敏感值。

包含禁用操作的组合请求，例如“提交后 push”，会在检查、准备或暂存前停止。请把请求缩小为仅提交当前任务。

## 验证

在开发仓库中使用 Node.js 22 或更高版本运行：

```powershell
npm run check
npm run audit
```

`npm run check` 运行确定性测试和项目契约验证。`npm run audit` 检查发布包内容、敏感信息和运行时边界。

交付前还应按项目计划运行行为评测和最终门禁；这些流程属于开发验证，不是安装后的运行时命令。

## 卸载

删除 Codex Skill 根目录中的 `git-commit-assistant` 文件夹即可卸载。卸载前可确认该目录只包含 `SKILL.md` 和 `scripts/staged-commit.mjs`，避免误删其他本地文件。
