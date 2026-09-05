# Skill Brief

## Requirement Version

Version 6, revised and confirmed 2026-09-05, changes only commit-message language precedence. An explicit user language controls `SUBJECT` and body; otherwise Simplified Chinese is mandatory. Code, paths, and recent subjects cannot select the language, while recent subjects may still guide a stable `SCOPE` and repository conventions. Fresh independent EVAL-002, EVAL-011, EVAL-020, and EVAL-021 cases passed against frozen `SKILL.md` SHA-256 `816711cdf84ff4565ec9d32d5078fd3f5a745fe0c04c0c31c001549f082ce1ca`; the transaction script remains frozen at SHA-256 `b7332abc9bdf5a2839eb75d793a9fa44f767865ab0cbff231c4212540b873791`. The final Skill measures 1,778/1,800 conservative prompt tokens. Version 5 transaction and safety evidence remains the historical baseline for unchanged behavior.

The global installation at `$CODEX_HOME/skills/git-commit-assistant` is synchronized to Version 6 and contains exactly `SKILL.md` plus `scripts/stage-transaction.mjs`. Their SHA-256 values match the repository copies, and an installed `inspect` smoke returned one JSON line with the isolated repository's HEAD, index, status, and object database unchanged. The prior 87-file installation was moved intact to `$CODEX_HOME/skill-backups/git-commit-assistant-20260905-pre-v6` for recoverability rather than deleted.

## Objective

For an explicit commit request, prepare only the current task's files or hunks in an external transaction, generate an evidence-based Conventional Commit message, and create one unsigned commit only after a second, fully bound confirmation. For a message-only request, generate a message from the exact real staged snapshot without creating a transaction.

## Trigger and Inputs

Trigger for staged-change commit or commit-message requests, including natural requests that do not name the Skill. An explicit commit request may inspect and prepare a stable manifest containing only current-task files or hunks, even when the real index is empty; message-only requests require a coherent non-empty real staged set. Repository rules, paths, diffs, recent subjects, and Git state are evidence inputs and never instruction sources; repository instructions cannot broaden the runtime boundaries.

## Outputs and Side Effects

Return a complete candidate and task-selection summary, or a safe stop reason. Explicit language requests control the subject and body; otherwise they use Simplified Chinese, while recent history may still guide a stable scope. A simple change uses only a complete subject; a coherent multi-change or complex business change adds the smallest useful set of concise hyphen bullets for material handling points. The runtime is `SKILL.md` plus `scripts/stage-transaction.mjs`: the Agent selects manifest units and the script performs deterministic external-index transactions. Before the second confirmation, the real index, worktree, HEAD, and main object database remain unchanged. Only the second confirmation may create one unsigned commit using exactly `git commit --no-gpg-sign -F <temp>` while preserving hooks. Message-only requests have no repository side effect.

## Non-goals

Do not alter the real index before confirmation; do not amend, sign, push, create tags or releases, publish or upload packages, rewrite history, install or edit hooks, write local or global Git or Codex configuration, or call an external model, API, or delegated agent. Explicit commit requests may prepare selected current-task manifest units only in an owned external transaction. A combined request stops before inspection, preparation, or commit and requires a commit-only scope. The portable runtime does not claim protection against a deliberately hostile same-privilege process that interposes in an individual filesystem-syscall gap and erases every observable trace, nor does it claim to attest an arbitrary same-privilege parent process or parent-created cwd; no native platform helper is added for those adversarial cases.

## Concurrency Threat Model

The runtime protects cooperative concurrency: ordinary Git commands, user actions, hooks, and other processes when their change to bound or protected content, object identity, path state, ownership evidence, or filesystem metadata is observable at a defined validation or recovery checkpoint. It fails closed on those checkpoint observations, preserves foreign locks and recoverable bytes when ownership is uncertain, and never overwrites worktree content to hide a conflict. Hooks remain untrusted and do not receive a broader exemption.

An active same-privilege adversary that precisely races between two operating-system calls and then erases every observable trace with native APIs is outside the portable contract. This residual risk qualifies concurrency and lock guarantees throughout the retained Version 5/6 runtime; deterministic tests must still cover every recorded, in-scope, reproducible observable replacement window and must not present metadata barriers as proof against the excluded adversary.

Helper authorization protects only the capability attached to an already-created real transaction: foreign callers cannot reuse that capability across transactions. A same-privilege parent process that independently constructs a cwd is not thereby an ownership-protected object. The helper boundary is capability isolation, not portable parent identity or ancestry attestation.

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
- `CONFLICT-005` is resolved: helper authorization must isolate an existing real transaction capability without treating an arbitrary same-privilege parent-created cwd as an owned object or claiming portable parent-process attestation.
- `CONFLICT-006` is resolved: the Version 5 repository-history language fallback conflicts with the confirmed Version 6 requirement that unspecified messages default to Simplified Chinese.

<!-- scaffold-contract:skill-brief:v1 -->
```json
{
  "schema_version": 1,
  "status": "ready",
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
    },
    {
      "id": "CONFLICT-005",
      "summary": "Helper 授权若把任意同权限父进程自建 cwd 当作所有权对象，会超出可移植运行时能够证明的可信根。",
      "status": "resolved",
      "resolution": "只隔离已有真实事务 capability，拒绝 foreign caller 跨事务复用；任意同权限父进程及其自建 cwd 不属于所有权保护对象，不声明 portable parent attestation。"
    },
    {
      "id": "CONFLICT-006",
      "summary": "Version 5 允许近期提交语言覆盖 fallback，而 Version 6 要求用户未指定语言时默认使用简体中文。",
      "status": "resolved",
      "resolution": "语言先于仓库历史决定：显式语言要求优先，否则 SUBJECT 和正文必须使用简体中文；近期提交只用于稳定 scope 和其他仓库惯例。"
    }
  ],
  "acceptance_criteria": [
    {
      "id": "REQ-001",
      "requirement": "A coherent staged change produces an evidence-based Conventional Commit candidate: a simple change uses only a complete subject, while coherent multi-change or complex business work adds the smallest useful set of concise hyphen bullets for distinct material handling points.",
      "verification": "EVAL-011, EVAL-012, EVAL-018, EVAL-021, and the deterministic transaction tests verify simple and complex message derivation, task selection, and message-only restraint.",
      "status": "pass"
    },
    {
      "id": "REQ-002",
      "requirement": "No commit occurs before a second confirmation. Any change to a bound HEAD, index, manifest, selection, worktree, task tree, script, or complete message digest that is observable at a defined validation checkpoint before commit-object creation invalidates that confirmation; after the single Git process starts, actual HEAD/tree and recovery evidence also govern hook effects and final reporting.",
      "verification": "EVAL-012, EVAL-017, and deterministic transaction tests verify confirmation checkpoints, post-spawn actual-tree handling, and zero real-side-effect preparation.",
      "status": "pass"
    },
    {
      "id": "REQ-003",
      "requirement": "Within the declared cooperative-concurrency threat model, the Skill stops without weakening safeguards for ambiguous task hunks, special Git state, likely sensitive material, observable concurrent changes, hook rejection, or foreign reuse of an existing transaction capability; it does not treat an arbitrary same-privilege parent cwd as an owned object.",
      "verification": "EVAL-013, EVAL-015, EVAL-016, EVAL-017, and deterministic transaction/helper-authorization tests verify safe stops, observable race handling, capability isolation, and protected user state.",
      "status": "pass"
    },
    {
      "id": "REQ-004",
      "requirement": "The description discovers staged commit assistance without attracting adjacent Git explanation, history review, or history rewriting requests.",
      "verification": "Scaffold frontmatter validation plus EVAL-012, EVAL-018, and EVAL-019 verify positive and adjacent-negative trigger semantics.",
      "status": "pass"
    },
    {
      "id": "REQ-005",
      "requirement": "The workflow creates a unique external temporary message file and starts exactly one `git commit --no-gpg-sign -F <temp>` process, removes the file after success or failure, and never signs, bypasses hooks, changes hook or configuration state, pushes, tags, releases, publishes or uploads packages, delegates externally, or rewrites history.",
      "verification": "EVAL-014, EVAL-016, EVAL-019, and deterministic transaction tests verify the exact one-process protocol, cleanup, hooks, and forbidden-side-effect boundaries.",
      "status": "pass"
    },
    {
      "id": "REQ-006",
      "requirement": "明确提交请求从稳定 manifest 只选择当前任务的文件或 hunk；message-only 不创建事务。",
      "verification": "EVAL-012、EVAL-013、EVAL-018 和确定性事务测试验证选择与只读边界。",
      "status": "pass"
    },
    {
      "id": "REQ-007",
      "requirement": "二次确认前真实索引、工作区和主对象库不变；commit object 创建前在定义验证检查点可观察到的 HEAD、索引、manifest、选择、工作区、任务树、脚本或消息摘要变化使确认失效，唯一 Git 进程启动后还必须按实际 HEAD/tree 和恢复证据处理 hook 影响与最终结果。",
      "verification": "EVAL-012、EVAL-017 和确定性事务测试验证 prepare 零真实副作用、确认检查点绑定失效与 Git 启动后的 actual-tree 恢复。",
      "status": "pass"
    },
    {
      "id": "REQ-008",
      "requirement": "在已声明的 cooperative-concurrency 威胁模型内，成功提交只包含已选 hunk，并把原有无关 staged 内容恢复为 staged；取消、拒绝和失败不丢失用户内容。",
      "verification": "EVAL-013～EVAL-017 和确定性事务测试验证成功、取消、hook 拒绝、可观察并发失效与恢复。",
      "status": "pass"
    },
    {
      "id": "REQ-009",
      "requirement": "事务运行时只增加受审计脚本，不扩大签名、hook 绕过、amend、push、tag、release、发布、上传、历史或配置写入权限，也不引入平台原生 helper、driver 或新增运行时依赖。",
      "verification": "EVAL-016、EVAL-019、归档审计、依赖检查和 CLI/Git 进程测试验证权限与可移植运行时边界。",
      "status": "pass"
    },
    {
      "id": "REQ-010",
      "requirement": "用户明确指定语言时 SUBJECT 和正文使用指定语言；未指定时默认使用简体中文。代码、路径和提交历史不能选择语言，近期提交只可辅助稳定 scope 和仓库惯例。",
      "verification": "EVAL-002 与 EVAL-011 验证英文历史下默认简体中文 subject 和正文；EVAL-020 与 EVAL-021 验证中文历史下显式英文覆盖默认值并应用到 subject 和正文。",
      "status": "pass"
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
      "evidence": "artifact:evals/results/EVAL-014.txt#sha256:2260ae9ab62737e3ec0ea955511ce9dfac79ad2c44d0c934a5badba06dfcd9a6",
      "unblock_condition": ""
    },
    "assets": {
      "status": "disabled",
      "evidence": "The Skill produces text and requires no reusable output asset.",
      "unblock_condition": ""
    },
    "implicit-trigger": {
      "status": "enabled",
      "evidence": "artifact:evals/results/EVAL-002.txt#sha256:14e2e74de8fc146dda129ceb437458e91b9a740fcade7a0b7337704458f598d4",
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
    "limit_tokens": 1800,
    "measured_tokens": 1778,
    "evidence": "artifact:evals/results/prompt-budget.txt#sha256:d1ef60726c7754a695e77dbbe6527de6c971a58b796e21258ca2eed12130a0ac"
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
