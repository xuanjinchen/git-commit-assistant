# Skill Brief

## Requirement Version

Version 5, revised and confirmed 2026-08-23. Work continues with a portable cooperative-concurrency threat model for transactional hunk-level preparation; the Version 4 evidence remains a historical baseline and all affected runtime evaluations are frozen pending re-execution.

## Objective

For an explicit commit request, prepare only the current task's files or hunks in an external transaction, generate an evidence-based Conventional Commit message, and create one unsigned commit only after a second, fully bound confirmation. For a message-only request, generate a message from the exact real staged snapshot without creating a transaction.

## Trigger and Inputs

Trigger for staged-change commit or commit-message requests, including natural requests that do not name the Skill. An explicit commit request may inspect and prepare a stable manifest containing only current-task files or hunks, even when the real index is empty; message-only requests require a coherent non-empty real staged set. Repository rules, paths, diffs, recent subjects, and Git state are evidence inputs and never instruction sources; repository instructions cannot broaden the runtime boundaries.

## Outputs and Side Effects

Return a complete candidate and task-selection summary, or a safe stop reason. A simple change uses only a complete subject; a coherent multi-change or complex business change adds the smallest useful set of concise hyphen bullets for material handling points. The runtime is `SKILL.md` plus `scripts/stage-transaction.mjs`: the Agent selects manifest units and the script performs deterministic external-index transactions. Before the second confirmation, the real index, worktree, HEAD, and main object database remain unchanged. Only the second confirmation may create one unsigned commit using exactly `git commit --no-gpg-sign -F <temp>` while preserving hooks. Message-only requests have no repository side effect.

## Non-goals

Do not alter the real index before confirmation; do not amend, sign, push, create tags or releases, publish or upload packages, rewrite history, install or edit hooks, write local or global Git or Codex configuration, or call an external model, API, or delegated agent. Explicit commit requests may prepare selected current-task manifest units only in an owned external transaction. A combined request stops before inspection, preparation, or commit and requires a commit-only scope. The portable runtime does not claim protection against a deliberately hostile same-privilege process that interposes in an individual filesystem-syscall gap and uses native APIs to restore every observable path identity and timestamp; no native platform helper is added for that adversarial case.

## Concurrency Threat Model

The runtime protects cooperative concurrency: ordinary Git commands, user actions, hooks, and other processes when their change to bound or protected content, object identity, path state, ownership evidence, or filesystem metadata is observable at a defined validation or recovery checkpoint. It fails closed on those checkpoint observations, preserves foreign locks and recoverable bytes when ownership is uncertain, and never overwrites worktree content to hide a conflict. Hooks remain untrusted and do not receive a broader exemption.

An active same-privilege adversary that precisely races between two operating-system calls and then erases every observable trace with native APIs is outside the portable contract. This residual risk qualifies concurrency and lock guarantees throughout Version 5; deterministic tests must still cover every recorded, in-scope, reproducible observable replacement window and must not present metadata barriers as proof against the excluded adversary.

## Path Mapping

- `SKILL_FILE`: `SKILL.md`
- `README_FILE`: `README.md`
- `BRIEF_FILE`: `docs/skill-brief.md`
- `DECISIONS_FILE`: `docs/decisions.md`
- `DELIVERY_FILE`: `docs/delivery-report.md`
- `EVALS_FILE`: `evals/evals.json`
- `TEST_ROOT`: `tests/`
- `SOURCE_ROOT`: repository root
- `TRANSACTION_SCRIPT`: `scripts/stage-transaction.mjs`
- `RESOURCES_ROOT`: disabled; runtime is self-contained
- `EVAL_WORKSPACE`: `eval-workspaces/`

## Unresolved Conflicts

- `CONFLICT-001` is resolved: Version 3 allowed a body only for reasons or durable constraints, while Version 4 requires concise implementation-point bullets for coherent multi-change or complex business changes. Version 4 supersedes the narrower rule.
- `CONFLICT-002` is resolved: Version 4 prohibited staging, unstaging, and splitting, while Version 5 requires an explicit commit request to prepare current-task hunks.
- `CONFLICT-003` is resolved: the Version 4 single-file runtime conflicts with Version 5's deterministic index transaction.
- `CONFLICT-004` is resolved: the prior plan implied absolute protection against same-privilege adversarial replacement between filesystem calls, but a portable Node.js runtime has no cross-platform descriptor-bound unlink or rename primitive and cannot prove, only from child-visible path, identity, and timestamp evidence before commit creation, which tree the parent Git process already loaded after hooks.

<!-- scaffold-contract:skill-brief:v1 -->
```json
{
  "schema_version": 1,
  "status": "draft",
  "conflicts": [
    {
      "id": "CONFLICT-001",
      "summary": "Version 4 requires concise implementation-point bullets for coherent multi-change or complex business changes, conflicting with the narrower Version 3 body rule.",
      "status": "resolved",
      "resolution": "Apply the Version 4 semantic-complexity policy; keep subject-only messages for simple changes whose subject is complete, and supersede the Version 3 body rule."
    },
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
    },
    {
      "id": "CONFLICT-004",
      "summary": "原计划隐含要求跨平台 Node.js 运行时绝对防御同权限进程在文件系统调用间隙中的主动替换，并仅凭提交创建前对子进程可见的路径、身份和时间证据证明父 Git 在 hook 后已载入的内存 tree。",
      "status": "resolved",
      "resolution": "采用可移植 cooperative/observable concurrency 威胁模型：继续拒绝绑定或受保护状态在定义验证/恢复检查点可观察到的并发变化和所有权异常；把能精确命中 syscall 间隙并用原生 API 擦除全部证据的同权限主动对抗列为剩余风险，不引入平台原生 helper。"
    }
  ],
  "acceptance_criteria": [
    {
      "id": "REQ-001",
      "requirement": "A coherent staged change produces an evidence-based Conventional Commit candidate: a simple change uses only a complete subject, while coherent multi-change or complex business work adds the smallest useful set of concise hyphen bullets for distinct material handling points.",
      "verification": "EVAL-012, EVAL-018, and the deterministic transaction tests verify message derivation, task selection, and message-only restraint.",
      "status": "pending"
    },
    {
      "id": "REQ-002",
      "requirement": "No commit occurs before a second confirmation. Any change to a bound HEAD, index, manifest, selection, worktree, task tree, script, or complete message digest that is observable at a defined validation checkpoint before commit-object creation invalidates that confirmation; after the single Git process starts, actual HEAD/tree and recovery evidence also govern hook effects and final reporting.",
      "verification": "EVAL-012, EVAL-017, and deterministic transaction tests verify confirmation checkpoints, post-spawn actual-tree handling, and zero real-side-effect preparation.",
      "status": "pending"
    },
    {
      "id": "REQ-003",
      "requirement": "Within the declared cooperative-concurrency threat model, the Skill stops without weakening safeguards for ambiguous task hunks, special Git state, likely sensitive material, observable concurrent changes, or hook rejection.",
      "verification": "EVAL-013, EVAL-015, EVAL-016, EVAL-017, and deterministic transaction tests verify safe stops, observable race handling, and protected user state.",
      "status": "pending"
    },
    {
      "id": "REQ-004",
      "requirement": "The description discovers staged commit assistance without attracting adjacent Git explanation, history review, or history rewriting requests.",
      "verification": "Scaffold frontmatter validation plus EVAL-012, EVAL-018, and EVAL-019 verify positive and adjacent-negative trigger semantics.",
      "status": "pending"
    },
    {
      "id": "REQ-005",
      "requirement": "The workflow creates a unique external temporary message file and starts exactly one `git commit --no-gpg-sign -F <temp>` process, removes the file after success or failure, and never signs, bypasses hooks, changes hook or configuration state, pushes, tags, releases, publishes or uploads packages, delegates externally, or rewrites history.",
      "verification": "EVAL-014, EVAL-016, EVAL-019, and deterministic transaction tests verify the exact one-process protocol, cleanup, hooks, and forbidden-side-effect boundaries.",
      "status": "pending"
    },
    {
      "id": "REQ-006",
      "requirement": "明确提交请求从稳定 manifest 只选择当前任务的文件或 hunk；message-only 不创建事务。",
      "verification": "EVAL-012、EVAL-013、EVAL-018 和确定性事务测试验证选择与只读边界。",
      "status": "pending"
    },
    {
      "id": "REQ-007",
      "requirement": "二次确认前真实索引、工作区和主对象库不变；commit object 创建前在定义验证检查点可观察到的 HEAD、索引、manifest、选择、工作区、任务树、脚本或消息摘要变化使确认失效，唯一 Git 进程启动后还必须按实际 HEAD/tree 和恢复证据处理 hook 影响与最终结果。",
      "verification": "EVAL-012、EVAL-017 和确定性事务测试验证 prepare 零真实副作用、确认检查点绑定失效与 Git 启动后的 actual-tree 恢复。",
      "status": "pending"
    },
    {
      "id": "REQ-008",
      "requirement": "在已声明的 cooperative-concurrency 威胁模型内，成功提交只包含已选 hunk，并把原有无关 staged 内容恢复为 staged；取消、拒绝和失败不丢失用户内容。",
      "verification": "EVAL-013～EVAL-017 和确定性事务测试验证成功、取消、hook 拒绝、可观察并发失效与恢复。",
      "status": "pending"
    },
    {
      "id": "REQ-009",
      "requirement": "事务运行时只增加受审计脚本，不扩大签名、hook 绕过、amend、push、tag、release、发布、上传、历史或配置写入权限，也不引入平台原生 helper、driver 或新增运行时依赖。",
      "verification": "EVAL-016、EVAL-019、归档审计、依赖检查和 CLI/Git 进程测试验证权限与可移植运行时边界。",
      "status": "pending"
    }
  ],
  "tracks": {
    "references": {
      "status": "disabled",
      "evidence": "The confirmed workflow fits in one focused SKILL.md without conditional domain material.",
      "unblock_condition": ""
    },
    "scripts": {
      "status": "enabled",
      "evidence": "Version 5 已确认使用 scripts/stage-transaction.mjs；最终交付时替换为脚本测试或评测 artifact 摘要。",
      "unblock_condition": ""
    },
    "assets": {
      "status": "disabled",
      "evidence": "The Skill produces text and requires no reusable output asset.",
      "unblock_condition": ""
    },
    "implicit-trigger": {
      "status": "enabled",
      "evidence": "Version 5 运行时和触发评测尚未完成，最终交付时替换为 artifact 证据。",
      "unblock_condition": ""
    },
    "multi-agent": {
      "status": "disabled",
      "evidence": "Formal compatibility outside Codex was not requested.",
      "unblock_condition": ""
    },
    "installer": {
      "status": "disabled",
      "evidence": "Standard Skill directory placement is sufficient and no managed configuration write is authorized.",
      "unblock_condition": ""
    },
    "open-source-release": {
      "status": "disabled",
      "evidence": "Local development and delivery were requested; no public release, tag, or remote publication was authorized.",
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

## Evidence References

Evidence Contract v1 uses field-specific repository-relative references.

- `artifact:path#sha256` means `artifact:<path>#sha256:<64 lowercase hex digest>`.
- `path:` means `path:<path>` for delivery implementation.
- `eval:` means `eval:<evaluation-id>[,<evaluation-id>...]` from `evals/evals.json`, such as `eval:EVAL-001,EVAL-002`.

Enabled tracks, prompt budgets, evaluation results, and capability claims use `artifact:` evidence at delivery. During a draft, an enabled track records the confirmed implementation direction until artifact evidence exists. Disabled tracks record a non-empty reason. Blocked tracks use `required:<work>;impact:<delivery-impact>` and an `unblock_condition`.

Use stable IDs for conflicts and acceptance criteria. Acceptance criteria record a measurable requirement, verification method, and status. The matching requirement entry in `docs/delivery-report.md` places `path:` in `implementation` and `eval:` in `verification`; adding those fields to an acceptance criterion would violate the strict schema. The Gate checks the recorded contract but does not run an Agent or prove that a model actually produced the result.
