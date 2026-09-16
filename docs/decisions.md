# 决策记录

Version 8 取代旧事务式工作流。旧决策、规格和评测可从 Git 历史恢复，不再构成当前行为承诺。

<!-- scaffold-contract:decisions:v1 -->
```json
{
  "schema_version": 1,
  "requirement_version": 8,
  "decisions": [
    {
      "id": "DEC-027",
      "status": "active",
      "scope": "single responsibility",
      "decision": "运行时仅 SKILL.md；只分析 staged diff 并返回消息，不执行 Git 写入。",
      "evidence": "2026-09-16 用户明确要求。",
      "supersedes": "DEC-023,DEC-024,DEC-025,DEC-026"
    },
    {
      "id": "DEC-028",
      "status": "active",
      "scope": "skill handoff",
      "decision": "通过会话中完整消息文本交接；确认策略与 Git 操作属于调用方，暂存区更新后重新生成。",
      "evidence": "用户指定 finishing-a-development-branch 等管理 Skill 作为消费者。"
    }
  ]
}
```
