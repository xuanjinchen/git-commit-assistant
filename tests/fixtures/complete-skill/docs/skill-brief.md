# Skill Brief

<!-- scaffold-contract:skill-brief:v1 -->
```json
{
  "schema_version": 1,
  "status": "ready",
  "conflicts": [],
  "acceptance_criteria": [
    {
      "id": "REQ-001",
      "requirement": "Generate concise structured summaries without inventing unsupported facts",
      "verification": "Automated positive, negative, and boundary evaluations pass",
      "status": "pass"
    }
  ],
  "tracks": {
    "references": {
      "status": "enabled",
      "evidence": "artifact:SKILL.md#sha256:ded29f1c7a27a3285ba0fd26266867c2947e9dc5adfc61e88dca10f3e4d498ff",
      "unblock_condition": ""
    },
    "scripts": {
      "status": "disabled",
      "evidence": "No deterministic helper script is required.",
      "unblock_condition": ""
    },
    "assets": {
      "status": "disabled",
      "evidence": "No reusable binary or text asset is required by the accepted behavior.",
      "unblock_condition": ""
    },
    "implicit-trigger": {
      "status": "disabled",
      "evidence": "Activation remains explicit in this fixture.",
      "unblock_condition": ""
    },
    "multi-agent": {
      "status": "disabled",
      "evidence": "Only one Agent contract is evaluated.",
      "unblock_condition": ""
    },
    "installer": {
      "status": "disabled",
      "evidence": "No managed installation behavior is claimed.",
      "unblock_condition": ""
    },
    "open-source-release": {
      "status": "blocked",
      "evidence": "required:Record explicit release authorization and immutable release evidence.;impact:Public release capability is not claimed.",
      "unblock_condition": "Record explicit release authorization and immutable release evidence."
    }
  },
  "prompt_budget": {
    "limit_tokens": 1200,
    "measured_tokens": 840,
    "evidence": "artifact:evals/results/prompt-budget.txt#sha256:5a0dca07f061ea026119aa7ae77bf3626981b6d269d48d14095e395cb877995c"
  }
}
```
