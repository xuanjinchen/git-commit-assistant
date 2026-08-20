# Decisions

Record requirement interpretations and superseding decisions without rewriting history.

<!-- scaffold-contract:decisions:v1 -->
```json
{
  "schema_version": 1,
  "decisions": [
    {
      "id": "DEC-001",
      "status": "active",
      "scope": "runtime architecture",
      "decision": "Ship one self-contained SKILL.md and no Git hook, runtime script, reference, asset, or installer.",
      "evidence": "User confirmed the single-file route and Codex-only boundary.",
      "supersedes": null
    },
    {
      "id": "DEC-002",
      "status": "active",
      "scope": "commit authorization",
      "decision": "Require explicit confirmation and bind it to the exact git write-tree identity before committing.",
      "evidence": "Confirmed workflow and safety design sections.",
      "supersedes": null
    },
    {
      "id": "DEC-003",
      "status": "active",
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
      "status": "active",
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
      "decision": "Use only one Git process with argv equivalent to git commit --no-gpg-sign -F <temp>, after writing the exact confirmed message through a safe file API to one unique temporary file outside the repository; always remove that file and never retry.",
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
    }
  ]
}
```
