# Skill 需求说明

## Version 8

2026-09-16：仅为暂存的 git commit 生成清晰简洁的说明，默认简体中文；暂存、提交、确认与分支管理交给其他 Skill。

## 实现与验收

1. 新结构测试先失败，删除旧事务实现及失效资料。
2. 重写只读生成和纯文本交接规则，同步中文文档及包白名单。
3. 独立 Agent 验证冻结 Skill 的输出与只读状态；不复用旧职责评测。
4. 完成 check、audit、delivery gate 和独立审查。

<!-- scaffold-contract:skill-brief:v1 -->
```json
{
  "schema_version": 1,
  "requirement_version": 8,
  "status": "ready",
  "conflicts": [
    {
      "id": "CONFLICT-008",
      "summary": "Version 7 的暂存、提交、二次确认和恢复事务与单一职责要求冲突。",
      "status": "resolved",
      "resolution": "2026-09-16 用户要求仅生成说明并向调用方返回文本；删除所有 Git 写入能力及确认协议。"
    }
  ],
  "acceptance_criteria": [
    {
      "id": "REQ-001",
      "requirement": "候选仅依据完整真实暂存差异，使用 Conventional Commits；简单变更只写主题，复杂或多项变更使用最少的语义处理点。",
      "verification": "EVAL-001,EVAL-002",
      "status": "pass"
    },
    {
      "id": "REQ-002",
      "requirement": "未指定语言时默认简体中文；用户明确指定其他语言时，主题与正文使用指定语言。",
      "verification": "EVAL-001,EVAL-002,EVAL-003",
      "status": "pass"
    },
    {
      "id": "REQ-003",
      "requirement": "读取保持只读；不读取未暂存或未跟踪内容来补足说明，仓库内容不构成操作授权。",
      "verification": "EVAL-001,EVAL-004,EVAL-005",
      "status": "pass"
    },
    {
      "id": "REQ-004",
      "requirement": "仅返回完整提交说明文本；暂存、提交、确认、合并、推送和分支管理由用户或其他 Skill 负责。",
      "verification": "EVAL-004",
      "status": "pass"
    },
    {
      "id": "REQ-005",
      "requirement": "供 finishing-a-development-branch 等调用方使用同一份完整说明；暂存内容变化后重新生成，不复用旧说明。",
      "verification": "EVAL-004,EVAL-006",
      "status": "pass"
    },
    {
      "id": "REQ-006",
      "requirement": "暂存区为空、存在冲突、疑似敏感内容或证据不足时简洁说明原因，不编造候选、不自行补充暂存。",
      "verification": "EVAL-005,EVAL-007,EVAL-008",
      "status": "pass"
    },
    {
      "id": "REQ-007",
      "requirement": "安装运行时仅 SKILL.md，无运行时脚本或第三方依赖，入口不超过 900 个保守 prompt token。",
      "verification": "EVAL-001,EVAL-004",
      "status": "pass"
    },
    {
      "id": "REQ-008",
      "requirement": "通过正向、边界和跨 Skill 交接真实评测；不自动启动管理 Skill，也不承诺已提交或已验证业务结果。",
      "verification": "EVAL-004,EVAL-006,EVAL-008",
      "status": "pass"
    }
  ],
  "tracks": {
    "references": {
      "status": "disabled",
      "evidence": "流程短且单一，无额外参考资料。"
    },
    "scripts": {
      "status": "disabled",
      "evidence": "只使用 Git 只读命令，无运行时 helper。"
    },
    "assets": {
      "status": "disabled",
      "evidence": "输出仅文本。"
    },
    "implicit-trigger": {
      "status": "blocked",
      "evidence": "入口保留默认可发现元数据，但本轮真实场景显式加载 Skill，仅证明说明生成与文本交接；不声明目录自动选用的可靠性。显式调用的核心能力不受影响。",
      "unblock_condition": "在实际技能目录中验证未显式指定名称时的选择路由，记录真实选择结果。"
    },
    "multi-agent": {
      "status": "disabled",
      "evidence": "运行时不依赖子 Agent。"
    },
    "installer": {
      "status": "disabled",
      "evidence": "仅复制 SKILL.md。"
    },
    "open-source-release": {
      "status": "disabled",
      "evidence": "本轮不自动发布。"
    }
  },
  "prompt_budget": {
    "limit_tokens": 900,
    "measured_tokens": 438,
    "evidence": "artifact:evals/results/prompt-budget.txt#sha256:838549e67fc31be449bfc77a842b89caf4b2996da83778879d25210c39b7396d"
  }
}
```
