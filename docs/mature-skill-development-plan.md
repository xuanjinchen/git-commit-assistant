# 成熟 Skill 独立开发实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使开发 Agent 在只获得一个明确 Skill 目标的情况下，能够独立完成需求固化、设计、实现、评测、按需工程化、安全检查和可发布交付。

**Architecture:** 所有 Skill 先执行核心轨道，建立需求基线、`SKILL.md`、确定性契约、行为评测和使用文档；脚本、领域资料、隐式触发、多 Agent、安装器和公开发布分别由证据门启用。需求变更通过版本化 Skill Brief 回退到最早受影响阶段，所有正式能力必须有测试或真实运行证据。

**Tech Stack:** Agent Skills 的 Markdown/YAML 约定、Git、目标仓库现有测试栈；新仓库没有既定自动化栈时，默认使用 Node.js 22+、`node:test` 和标准库。真实 Agent 评测通过目标 CLI 的 headless 接口显式运行，不进入默认 CI。

## Global Constraints

- 需求优先级固定为：最新明确用户指令、当前 Skill Brief、项目就近规范、本计划默认值。
- 核心轨道强制执行；增强轨道必须记录启用证据或禁用理由。
- 不默认创建安装器、多 Agent 适配器、全局规则、运行时依赖或发布流水线。
- `SKILL.md` 保持聚焦并优先控制在 500 行以内；大段资料和变体使用渐进披露。
- Skill description 同时说明“做什么”和“何时使用”，触发条件不依赖正文才能被发现。
- 不以关键词命中代替语义触发评测，必须覆盖正向、隐式、负向、边界和冲突场景。
- 确定性检查不得调用付费模型；真实 Agent 评测必须显式选择目标 Agent 并报告可能产生的费用。
- 未完成真实 CLI 验证的平台只能标记为通用模板或实验性支持。
- 涉及用户文件写入时，必须先预检，再原子提交；卸载只删除能够证明由本项目托管的内容。
- 示例使用保留域名、虚构用户名和中性路径；日志、测试和发布资产不得包含凭据或私人信息。
- 保留目标仓库中与本任务无关的现有改动，不重置、不覆盖、不顺带重构。
- 公开发布采用不可变版本 Tag、明确包白名单和可复现校验；是否发布到包注册表由用户目标决定。

---

## 执行约定

### 启动输入

执行本计划只要求用户提供一句可验证的 Skill 目标，或提供一段需要固化为 Skill 的现有工作流。Agent 先从会话、仓库、样例和现有规范提取事实；只有核心目标冲突、不可逆操作、凭据需求或多个解释会改变正式行为时才提问。

优先使用文档头指定的执行 Skill。当前环境没有对应 Superpowers Skill 或子代理能力时，直接在当前会话按复选框顺序执行，并在 Task 16 使用一次独立代码审查或新会话复核；缺少调度工具不能阻塞 Skill 开发。

### 默认路径

全新独立 Skill 仓库默认使用：

```text
SKILL.md
README.md
docs/
  skill-brief.md
  decisions.md
  delivery-report.md
evals/
  evals.json
tests/
references/       # 仅在增强轨道启用时创建
scripts/          # 仅在增强轨道启用时创建
assets/           # 仅在增强轨道启用时创建
```

已有仓库优先遵循现有结构。Task 1 必须为 `SKILL_FILE`、`README_FILE`、`BRIEF_FILE`、`DECISIONS_FILE`、`DELIVERY_FILE`、`EVALS_FILE`、`TEST_ROOT`、`SOURCE_ROOT`、`RESOURCES_ROOT` 和 `EVAL_WORKSPACE` 写入实际路径映射。

后续命令块展示全新仓库的默认路径。已有仓库在执行每个命令前，必须根据路径映射替换对应参数，并把本次实际命令写入工作记录；不得为了照抄示例在仓库中创建第二套 `docs`、`evals`、`tests`、`src` 或 `resources`。

### 增强轨道状态

Skill Brief 必须维护以下状态，值只能是 `enabled`、`disabled` 或 `blocked`：

| 轨道 | 默认状态 | 启用条件 |
| --- | --- | --- |
| `references` | `disabled` | 主 Skill 过长、存在多领域变体或需要大段权威资料 |
| `scripts` | `disabled` | 多个评测重复生成同类确定性逻辑，或任务需要机械校验 |
| `assets` | `disabled` | 输出必须依赖模板、字体、图标或固定素材 |
| `implicit-trigger` | `disabled` | 用户要求未显式提及 Skill 时也稳定触发，且 description 不足以保证 |
| `multi-agent` | `disabled` | 用户明确要求多个 Agent 正式兼容 |
| `installer` | `disabled` | 需要写入多个 Skill 目录、用户规则或共享配置 |
| `open-source-release` | `disabled` | 用户要求公开仓库、版本安装和 Release 维护 |

`blocked` 只用于已经需要该轨道但外部条件暂不可得的情况，必须说明阻塞证据、受影响能力和解除条件。

### 简单 Skill 最短路径

仅包含提示规则、无需写入用户配置且只支持标准 Skill 发现的项目，执行 Task 1-9、Task 14 的通用安全步骤和 Task 16。Task 10-13 与 Task 15 在各自第一步记录禁用证据后立即结束。

最短路径只运行一轮三个案例的配对评测。Task 8 仍补齐静态案例矩阵和 Token 预算，但只有新增高风险案例、首轮失败、description 改动或行为契约变化时才继续调用模型。最终验收复用当前提交上的最新有效评测证据，不重复产生没有区分度的模型调用。

### 自主停止条件

以下情况立即停止受影响步骤并只提出一个关键问题：

- 最新指令含义不明确，无法判断它是在覆盖旧要求还是要求同时保留互斥行为。
- 需要真实凭据、付费调用、公开发布、删除用户数据或重写 Git 历史。
- 无法验证的第三方行为会决定是否能够宣称正式兼容。
- 继续执行会覆盖不属于本任务的用户修改。

其他选择由 Agent 做出最小、可逆、符合项目惯例的决定并记录在 `docs/decisions.md`。

---

### Task 1: 建立需求基线与路径映射

**Files:**
- Create: `docs/skill-brief.md`
- Create: `docs/decisions.md`
- Inspect: 仓库根目录、就近 `AGENTS.md`、现有 Skill、测试、构建和发布文件

**Interfaces:**
- Consumes: 用户初始目标、会话中的修正、目标仓库现状
- Produces: 后续所有任务唯一使用的需求基线、实际路径映射和增强轨道状态

- [ ] **Step 1: 检查仓库和约束**

运行：

```bash
git status --short --branch
git log -5 --oneline
rg --files -g "AGENTS.md" -g "SKILL.md" -g "package.json" -g "pyproject.toml" -g "Cargo.toml" -g "go.mod" -g "README*"
```

若目录不是 Git 仓库，记录“未初始化 Git”，但不要因为缺少 Git 阻止核心 Skill 开发。读取所有作用域覆盖目标文件的 Agent 规则，不修改无关脏文件。

- [ ] **Step 2: 编写具体 Skill Brief**

`docs/skill-brief.md` 必须写入实际内容并包含以下章节：

```markdown
# Skill Brief
## 需求版本
## 一句话目标
## 目标用户与使用环境
## 应触发场景
## 不应触发场景
## 输入与前置条件
## 输出与副作用
## 核心工作流
## 非目标
## 权限、数据与外部依赖
## 验收标准
## 路径映射
## 增强轨道状态
## 未决冲突
```

“未决冲突”必须写“无”或列出已经向用户提出的唯一阻塞问题；不能留下空章节。每条验收标准必须可以通过测试、评测、文件检查或人工复核判定。

- [ ] **Step 3: 写入初始决策日志**

`docs/decisions.md` 使用以下字段记录实际决定：

```markdown
# Decisions

| ID | 日期 | 状态 | 决定 | 依据 | 影响范围 | 替代方案 |
| --- | --- | --- | --- | --- | --- | --- |
```

状态只使用 `active` 或 `superseded`。至少记录 Skill 边界、默认输出、验证栈和每条增强轨道是否启用。

- [ ] **Step 4: 执行需求完整性自检**

检查每个应触发场景都有对应输出，每个副作用都有权限和恢复说明，每个非目标都没有被增强轨道重新引入。运行：

```bash
rg -n -i "T[B]D|T[O]DO|implement[ ]later|fill[ ]in[ ]details" docs/skill-brief.md docs/decisions.md
```

预期：无命中。若命中来自禁止占位内容的说明，应改写说明，保持扫描结果为空。

- [ ] **Step 5: 提交需求基线**

```bash
git add docs/skill-brief.md docs/decisions.md
git commit -m "docs: define skill requirements"
```

非 Git 仓库跳过提交，但在工作记录中保留完成状态。

---

### Task 2: 在实现前固定行为评测契约

**Files:**
- Create: `evals/evals.json`
- Create: `tests/behavior-eval-output.schema.json` when structured grading is applicable
- Modify: `docs/skill-brief.md`

**Interfaces:**
- Consumes: Skill Brief 中的触发、输出、边界和验收标准
- Produces: 不依赖具体 Skill 文案的真实行为案例、预期结果和待评分维度

- [ ] **Step 1: 定义评测数据结构**

先定位当前环境实际加载的 `skill-creator`，读取其 `SKILL.md` 和评测 Schema，并在决策日志记录来源路径或版本。当前工具的字段与下述格式不同时，以已加载版本的 Schema 为准，同时保留 `prompt`、`expected_output`、稳定 ID 和空断言四项语义；完全没有 Skill Creator 时使用下述内置格式。

`evals/evals.json` 使用稳定 ID，并为每个案例写入：

```json
{
  "skill_name": "从 Skill Brief 读取的实际名称",
  "evals": [
    {
      "id": 1,
      "eval_name": "稳定且描述场景的标识",
      "category": "direct-positive",
      "prompt": "真实用户可能输入的完整请求",
      "expected_output": "可观察的预期结果",
      "should_invoke": true,
      "assertions": [],
      "files": []
    }
  ]
}
```

`id` 使用仓库内稳定整数，`eval_name` 承担可读语义，不能只靠顺序号理解案例。`category` 至少覆盖 `direct-positive`、`implicit-positive`、`negative`、`boundary`、`conflict` 和 `failure`。首轮保持 `assertions` 为空，避免在看到真实运行前把评分过拟合到预想实现。

- [ ] **Step 2: 先写三个代表性案例**

首轮只选择三个高区分度案例：一个核心正向、一个最容易误触发的负向、一个会暴露边界或失败策略的案例。提示必须像真实用户请求，不得包含为帮助 Skill 通过而添加的规则复述。

- [ ] **Step 3: 为客观字段建立输出 Schema**

当结果可结构化时，Schema 至少要求：案例 ID、是否调用、结果摘要、证据、错误和输出文件。主观写作或设计质量保留人工评价，不强行转换为脆弱的关键词断言。

- [ ] **Step 4: 验证 JSON 和案例追踪**

若仓库使用 Node.js，运行：

```bash
node -e "const fs=require('node:fs'); const x=JSON.parse(fs.readFileSync('evals/evals.json','utf8')); if(!x.skill_name||!Array.isArray(x.evals)||x.evals.length<3) process.exit(1)"
```

同时逐项确认 Skill Brief 的核心验收标准至少被一个案例或后续确定性测试覆盖。

- [ ] **Step 5: 提交评测契约**

```bash
git add evals docs/skill-brief.md
```

存在结构化 Schema 时，在提交前另行运行 `git add tests/behavior-eval-output.schema.json`；否则不创建对应文件。

```bash
git commit -m "test: define skill behavior contract"
```

---

### Task 3: 建立最小 Skill 结构和静态契约

**Files:**
- Create: `SKILL.md`
- Create or Modify: 目标仓库的测试入口
- Create: `agents/openai.yaml` only when Codex metadata is an enabled requirement

**Interfaces:**
- Consumes: 实际 Skill 名称、触发边界、首轮评测
- Produces: 可发现但尚未完成全部正文的最小 Skill，以及先失败的结构测试

- [ ] **Step 1: 先写结构测试**

测试必须验证：

- 文件存在且是有效 UTF-8。
- frontmatter 由一对 `---` 包围。
- `name` 与 Skill 目录或仓库约定一致。
- `description` 非空，同时包含能力和使用场景。
- frontmatter 不承载正文算法或大段示例。
- 主 Skill 行数低于 500，除非 Skill Brief 记录了经过评审的例外。

先运行单项结构测试，预期因为 `SKILL.md` 不存在或字段缺失而失败。

- [ ] **Step 2: 创建最小 frontmatter**

```markdown
---
name: 使用 Skill Brief 中已确认的实际标识
description: 用一句紧凑描述同时表达能力、应触发上下文和关键排除边界
---

# 使用面向用户或任务的清晰标题
```

描述优先写用户会表达的任务语义，不堆叠产品名或同义关键词。重要负向边界只有在能降低误触发时才进入 description。

- [ ] **Step 3: 运行结构测试并确认通过**

运行目标仓库的单项测试命令。预期：frontmatter、名称、description 和行数测试通过。

- [ ] **Step 4: 确认标准安装发现**

若目标生态支持 Agent Skills 标准入口，使用本地路径执行发现或安装 dry run。若只支持手工复制，README 必须明确实际目录和移除方式，不能声称支持标准安装器。

- [ ] **Step 5: 提交最小结构**

```bash
git add SKILL.md tests
```

启用 Codex metadata 时，在提交前另行运行 `git add agents/openai.yaml`；未启用时不创建该文件。

```bash
git commit -m "feat: scaffold skill contract"
```

---

### Task 4: 编写核心工作流和输出协议

**Files:**
- Modify: `SKILL.md`
- Modify: 结构与契约测试
- Modify: `docs/decisions.md`

**Interfaces:**
- Consumes: Skill Brief、首轮案例、目标领域规范
- Produces: 能独立指导 Agent 完成核心任务的 Skill 正文

- [ ] **Step 1: 先写正文契约测试**

为不可丢失的行为写语义契约，不把整段文案锁死。至少验证正文明确包含：输入检查、决策顺序、核心步骤、边界、失败处理、输出格式和验证要求。

- [ ] **Step 2: 按决策顺序编写正文**

正文使用命令式表达，并按以下顺序组织：

```markdown
# 标题
## 开始前确定什么
## 执行步骤
## 质量标准
## 边界与失败处理
## 输出或报告格式
## 按需资源
```

只保留能改变 Agent 决策或输出的规则。解释约束背后的原因，避免依赖大量全大写强制词。用户已经提供的信息不得再次询问。

- [ ] **Step 3: 明确输入不足策略**

区分三类情况：可由仓库证据推断时自动继续；低风险缺省值写入决策日志后继续；会改变核心行为或产生不可逆影响时只问一个问题。

- [ ] **Step 4: 明确输出协议**

输出协议必须说明交付物、报告字段、文件位置和错误状态。没有固定格式需求时，要求结果简洁地报告完成内容、验证证据和剩余风险，不强迫所有任务输出同一大模板。

- [ ] **Step 5: 去除重复和过拟合**

description 不重复正文算法；正文不复制后续全局规则；三个案例的具体答案不写入规则。搜索重复段落和同义强制语句，保留唯一事实来源。

- [ ] **Step 6: 运行契约测试并提交**

```bash
git diff --check
git add SKILL.md tests docs/decisions.md
git commit -m "feat: define skill workflow"
```

---

### Task 5: 设计渐进披露和资源边界

**Files:**
- Modify: `SKILL.md`
- Create: `references/*.md` only when enabled
- Create: `assets/*` only when enabled
- Modify: 资源引用测试
- Modify: `docs/skill-brief.md`

**Interfaces:**
- Consumes: 主 Skill 长度、领域变体、固定素材需求
- Produces: 明确的资源加载图，或可审计的禁用结论

- [ ] **Step 1: 执行资源启用判定**

满足任一条件时启用 `references`：主 Skill 接近 500 行；多个框架或领域拥有不同规则；大段规范只在少数任务中需要。输出必须依赖模板或素材时启用 `assets`。否则保持禁用并记录“主 Skill 足以覆盖核心流程”或实际理由。

- [ ] **Step 2: 按变体拆分 references**

每个文件只服务一个领域或决策分支，文件名表达用途。超过 300 行的 reference 添加目录。`SKILL.md` 在相关步骤明确写出“什么条件下读取哪个文件”，不得要求启动时读取全部 references。

- [ ] **Step 3: 建立资源契约测试**

测试所有 `SKILL.md` 相对引用存在、没有越出 Skill 目录、没有孤立资源、没有引用评测工作区或本机绝对路径。对 assets 检查文件类型、许可证来源和实际引用。

- [ ] **Step 4: 记录轨道状态并提交**

```bash
git add SKILL.md tests docs/skill-brief.md
```

在提交前只对已启用目录分别运行 `git add references` 或 `git add assets`。两个轨道均禁用时，只提交 Skill Brief 中的判定记录，提交信息使用 `docs: record skill resource decision`。

```bash
git commit -m "feat: add progressive skill resources"
```

---

### Task 6: 建立统一确定性验证入口

**Files:**
- Create or Modify: 目标仓库测试配置
- Create: `tests/validate.*` when no validator exists

**Interfaces:**
- Consumes: 结构、正文、资源和评测数据契约
- Produces: 不调用模型即可重复执行的单一质量入口

- [ ] **Step 1: 选择验证栈**

已有仓库使用现有语言、测试框架和包管理器；根据 `packageManager` 字段及 `pnpm-lock.yaml`、`yarn.lock`、`bun.lock`/`bun.lockb`、`package-lock.json` 识别实际命令，绝不创建第二种锁文件。全新仓库默认 Node.js 22+、npm、ES modules、`node:test` 和标准库；仅为验证 Markdown 不引入生产运行时依赖。

全新 Node 仓库创建 `package.json`，写入 Skill Brief 中的实际包名、`0.1.0` 初始版本、`private: true`、`type: module`、`engines.node: ">=22"` 和实际许可证。随后运行 `npm install --package-lock-only --ignore-scripts` 生成锁文件；公开分发策略确定前保持 `private: true`。

- [ ] **Step 2: 先写失败的验证测试**

覆盖：UTF-8、frontmatter、名称一致性、description、正文契约、资源引用、JSON Schema、禁止的绝对路径、敏感文件名和增强轨道状态。先故意移除一个测试夹具字段或引用不存在资源，确认测试能失败，再恢复。

- [ ] **Step 3: 提供统一命令**

使用 npm 的 Node 项目把以下脚本合并到现有 `package.json`，不得覆盖名称、版本、依赖或其他已有字段。pnpm、Yarn 或 Bun 项目保留相同脚本名，并用当前包管理器执行：

```json
{
  "scripts": {
    "test": "node --test",
    "validate": "node tests/validate.js",
    "check": "npm test && npm run validate"
  }
}
```

其他技术栈提供语义等价的 `test`、`validate` 和聚合 `check`。Task 9 的 README 只展示实际存在且已运行成功的命令。

- [ ] **Step 4: 隔离文件系统测试**

所有写入型测试使用系统临时目录和虚构主目录，不触碰维护者真实 Agent 配置。每个测试自行创建和清理夹具，失败时保留足够诊断信息但不输出秘密。

- [ ] **Step 5: 运行确定性门**

使用 npm 的 Node 项目运行：

```bash
npm test
npm run validate
npm run check
git diff --check
```

预期：全部退出码为 0，重复运行结果一致且不产生未跟踪交付文件。

- [ ] **Step 6: 提交验证入口**

```bash
git add tests
```

全新 npm 项目在提交前另行运行 `git add package.json package-lock.json`；已有 Node 项目只加入实际 `package.json` 和原包管理器锁文件。非 Node 项目只加入实际测试配置和锁文件。

```bash
git commit -m "test: add deterministic skill validation"
```

---

### Task 7: 运行首轮有 Skill 与基线对比

**Files:**
- Modify: `evals/evals.json`
- Create outside repository: 同级评测工作区的 `iteration-1/`
- Modify: `docs/decisions.md`

**Interfaces:**
- Consumes: 三个首轮案例和可加载的 Skill
- Produces: 质量、Token 和耗时的首轮比较证据

- [ ] **Step 1: 同时启动两组运行**

在 Skill 目录的同级创建 Skill Brief 已记录的 `EVAL_WORKSPACE`，按以下结构初始化首轮；该工作区不进入仓库和发布包：

```text
iteration-1/
  案例的 eval_name/
    eval_metadata.json
    with_skill/
      run-1/
        outputs/
    without_skill/
      run-1/
        outputs/
```

`eval_metadata.json` 初始写入 `eval_id`、`eval_name`、完整 `prompt` 和空 `assertions`。每个案例在同一轮启动 `with_skill/run-1` 和 `without_skill/run-1`，两组使用相同输入、模型和输出要求，只有 Skill 加载不同。重复采样使用递增的 `run-2`、`run-3`，不能覆盖旧运行。不得先调优 Skill 后再生成基线。

- [ ] **Step 2: 在运行期间起草断言**

利用两组运行时间，把 Skill Brief 的客观验收标准改写成清晰、可评分且不依赖具体措辞的断言。同步更新 `evals/evals.json` 和每个案例工作区的 `eval_metadata.json`；主观质量仍保留给独立复核，不制造关键词断言。

- [ ] **Step 3: 即时记录运行元数据**

每个 `run-N` 目录保存 `timing.json`，字段为 `total_tokens`、`duration_ms` 和 `total_duration_seconds`。保存完整输出，但不得把评测工作区加入发布包。

- [ ] **Step 4: 执行客观评分**

可程序判断的断言使用脚本评分；在每个 `run-N/` 下保存 `grading.json`，每项使用 `text`、`passed` 和 `evidence`。证据引用输出位置或事实，不重复粘贴长内容。

- [ ] **Step 5: 执行人工质量复核**

检查正确性、边界、表达、意外副作用和是否过度遵循样例。主观质量不能因为关键词命中而判为通过。

- [ ] **Step 6: 聚合 benchmark 并执行分析**

使用当前 `skill-creator` 提供的 benchmark 聚合脚本生成 `benchmark.json` 和 `benchmark.md`；工具不可用时按相同字段记录每组通过率、Token、耗时、均值和差值。分析不区分两组的断言、高波动案例、质量与 Token 的交换，以及某个案例是否主导总体结果。

高自主模式下由独立复核 Agent 阅读全部输出和 benchmark；用户主动参与时再生成标准 review viewer，不把等待用户评分设为默认阻塞门。

- [ ] **Step 7: 分析区分度**

删除两组都稳定通过且不能衡量 Skill 增益的断言；修正波动大、依赖外部状态或可以被格式投机通过的断言。Skill 至少应在一个核心指标优于基线，且不能以明显增加错误、副作用或 Token 为代价。

- [ ] **Step 8: 根据证据迭代并提交**

只修改能解释失败原因的规则，避免为三个样例硬编码答案。重跑受影响案例，记录决定后提交：

```bash
git add SKILL.md evals/evals.json docs/decisions.md
git commit -m "fix: improve skill behavior from evaluation"
```

没有必要修改时，不创建空提交。

---

### Task 8: 扩展触发、边界和 Token 评测

**Files:**
- Modify: `evals/evals.json`
- Create or Modify: prompt budget contract test
- Modify: `SKILL.md`
- Modify: `docs/skill-brief.md`

**Interfaces:**
- Consumes: 首轮薄弱点、真实用户表达、Skill 运行负载
- Produces: 完整评测矩阵和可执行 Token 预算

- [ ] **Step 1: 扩展评测矩阵**

加入直接正向、隐式正向、相邻负向、否定表达、作用域、输入缺失、冲突、失败恢复和不应产生副作用的案例。只有 Skill 明确支持多语言、代码语言或平台时才加入对应交叉案例，避免无关组合爆炸。

- [ ] **Step 2: 优化 description 触发准确率**

分析漏触发和误触发案例，修改 description 中的任务语义和边界，不把完整工作流塞入 frontmatter。重新运行正向与负向集合，二者必须同时改善或保持。

只有正向漏触发、负向误触发、description 明显超过预算或用户明确要求优化时，才运行当前 `skill-creator` 提供的 description improver。行为已经稳定且没有触发问题时跳过，避免额外模型调用。只接受能在触发集和负向集上验证的建议，拒绝单纯增加关键词或扩大无关触发面的改写。

- [ ] **Step 3: 固定四层 Token 预算**

分别测量 description、`SKILL.md`、常驻规则和单次按需资源。预算值依据首轮有效实现设置，并预留小幅维护空间；测试报告实际字符数和 UTF-8 字节数。不能通过删除安全边界或验收要求来通过预算。

- [ ] **Step 4: 分离默认与完整评测**

默认评测只运行高区分度核心案例；完整评测包含全部交叉场景；单案例运行支持稳定 ID。真实模型入口必须要求显式 Agent 参数，缺少 CLI 或登录时明确失败，不静默跳过。

- [ ] **Step 5: 按变化范围运行行为门并提交**

首轮失败、description 改动、核心工作流变化或新增高风险案例时，运行受影响案例的配对评测；启用隐式触发、多 Agent、安装器或正式发布时，运行完整行为门。仅补充未改变行为的静态案例时，只验证评测数据和 Token 契约，不重复调用模型。产生新运行时保存聚合通过率、Token 和耗时，并确认新增案例不是只验证格式。

提交：

```bash
git add SKILL.md evals tests docs/skill-brief.md
git commit -m "test: expand skill behavior coverage"
```

---

### Task 9: 编写用户优先的使用与维护文档

**Files:**
- Create or Modify: `README.md`
- Create or Modify: README 契约测试
- Modify: `docs/decisions.md`

**Interfaces:**
- Consumes: 已验证的核心行为、实际安装入口、限制和验证命令
- Produces: 不依赖开发会话即可安装、使用、验证和移除 Skill 的用户文档

- [ ] **Step 1: 先写 README 契约测试**

测试 README 包含实际项目名、用途、前置条件、安装、最小使用示例、核心行为、边界、验证、故障排查和移除方式。命令必须能在仓库中找到对应入口，不能引用漂移分支作为默认稳定版本。

- [ ] **Step 2: 按用户任务顺序编写 README**

正文顺序固定为：一句话用途、前置条件、最快安装、最小示例、预期结果、可选能力、诊断/验证、升级/移除、边界、安全、贡献和许可证。第一屏直接说明 Skill 解决什么问题，不先介绍内部架构或发布流程。

- [ ] **Step 3: 区分标准入口和增强入口**

若标准 Skills 安装只能复制 Skill，而项目安装器还会写入自动触发规则，使用对照表明确两者差异。未启用安装器时只记录实际手工或标准安装方式，不展示不存在的 `install`、`doctor` 或 `uninstall` 命令。

- [ ] **Step 4: 只声明已验证能力**

README 的 Agent、平台、操作系统、语言和版本范围必须与 Skill Brief 及测试证据一致。通用模板、实验性 runner 和阻塞环境分别标注，不能放入正式支持表。

- [ ] **Step 5: 验证命令、链接和版本**

逐条运行 README 中的本地命令；检查相对链接、标题锚点、版本号、包名和路径。运行 README 契约测试和 `git diff --check`，预期全部通过。

- [ ] **Step 6: 提交用户文档**

```bash
git add README.md tests docs/decisions.md
git commit -m "docs: add skill usage and maintenance guide"
```

---

### Task 10: 按证据启用确定性脚本

**Files:**
- Create: `scripts/` only when enabled
- Create: 对应脚本测试
- Modify: `SKILL.md`
- Modify: `docs/skill-brief.md`

**Interfaces:**
- Consumes: 多个评测中重复出现的确定性工作或机械验证需求
- Produces: 可单独测试的脚本，或明确的禁用记录

- [ ] **Step 1: 检查脚本启用证据**

只有以下情况启用：至少两个独立案例重复实现相同辅助逻辑；任务需要精确解析、转换、渲染或验证；脚本能明显减少 Token、错误或重复代码。单次方便性不足以启用。

没有满足条件时，将 `scripts` 保持为 `disabled`，写入证据“核心工作流未出现重复确定性实现”，并跳过本任务其余步骤。

- [ ] **Step 2: 先定义脚本接口测试**

为命令行参数、标准输入、标准输出、退出码、错误消息、幂等性和异常输入写失败测试。脚本不得默认联网、扫描无关目录或修改输入文件。

- [ ] **Step 3: 实现最小脚本**

优先使用仓库现有运行时和结构化解析 API。输出机器可读数据时使用 JSON；用户错误和系统错误使用不同退出码或明确类别。复杂分支附近只添加解释约束、资源或非直观原因的维护注释。

- [ ] **Step 4: 在 Skill 中按条件调用**

`SKILL.md` 说明何时调用、输入来自哪里、如何解释结果以及失败时是否可退回 Agent 推理。不要把脚本源码或帮助全文复制到 Skill。

- [ ] **Step 5: 验证收益并提交**

重跑触发脚本的案例，比较错误率、Token 和耗时。没有可观察收益时删除脚本并恢复禁用状态。通过后提交：

```bash
git add scripts tests SKILL.md docs/skill-brief.md
git commit -m "feat: automate deterministic skill work"
```

---

### Task 11: 按需实现隐式自动触发

**Files:**
- Create: 全局规则模板资源 only when enabled
- Modify: Agent metadata only when supported
- Create or Modify: 规则契约与 smoke 测试
- Modify: `docs/skill-brief.md`

**Interfaces:**
- Consumes: 用户对无显式 Skill 名称任务的自动触发要求
- Produces: 最小常驻规则和真实隐式触发证据，或禁用结论

- [ ] **Step 1: 证明 description 不足或平台需要规则层**

使用不包含 Skill 名称和领域关键词堆叠的真实请求测试。只有用户要求稳定隐式触发且单靠标准发现不能满足时启用规则层。

用户未要求隐式触发，或 description 已满足验收时，将 `implicit-trigger` 保持为 `disabled`，记录评测证据并跳过本任务其余步骤。

- [ ] **Step 2: 编写最小规则模板**

规则只说明任务范围、何时加载目标 Skill、不可缺失的流程门和必要例外。业务算法、详细质量标准和示例仍只存在于 `SKILL.md`。

- [ ] **Step 3: 建立唯一托管标记**

若规则会写入共享文件，使用稳定且唯一的开始/结束标记。预检拒绝重复、残缺、逆序或不支持编码；保留标记外内容、BOM、主要换行和末尾换行。

- [ ] **Step 4: 运行真实 smoke**

在隔离临时仓库和虚构主目录中发送不含 Skill 名称的请求，验证 Agent 加载 Skill、执行目标工作流、产生真实交付物并报告最终验证。只观察最终文字不足以证明加载时，记录工具轨迹或其他可重复证据。

- [ ] **Step 5: 测量常驻预算并提交**

规则模板应明显短于主 Skill，且不重复核心算法。通过后提交：

```bash
git add resources tests docs/skill-brief.md
```

目标 Agent 确实需要独立 metadata 时，在提交前另行加入对应 metadata 文件；不得因为目录存在就批量提交无关 Agent 配置。

```bash
git commit -m "feat: add implicit skill activation"
```

---

### Task 12: 按需实现多 Agent 正式适配

**Files:**
- Create: 每个正式 Agent 的独立适配器
- Create: 适配器注册表与契约测试
- Create: 每个正式 Agent 的 live runner
- Modify: `README.md`
- Modify: `docs/skill-brief.md`

**Interfaces:**
- Consumes: 用户明确要求的 Agent 列表、每个平台当前官方约定
- Produces: 共享业务规则之上的薄适配层和逐平台真实证据

- [ ] **Step 1: 确认每个平台事实**

先检查 Skill Brief 是否明确要求多个 Agent 正式兼容。没有该要求时，将 `multi-agent` 保持为 `disabled`，记录标准 Skill 或单 Agent 已满足目标，并跳过本任务其余步骤。

需要正式兼容时，核对官方文档或已安装 CLI 的帮助：Skill 目录、规则文件、配置根环境变量、调用语法、headless 命令和输出协议。把来源日期和版本写入决策日志。

- [ ] **Step 2: 定义统一适配器接口**

每个适配器至少提供稳定 ID、别名、Skill 存储组、Skill 根目录、规则文件、调用表达和 live runner 配置。平台差异只进入适配器，业务规则由同一模板渲染。

- [ ] **Step 3: 先写路径和选择契约**

覆盖默认路径、环境覆盖、Windows/macOS/Linux、未知 ID、重复 ID、空 ID 和绝对路径验证。所有测试注入虚构 home，不读取真实用户配置。

- [ ] **Step 4: 实现适配器并运行确定性测试**

适配器不直接写文件；只计算路径、能力和渲染参数。共享存储组需要引用计数或等价所有权模型，局部卸载不能删除仍被其他 Agent 使用的 Skill 副本。

- [ ] **Step 5: 逐 Agent 运行真实评测**

每次命令显式选择一个 Agent。验证 CLI 存在、已登录、Skill 可发现、规则可加载和输出可归一化。缺少环境时该 Agent 状态为 `blocked` 或实验性，其他已验证 Agent 不受影响。

- [ ] **Step 6: 提供通用规则模板**

对未正式适配的 Agent，只提供平台无关模板和手工接入原则，README 明确“不属于正式支持”。

- [ ] **Step 7: 提交每个平台的独立变更**

每个 Agent 独立提交，便于回滚：

```bash
git add tests README.md docs/skill-brief.md
```

提交前按 Skill Brief 的路径映射逐个加入本次 Agent 的适配器、注册表和 runner 文件。实际提交信息使用目标 Agent 名称替换笼统表述。

```bash
git commit -m "feat: support selected agent"
```

---

### Task 13: 按需实现安装、诊断和卸载生命周期

**Files:**
- Create: CLI 入口和安装生命周期模块
- Create: 状态、托管区块、事务、锁和文本编码模块
- Create: 单元与集成测试
- Modify: `README.md`
- Modify: `docs/skill-brief.md`

**Interfaces:**
- Consumes: 多目录写入、全局规则或共享副本需求
- Produces: 幂等 `install`、只读 `doctor`、保守 `uninstall` 和可恢复状态

- [ ] **Step 1: 先定义 CLI 契约**

先确认交付是否需要写入多个 Skill 目录、共享规则或用户配置。只复制一个标准 Skill 目录即可完成目标时，将 `installer` 保持为 `disabled`，记录标准入口和手工移除方式，并跳过本任务其余步骤。

需要安装器时，最小命令为 `install`、`doctor`、`uninstall`、`--help` 和 `--version`。安装同时承担幂等升级；除非用户确有独立语义，不增加重复的 `update` 命令。

- [ ] **Step 2: 编写全生命周期失败测试**

覆盖首次安装、重复安装、局部安装、局部卸载、完整卸载、状态丢失诊断、外部所有权冲突、目录占位、重复或残缺标记、UTF-8 BOM、LF/CRLF、UTF-16、NUL、无效 UTF-8 和权限保留。

- [ ] **Step 3: 实现无副作用预检**

在内存中解析所有目标、读取现状、验证编码和所有权、生成期望内容。任一目标失败时不创建目录、不写临时文件、不更新状态。

- [ ] **Step 4: 实现事务提交与恢复**

暂存文件与目标位于同一文件系统；提交前创建必要备份；任一提交失败按相反顺序恢复。自动恢复失败时保留最后可用备份并报告路径，不能在清理阶段销毁人工恢复证据。

- [ ] **Step 5: 实现并发所有权**

安装器锁必须原子发布完整 owner，包含进程标识和随机令牌；只释放自己的锁。回收死锁前重新确认 owner 未变化，并使用恢复门阻止新持有者与回收者同时操作。

- [ ] **Step 6: 实现保守卸载和只读 doctor**

卸载只删除托管文件、托管区块和状态条目；无法证明共享副本无人使用时保留。`doctor` 不修改文件，逐目标报告 Skill、规则、状态、所有权、CLI 可见性和修复建议，不输出完整用户配置。

- [ ] **Step 7: 运行隔离集成测试**

所有故障注入覆盖暂存、提交、回滚和清理阶段。重复运行安装和卸载必须收敛到相同状态。Windows、macOS 和 Linux CI 至少运行确定性生命周期测试。

- [ ] **Step 8: 提交生命周期实现**

```bash
git add tests README.md docs/skill-brief.md
```

提交前逐个加入路径映射中的 CLI 和生命周期模块；Node 项目另行加入 `package.json` 与路径映射中识别出的现有锁文件。不得批量加入与安装器无关的源码目录，也不得引入第二种包管理器。

```bash
git commit -m "feat: add safe skill lifecycle management"
```

---

### Task 14: 完成安全、隐私和开源准备

**Files:**
- Create or Modify: `.gitignore`
- Create when public: `LICENSE`, `SECURITY.md`, `CONTRIBUTING.md`
- Create when public: Issue/PR templates and dependency update configuration
- Create or Modify: CI workflows
- Modify: `README.md`

**Interfaces:**
- Consumes: 所有交付文件、Git 历史、依赖和发布目标
- Produces: 无已知敏感泄露、最小权限、可公开审计的仓库

- [ ] **Step 1: 执行内容与路径扫描**

先探测仓库认可的安全工具。存在 Gitleaks 时对工作区和全部可达历史运行：

```bash
gitleaks dir . --no-banner --redact
gitleaks git . --no-banner --redact
```

不存在 Gitleaks 时，先使用环境中其他 secret scanner。仍无工具且 Node 可用时，在系统临时目录创建并运行以下回退扫描器；它只输出类别、提交和仓库相对路径，不输出匹配值：

```js
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const patterns = new Map([
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u],
  ['github-token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{70,})\b/u],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/u],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/u],
  ['authorization', /authorization\s*[:=]\s*['"]?(?:bearer|basic)\s+[A-Za-z0-9+/_=.-]{12,}/iu],
  ['credential-assignment', /(?:password|passwd|client_secret|api[_-]?key|access[_-]?token)\s*[:=]\s*['"][^'"\r\n]{8,}['"]/iu],
  ['private-path', /(?:[A-Z]:\\Users\\[^\\\s'"]+|\/Users\/[^/\s'"]+|\/home\/[^/\s'"]+)/iu],
  ['email', /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu],
]);

function git(args, encoding = 'utf8') {
  const result = spawnSync('git', args, { encoding, maxBuffer: 256 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr?.toString() || `git ${args[0]} failed`);
  return result.stdout;
}

function scan(label, content) {
  for (const [category, pattern] of patterns) {
    if (pattern.test(content)) console.log(`${category}:${label}`);
  }
}

for (const file of git(['ls-files', '-co', '--exclude-standard', '-z']).split('\0').filter(Boolean)) {
  scan(`worktree:${file}`, readFileSync(file).toString('utf8'));
}

for (const commit of git(['rev-list', '--all']).trim().split(/\r?\n/u).filter(Boolean)) {
  const files = git(['ls-tree', '-r', '--name-only', '-z', commit]).split('\0').filter(Boolean);
  for (const file of files) {
    scan(`${commit}:${file}`, git(['show', `${commit}:${file}`], 'buffer').toString('utf8'));
  }
}
```

将脚本以 `skill-secret-scan.mjs` 保存到操作系统临时目录，使用当前 shell 解析出的完整路径运行 Node，并在记录结果后删除临时脚本。非 Node 仓库使用现有运行时实现相同输入、模式和“只输出类别/位置”协议。命中的保留域名、虚构路径和占位符必须人工分类；禁止把原始匹配值写入终端、报告或模型提示。

同时检查未跟踪文件名中的 `.env`、证书、密钥、日志、状态和凭据文件。存在 Tag 或 GitHub Release 时，通过 API 下载说明和全部资产到临时目录并验证校验和。解压前先用 `tar -tf` 和 `tar -tvf` 检查：拒绝 `/`、`\`、盘符开头的绝对路径，拒绝任一路径段为 `..`，拒绝未经明确白名单允许的符号链接和硬链接，并核对异常 owner/group；只有检查通过才解压并使用同一规则扫描。删除 Release 不能代替 Git 历史扫描。

- [ ] **Step 2: 处理确认的敏感信息**

任一命中先区分保留域名、虚构路径、测试占位符和真实秘密。确认泄露后立即停止发布和推送，先撤销或轮换凭据，再记录传播面：工作区、提交历史、分支、Tag、Release 说明、资产、包注册表和 CI 日志。

清理必须覆盖全部传播面；历史重写、Tag 删除或 Release 删除属于不可逆操作，取得授权并创建仓库外恢复备份后执行。清理后重新扫描所有引用和资产，验证旧凭据失效，并通知协作者重新同步。只删除最早看到秘密的文件或 Release 不算完成。

- [ ] **Step 3: 清理示例身份**

测试邮箱使用 `example.invalid` 或保留域名；路径使用 `/home/tester`、`C:/Users/tester` 或 `$HOME`；提交身份使用项目认可的公开身份或 GitHub noreply。

- [ ] **Step 4: 检查依赖和外部动作**

删除无实际用途依赖。公开仓库的第三方 GitHub Actions 固定到完整提交 SHA，并保留版本注释；依赖更新只覆盖仓库实际使用的生态。

- [ ] **Step 5: 补齐最小治理**

README 先服务使用者；SECURITY 使用私密漏洞报告渠道，不公开个人邮箱；CONTRIBUTING 说明范围、环境、提交规范和验证命令。单维护者仓库不为了形式增加无收益的审批文件。

- [ ] **Step 6: 运行安全门**

至少运行：

```bash
git diff --check
git status --short
```

并使用仓库认可的依赖审计和静态分析。工具不可用时记录缺口，不能把未运行写成通过。

- [ ] **Step 7: 提交安全与治理文件**

```bash
git add .gitignore README.md
```

公开仓库再逐个加入实际创建的许可证、SECURITY、CONTRIBUTING、Issue/PR 模板、依赖更新和 CI 文件；私有 Skill 不创建形式化占位文件。

```bash
git commit -m "chore: harden skill repository"
```

私有且不发布的 Skill 只提交实际需要的安全修复和忽略规则。

---

### Task 15: 按需建立版本和 Release 维护

**Files:**
- Create or Modify: 版本清单和锁文件
- Create: `CHANGELOG.md`
- Create: 发布打包脚本 only when needed
- Create: Release 工作流 only when public releases are enabled
- Modify: `README.md`
- Modify: `docs/skill-brief.md`

**Interfaces:**
- Consumes: 已通过质量门的仓库、用户选择的分发入口
- Produces: 不可变版本、白名单资产、校验文件和安装验证

- [ ] **Step 1: 固定版本策略**

先确认用户是否要求公开仓库、固定版本安装或 GitHub Release。没有发布需求时，将 `open-source-release` 保持为 `disabled`，记录可通过本地路径或标准 Skill 入口使用，并跳过本任务其余步骤。

需要正式发布时，使用 Semantic Versioning 和 Conventional Commits。`fix`、`feat` 和 breaking change 分别驱动补丁、次版本和主版本；纯文档、测试和 CI 变更默认不单独升级版本。

- [ ] **Step 2: 建立发布包白名单**

只打包运行所需的 `SKILL.md`、元数据、资源、脚本和安装器文件。显式排除测试、评测工作区、状态、日志、设计文档、临时目录和凭据文件。运行 dry run 并人工核对每个条目。

- [ ] **Step 3: 从目标 Tag 构建**

Release 资产必须从将要发布的不可变 Tag 构建，而不是从漂移的默认分支工作区构建。生成 SHA-256 校验文件，校验文件只包含摘要和资产文件名，不包含本机绝对路径。

- [ ] **Step 4: 验证安装、升级和卸载**

从固定 Tag 或正式包入口在隔离环境验证实际分发路径。启用安装器时执行安装、重复升级、`doctor` 和卸载；未启用安装器时执行标准 Skills 安装或文档规定的目录复制、Agent 发现和安全移除。跨平台运行时项目至少在 Windows、macOS 和 Linux 验证确定性命令；若包只包含平台无关 Markdown，也要验证目标 Agent 能发现实际文件布局。

- [ ] **Step 5: 建立幂等 Release 流程**

Tag、Release 和资产部分成功时，重跑只能补齐完全缺失且能从同一 Tag 可复现为相同摘要的资产，不能移动已有 Tag，也不能替换内容不同的同名资产。发现摘要冲突时发布流程必须失败，修复内容后使用新版本。是否发布到 npm、PyPI 等注册表必须来自 Skill Brief，默认仅使用 GitHub Release 或标准 Skill 安装入口。

- [ ] **Step 6: 提交发布维护能力**

```bash
git add CHANGELOG.md README.md docs/skill-brief.md
```

提交前加入实际创建的发布脚本、工作流、版本清单和锁文件；未启用的分发入口不得产生空目录或占位配置。

```bash
git commit -m "chore: automate skill releases"
```

---

### Task 16: 执行最终追踪、独立复核和交付

**Files:**
- Create: `docs/delivery-report.md`
- Modify: `docs/skill-brief.md`
- Modify: `docs/decisions.md`
- Modify: 发现问题对应的实现、测试和文档文件

**Interfaces:**
- Consumes: 最新需求版本、所有启用轨道、完整 diff 和验证记录
- Produces: 可审计的成熟 Skill 交付和剩余风险说明

- [ ] **Step 1: 建立需求追踪矩阵**

`docs/delivery-report.md` 对每条验收标准列出实现位置、测试或评测证据、状态和说明。状态只使用 `passed`、`blocked` 或 `not-applicable`；`blocked` 必须说明为何仍可或不可交付。

- [ ] **Step 2: 重跑完整确定性门**

运行目标仓库的聚合 `check`、格式检查和安全扫描；只有启用发布包时才运行包 dry run。确认命令从干净依赖安装开始也能通过，且不会读写真实用户 Agent 配置。

- [ ] **Step 3: 重跑完整行为门**

如果 Task 7/8 后修改了 description、核心工作流、资源选择或正式适配器，重跑受影响评测；启用发布时运行完整评测和所有正式 Agent smoke。没有行为变化时校验最新评测证据对应当前 Skill 内容哈希并复用，不重复调用模型。付费或外部评测仍需显式授权；未授权时报告最后一次有效证据的日期和版本，不伪造本轮通过。

- [ ] **Step 4: 审查完整 diff 和未跟踪交付文件**

检查需求偏离、重复规则、失真文档、无效注释、非法格式写入、意外打包文件和私人信息。代码任务按目标仓库的注释政策审查实现意图；无需新增注释也记录审查结论。

- [ ] **Step 5: 请求独立复核**

让未参与实现的 Agent 只依据 Skill Brief、设计、diff 和测试结果审查：核心行为缺口、误触发、危险副作用、所有权、Token 回归、虚假兼容声明和缺失测试。先处理高严重度问题，再重跑受影响门。

- [ ] **Step 6: 完成自主性复现测试**

在新会话或隔离工作区中，让 Agent 只读取仓库 README、`SKILL.md` 和实际可用入口完成一个核心案例。公开发布时使用固定版本安装入口；私有或未发布 Skill 使用本地路径、标准 Skill 目录复制或仓库声明的内部入口。复现者不得依赖开发会话中的隐藏说明；失败表示文档、安装或 Skill 本体仍不完整。

- [ ] **Step 7: 写入最终交付报告**

报告必须包含：Skill 目标、需求版本、已启用轨道、未启用轨道及理由、确定性命令结果、行为评测增益、正式兼容范围、安全检查、适用的安装/升级/卸载方式和剩余风险。

- [ ] **Step 8: 完成最终提交**

```bash
git add docs/delivery-report.md docs/skill-brief.md docs/decisions.md
git diff --cached --check
git commit -m "feat: deliver production-ready skill"
```

Task 16 中发现并修复其他文件时，逐个审查后再显式加入暂存区。提交后运行 `git status --short --branch`，确认没有遗漏交付文件，也没有把用户无关改动纳入提交。

---

## 最终验收清单

- [ ] 最新用户要求全部进入当前 Skill Brief，没有继续使用已被覆盖的旧要求。
- [ ] `SKILL.md` 能被目标 Agent 发现，description 的正向和负向触发均有证据。
- [ ] 核心工作流、边界、失败策略和输出协议没有依赖开发会话中的隐藏上下文。
- [ ] 确定性 `check` 在支持平台重复通过，不调用模型且不修改真实用户配置。
- [ ] 有 Skill 相对基线产生可解释收益，没有以错误、副作用或显著 Token 回归换取表面通过率。
- [ ] 每条增强轨道都有启用证据或禁用理由，`blocked` 项有解除条件。
- [ ] 已启用的正式 Agent 和平台声明均有契约测试及真实运行证据；未启用时验收为 `not-applicable`。
- [ ] 启用安装器时，它只管理自己拥有的内容，并通过预检、事务、并发、回滚和保守卸载测试；未启用时验收为 `not-applicable`。
- [ ] 工作区没有已知敏感信息；存在 Git 历史、Tag 或 Release 时，对应传播面也已扫描。
- [ ] 启用发布时，发布包使用白名单，安装入口固定版本，Tag 不可变，校验和可复现；未启用时验收为 `not-applicable`。
- [ ] README、Skill 和测试一致；启用版本或 Release 时，相关信息也保持一致。
- [ ] 独立 Agent 能只依赖交付仓库完成核心任务和验证。
- [ ] 最终报告列出完成内容、未启用能力、验证证据和剩余风险。

## 需求变更恢复流程

执行期间收到新要求时，按以下顺序处理：

1. 标记当前步骤受影响，不继续扩大旧实现。
2. 将旧决策状态改为 `superseded`，新增一条 `active` 决策。
3. 更新 Skill Brief 的需求版本、验收标准和增强轨道状态。
4. 从最早受影响任务重新开始；只重做受影响产物。
5. 重跑受影响质量门，再执行 Task 16 的全量门。
6. 最终报告说明变更影响，不保留互相冲突的双重行为。

涉及删除、公开发布、历史重写、凭据或付费服务时，即使新要求很明确也先获得操作授权。
