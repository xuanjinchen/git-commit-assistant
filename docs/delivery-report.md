# Delivery Report

Version 4 evidence is a historical baseline. At documentation commit `3120993`, EVAL-001 through EVAL-019 independently passed against the then-frozen Version 5 runtime, ordinary hook rejection restored the main ODB to baseline, foreign-object or reflog mutation made imported-pack cleanup fail closed, and the prompt budget was 1,734/1,800. The subsequent whole-branch review identified a hidden-helper authorization defect; its runtime remediation changes the script bytes, so the hash-bound Agent artifacts remain historical until the maintainer refreshes or explicitly revalidates that evidence before push.

On 2026-08-24, Task 9 installed Version 5 at the logical path `$CODEX_HOME/skills/git-commit-assistant`. Its layout was exactly `SKILL.md` and `scripts/stage-transaction.mjs`; the respective SHA-256 values were `2d4662ca8a757ee3f099f75683feac1053ac1134d5b664696b872d4c4da18914` and `73618ca6d5a947284ddb38a9ed8eaebfd16bcf11c66aa87c1cd21982f0b56671`. Each installed runtime file was then byte-for-byte equal to its repository counterpart. The installed `inspect` smoke test exited 0, produced one-line JSON, and left its repository snapshot unchanged. The Task 9 scoped installation/documentation re-review passed, and documentation commit `3120993` completed. Because the whole-branch helper fix changes the repository script after that installation, updated installation/hash verification, whole-branch re-review, and the separately authorized maintainer push remain pending.

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
      "verification": "eval:EVAL-013,EVAL-014,EVAL-015,EVAL-016",
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
      "evidence": "artifact:evals/results/EVAL-002.txt#sha256:3e6952e34392ed59848389fe2dfbd152154531b53ecd17fdb7cef963b2b84c6d"
    },
    {
      "name": "Transactional task-hunk staging and restoration",
      "track": "scripts",
      "evidence": "artifact:evals/results/EVAL-014.txt#sha256:61e9a790a87e994d2be4aeb931a5dcbd4b19001e9168b4178cbe8bc7a06da03c"
    }
  ]
}
```
