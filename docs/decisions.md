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
      "status": "superseded",
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
      "status": "superseded",
      "scope": "delivery evidence",
      "decision": "Close Version 5 as ready only after all nineteen independent active Agent/controller cases pass against SKILL.md SHA-256 2d4662ca8a757ee3f099f75683feac1053ac1134d5b664696b872d4c4da18914 and transaction-script SHA-256 e5fc1cb91c468f68366a91b557b9bbd531d07cd58438ee746a4faa5d25f5fe52, every formal source set excludes diagnostics, ordinary hook-rejection cleanup restores the main ODB exactly, foreign-object or reflog mutation makes cleanup fail closed with the owned pack preserved, and the conservative Skill prompt estimate remains within 1,800 tokens. Harmless harness rejections before a fresh sealed run and evidence isolation mistakes strictly after sealing remain procedural concerns rather than invalidators when they cannot change any formal decision, raw report, or canonical snapshot.",
      "evidence": "Historical 2026-08-23 closure record: the then-current EVAL-016, EVAL-017, and prompt-budget artifacts were reviewed under that frozen Version 5 source set. Their recorded digests remain in repository history and are not current mutable-path evidence.",
      "supersedes": "DEC-017"
    },
    {
      "id": "DEC-019",
      "status": "superseded",
      "scope": "helper authorization and delivery evidence",
      "decision": "Close the repository delivery at HEAD dc54b60d223e157b3fe5203afb6a3168e799b6a9 only after nineteen fresh active Agent/controller cases pass against SKILL.md SHA-256 2d4662ca8a757ee3f099f75683feac1053ac1134d5b664696b872d4c4da18914 and transaction-script SHA-256 b7332abc9bdf5a2839eb75d793a9fa44f767865ab0cbff231c4212540b873791. Helper authorization protects the capability of an already-created real transaction from foreign callers; an arbitrary same-privilege parent process that constructs its own cwd is not an ownership-protected object, and the portable runtime does not claim parent-process attestation. Formal evidence uses only current active controller/runtime source files and keeps installation equivalence as a separate, explicitly verified operational claim.",
      "evidence": "Historical 2026-08-24 closure record: the then-current EVAL-016, EVAL-017, EVAL-019, and prompt-budget artifacts were reviewed against the post-helper-authorization Version 5 runtime. Their recorded digests remain in repository history and are not current mutable-path evidence.",
      "supersedes": "DEC-018"
    },
    {
      "id": "DEC-020",
      "status": "superseded",
      "scope": "helper authorization, delivery evidence, and global installation",
      "decision": "Close Version 5 repository and installation delivery at HEAD dc54b60d223e157b3fe5203afb6a3168e799b6a9 with SKILL.md SHA-256 2d4662ca8a757ee3f099f75683feac1053ac1134d5b664696b872d4c4da18914 and transaction-script SHA-256 b7332abc9bdf5a2839eb75d793a9fa44f767865ab0cbff231c4212540b873791. The global installation must contain exactly SKILL.md and scripts/stage-transaction.mjs, match both repository files byte-for-byte, and pass an installed inspect smoke without changing the isolated repository. Helper authorization remains capability isolation for an already-created real transaction and does not claim portable parent-process attestation.",
      "evidence": "On 2026-08-24 the main controller recorded an installed inspect exit of 0 with single-line JSON and unchanged isolated-repository HEAD, index, status, and main ODB. An independent read-only closure check found exactly the two declared installed files, reproduced both frozen SHA-256 values, and confirmed byte equality with the repository copies.",
      "supersedes": "DEC-019"
    },
    {
      "id": "DEC-021",
      "status": "active",
      "scope": "message policy",
      "decision": "Resolve commit-message language before repository conventions: honor an explicit user language for SUBJECT and body; otherwise require Simplified Chinese. Code, paths, and recent subjects cannot select the language, while recent subjects may still guide a stable scope and other repository conventions. Keep subject-only messages for simple changes and the fewest concise evidence-backed hyphen bullets for coherent complex or multi-point changes.",
      "evidence": "User-confirmed Version 6 requirement on 2026-09-05; artifact:evals/results/EVAL-002.txt#sha256:14e2e74de8fc146dda129ceb437458e91b9a740fcade7a0b7337704458f598d4; artifact:evals/results/EVAL-011.txt#sha256:9e22527b1d856c9a160033616abf133e0c495d27464f728ff97d88654bf8680b; artifact:evals/results/EVAL-020.txt#sha256:d6172968807d206e09672e5ef3ca9d700eed70186af82fb52ad22fd7db39622d; artifact:evals/results/EVAL-021.txt#sha256:c7833396892c3537d25cb3d2d7d08f26a4a4a0ccdc55bd42d825a60b7e9fa591",
      "supersedes": "DEC-011"
    },
    {
      "id": "DEC-022",
      "status": "active",
      "scope": "Version 6 delivery evidence and global installation",
      "decision": "Close the Version 6 language-policy update with SKILL.md SHA-256 816711cdf84ff4565ec9d32d5078fd3f5a745fe0c04c0c31c001549f082ce1ca, unchanged transaction-script SHA-256 b7332abc9bdf5a2839eb75d793a9fa44f767865ab0cbff231c4212540b873791, and a conservative 1,778/1,800 prompt budget. The global installation contains exactly those two runtime files and must pass an installed inspect smoke without changing the isolated repository. Preserve the prior 87-file installation as a recoverable backup outside the Skill discovery root rather than deleting it.",
      "evidence": "artifact:evals/results/EVAL-002.txt#sha256:14e2e74de8fc146dda129ceb437458e91b9a740fcade7a0b7337704458f598d4; artifact:evals/results/EVAL-011.txt#sha256:9e22527b1d856c9a160033616abf133e0c495d27464f728ff97d88654bf8680b; artifact:evals/results/EVAL-020.txt#sha256:d6172968807d206e09672e5ef3ca9d700eed70186af82fb52ad22fd7db39622d; artifact:evals/results/EVAL-021.txt#sha256:c7833396892c3537d25cb3d2d7d08f26a4a4a0ccdc55bd42d825a60b7e9fa591; artifact:evals/results/prompt-budget.txt#sha256:d1ef60726c7754a695e77dbbe6527de6c971a58b796e21258ca2eed12130a0ac; installed inspect returned one JSON line and preserved HEAD, index, status, and object database on 2026-09-05.",
      "supersedes": "DEC-020"
    }
  ]
}
```
