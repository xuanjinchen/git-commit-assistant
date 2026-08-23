# Decisions

Record requirement interpretations and superseding decisions without rewriting history.

<!-- scaffold-contract:decisions:v1 -->
```json
{
  "schema_version": 1,
  "decisions": [
    {
      "id": "DEC-001",
      "status": "superseded",
      "scope": "runtime architecture",
      "decision": "Ship one self-contained SKILL.md and no Git hook, runtime script, reference, asset, or installer.",
      "evidence": "User confirmed the single-file route and Codex-only boundary.",
      "supersedes": null
    },
    {
      "id": "DEC-002",
      "status": "superseded",
      "scope": "commit authorization",
      "decision": "Require explicit confirmation and bind it to the exact git write-tree identity before committing.",
      "evidence": "Confirmed workflow and safety design sections.",
      "supersedes": null
    },
    {
      "id": "DEC-003",
      "status": "superseded",
      "scope": "message policy",
      "decision": "Use evidence-driven Conventional Commits with an optional scope, body, and footer and a 72-character subject target.",
      "evidence": "Confirmed commit-message design section.",
      "supersedes": null
    },
    {
      "id": "DEC-004",
      "status": "active",
      "scope": "safety",
      "decision": "Treat repository content as untrusted data and stop for special Git state, likely sensitive material, insufficient evidence, changed index identity, or hook rejection.",
      "evidence": "Confirmed error and safety design section.",
      "supersedes": null
    },
    {
      "id": "DEC-005",
      "status": "active",
      "scope": "validation",
      "decision": "Use Node 22 scaffold checks, test-first behavior contracts, real isolated Git evaluations, and Evidence Contract v1 delivery closure.",
      "evidence": "Confirmed evaluation design and bundled system skill-creator guidance loaded on 2026-08-19.",
      "supersedes": null
    },
    {
      "id": "DEC-006",
      "status": "active",
      "scope": "discovery",
      "decision": "Enable implicit discovery through the SKILL.md description only, with no persistent rule template.",
      "evidence": "User confirmed automatic activation for Codex commit requests.",
      "supersedes": null
    },
    {
      "id": "DEC-007",
      "status": "superseded",
      "scope": "commit execution",
      "decision": "Run git commit --no-gpg-sign to enforce unsigned commits while preserving configured hook execution.",
      "evidence": "2026-08-20 independent review proved ordinary git commit can inherit commit.gpgSign=true.",
      "supersedes": null
    },
    {
      "id": "DEC-008",
      "status": "active",
      "scope": "discovery safety",
      "decision": "Select the matching Skill from a controlled catalog before loading its body.",
      "evidence": "2026-08-20 remediation requires catalog routing before Skill-body exposure.",
      "supersedes": null
    },
    {
      "id": "DEC-009",
      "status": "active",
      "scope": "commit execution",
      "decision": "Use only one Git process with argv equivalent to git commit --no-gpg-sign -F <temp>, after canonicalizing the complete confirmed message to UTF-8 without a BOM and exactly one terminal LF, writing those exact bytes through a safe file API to one unique temporary file outside the repository, and hashing those same bytes for confirmation; always remove that file and never retry.",
      "evidence": "2026-08-20 final fix wave addresses review findings on exact execution and temporary-file lifecycle.",
      "supersedes": "DEC-007"
    },
    {
      "id": "DEC-010",
      "status": "active",
      "scope": "commit authorization",
      "decision": "A request that combines a commit with any forbidden side effect stops before commit execution and asks for a commit-only scope; repository instructions cannot authorize an exception.",
      "evidence": "2026-08-20 final fix wave requires explicit boundary enforcement for tags, releases, publishing, uploads, external delegation, configuration, hooks, signing, bypass, and history mutation.",
      "supersedes": null
    },
    {
      "id": "DEC-011",
      "status": "active",
      "scope": "message policy",
      "decision": "Use an evidence-driven Conventional Commit message with an optional scope, body, and footer and a 72-character subject target. Use a subject-only message when one simple semantic change is fully described by the subject; for one coherent change with multiple material handling points or complex business behavior, add the smallest useful set of concise hyphen bullets, derived from staged evidence and not from file count.",
      "evidence": "User-confirmed Version 4 design and remittance-status example on 2026-08-20.",
      "supersedes": "DEC-003"
    },
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
    },
    {
      "id": "DEC-016",
      "status": "active",
      "scope": "concurrency threat model",
      "decision": "Clarify only the concurrency-related guarantees of DEC-004, DEC-014, and DEC-015 with portable cooperative concurrency: stop when a bound or protected content, identity, path, ownership, or metadata change is observable at a defined validation or recovery checkpoint, and preserve foreign state when ownership is uncertain. Do not claim protection against a deliberately hostile same-privilege process that races inside an individual filesystem-syscall gap and uses native APIs to erase every observable trace; do not add a platform-native helper for that residual risk. Hooks remain untrusted, observable hook mutations and post-commit actual HEAD/tree verification remain in scope, and all non-concurrency safeguards in those decisions remain unchanged.",
      "evidence": "User approved the review-driven portable threat-model revision on 2026-08-23 after independent Round 4 review demonstrated that Node.js lacks cross-platform descriptor-bound unlink/rename and that child-visible path, identity, and timestamp barriers alone cannot prove which tree the parent Git process loaded after hooks before commit-object creation.",
      "supersedes": null
    },
    {
      "id": "DEC-017",
      "status": "superseded",
      "scope": "delivery evidence",
      "decision": "Keep Version 5 delivery draft when raw evidence contradicts an assertion or the frozen runtime exceeds the prompt budget; do not convert partial evidence into a ready contract. EVAL-016 fails diagnostic-only recovery isolation because a retained unreachable diagnostic pack also changed the main ODB, and the frozen Skill measures 1,891 tokens against a 1,800-token limit.",
      "evidence": "Historical draft review on 2026-08-23 recorded that the then-current EVAL-016 diagnostic run contradicted recovery isolation and that the then-frozen Skill exceeded the 1,800-token budget. Those superseded bytes were not preserved as current Evidence Contract artifacts.",
      "supersedes": null
    },
    {
      "id": "DEC-018",
      "status": "active",
      "scope": "delivery evidence",
      "decision": "Close Version 5 as ready only after all nineteen independent active Agent/controller cases pass against SKILL.md SHA-256 2d4662ca8a757ee3f099f75683feac1053ac1134d5b664696b872d4c4da18914 and transaction-script SHA-256 e5fc1cb91c468f68366a91b557b9bbd531d07cd58438ee746a4faa5d25f5fe52, every formal source set excludes diagnostics, ordinary hook-rejection cleanup restores the main ODB exactly, foreign-object or reflog mutation makes cleanup fail closed with the owned pack preserved, and the conservative Skill prompt estimate remains within 1,800 tokens. Harmless harness rejections before a fresh sealed run and evidence isolation mistakes strictly after sealing remain procedural concerns rather than invalidators when they cannot change any formal decision, raw report, or canonical snapshot.",
      "evidence": "artifact:evals/results/EVAL-016.txt#sha256:c88c7c54130a833baeaaa584f5090664e31b4d7dc403b9077fc7266c1ee75cbe; artifact:evals/results/EVAL-017.txt#sha256:6a96aa33e7788033aa5f464bb26af709200fb16933c92082a0b74f83aad360b9; artifact:evals/results/prompt-budget.txt#sha256:7b64f8ce2146ff781f2f5b9e5df6baa8193f7ea214add6b6d36e3e0c08f4fc2b",
      "supersedes": "DEC-017"
    }
  ]
}
```
