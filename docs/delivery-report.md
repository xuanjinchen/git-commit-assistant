# Delivery Report

Complete this report only with evidence produced by the implemented Skill and its evaluations.

<!-- scaffold-contract:delivery-report:v1 -->
```json
{
  "schema_version": 1,
  "requirements": [
    {
      "id": "REQ-001",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-001,EVAL-002",
      "status": "pass"
    },
    {
      "id": "REQ-002",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-001,EVAL-005",
      "status": "pass"
    },
    {
      "id": "REQ-003",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-003,EVAL-004,EVAL-006,EVAL-008,EVAL-009",
      "status": "pass"
    },
    {
      "id": "REQ-004",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-002,EVAL-007",
      "status": "pass"
    },
    {
      "id": "REQ-005",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-001,EVAL-009",
      "status": "pass"
    }
  ],
  "capability_claims": [
    {
      "name": "Implicit staged-commit assistance discovery",
      "track": "implicit-trigger",
      "evidence": "artifact:evals/results/EVAL-002.txt#sha256:d5f5e8a91d44140c4b18b281c883553652fadf91424d9e468e12e846ebe71b9d"
    }
  ]
}
```
