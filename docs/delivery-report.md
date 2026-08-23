# Delivery Report

Version 4 evidence is a historical baseline. On 2026-08-24, EVAL-001 through EVAL-019 independently passed against final frozen runtime hashes `SKILL.md=2d4662ca8a757ee3f099f75683feac1053ac1134d5b664696b872d4c4da18914` and `scripts/stage-transaction.mjs=e5fc1cb91c468f68366a91b557b9bbd531d07cd58438ee746a4faa5d25f5fe52`. Each result artifact is bound to a unique SHA-256 and cites only its current active fixture paths; all `diagnostics` paths are excluded. Ordinary hook rejection restored the main ODB to baseline, foreign-object or reflog mutation made imported-pack cleanup fail closed, and the unchanged Skill retains its valid 1,734/1,800 prompt-budget evidence.

EVAL-001 had three harmless malformed harness requests before its fresh recorded inspect and a post-completion verification command later read an excluded diagnostics path. The requests were rejected with no repository change or retained transaction; every formal decision, raw report, and canonical snapshot was complete before the later read. These are procedural concerns, not contradictions of the sealed active evidence.

On 2026-08-24, the main controller completed the final global reinstallation at the logical path `$CODEX_HOME/skills/git-commit-assistant`. The installed layout is exactly `SKILL.md` and `scripts/stage-transaction.mjs`; their SHA-256 values are `2d4662ca8a757ee3f099f75683feac1053ac1134d5b664696b872d4c4da18914` and `e5fc1cb91c468f68366a91b557b9bbd531d07cd58438ee746a4faa5d25f5fe52`, and each installed file is byte-for-byte equal to its repository counterpart. The installed `inspect` smoke exited 0 with single-line JSON while the isolated repository's HEAD, index, status, and main ODB remained unchanged. Temporary backups from the failed installation attempt were verified and then removed. The whole-branch re-review and separately authorized maintainer push remain pending.

<!-- scaffold-contract:delivery-report:v1 -->
```json
{
  "schema_version": 1,
  "requirements": [
    {
      "id": "REQ-001",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-012,EVAL-018",
      "status": "pass"
    },
    {
      "id": "REQ-002",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-012,EVAL-017",
      "status": "pass"
    },
    {
      "id": "REQ-003",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-013,EVAL-015,EVAL-016,EVAL-017",
      "status": "pass"
    },
    {
      "id": "REQ-004",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-012,EVAL-018,EVAL-019",
      "status": "pass"
    },
    {
      "id": "REQ-005",
      "implementation": "path:scripts/stage-transaction.mjs",
      "verification": "eval:EVAL-014,EVAL-016,EVAL-019",
      "status": "pass"
    },
    {
      "id": "REQ-006",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-012,EVAL-013,EVAL-018",
      "status": "pass"
    },
    {
      "id": "REQ-007",
      "implementation": "path:scripts/stage-transaction.mjs",
      "verification": "eval:EVAL-012,EVAL-017",
      "status": "pass"
    },
    {
      "id": "REQ-008",
      "implementation": "path:scripts/stage-transaction.mjs",
      "verification": "eval:EVAL-013,EVAL-014,EVAL-015,EVAL-016,EVAL-017",
      "status": "pass"
    },
    {
      "id": "REQ-009",
      "implementation": "path:scripts/stage-transaction.mjs",
      "verification": "eval:EVAL-016,EVAL-019",
      "status": "pass"
    }
  ],
  "capability_claims": [
    {
      "name": "Implicit staged and current-task commit assistance",
      "track": "implicit-trigger",
      "evidence": "artifact:evals/results/EVAL-002.txt#sha256:a04f80aa2586eb4a8dd6dc71ff76c5770de85aea5bef1175270d039e15d7cb0a"
    },
    {
      "name": "Transactional task-hunk staging and restoration",
      "track": "scripts",
      "evidence": "artifact:evals/results/EVAL-014.txt#sha256:a78e3db4f22bfa86ef10381d3082b0cb5dab0356465fe95bafc34f3690c57c23"
    }
  ]
}
```
