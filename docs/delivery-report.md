# Delivery Report

Version 4 evidence is a historical baseline. On 2026-08-24, EVAL-001 through EVAL-019 independently passed fresh post-helper-authorization evaluation against delivery HEAD `dc54b60d223e157b3fe5203afb6a3168e799b6a9`, `SKILL.md=2d4662ca8a757ee3f099f75683feac1053ac1134d5b664696b872d4c4da18914`, and `scripts/stage-transaction.mjs=b7332abc9bdf5a2839eb75d793a9fa44f767865ab0cbff231c4212540b873791`. Each result artifact is bound to a unique SHA-256 and cites only current active controller/runtime source files. Ordinary hook rejection restored every controller-observed repository field to baseline, EVAL-017 rejected all five observable stale-confirmation vectors while preserving controller changes, EVAL-018 remained message-only, and EVAL-019 performed zero network action. The unchanged Skill retains its valid 1,734/1,800 prompt-budget evidence.

The helper trust root is intentionally narrow: it isolates the capability of an already-created real transaction from foreign callers. An arbitrary same-privilege parent process that creates its own cwd is not an ownership-protected object, and this portable runtime does not claim parent-process attestation.

The final global installation at `$CODEX_HOME/skills/git-commit-assistant` is now closed against the frozen post-helper-authorization runtime. An independent read-only check found exactly `SKILL.md` and `scripts/stage-transaction.mjs`, reproduced SHA-256 values `2d4662ca8a757ee3f099f75683feac1053ac1134d5b664696b872d4c4da18914` and `b7332abc9bdf5a2839eb75d793a9fa44f767865ab0cbff231c4212540b873791`, and confirmed that both installed files equal their repository copies. The controller's installed `inspect` smoke exited 0 with single-line JSON while the isolated repository's HEAD, index, status, and main ODB remained unchanged. This documentation closure did not stage, commit, push, or publish anything.

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
      "evidence": "artifact:evals/results/EVAL-002.txt#sha256:14d1977e516d0512bc6134b4ea701106ea504d19949d1d7a7aaec8c5ad08165e"
    },
    {
      "name": "Transactional task-hunk staging and restoration",
      "track": "scripts",
      "evidence": "artifact:evals/results/EVAL-014.txt#sha256:2260ae9ab62737e3ec0ea955511ce9dfac79ad2c44d0c934a5badba06dfcd9a6"
    }
  ]
}
```
