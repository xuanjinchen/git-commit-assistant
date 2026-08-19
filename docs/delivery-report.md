# Delivery Report

Complete this report only with evidence produced by the implemented Skill and its evaluations.

<!-- scaffold-contract:delivery-report:v1 -->
```json
{
  "schema_version": 1,
  "requirements": [
    { "id": "REQ-001", "implementation": "path:SKILL.md", "verification": "eval:EVAL-001,EVAL-002", "status": "pass" },
    { "id": "REQ-002", "implementation": "path:SKILL.md", "verification": "eval:EVAL-001,EVAL-005", "status": "pass" },
    { "id": "REQ-003", "implementation": "path:SKILL.md", "verification": "eval:EVAL-003,EVAL-004,EVAL-006,EVAL-008,EVAL-009", "status": "pass" },
    { "id": "REQ-004", "implementation": "path:SKILL.md", "verification": "eval:EVAL-002,EVAL-007", "status": "pass" }
  ],
  "capability_claims": [
    {
      "name": "Description-based discovery for staged commit assistance",
      "track": "implicit-trigger",
      "evidence": "artifact:SKILL.md#sha256:47edb03f31770ee91ebf52bf18f6740d1f738d114170c93055d9b32ca0a648b6"
    }
  ]
}
```
