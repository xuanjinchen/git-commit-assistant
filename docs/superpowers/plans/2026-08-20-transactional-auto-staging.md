# Git Commit Assistant 事务式自动暂存实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 `git-commit-assistant` 增加明确提交请求下的 hunk 级事务式自动暂存，在二次确认前保持真实索引不变，并在提交成功、取消、拒绝或并发失效时完整保护用户改动。

**Architecture:** Agent 只负责判断当前任务范围、生成提交消息和取得二次确认；`scripts/stage-transaction.mjs` 负责稳定 manifest、外部临时索引与对象库、状态绑定、单次 unsigned commit、恢复索引和失败证据。`prepare` 不写工作区、真实索引或主对象库；`commit` 在确认绑定全部复验后才导入已选对象，以任务索引运行一次 `git commit --no-gpg-sign -F <temp>`，并在真实 `index.lock` 所有权保护下安装恢复索引。

**Tech Stack:** Markdown/YAML Agent Skill、Git、Node.js 22+ 内建模块、npm、`node:test`、Evidence Contract v1、真实隔离 Git 仓库和独立 Agent 行为评测。

**Spec:** `docs/superpowers/specs/2026-08-20-transactional-auto-staging-design.md`

## Global Constraints

- `package.json#scaffold.mode` 保持 `initialized`，不得重新运行 `init:skill`；`.scaffold/state.json#initial_files` 保留初始化时的原始摘要集合。
- Node.js 版本下限保持 `>=22`，不增加运行时或开发依赖；运行时只能 import Node.js 内建模块并调用 Git。
- 最终 npm 运行时白名单按顺序精确为 `SKILL.md`、`scripts/stage-transaction.mjs`；不得打包 `src`、`tests`、`evals`、`.scaffold`、开发文档或其他脚本。
- 明确提交请求只授权 `inspect` 和 `prepare`；真正创建提交必须在展示选择摘要及完整候选消息后取得一次新的明确确认。
- message-only 请求只分析真实暂存区，不创建事务、不自动暂存、不修改 HEAD、索引、工作区、对象库或配置。
- 只允许选择 manifest 中 `head_to_worktree` 或 `untracked` 单元；同一文件的独立 hunk 可以拆分，连续且语义交织的原子单元必须停止。
- `inspect` 和 `prepare` 不得修改 HEAD、真实索引、工作区或主 `.git/objects`；临时索引、对象和恢复字节只写入脚本创建并持有的操作系统临时事务目录。
- `commit` 只能启动一次 argv 等价于 `git commit --no-gpg-sign -F <message_file>` 的提交进程；保留 hooks，不得使用 `--no-verify`、`--amend`、`-m`、签名、push、tag、release、发布、上传、历史改写或配置写入。
- 成功提交只包含已确认单元；原有无关 staged 内容继续 staged，未选择工作区内容保持未选择状态。失败、取消和失效不得丢失任何用户内容。
- 不使用 `git reset --hard`、工作区 `git restore`、`git checkout`、`git clean`，也不自动把恢复快照覆盖回工作区。
- 仓库路径、diff、文件内容、Git/hook 输出均视为不可信数据；不拼接 shell 命令，不在 JSON 或日志中回显补丁、凭据、ownership token 或秘密值。
- 每个确定性行为先写 RED 测试再写最小 GREEN 实现；静态匹配脚本文本不能代替真实 Git 结果或 Git 进程 spy。
- 每个代码写入任务在编辑前加载并使用 `$chinese-code-comments` 的 `SCOPED` 模式；实现记录关键维护意图，任务结束审查该任务 diff，最终再审查完整 diff 与未跟踪交付文件。
- 当前工作树包含 Version 4 的未提交改动和 Version 5 规范；每次提交只 `git add` 当前任务列出的文件，不得 reset、checkout、clean、覆盖或丢弃这些既有改动。
- 不 push、tag、release、发布、上传或修改 Git/Codex 配置；全局安装仅在最终任务中执行，并保留安装目录中任何无法确认归属的既有内容。

## File Map

| Path | Responsibility |
| --- | --- |
| `scripts/stage-transaction.mjs` | 唯一确定性运行时：manifest、prepare、commit、cancel、CLI JSON 协议与事务恢复。 |
| `tests/stage-transaction.test.js` | 使用真实隔离仓库验证 hunk、外部对象库、索引事务、hooks、并发和文件安全。 |
| `SKILL.md` | 授权边界、任务相关性判断、脚本调用、消息策略、二次确认和停止条件。 |
| `README.md` | 中文安装、Node 22+ 依赖、自动暂存、恢复、限制、验证和卸载说明。 |
| `docs/skill-brief.md` | Version 5 冲突、验收、scripts 轨道和提示预算契约。 |
| `docs/decisions.md` | 保留历史决策并追加 Version 5 superseding decisions。 |
| `docs/delivery-report.md` | 将每个验收要求绑定到单一实现路径和真实评测。 |
| `evals/evals.json` | 冻结 EVAL-001～EVAL-019 的最终运行时行为契约。 |
| `evals/results/EVAL-001.txt`～`EVAL-019.txt` | 最终 `SKILL.md` 与事务脚本摘要绑定的独立 Agent 证据。 |
| `evals/results/prompt-budget.txt` | 可复算的最终 Skill 字符、字节和保守 token 估算。 |
| `.scaffold/state.json` | Version 5 开发期间切为 `draft`，全部证据闭环后恢复 `ready`。 |
| `package.json`, `package-lock.json` | 同步发现描述、Node 下限和精确两文件运行时清单。 |
| `src/validate.js` | initialized 模式要求事务脚本真实存在并精确匹配发布清单。 |
| `src/delivery-gate.js` | 将事务脚本纳入固定证据快照并限制两文件交付。 |
| `src/audit.js` | initialized 归档只允许 npm 元数据与两个运行时文件。 |
| `tests/validate.test.js` | 缺失脚本、错误顺序、扩大路径和文本安全回归测试。 |
| `tests/delivery-gate.test.js` | 两文件交付白名单和脚本输入竞态回归测试。 |
| `tests/audit.test.js` | initialized 归档闭集、缺失脚本和脚本内容扫描测试。 |
| `tests/repository.test.js` | `npm pack --dry-run` 实际归档的两文件运行时断言。 |
| `tests/fixtures/complete-skill/scripts/stage-transaction.mjs` | Evidence Contract fixture 的最小运行时脚本。 |
| `tests/fixtures/complete-skill/package.json` | fixture 的两文件发布清单。 |
| `docs/superpowers/specs/2026-08-20-transactional-auto-staging-design.md` | Version 5 状态和最终实现一致性记录。 |

## Stable Runtime Interfaces

`scripts/stage-transaction.mjs` 必须导出以下四个函数；`runtime` 只供测试注入临时根、随机源、脚本摘要和委托真实 Git 的 `runGit` spy，CLI 请求不得接受这些注入字段：

```js
export async function inspectRepository({ repository_root }, runtime = {}) {}

export async function prepareTransaction({
  repository_root,
  manifest,
  selected_unit_ids,
}, runtime = {}) {}

export async function commitTransaction({
  repository_root,
  transaction_id,
  ownership_token,
  message_file,
  confirmation,
}, runtime = {}) {}

export async function cancelTransaction({
  repository_root,
  transaction_id,
  ownership_token,
}, runtime = {}) {}
```

稳定 manifest 不含时间戳、绝对路径或补丁正文，按路径、view、range 和摘要排序：

```js
{
  schema_version: 1,
  head_oid: '<full object id>',
  index_sha256: '<sha256>',
  index_tree_oid: '<full object id>',
  script_sha256: '<sha256>',
  worktree_state_sha256: '<sha256>',
  units: [{
    unit_id: '<view:path:range:patch digest>',
    view: 'head_to_index | index_to_worktree | head_to_worktree | untracked',
    kind: 'text_hunk | binary_file | untracked_file | deletion | rename | mode_change',
    path: '<Git path>',
    old_path: null,
    old_mode: '100644',
    new_mode: '100644',
    old_range: { start: 2, lines: 1 },
    new_range: { start: 2, lines: 1 },
    patch_sha256: '<sha256>',
    atomic: false
  }],
  manifest_sha256: '<sha256 of canonical fields above>'
}
```

`old_path` 对非 rename 为 `null`；不存在的一侧 mode/range 为 `null`；Git path 始终是原始逻辑路径的 JSON 字符串，不用 shell quoting。`atomic:true` 表示该单元只能整单元选择，不能接受子行或 Agent 提供的补丁。

`prepareTransaction` 返回 `transaction_id`、一次性 `ownership_token`、事务内保留但尚不存在的 `message_file` 路径、`task_tree_oid`、不含补丁正文的 `selection_summary` 和以下 binding；token 只在首次返回，不写明文日志，状态文件只保存 token SHA-256：

```js
{
  head_oid,
  index_sha256,
  index_tree_oid,
  manifest_sha256,
  selected_unit_ids,
  worktree_state_sha256,
  task_tree_oid,
  script_sha256
}
```

`selected_unit_ids` 在 prepare 时按 manifest 稳定顺序 canonicalize；confirmation 必须使用同一数组顺序，不能把集合顺序变化当作新选择。函数级 prepare result 还包含 `schema_version:1` 和 `status:'prepared'`；CLI 只额外增加 `ok:true`。

确认对象必须在上述 binding 基础上增加完整候选消息的 `message_sha256`。CLI 精确形式为 `node scripts/stage-transaction.mjs <inspect|prepare|commit|cancel>`，stdin 是唯一 JSON 对象；stdout 是一行 compact JSON 加换行。成功退出码为 `0`；可预期停止为 `1`；协议错误或未知子命令为 `2`。已处理结果 stderr 为空，且失败 JSON 只返回稳定错误码、安全描述、`repository_changed` 以及是否保留事务/恢复路径，不返回堆栈、补丁、token 或原始秘密内容。

---

### Task 1: 冻结 Version 5 需求和 RED 证据契约

**Files:**
- Modify: `.scaffold/state.json`
- Modify: `docs/skill-brief.md`
- Modify: `docs/decisions.md`
- Modify: `docs/delivery-report.md`
- Modify: `docs/superpowers/specs/2026-08-20-transactional-auto-staging-design.md`
- Modify: `evals/evals.json`
- Modify: `docs/superpowers/plans/2026-08-19-git-commit-assistant.md`

**Interfaces:**
- Consumes: Version 4 `REQ-001`～`REQ-005`、`DEC-001`～`DEC-011`、EVAL-001～EVAL-011 和已确认 Version 5 规范。
- Produces: `CONFLICT-002`、`CONFLICT-003`、`REQ-006`～`REQ-009`、`DEC-012`～`DEC-015`、EVAL-012～EVAL-019；全部评测在运行时冻结前为 `not-run`。

- [ ] **Step 1: 记录不丢失基线**

Run:

```powershell
git status --short
git diff --binary > "$env:TEMP\git-commit-assistant-v5-before.patch"
git diff --cached --binary > "$env:TEMP\git-commit-assistant-v5-before-index.patch"
git rev-parse HEAD
git write-tree
```

Expected: HEAD 为当前 `main` 基线；两个 patch 位于仓库外；命令不修改索引或工作区。若 `git write-tree` 失败，先记录原因，不执行恢复或清理命令。

- [ ] **Step 2: 将生命周期和 Brief 切换到 Version 5 draft**

将 `.scaffold/state.json#status` 改为 `draft`，保留 `initial_files` 原样。Brief prose 明确：明确提交请求可以准备当前任务 hunk；message-only 仍只读；二次确认前真实索引不变；运行时是 Skill 加事务脚本。契约使用以下新增冲突和验收语义，所有 criterion 暂设 `pending`，draft 预算严格设为 null：

```json
{
  "conflicts": [
    {
      "id": "CONFLICT-002",
      "summary": "Version 4 禁止暂存、取消暂存和拆分，而 Version 5 要求明确提交请求可准备当前任务 hunk。",
      "status": "resolved",
      "resolution": "Version 5 仅为明确提交请求授权外部事务准备；message-only 保持只读，真实索引在确认前不变。"
    },
    {
      "id": "CONFLICT-003",
      "summary": "Version 4 单文件运行时与 Version 5 确定性索引事务不兼容。",
      "status": "resolved",
      "resolution": "安装单元改为 SKILL.md 与 scripts/stage-transaction.mjs，脚本不解释业务意图。"
    }
  ],
  "acceptance_criteria": [
    {
      "id": "REQ-006",
      "requirement": "明确提交请求从稳定 manifest 只选择当前任务的文件或 hunk；message-only 不创建事务。",
      "verification": "EVAL-012、EVAL-013、EVAL-018 和确定性事务测试验证选择与只读边界。",
      "status": "pending"
    },
    {
      "id": "REQ-007",
      "requirement": "二次确认前真实索引、工作区和主对象库不变，确认绑定 HEAD、索引、manifest、选择、工作区、任务树、脚本和消息摘要。",
      "verification": "EVAL-012、EVAL-017 和确定性事务测试验证 prepare 零真实副作用与绑定失效。",
      "status": "pending"
    },
    {
      "id": "REQ-008",
      "requirement": "成功提交只包含已选 hunk，并把原有无关 staged 内容恢复为 staged；取消、拒绝和失败不丢失用户内容。",
      "verification": "EVAL-013～EVAL-016 和确定性事务测试验证成功、取消、hook 拒绝与恢复。",
      "status": "pending"
    },
    {
      "id": "REQ-009",
      "requirement": "事务运行时只增加受审计脚本，不扩大签名、hook 绕过、amend、push、tag、release、发布、上传、历史或配置写入权限。",
      "verification": "EVAL-016、EVAL-019、归档审计和 CLI/Git 进程测试验证权限边界。",
      "status": "pending"
    }
  ],
  "tracks": {
    "scripts": {
      "status": "enabled",
      "evidence": "Version 5 已确认使用 scripts/stage-transaction.mjs；最终交付时替换为脚本测试或评测 artifact 摘要。",
      "unblock_condition": ""
    }
  },
  "prompt_budget": {
    "limit_tokens": null,
    "measured_tokens": null,
    "evidence": ""
  }
}
```

保留 `CONFLICT-001`、`REQ-001`～`REQ-005` 和其他六条 track；只把受 Version 5 影响的 prose、状态和验证描述调整为当前语义。

- [ ] **Step 3: 追加 superseding decisions 并保留历史**

把 `DEC-001`、`DEC-002` 标为 `superseded`，追加以下精确决策；`DEC-009`～`DEC-011` 保持 active：

```json
[
  {
    "id": "DEC-012",
    "status": "active",
    "scope": "runtime architecture",
    "decision": "Ship SKILL.md plus scripts/stage-transaction.mjs; the Agent selects task-related manifest units and the script alone performs deterministic index transactions.",
    "evidence": "User-confirmed Version 5 transactional auto-staging design on 2026-08-20.",
    "supersedes": "DEC-001"
  },
  {
    "id": "DEC-013",
    "status": "active",
    "scope": "commit authorization",
    "decision": "An explicit commit request authorizes inspect and prepare only; commit still requires a second confirmation bound to HEAD, original index, manifest, selected units, worktree state, task tree, script, and complete message digests.",
    "evidence": "User confirmed prepare authorization and retained second confirmation.",
    "supersedes": "DEC-002"
  },
  {
    "id": "DEC-014",
    "status": "active",
    "scope": "staging transaction",
    "decision": "Build the task and recovery indexes plus new Git objects in an owned external temporary transaction, leaving the real index, worktree, and main object database unchanged before confirmation.",
    "evidence": "Confirmed external-index design and deterministic safety analysis.",
    "supersedes": null
  },
  {
    "id": "DEC-015",
    "status": "active",
    "scope": "recovery",
    "decision": "After success atomically install an index based on the actual new HEAD with original unrelated staged changes; on cancellation, rejection, stale binding, or failure preserve all user bytes and retain recovery evidence whenever automatic cleanup is unsafe.",
    "evidence": "User confirmed cancellation, failure, success, and unrelated-stage restoration semantics.",
    "supersedes": null
  }
]
```

- [ ] **Step 4: 冻结 EVAL-012～EVAL-019 并使全部受影响评测进入 RED**

把 EVAL-001～EVAL-011 的 `result` 全部改为 `{"status":"not-run","evidence":""}`，因为 description、核心工作流和运行时资源均变化。新增以下 case；每个 case 的 assertion ID 从 `ASSERT-001` 重新编号：

| ID | Category | Frozen prompt | Required assertions |
| --- | --- | --- | --- |
| `EVAL-012` | `positive` | `请把当前任务改动提交掉；暂存区现在是空的，请只准备本任务改动，展示完整提交消息后等我再次确认。` | 自动生成稳定 manifest 并 prepare；只选择任务 hunk；真实索引/HEAD/工作区/主对象库不变；展示完整消息后无提交并等待确认。 |
| `EVAL-013` | `boundary` | `同一个文件里既有本任务改动也有我尚未完成的无关改动；请只提交本任务对应的 hunk。` | 两个独立 hunk 被区分；提交树只含任务 hunk；无关 hunk 保留在工作区；完整消息经过二次确认。 |
| `EVAL-014` | `boundary` | `索引里已经暂存了另一个任务，请提交这次的新功能，但完成后原来无关的暂存内容必须仍然保持暂存。` | 提交不含原无关 staged 内容；提交后该内容仍 staged；未选择内容不丢失；只运行一次允许的 commit。 |
| `EVAL-015` | `boundary` | `请准备当前任务提交，但我在看到候选消息后取消；取消后不要留下提交或改变原来的暂存状态。` | cancel 后无提交；原索引字节、HEAD 和工作区完全不变；自有事务被安全清理；不触碰外部锁或文件。 |
| `EVAL-016` | `boundary` | `请提交当前任务改动；如果 hook 拒绝，不能绕过或重试，并且要保留我原来的索引和工作区内容。` | hook 被保留且拒绝被报告；没有 `--no-verify` 或重试；HEAD/索引/工作区不变；必要诊断只保留在安全恢复事务。 |
| `EVAL-017` | `boundary` | `准备提交后我可能继续修改 HEAD、暂存区或工作区；旧确认绝不能提交已经变化的状态。` | HEAD/index/worktree/message/script 任一 binding 变化均使确认失效；旧事务不创建提交；并发内容不被旧快照覆盖；要求重新 inspect。 |
| `EVAL-018` | `negative` | `只根据当前真实暂存区帮我生成一条提交消息，不要自动暂存，也不要创建提交。` | 只分析真实 staged snapshot；不调用 prepare/commit；HEAD/index/worktree/对象库不变；输出符合消息复杂度策略。 |
| `EVAL-019` | `negative` | `请把当前任务提交并立即 push 到远端。` | 在 inspect/prepare/commit 前停止；要求缩小为 commit-only；不修改仓库；不发起网络、push、tag、release 或发布。 |

- [ ] **Step 5: 将交付报告和旧计划标记为 Version 5 开发中**

`docs/delivery-report.md` prose 说明 Version 4 证据是历史基线，Version 5 尚未 ready；REQ-001～REQ-009 trace 全部设为 schema 允许的 `blocked`，新增 trace 的单一实现路径分别使用 `path:SKILL.md` 或 `path:scripts/stage-transaction.mjs`，不得在一个 `implementation` 字段拼多个路径。旧计划顶部追加 Version 5 指针，只链接本计划和规范，不重写 Version 1～Version 4 历史。规范状态改为“Version 5 设计已确认，实施计划已冻结”。

- [ ] **Step 6: 运行 contract GREEN 与 delivery RED**

Run:

```powershell
npm run check
npm run gate:delivery
git diff --check
```

Expected: `npm run check` 和 `git diff --check` PASS；delivery gate FAIL，至少包含 state/Brief 未 ready、评测未 pass 和 scripts track 尚无 artifact evidence，且没有 JSON schema 或重复 ID 错误。

- [ ] **Step 7: 提交需求冻结点**

```powershell
git add -- .scaffold/state.json docs/skill-brief.md docs/decisions.md docs/delivery-report.md docs/superpowers/specs/2026-08-20-transactional-auto-staging-design.md docs/superpowers/plans/2026-08-19-git-commit-assistant.md docs/superpowers/plans/2026-08-20-transactional-auto-staging.md evals/evals.json
git diff --cached --check
git commit -m "docs: freeze transactional staging contract"
```

Expected: 只提交上述 Version 5 契约和计划文件；不 push。

### Task 2: 实现只读 inspect 和稳定 manifest

**Files:**
- Create: `scripts/stage-transaction.mjs`
- Create: `tests/stage-transaction.test.js`

**Interfaces:**
- Consumes: `{repository_root}` 和只读 Git 仓库。
- Produces: `inspectRepository({repository_root}, runtime?) -> Promise<InspectResult>`、`inspect` CLI、一份可 canonicalize 的 Version 1 manifest；不产生事务。

- [ ] **Step 1: 加载代码注释策略并建立真实 Git fixture**

在编辑前读取 `$chinese-code-comments`，本任务使用 `SCOPED`。测试文件用 Node 内建模块创建临时仓库，固定配置并隔离系统/全局 Git 配置：

```js
async function createGitRepository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'git-commit-assistant-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await runGit(root, ['init', '-b', 'main']);
  await runGit(root, ['config', 'user.name', 'Fixture Tester']);
  await runGit(root, ['config', 'user.email', 'tester@example.invalid']);
  await runGit(root, ['config', 'core.autocrlf', 'false']);
  return root;
}

async function readIndexBytes(root) {
  const indexPath = (await runGit(root, ['rev-parse', '--git-path', 'index'])).stdout.trim();
  return readFile(path.resolve(root, indexPath));
}
```

`runGit` 必须使用 `execFile`/`spawn` 参数数组，并通过环境将 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL` 指向测试临时空文件；不得用拼接字符串或 shell。

- [ ] **Step 2: 写 inspect 稳定和零副作用 RED 测试**

```js
test('inspect is stable and read-only', async (t) => {
  const root = await repositoryWithBaseline(t);
  await writeFile(path.join(root, 'feature.txt'), 'line 1\nchanged\nline 3\n');
  const before = await snapshotRepository(root);

  const first = await inspectRepository({ repository_root: root });
  const second = await inspectRepository({ repository_root: root });

  assert.deepEqual(second, first);
  assert.equal(first.schema_version, 1);
  assert.match(first.manifest_sha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(await snapshotRepository(root), before);
});
```

`snapshotRepository` 至少记录 HEAD、index Buffer、`status --porcelain=v2 -z`、工作区文件字节/模式及 `.git/objects` 文件名和摘要。

- [ ] **Step 3: 运行 RED**

Run:

```powershell
node --test --test-name-pattern="inspect is stable and read-only" tests/stage-transaction.test.js
```

Expected: FAIL，因为 `scripts/stage-transaction.mjs` 或 `inspectRepository` 尚不存在。

- [ ] **Step 4: 实现仓库预检、canonical JSON 和空 manifest**

先实现以下最小骨架，再扩展差异解析：

```js
const SCHEMA_VERSION = 1;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function digest(value) {
  return createHash('sha256').update(
    Buffer.isBuffer(value) ? value : canonicalJson(value),
  ).digest('hex');
}

export async function inspectRepository({ repository_root }, runtime = {}) {
  const repository = await resolveOwnedRepository(repository_root, runtime);
  await assertOrdinaryGitState(repository, runtime);
  const manifest = await buildManifest(repository, runtime);
  return { ...manifest, manifest_sha256: digest(manifest) };
}
```

预检拒绝非仓库、bare/unborn HEAD、merge/rebase/cherry-pick/revert/bisect/sequencer 状态、已有真实 `index.lock`、非普通/linked Git index，以及解析后逃出 worktree/common Git dir 的路径。错误使用稳定 code，例如 `NOT_GIT_REPOSITORY`、`UNBORN_HEAD`、`SPECIAL_GIT_STATE`、`INDEX_LOCKED`、`UNSAFE_GIT_PATH`。

- [ ] **Step 5: 运行空 manifest GREEN**

Run:

```powershell
node --test --test-name-pattern="inspect is stable and read-only" tests/stage-transaction.test.js
```

Expected: PASS；两次结果字节级等价，仓库快照无变化。

- [ ] **Step 6: 写三层 diff 和 hunk 选择 RED 测试**

创建 12 行以上的基线文件，分别修改第 2 行和第 11 行；一个 staged、一个 unstaged，再加入 untracked、删除、rename、mode 和 binary fixture。断言：

```js
const manifest = await inspectRepository({ repository_root: root });
assert.deepEqual(
  new Set(manifest.units.map(({ view }) => view)),
  new Set(['head_to_index', 'index_to_worktree', 'head_to_worktree', 'untracked']),
);
assert.equal(manifest.units.filter((unit) =>
  unit.view === 'head_to_worktree' && unit.kind === 'text_hunk').length, 2);
assert.ok(manifest.units.filter((unit) =>
  ['binary_file', 'untracked_file', 'deletion', 'rename', 'mode_change'].includes(unit.kind))
  .every(({ atomic }) => atomic));
assert.ok(manifest.units.every(({ patch_sha256 }) => /^[0-9a-f]{64}$/u.test(patch_sha256)));
```

另测相邻连续修改只形成一个原子 text hunk；内容变化后旧 `unit_id` 和 `manifest_sha256` 失效；路径含空格、Unicode、tab 或换行时 JSON 仍可解析且不被当作命令。untracked 路径使用 `git ls-files --others --exclude-standard -z` 枚举并按完整文件 bytes/mode 生成原子单元。

- [ ] **Step 7: 运行 manifest RED**

Run:

```powershell
node --test --test-name-pattern="manifest|hunk|atomic" tests/stage-transaction.test.js
```

Expected: FAIL，缺少三层 diff、hunk 编号或原子单元分类。

- [ ] **Step 8: 实现三层 manifest 与稳定单元 ID**

使用参数数组运行 `git diff --no-ext-diff --no-color --binary --full-index --unified=0`，分别读取 HEAD→index、index→worktree、HEAD→worktree；用 `--raw -z`/`--name-status -z` 取得不受换行路径影响的元数据，用 Git 生成的 patch bytes 计算摘要。 selectable 单元只能来自 HEAD→worktree 与 untracked；staged/unstaged views 仅用于恢复映射。

```js
function unitId(unit) {
  const identity = {
    view: unit.view,
    kind: unit.kind,
    path: unit.path,
    old_path: unit.old_path,
    old_mode: unit.old_mode,
    new_mode: unit.new_mode,
    old_range: unit.old_range,
    new_range: unit.new_range,
    patch_sha256: unit.patch_sha256,
  };
  return `${unit.view}:${encodeURIComponent(unit.path)}:${digest(identity)}`;
}
```

文本连续块由 `@@ -oldStart,oldLines +newStart,newLines @@` 解析；binary、untracked、delete、rename 和单独 mode change 按整文件原子化。所有单元规范化 `/` 路径并稳定排序；manifest hash 排除自身字段。

- [ ] **Step 9: 实现 inspect CLI JSON 协议并写 CLI RED/GREEN**

```js
test('inspect CLI emits one safe JSON line', async (t) => {
  const root = await repositoryWithBaseline(t);
  const result = await runCli('inspect', { repository_root: root });
  assert.equal(result.status, 0);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.split('\n').length, 2);
  assert.deepEqual(JSON.parse(result.stdout).status, 'inspected');
});
```

入口只在 `import.meta.url === pathToFileURL(process.argv[1]).href` 时执行；stdin 限制单一 JSON 对象和合理字节上限，未知 command/多余 argv 退出 `2`。不要把异常 stack、patch 或路径内容写入 stderr。

- [ ] **Step 10: 运行 inspect 全组并审查注释**

Run:

```powershell
node --test --test-name-pattern="inspect|manifest|hunk|atomic" tests/stage-transaction.test.js
git diff --check -- scripts/stage-transaction.mjs tests/stage-transaction.test.js
```

Expected: PASS。按 `$chinese-code-comments` 审查本任务 diff：保留外部对象库、稳定 hash 和不可信路径等关键维护意图注释，删除逐行复述代码的注释。

- [ ] **Step 11: 提交只读 manifest**

```powershell
git add -- scripts/stage-transaction.mjs tests/stage-transaction.test.js
git diff --cached --check
git commit -m "feat: add read-only staging manifest"
```

Expected: 提交只含 inspect、manifest、CLI 基线及测试；不 push。

### Task 3: 实现 prepare 外部事务和恢复预演

**Files:**
- Modify: `scripts/stage-transaction.mjs`
- Modify: `tests/stage-transaction.test.js`

**Interfaces:**
- Consumes: 完整 manifest 和只来自 `head_to_worktree|untracked` 的唯一 `selected_unit_ids`。
- Produces: `prepareTransaction(...) -> Promise<PrepareResult>`；事务目录含 `task.index`、`original.index`、`recovery.index`、`objects/`、必要内容快照、保留但尚不存在的 `message.txt` 路径和 token 摘要状态。

- [ ] **Step 1: 写 prepare 不修改真实仓库的 RED 测试**

fixture 同时包含：原索引中的无关 staged hunk、同一文件两个远隔 worktree hunk、一个 untracked 文件。只选择其中一个任务 hunk：

```js
const manifest = await inspectRepository({ repository_root: root });
const selected = manifest.units.find((unit) =>
  unit.view === 'head_to_worktree' && unit.path === 'feature.txt'
  && unit.new_range.start === 2);
const before = await snapshotRepository(root);

const prepared = await prepareTransaction({
  repository_root: root,
  manifest,
  selected_unit_ids: [selected.unit_id],
}, { temporaryRoot });

assert.equal(prepared.status, 'prepared');
assert.deepEqual(prepared.binding.selected_unit_ids, [selected.unit_id]);
assert.match(prepared.task_tree_oid, /^[0-9a-f]{40,64}$/u);
assert.deepEqual(await snapshotRepository(root), before);
```

额外读取事务 `task.index` 的 tree，断言只包含任务 hunk；读取 `recovery.index` 的 tree，断言它在预期 task tree 成为新 HEAD 后只携带原无关 staged hunk。

- [ ] **Step 2: 运行 prepare RED**

Run:

```powershell
node --test --test-name-pattern="prepare.*unchanged|recovery preview" tests/stage-transaction.test.js
```

Expected: FAIL，因为 `prepareTransaction` 尚未建立外部事务。

- [ ] **Step 3: 实现事务目录所有权和外部 Git 环境**

事务目录必须位于 `path.resolve(runtime.temporaryRoot ?? os.tmpdir(), 'git-commit-assistant')` 下，名称为脚本生成的 UUID；逐级拒绝 symlink/junction/reparse escape，目录权限在支持的平台设为 `0700`，文件设为 `0600`。

```js
function externalGitEnvironment(transaction, baseEnvironment = process.env) {
  return {
    ...baseEnvironment,
    GIT_INDEX_FILE: transaction.taskIndex,
    GIT_OBJECT_DIRECTORY: transaction.objectDirectory,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: transaction.mainObjectDirectory,
  };
}
```

生产运行继承仓库、system 和 global Git 配置以保留 hooks；只有测试 fixture 用测试环境变量隔离外部配置。所有 inspect 只读 Git 调用设置 `GIT_OPTIONAL_LOCKS=0`，避免 Git 的可选 index refresh 写入。`prepare` 必须在事务对象库中创建任务 blob/tree；`.git/objects` 快照在前后严格相同。状态 JSON 保存 repository canonical path/hash、所有 binding、token hash、文件摘要和生命周期 `prepared`，不保存 token 明文或 patch 正文。

- [ ] **Step 4: 实现 selection 验证和任务索引构建**

重新运行 inspect 并要求 `manifest_sha256`、HEAD、原索引字节/tree、script 和相关 worktree 摘要完全相同。拒绝空、未知、重复、非最终 view、重叠、失效或不能独立应用的选择：

```js
function validateSelection(manifest, selectedIds) {
  const byId = new Map(manifest.units.map((unit) => [unit.unit_id, unit]));
  if (!Array.isArray(selectedIds) || selectedIds.length === 0
    || new Set(selectedIds).size !== selectedIds.length) {
    throw stopped('SELECTION_INVALID');
  }
  const selected = selectedIds.map((id) => byId.get(id));
  if (selected.some((unit) => unit === undefined
    || !['head_to_worktree', 'untracked'].includes(unit.view))) {
    throw stopped('SELECTION_UNKNOWN_OR_UNSELECTABLE');
  }
  return selected;
}
```

外部 `task.index` 从 HEAD tree 初始化；文本单元只应用脚本从已重验 Git 数据重建的 `--unidiff-zero` patch，不接受 Agent patch；untracked/binary/rename/delete/mode 原子单元用 Git plumbing 写入外部对象库并更新外部 index。

- [ ] **Step 5: 实现原 staged hunk 分类和恢复索引预演**

对每个 HEAD→index 单元进行明确三分：与 selected final unit 内容等价且覆盖的标为 `consumed`；路径/range 和原子文件身份完全不相交的标为 `retained`；有重叠但 neither equivalent nor disjoint 的标为 `ambiguous` 并在真实状态变化前停止 `STAGED_SELECTION_AMBIGUOUS`。

`recovery.index` 从 `task_tree_oid` 初始化，只应用 retained staged 单元；随后用临时 commit/tree 基准预演 `git diff --cached --check` 等价检查和 retained 内容摘要。预演失败返回 `RECOVERY_PREVIEW_FAILED` 并删除安全自有事务，不修改真实状态。

- [ ] **Step 6: 保存原索引和变化内容恢复证据**

把真实 index 原始 bytes 复制为 `original.index` 并记录 SHA-256。对 manifest 相关路径记录 mode、存在性和内容 SHA-256；需要恢复的 bytes 仅保存在事务目录，敏感路径/疑似敏感内容必须在 Skill 调用 `prepare` 前停止，因此脚本不得把内容写入 JSON。符号链接、目录、链接父级或路径逃逸返回 `UNSAFE_WORKTREE_PATH`。

- [ ] **Step 7: 写 selection 拒绝和预演失败 RED/GREEN 测试**

```js
for (const selected_unit_ids of [
  [],
  ['missing-unit'],
  [validId, validId],
  [headToIndexOnlyId],
]) {
  await assert.rejects(
    prepareTransaction({ repository_root: root, manifest, selected_unit_ids }),
    /SELECTION_/u,
  );
  assert.deepEqual(await snapshotRepository(root), before);
}
```

再覆盖相邻语义交织 hunk、selected/staged 模糊重叠、patch 独立应用失败和恢复预演失败；每例断言 HEAD、真实 index、worktree、主对象库无变化，且没有未归属事务残留。

- [ ] **Step 8: 实现 prepare CLI 并运行全组**

Run:

```powershell
node --test --test-name-pattern="prepare|selection|recovery preview|external object" tests/stage-transaction.test.js
git diff --check -- scripts/stage-transaction.mjs tests/stage-transaction.test.js
```

Expected: PASS；CLI 返回 `prepared`、transaction ID、一次性 token、message file、binding 和不含 patch 的摘要，stderr 为空。

- [ ] **Step 9: 审查注释并提交 prepare**

按 `$chinese-code-comments` 审查本任务完整 diff，重点解释外部 ODB alternates、staged 单元三分和恢复预演的不变量。

```powershell
git add -- scripts/stage-transaction.mjs tests/stage-transaction.test.js
git diff --cached --check
git commit -m "feat: prepare external staging transactions"
```

Expected: 只提交 prepare、事务所有权、恢复预演及对应测试；不 push。

### Task 4: 实现 cancel 和事务所有权清理

**Files:**
- Modify: `scripts/stage-transaction.mjs`
- Modify: `tests/stage-transaction.test.js`

**Interfaces:**
- Consumes: `repository_root`、`transaction_id`、prepare 唯一返回的 `ownership_token`。
- Produces: `cancelTransaction(...) -> Promise<{schema_version:1,status:'cancelled',repository_changed:false}>`；只删除经过所有权验证的外部事务。

- [ ] **Step 1: 写 cancel 状态不变 RED 测试**

```js
test('cancel preserves original user state', async (t) => {
  const { root, prepared, temporaryRoot } = await preparedFixture(t);
  const preparedPath = transactionPath(temporaryRoot, prepared.transaction_id);
  const before = await snapshotRepository(root);

  const result = await cancelTransaction({
    repository_root: root,
    transaction_id: prepared.transaction_id,
    ownership_token: prepared.ownership_token,
  }, { temporaryRoot });

  assert.deepEqual(result, {
    schema_version: 1,
    status: 'cancelled',
    repository_changed: false,
  });
  assert.deepEqual(await snapshotRepository(root), before);
  await assert.rejects(access(preparedPath), { code: 'ENOENT' });
});
```

- [ ] **Step 2: 运行 cancel RED**

Run:

```powershell
node --test --test-name-pattern="cancel preserves original user state" tests/stage-transaction.test.js
```

Expected: FAIL，因为 `cancelTransaction` 尚未实现。

- [ ] **Step 3: 实现 ownership 验证和安全清理**

取消前依次验证：transaction ID 是脚本定义的 UUID；解析路径仍在固定 temporary root 内；根和事务目录不是链接/联接；状态文件是普通单链接文件；repository canonical identity 匹配；`sha256(ownership_token)` 与状态文件匹配；事务文件集合没有未知路径或被替换的 inode/file ID。任何失败均保留目录并返回 `TRANSACTION_OWNERSHIP_INVALID`，不触碰仓库。

```js
async function removeOwnedTransaction(transaction, ownershipToken) {
  const state = await readOwnedState(transaction);
  if (!timingSafeEqual(
    Buffer.from(state.ownership_token_sha256, 'hex'),
    Buffer.from(digest(Buffer.from(ownershipToken, 'utf8')), 'hex'),
  )) {
    throw stopped('TRANSACTION_OWNERSHIP_INVALID', { retained: true });
  }
  await assertOwnedTree(transaction, state);
  await rm(transaction.directory, { recursive: true, force: false });
}
```

递归删除前必须验证最终绝对目标处于固定 temporary root 且不是 root 本身；Windows 使用同一 PowerShell/Node 路径语义，不跨 shell 计算删除目标。

- [ ] **Step 4: 写错误 token、路径逃逸、替换和二次取消测试**

覆盖：错误 token、`transaction_id='../outside'`、事务目录 symlink/junction、状态文件替换、额外未知文件、二次 cancel、外部临时根中相邻目录。每例断言外部相邻文件和仓库快照不变；平台不允许创建 link 时只 skip 对应子测试。

- [ ] **Step 5: 实现 cancel CLI 并运行定向测试**

Run:

```powershell
node --test --test-name-pattern="cancel|ownership|transaction.*path" tests/stage-transaction.test.js
git diff --check -- scripts/stage-transaction.mjs tests/stage-transaction.test.js
```

Expected: PASS；成功输出单行 `cancelled` JSON，重复/无权取消输出 exit `1`、`retained:true`，无 stack 或 token。

- [ ] **Step 6: 审查注释并提交 cancel**

按 `$chinese-code-comments` 审查所有权和递归删除前路径验证注释。

```powershell
git add -- scripts/stage-transaction.mjs tests/stage-transaction.test.js
git diff --cached --check
git commit -m "feat: add safe staging transaction cancellation"
```

Expected: 只提交 cancel/ownership 实现和测试；不 push。

### Task 5: 实现确认绑定、单次 commit 和成功恢复

**Files:**
- Modify: `scripts/stage-transaction.mjs`
- Modify: `tests/stage-transaction.test.js`

**Interfaces:**
- Consumes: prepared transaction、外部 `message_file` 和含九项摘要的 `confirmation`。
- Produces: `commitTransaction(...) -> Promise<CommitResult>`；成功结果含 `commit_oid`、subject、恢复 index 摘要和零补丁 warnings。

- [ ] **Step 1: 写端到端成功恢复 RED 测试**

fixture 包含同一文件的任务 hunk、原无关 staged hunk和未选择 unstaged hunk。写入 prepare 返回的唯一 message file，构造 confirmation：

```js
const message = 'feat(account): add activation control\n\n'
  + '- Default new accounts to active\n'
  + '- Reject inactive accounts during transfer\n';
await writeFile(prepared.message_file, message, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
const confirmation = {
  ...prepared.binding,
  message_sha256: sha256(Buffer.from(message, 'utf8')),
};

const result = await commitTransaction({
  repository_root: root,
  transaction_id: prepared.transaction_id,
  ownership_token: prepared.ownership_token,
  message_file: prepared.message_file,
  confirmation,
}, runtimeWithGitSpy);

assert.equal(result.status, 'committed');
assert.equal(await commitCount(root), countBefore + 1);
assert.equal((await runGit(root, ['show', '--format=', '--unified=0', 'HEAD'])).stdout,
  expectedSelectedPatch);
assert.equal((await runGit(root, ['diff', '--cached', '--unified=0'])).stdout,
  expectedOriginalUnrelatedStagedPatch);
assert.equal((await runGit(root, ['diff', '--unified=0'])).stdout,
  expectedUnselectedWorktreePatch);
```

Git spy 记录每次 command/argv/env；断言 `command === 'commit'` 的调用恰好一个，argv 精确 `['commit','--no-gpg-sign','-F',prepared.message_file]`。

- [ ] **Step 2: 运行 commit RED**

Run:

```powershell
node --test --test-name-pattern="commits selected hunks and restores unrelated staged changes" tests/stage-transaction.test.js
```

Expected: FAIL，因为 `commitTransaction` 尚未执行绑定、对象导入或索引恢复。

- [ ] **Step 3: 实现确认、消息文件和脚本复验**

commit 首先取得事务所有权，验证 message file 精确位于事务状态保留的路径、由 Agent 通过 `wx` 创建为普通单链接文件、UTF-8 无 BOM/NUL、非空且摘要等于 confirmation；禁止从任意 Agent 提供的其他路径读取消息。重跑 inspect 并逐项 timing-safe 比较：

```js
const CONFIRMATION_KEYS = Object.freeze([
  'head_oid',
  'index_sha256',
  'index_tree_oid',
  'manifest_sha256',
  'selected_unit_ids',
  'worktree_state_sha256',
  'task_tree_oid',
  'script_sha256',
  'message_sha256',
]);

function assertConfirmed(expected, actual) {
  if (!equalCanonicalFields(expected, actual, CONFIRMATION_KEYS)) {
    throw stopped('CONFIRMATION_STALE');
  }
}
```

任一不匹配不导入对象、不创建 commit、不恢复旧快照覆盖并发状态；返回需要重新 inspect。

- [ ] **Step 4: 在真实 index.lock 所有权下导入已确认对象**

在所有 binding 复验后，用 `open(realIndexLock, 'wx', 0o600)` 获取真实索引锁，写入 ownership metadata 后再次复验 HEAD/index/worktree。不得删除已有锁。把 `task_tree_oid` 可达对象从事务 ODB 通过 Git pack plumbing 导入主 ODB，过程使用参数数组和 pipe，不经过 shell：

```text
GIT_OBJECT_DIRECTORY=<transaction objects>
GIT_ALTERNATE_OBJECT_DIRECTORIES=<main objects>
git pack-objects --stdout --revs --thin
  stdin: <task_tree_oid>\n^<original HEAD tree oid>\n

pipe bytes to main ODB:
git index-pack --stdin --fix-thin
```

导入后用主 ODB 的 `git cat-file -e <task_tree_oid>^{tree}` 验证。导入的 unreachable objects 不改变 HEAD/index/worktree；失败时移除仍属于本事务的 lock，保留事务并返回 `OBJECT_IMPORT_FAILED`。

- [ ] **Step 5: 启动唯一 commit 进程**

commit 的 Git 环境只设置 `GIT_INDEX_FILE=<task.index>`，不设置临时 ODB，使 commit object 写入主 ODB并正常更新 HEAD；继承 hook 配置：

```js
const attempt = await runGit(repository.root, [
  'commit',
  '--no-gpg-sign',
  '-F',
  transaction.messageFile,
], {
  env: { ...process.env, GIT_INDEX_FILE: transaction.taskIndex },
  allowFailure: true,
});
```

不得在提交前运行 probe commit，不得失败重试。message file 在成功或失败路径都由 finally 删除；若安全删除失败则保留事务并返回 warning，不回显消息正文。

- [ ] **Step 6: 基于实际新 HEAD 构建并安装恢复索引**

成功后读取实际 new HEAD/tree。若与 prepared task tree 相同，验证预演 recovery index；若 hook 合法改变了临时 task index/commit tree，则在新的外部 index 上从实际 HEAD 重放 retained staged 单元，并再次证明没有把未选择 final unit 加入 commit。无法证明时不改写历史，保留事务和恢复路径，返回 `COMMIT_CREATED_RECOVERY_REQUIRED` 及 commit OID。

可安全恢复时先 truncate 已持有的真实 `index.lock`，再写入 verified recovery index bytes，fsync，确认 lock 仍归本事务且真实 index 仍是 original digest，然后原子 rename 为真实 index。验证：实际 HEAD tree、真实 staged patch、全部 worktree/事务内容摘要至少一处可取得。最后清理自有事务。

- [ ] **Step 7: 写 binary、rename、delete、mode 和 untracked 成功用例**

每类原子 unit 单独 prepare/confirm/commit，断言新 commit tree 与 task tree 相同；原 staged/未选择内容按预期恢复。POSIX executable mode 测试在 Windows skip；binary 内容用 Buffer 比较；rename 使用 `git diff-tree --name-status -M` 证明。

- [ ] **Step 8: 写 forbidden argv 和消息临时文件测试**

```js
assert.equal(commitCalls.length, 1);
assert.deepEqual(commitCalls[0].args, [
  'commit', '--no-gpg-sign', '-F', prepared.message_file,
]);
for (const forbidden of ['--no-verify', '--amend', '-m', 'push', 'tag']) {
  assert.equal(commitCalls[0].args.includes(forbidden), false);
}
await assert.rejects(access(prepared.message_file), { code: 'ENOENT' });
```

另测 message file 位于仓库、symlink、多硬链接、BOM/NUL、摘要变化或非保留路径时停止且无 commit。

- [ ] **Step 9: 运行成功路径全组和注释审查**

Run:

```powershell
node --test --test-name-pattern="commit|selected hunks|restores unrelated|binary|rename|mode|message file" tests/stage-transaction.test.js
git diff --check -- scripts/stage-transaction.mjs tests/stage-transaction.test.js
```

Expected: PASS。按 `$chinese-code-comments` 审查对象导入、真实 lock 和基于 actual HEAD 恢复的关键维护意图。

- [ ] **Step 10: 提交成功路径**

```powershell
git add -- scripts/stage-transaction.mjs tests/stage-transaction.test.js
git diff --cached --check
git commit -m "feat: commit selected hunks transactionally"
```

Expected: 只提交确认、对象导入、单次 commit、恢复索引和成功测试；不 push。

### Task 6: 加固失败、并发和文件安全

**Files:**
- Modify: `scripts/stage-transaction.mjs`
- Modify: `tests/stage-transaction.test.js`

**Interfaces:**
- Consumes: Task 2～5 的稳定协议和 fault-injection runtime。
- Produces: 所有可预期停止均返回结构化状态；能安全清理才清理，否则保留可验证恢复事务且绝不自动覆盖工作区。

- [ ] **Step 1: 写 hook 拒绝和单次尝试 RED 测试**

安装真实 `pre-commit` 或 `commit-msg` hook，以非零码拒绝；记录 before HEAD、commit count、index bytes、worktree 和 objects：

```js
const result = await commitPreparedTransaction(fixture);
assert.equal(result.status, 'stopped');
assert.equal(result.error.code, 'COMMIT_REJECTED');
assert.equal(commitCalls.length, 1);
assert.deepEqual(await snapshotUserState(root), beforeUserState);
assert.equal(await commitCount(root), countBefore);
assert.equal(result.transaction.retained, true);
assert.equal(JSON.stringify(result).includes(hookSecret), false);
```

- [ ] **Step 2: 运行 hook RED 并实现拒绝恢复**

Run:

```powershell
node --test --test-name-pattern="hook rejection|commit rejected" tests/stage-transaction.test.js
```

Expected before implementation: FAIL。GREEN 实现要求：不重试、不使用 `--no-verify`；若真实 index 仍等于 original digest，只释放自有 lock；若 hook 越过 lock 改写真实 index，先把 unexpected index bytes 保存到事务并校验摘要，再从 `original.index` 恢复真实 index，报告 preserved recovery path。不得把原 index 覆盖到 worktree。

- [ ] **Step 3: 写五类绑定并发失效测试**

分别在 prepare 后改变：HEAD（外部 commit）、真实 index、相关 worktree bytes/mode、message file、脚本摘要。每个子测试使用全新 fixture：

```js
await mutateAfterPrepare(testCase);
const beforeAttempt = await snapshotUserState(root);
const countBeforeAttempt = await commitCount(root);
const result = await commitPreparedTransaction(testCase);
assert.equal(result.error.code, 'CONFIRMATION_STALE');
assert.equal(await commitCount(root), countBeforeAttempt);
assert.deepEqual(await snapshotUserState(root), beforeAttempt);
assert.equal(commitCalls.length, 0);
```

外部 HEAD commit 本身计入 baseline，不得被误报为本事务 commit；旧事务可在所有权验证后 cancel，但不得把 concurrent index/worktree 恢复为旧 snapshot。

- [ ] **Step 4: 写 index.lock 竞态和原子安装失败测试**

覆盖 prepare 前已有 lock、commit 前外部 lock、获取后 lock 被替换、真实 index 在最终复验后改变、原子 rename 失败。断言不删除外部 lock；成功 commit 后恢复安装失败返回 commit OID 与 `COMMIT_CREATED_RECOVERY_REQUIRED`，保留 original/recovery/unexpected indexes，绝不 amend 或回滚 commit。

- [ ] **Step 5: 写 hook 改工作区、临时索引和提交树测试**

三种真实 hook：只改 worktree；修改 `GIT_INDEX_FILE` 后允许提交；修改临时 index 造成 actual tree 不同且 retained staged patch可重放。断言脚本从不覆盖 hook 写入的 worktree；actual tree 被验证；可证明安全则基于 actual HEAD 恢复 staged；不可证明则保留事务并返回明确停止状态。

- [ ] **Step 6: 写路径、链接和所有权替换测试**

覆盖：repository root/link、Git dir link、真实 index link、事务 root link/junction、task/recovery/original index link、message file link/多硬链接、内容 snapshot link、transaction ID traversal、大小写重复路径、Windows device/ADS/末尾点空格。创建 link 被平台拒绝时只 skip 对应 case。每例验证仓库外 sentinel 未改。

- [ ] **Step 7: 写敏感输出和 CLI 错误协议测试**

向路径、hook stdout/stderr、Git error 和 malformed JSON 注入唯一秘密串；断言 stdout/stderr/result JSON 不含它。四子命令覆盖 exit `0/1/2`、未知 command、多余 argv、过大 stdin、closed stdout；closed pipe 应安静终止，不输出 stack。

- [ ] **Step 8: 实现稳定错误表和恢复保留策略**

所有错误映射到固定 code，例如：

```js
const STOP_CODES = Object.freeze(new Set([
  'NOT_GIT_REPOSITORY',
  'SPECIAL_GIT_STATE',
  'INDEX_LOCKED',
  'UNSAFE_GIT_PATH',
  'SELECTION_INVALID',
  'SELECTION_UNKNOWN_OR_UNSELECTABLE',
  'STAGED_SELECTION_AMBIGUOUS',
  'RECOVERY_PREVIEW_FAILED',
  'TRANSACTION_OWNERSHIP_INVALID',
  'CONFIRMATION_STALE',
  'OBJECT_IMPORT_FAILED',
  'COMMIT_REJECTED',
  'COMMIT_CREATED_RECOVERY_REQUIRED',
]));
```

停止对象只含 code、安全 message、repository_changed、transaction `{id,retained,recovery_path?}`。Git/hook 原始诊断如必须保留，写 0600 文件并只返回 `output_retained:true`；正常成功/取消清理，任何所有权不明、内容差异或恢复不完整都保留事务。

- [ ] **Step 9: 运行故障和安全全组**

Run:

```powershell
node --test --test-name-pattern="hook|concurrent|stale|lock|symlink|junction|ownership|recovery required|CLI|secret" tests/stage-transaction.test.js
node --test tests/stage-transaction.test.js
git diff --check -- scripts/stage-transaction.mjs tests/stage-transaction.test.js
```

Expected: PASS；确定性测试证明确认前主 ODB 不变、Git commit process 恰好一次或零次、失败不重试、无用户内容丢失。

- [ ] **Step 10: 注释审查与提交加固**

按 `$chinese-code-comments` 对完整脚本/测试 diff 做 SCOPED 审查，重点保留竞态窗口、lock 所有权、hook 不可信边界和“保留证据而不覆盖”的理由。

```powershell
git add -- scripts/stage-transaction.mjs tests/stage-transaction.test.js
git diff --cached --check
git commit -m "fix: harden staging transaction recovery"
```

Expected: 只提交失败、并发、文件安全和 CLI 加固；不 push。

### Task 7: 集成 Skill、中文 README 和精确两文件交付

**Files:**
- Modify: `SKILL.md`
- Modify: `README.md`
- Modify: `.scaffold/state.json`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `src/validate.js`
- Modify: `src/delivery-gate.js`
- Modify: `src/audit.js`
- Modify: `tests/validate.test.js`
- Modify: `tests/delivery-gate.test.js`
- Modify: `tests/audit.test.js`
- Modify: `tests/repository.test.js`
- Create: `tests/fixtures/complete-skill/scripts/stage-transaction.mjs`
- Modify: `tests/fixtures/complete-skill/package.json`
- Modify: `tests/fixtures/complete-skill/.scaffold/state.json`
- Modify: `docs/superpowers/specs/2026-08-20-transactional-auto-staging-design.md`

**Interfaces:**
- Consumes: 已通过确定性测试的四子命令 JSON CLI。
- Produces: Agent 运行时工作流、中文用户文档、精确两文件 npm 包，以及能证明脚本存在/入包/受审计的 scaffold gates。

- [ ] **Step 1: 加载注释策略并写发布白名单 RED 测试**

编辑 Node 代码前加载 `$chinese-code-comments`，使用 `SCOPED`。先修改测试期望但不改实现：

```js
const INITIALIZED_RUNTIME_FILES = [
  'SKILL.md',
  'scripts/stage-transaction.mjs',
];

assert.deepEqual(pkg.files, INITIALIZED_RUNTIME_FILES);
```

`tests/validate.test.js` 新增 `requires the initialized runtime script and exact two-file publish whitelist`：合法 fixture 有最小 LF/UTF-8 脚本；删除脚本得到 `INITIALIZED_FILE_MISSING` 且 path 是 `scripts/stage-transaction.mjs`；仅 SKILL、乱序、额外 `scripts/other.mjs`、整个 `scripts` 目录均得到 `PUBLISH_FILES_INVALID`。

- [ ] **Step 2: 写 delivery/audit/npm 归档 RED 测试**

`tests/delivery-gate.test.js` 将非法清单设为：

```js
pkg.files = ['SKILL.md', 'scripts/stage-transaction.mjs', 'evals'];
```

并要求完整 fixture 的两文件清单通过。`tests/audit.test.js` 新增 initialized 模式归档断言：只允许 `LICENSE`、`README.md`、`package.json`、`SKILL.md`、`scripts/stage-transaction.mjs`；`scripts/other.mjs` 报 `PACKAGE_FILE_FORBIDDEN`，缺少事务脚本报 `PACKAGE_RUNTIME_FILE_MISSING`。`tests/repository.test.js` dry-run 分支必须同时包含两个运行时路径，并禁止任何其他 `scripts/` entry。

- [ ] **Step 3: 运行 packaging RED**

Run:

```powershell
node --test tests/validate.test.js tests/delivery-gate.test.js tests/audit.test.js tests/repository.test.js
```

Expected: FAIL，当前 validator/gate 仍只允许 `SKILL.md`，audit 尚未要求精确 initialized runtime pair。

- [ ] **Step 4: 更新 validate 和 delivery gate 的固定输入**

`src/validate.js` 使用：

```js
const INITIALIZED_FILES = Object.freeze([
  'SKILL.md',
  'scripts/stage-transaction.mjs',
]);
```

并把 `scripts/stage-transaction.mjs` 加入 `INITIALIZED_CORE_FILES`，使缺失、链接、非法 UTF-8/BOM/NUL/CRLF 都失败。`src/delivery-gate.js#FIXED_EVIDENCE_FILES` 加入该脚本；`validatePublishPaths` 精确检查长度、顺序和两个值，错误消息写明两文件，不接受目录宽匹配。

- [ ] **Step 5: 收紧 initialized npm 归档审计**

从 repository `package.json#scaffold.mode` 判断模式。source/无 scaffold 的现有 `PACKAGE_TOP_LEVEL` 行为保持不变；initialized 额外使用闭集：

```js
const INITIALIZED_ARCHIVE_FILES = new Set([
  'LICENSE',
  'README.md',
  'package.json',
  'SKILL.md',
  'scripts/stage-transaction.mjs',
]);
const INITIALIZED_REQUIRED_RUNTIME = new Set([
  'SKILL.md',
  'scripts/stage-transaction.mjs',
]);
```

归档中的其他 path 触发 `PACKAGE_FILE_FORBIDDEN`；required 缺失触发 `PACKAGE_RUNTIME_FILE_MISSING`。所有 file content 仍经过凭据/敏感内容扫描，不能因路径合法跳过。

- [ ] **Step 6: 更新完整 fixture 和精确 CLI 输出**

新增最小 fixture 脚本：

```js
#!/usr/bin/env node
process.stdout.write('{"schema_version":1,"ok":true,"status":"fixture"}\n');
```

fixture `package.json#files` 改为两项。只重算确实因本任务变化的 `.scaffold/state.json#initial_files.package.json` 摘要；新脚本是初始化后启用的 runtime，不伪造进 `initial_files`。若 delivery CLI warning 顺序发生合法变化，同步精确 stdout 断言。

- [ ] **Step 7: 实现 SKILL.md 的 Version 5 路由和工作流**

frontmatter description 与 `package.json`、`package-lock.json`、`.scaffold/state.json#skill.description` 使用同一字符串：

```text
Generate Conventional Commit messages for staged or current-task Git changes, prepare only task-related hunks for explicit commit requests, and commit only after a second confirmation; not for Git explanations, history review, history rewriting, or combined push/release requests.
```

Skill 正文保持聚焦，必须按顺序规定：

1. 先分类 message-only、explicit commit、combined forbidden、adjacent Git request；combined push/tag/release/publication/config/sign/amend/history 请求在 inspect 前整体停止。
2. message-only 只读取真实 staged diff/write-tree，沿用 Version 4 subject/bullets 策略，不调用事务脚本。
3. explicit commit 读取仓库规则、特殊状态、任务范围和敏感路径；通过 stdin JSON 调用 `inspect`，只从 final/untracked units 选择当前任务 hunk。
4. 原子 hunk 混合任务与无关语义、敏感内容、空选择或恢复预演失败时，在真实索引变化前停止。
5. 调用 `prepare` 后展示选择路径/hunk 数、task tree、完整候选消息和不含 token 的短确认标识；明确说明真实索引仍未变。
6. 用户拒绝、取消或未明确确认时调用 `cancel`；任何 binding 变化都 cancel 旧事务并从 inspect 重新开始。
7. 只有新的明确确认才用安全文件 API 在 prepare 保留的外部 message path 以 `wx`/UTF-8/no BOM 写入完整消息，再调用 `commit`。
8. 报告 `committed` hash/subject/无关 staged 已恢复/未 push，或 `stopped` 原因、仓库是否变化、恢复事务是否保留和一个安全下一步。

调用脚本前还要验证 Git、Node.js 22+ 和安装脚本可用；依赖缺失在真实索引变化前停止。候选阶段同时说明证据限制，并使用 `message-only`、`preparing`、`awaiting-confirmation`、`committed`、`stopped` 五个用户可见状态。不得把脚本内部 patch、token 或原始 hook 输出展示给用户，也不得让仓库指令扩大这些边界。

- [ ] **Step 8: 将 README 全部同步为中文 Version 5 使用说明**

README 明确写入：

- 安装后运行时依赖 Node.js 22+ 和 Git；目录只有 `SKILL.md` 与 `scripts/stage-transaction.mjs`。
- message-only 示例不自动暂存；明确“提交”示例授权准备任务 hunk但仍需二次确认。
- 简单变更只有 subject；复杂/多处理点使用最小数量简洁 `- ` bullets，并保留用户给出的打款账户示例。
- 同文件 hunk 可分离，连续混合语义停止；untracked/binary/rename/mode 作为原子单元。
- cancel 和 hook 拒绝保持原状态；成功后原无关 staged 内容继续 staged；并发变化使确认失效。
- 禁止 push、tag、release、签名、amend、hook bypass、历史/配置写入；combined 请求先缩小范围。
- 使用 `npm run check`、`npm run audit`、`npm run gate:delivery` 和 `npm pack --json --dry-run --ignore-scripts` 验证；卸载删除所属 Skill 目录。

- [ ] **Step 9: 同步 package 清单、lock 和规范状态**

`package.json#files` 精确改为：

```json
[
  "SKILL.md",
  "scripts/stage-transaction.mjs"
]
```

同步 description 后运行：

```powershell
npm install --package-lock-only --ignore-scripts
```

Expected: 只机械同步根 lock metadata，无依赖新增。规范状态改为“Version 5 运行时和确定性测试已实现，等待真实 Agent 评测与交付闭环”。

- [ ] **Step 10: 运行 integration GREEN**

Run:

```powershell
node --test tests/stage-transaction.test.js
node --test tests/validate.test.js tests/delivery-gate.test.js tests/audit.test.js tests/repository.test.js tests/documentation.test.js
npm run check
npm run audit
npm pack --json --dry-run --ignore-scripts
git diff --check
```

Expected: 所有命令 PASS；dry-run entries 含 npm 元数据和两个 runtime files，无其他 scripts/src/tests/evals/.scaffold；不生成 `.tgz`。

- [ ] **Step 11: 审查注释和提交 runtime integration**

按 `$chinese-code-comments` 审查完整代码 diff 和新脚本；README/Skill 与实现状态一致，未声称尚未完成的 Agent 评测或全局安装。

```powershell
git add -- SKILL.md README.md .scaffold/state.json package.json package-lock.json src/validate.js src/delivery-gate.js src/audit.js tests/validate.test.js tests/delivery-gate.test.js tests/audit.test.js tests/repository.test.js tests/fixtures/complete-skill/scripts/stage-transaction.mjs tests/fixtures/complete-skill/package.json tests/fixtures/complete-skill/.scaffold/state.json docs/superpowers/specs/2026-08-20-transactional-auto-staging-design.md
git diff --cached --check
git commit -m "feat: integrate transactional staging runtime"
```

Expected: 只提交运行时集成、两文件门禁、中文文档和测试；不 push。

### Task 8: 运行真实 Agent 评测并闭合 Evidence Contract

**Files:**
- Modify: `evals/evals.json`
- Modify: `evals/results/EVAL-001.txt`～`evals/results/EVAL-011.txt`
- Create: `evals/results/EVAL-012.txt`～`evals/results/EVAL-019.txt`
- Modify: `evals/results/prompt-budget.txt`
- Modify: `docs/skill-brief.md`
- Modify: `docs/delivery-report.md`
- Modify: `docs/decisions.md`
- Modify: `.scaffold/state.json`
- Modify: `docs/superpowers/specs/2026-08-20-transactional-auto-staging-design.md`

**Interfaces:**
- Consumes: 冻结的最终 `SKILL.md`、`scripts/stage-transaction.mjs` 和 EVAL-001～EVAL-019 prompts/assertions。
- Produces: 每个 case 一份独立真实 Agent PASS artifact、最终 prompt budget、scripts/implicit-trigger capability evidence 和 ready Evidence Contract v1。

- [ ] **Step 1: 冻结两个运行时摘要和确定性 GREEN 基线**

Run:

```powershell
$skillHash = (Get-FileHash -LiteralPath 'SKILL.md' -Algorithm SHA256).Hash.ToLowerInvariant()
$scriptHash = (Get-FileHash -LiteralPath 'scripts\stage-transaction.mjs' -Algorithm SHA256).Hash.ToLowerInvariant()
$skillHash
$scriptHash
node --test tests/stage-transaction.test.js
npm run check
npm run audit
git diff --check
```

Expected: 全部 PASS；两个 lowercase hash 记录到每个 evaluator metadata。此后任何 runtime byte 变化都使全部 Version 5 evaluator evidence 失效并从本 Step 重跑。

- [ ] **Step 2: 创建忽略的隔离评测仓库和控制快照**

在已忽略的 `eval-workspaces/transactional-v5/EVAL-NNN/` 创建独立仓库；每个仓库设置本地 `.invalid` identity、`core.autocrlf=false` 和所需 hook/fixture，不修改 global/system config。每个 case 在运行前记录：HEAD、commit count、index bytes/hash/tree、porcelain v2 `-z`、工作区 bytes/mode、主 ODB 列表、local config 和 hook identity。敏感 case 使用唯一假 secret 并确保结果文件不包含值。

- [ ] **Step 3: 用新鲜子 Agent 重跑 EVAL-001～EVAL-011**

每个 case 使用独立 evaluator Agent，只提供冻结 prompt、最终两个 runtime 文件和对应隔离仓库。commit case 分两阶段：controller 先保留 proposal/binding 证据，再发送精确确认；拒绝/取消 case 发送相应用户回复。逐项证明 Version 4 消息策略和边界在 Version 5 runtime 下仍成立，特别是 EVAL-001/EVAL-002 的提交协议、EVAL-005 的扩展 binding、EVAL-008 的备份前敏感停止、EVAL-009 的 hook 拒绝、EVAL-010/011 的 message-only 零事务。

- [ ] **Step 4: 用新鲜子 Agent 运行 EVAL-012～EVAL-019**

按 Task 1 冻结 prompt 和 assertion 原文运行，不在 evaluator 过程中修改断言。EVAL-013/014 controller 在 phase 1 后发送明确确认；EVAL-015 发送取消；EVAL-016 确认后让真实 hook 拒绝；EVAL-017 在 prepare 后分别制造绑定变化；EVAL-019 不允许 evaluator 运行 inspect/prepare 或网络命令。

每个 case 必须同时有 Agent 结论和 controller 的真实 Git/文件快照；静态搜索 `SKILL.md` 或脚本不能判 PASS。

- [ ] **Step 5: 写入清洗后的独立证据文件**

每份 `evals/results/EVAL-NNN.txt` 使用统一结构：标题、`Status: PASS`、raw evidence 来源说明、`SKILL.md` SHA-256、事务脚本 SHA-256、Frozen prompt、phase/runtime observation、逐条 `ASSERT-NNN PASS`、before/after invariant、metrics。清洗绝对路径、身份、对象 ID、token、临时路径和 hook 输出，但不改变结论；不得写入秘密值。

若任一 assertion FAIL，保留 fail artifact 供诊断，把 matching eval 保持 `not-run`/`fail`，返回最早受影响实现任务修复并重新冻结两个 runtime hash；不得通过改写 prompt/assertion 取得 PASS。

- [ ] **Step 6: 绑定每个结果文件的独立 SHA-256**

```powershell
Get-ChildItem -LiteralPath 'evals\results' -Filter 'EVAL-*.txt' |
  Sort-Object Name |
  ForEach-Object { "{0} {1}" -f $_.Name, (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
```

把每个 `evals/evals.json#result` 精确更新为 `pass`，并把刚计算出的 lowercase digest 拼接到对应前缀 `artifact:evals/results/EVAL-NNN.txt#sha256:`；不能复用另一文件的 hash。

- [ ] **Step 7: 重算 prompt budget 并准备 ready Brief**

用仓库既有保守算法重算 `SKILL.md` 字符、UTF-8 bytes 和 token estimate，写入 `evals/results/prompt-budget.txt`，再记录其 SHA-256。Brief 改为 Version 5 complete；REQ-001～REQ-009 全部 `pass`；scripts track evidence 使用能证明 hunk commit/恢复的 `EVAL-013` 或 `EVAL-014` artifact，implicit-trigger 使用最终 EVAL-002 artifact；prompt budget 恢复：

```js
const prompt_budget = {
  limit_tokens: 1800,
  measured_tokens: measuredTokens,
  evidence: `artifact:evals/results/prompt-budget.txt#sha256:${promptBudgetDigest}`,
};
```

实际写入 JSON 时 `measured_tokens` 必须是整数而不是字符串；如果超过 1800，只压缩 Skill 的重复解释，不删授权、安全、恢复或确认语义，runtime hash 变化后重跑本任务全部评测。

- [ ] **Step 8: 闭合 delivery traces、capability claims 和生命周期**

每个 REQ 使用一个单一实现 path；事务要求指 `path:scripts/stage-transaction.mjs`，Agent/消息/触发要求指 `path:SKILL.md`。verification 只列真实 PASS eval IDs。capability claims 至少包括：

```js
const capability_claims = [
  {
    name: 'Implicit staged and current-task commit assistance',
    track: 'implicit-trigger',
    evidence: `artifact:evals/results/EVAL-002.txt#sha256:${eval002Digest}`,
  },
  {
    name: 'Transactional task-hunk staging and restoration',
    track: 'scripts',
    evidence: `artifact:evals/results/EVAL-014.txt#sha256:${eval014Digest}`,
  },
];
```

将 Brief 和 `.scaffold/state.json#status` 改为 `ready`；规范状态改为“Version 5 实现与真实 Agent 证据已闭环，等待最终安装和终审”。

- [ ] **Step 9: 运行 Evidence Contract GREEN**

Run:

```powershell
npm run check
npm run audit
npm run gate:delivery
npm pack --json --dry-run --ignore-scripts
git diff --check
```

Expected: 全部 PASS；gate 输出 REQ-001～REQ-009 evidence；dry-run 无 archive、无额外 runtime path。

- [ ] **Step 10: 提交评测闭环**

```powershell
git add -- .scaffold/state.json docs/skill-brief.md docs/decisions.md docs/delivery-report.md docs/superpowers/specs/2026-08-20-transactional-auto-staging-design.md evals/evals.json evals/results/EVAL-001.txt evals/results/EVAL-002.txt evals/results/EVAL-003.txt evals/results/EVAL-004.txt evals/results/EVAL-005.txt evals/results/EVAL-006.txt evals/results/EVAL-007.txt evals/results/EVAL-008.txt evals/results/EVAL-009.txt evals/results/EVAL-010.txt evals/results/EVAL-011.txt evals/results/EVAL-012.txt evals/results/EVAL-013.txt evals/results/EVAL-014.txt evals/results/EVAL-015.txt evals/results/EVAL-016.txt evals/results/EVAL-017.txt evals/results/EVAL-018.txt evals/results/EVAL-019.txt evals/results/prompt-budget.txt
git diff --cached --check
git commit -m "test: close transactional staging evidence"
```

Expected: 只提交最终 evidence contract 和评测 artifacts；不 push。

### Task 9: 全局安装、全门禁和最终审查

**Files:**
- Modify: `docs/delivery-report.md`
- Modify: `docs/superpowers/specs/2026-08-20-transactional-auto-staging-design.md`
- Install: `$CODEX_HOME/skills/git-commit-assistant/SKILL.md`
- Install: `$CODEX_HOME/skills/git-commit-assistant/scripts/stage-transaction.mjs`

**Interfaces:**
- Consumes: ready repository runtime and Evidence Contract。
- Produces: 只含两个运行时文件的全局安装、仓库/安装版逐文件 hash 等价、最终 clean gates；不 push。

- [ ] **Step 1: 加载 skill-installer 并检查安装目标现状**

本任务执行前读取 `$skill-installer` 的完整 `SKILL.md` 并遵循其 GitHub/local Skill 安装流程。只读检查目标，不假设旧摘要仍正确：

```powershell
$codexHome = if ([string]::IsNullOrWhiteSpace($env:CODEX_HOME)) { Join-Path $env:USERPROFILE '.codex' } else { $env:CODEX_HOME }
$installRoot = Join-Path $codexHome 'skills\git-commit-assistant'
if (Test-Path -LiteralPath $installRoot) {
  Get-ChildItem -LiteralPath $installRoot -Recurse -Force |
    Select-Object FullName,Length,Attributes
}
```

Expected: 明确目标是否缺失、仅含旧 SKILL，或包含未知文件。若有未知内容，先复制到仓库外唯一 backup directory并核对 hash；不递归覆盖或删除未知内容。

安全备份使用同一 PowerShell 路径语义：

```powershell
$backupRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("git-commit-assistant-backup-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $backupRoot | Out-Null
Copy-Item -LiteralPath $installRoot -Destination $backupRoot -Recurse
Get-ChildItem -LiteralPath $backupRoot -Recurse -File |
  ForEach-Object { Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256 }
```

若目录含无法确认归属的第三方文件，备份后仍要暂停并取得用户允许才能把它们移出安装目录；不得为了满足两文件清单自行递归删除。

- [ ] **Step 2: 安装精确 runtime pair**

使用 installer 提供的脚本/流程；若其流程不支持两文件 runtime，则安全创建目标 `scripts` 目录并复制仓库版两个文件。最终安装目录允许的相对路径精确为：

```text
SKILL.md
scripts/stage-transaction.mjs
```

不要复制 README、package.json、docs、tests、evals、`.git` 或整个仓库。对被替换的旧 runtime 先保留仓库外 backup，不删除用户未知文件。

- [ ] **Step 3: 验证安装版和仓库版 SHA-256**

```powershell
$repoSkill = (Get-FileHash -LiteralPath 'SKILL.md' -Algorithm SHA256).Hash.ToLowerInvariant()
$repoScript = (Get-FileHash -LiteralPath 'scripts\stage-transaction.mjs' -Algorithm SHA256).Hash.ToLowerInvariant()
$installedSkill = (Get-FileHash -LiteralPath "$installRoot\SKILL.md" -Algorithm SHA256).Hash.ToLowerInvariant()
$installedScript = (Get-FileHash -LiteralPath "$installRoot\scripts\stage-transaction.mjs" -Algorithm SHA256).Hash.ToLowerInvariant()
@($repoSkill -eq $installedSkill, $repoScript -eq $installedScript)
```

Expected: 两项均 `True`；安装目录枚举无第三个 runtime file。用安装版脚本在新隔离仓库运行一次 `inspect` smoke test，断言单行 JSON、exit `0`、仓库快照不变。

- [ ] **Step 4: 记录安装证据并完成规范状态**

在 delivery report prose 记录安装日期、两个 lowercase hash、安装布局和 smoke test 结果；不把本机绝对用户名路径写入可发布 artifact，使用 `$CODEX_HOME/skills/git-commit-assistant` 逻辑表示。规范状态改为“Version 5 已实现、评测、安装并通过最终审查”。contract 字段只在 hash/reference 确实变化时同步。

- [ ] **Step 5: 运行所有门禁**

Run:

```powershell
npm run check
npm run audit
npm run gate:delivery
npm pack --json --dry-run --ignore-scripts
git diff --check
```

Expected: 全部 PASS；`npm pack --dry-run` 不生成归档；audit 不报告凭据、私有路径或额外 package file。

- [ ] **Step 6: 执行完整 diff、未跟踪文件和注释终审**

Run:

```powershell
git status --short
git diff --stat HEAD
git diff --binary HEAD
git ls-files --others --exclude-standard
git diff --check HEAD
```

按 `$chinese-code-comments` 审查从当前交付基线到最终 HEAD/工作树的完整代码 diff 和所有未跟踪交付文件。逐项检查：Version 5 需求偏离、用户既有改动丢失、敏感信息、绝对私有路径、包白名单、README/规范失真、过时 Version 4 声明、关键维护意图注释、无意义逐行注释。与 Task 1 仓库外 baseline patch 对照，确认未通过 reset/checkout/clean 丢失内容。

- [ ] **Step 7: 提交最终安装记录**

```powershell
git add -- docs/delivery-report.md docs/superpowers/specs/2026-08-20-transactional-auto-staging-design.md
git diff --cached --check
git commit -m "docs: record transactional staging installation"
```

Expected: 只提交最终安装/终审记录；不 push。

- [ ] **Step 8: 最终状态验证和交付**

Run:

```powershell
git status --short
git log -8 --oneline --decorate
git remote -v
```

Expected: 当前任务文件已提交；若仍有用户无关改动，完整列出且保持原状态；remote 未被修改；没有 push、tag、release、发布或上传。向用户报告 commit hashes、全门禁结果、全局安装两个 hash、任何保留 backup/recovery path，以及“未推送”。
