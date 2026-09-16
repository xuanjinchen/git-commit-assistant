# 交付报告

## Version 8：只生成说明

冻结入口 SHA-256：`ad999d8f2dcb522545d11a219a5bc8843e36789e17a812d834a026f08797a966`。运行时仅 `SKILL.md`，无可执行 helper、确认口令或事务状态。入口 1312 个 Unicode code point，按既定口径估算 438/900 prompt token。

## 行为证据

2026-09-16，在 8 个隔离、无远程的 Git 仓库执行真实 Agent 场景，并由控制器复核输出、命令及独立快照。

| 用例 | 场景 | 断言 |
| --- | --- | --- |
| EVAL-001 | 简单修复默认中文 | 3/3 |
| EVAL-002 | 复杂变更按业务合并处理点 | 3/3 |
| EVAL-003 | 显式英文覆盖默认语言 | 3/3 |
| EVAL-004 | 供Git管理Skill调用 | 3/3 |
| EVAL-005 | 空暂存区即停止 | 3/3 |
| EVAL-006 | 调用方调整暂存后重新生成 | 3/3 |
| EVAL-007 | 敏感材料安全停止 | 3/3 |
| EVAL-008 | 证据不足不推断用途 | 3/3 |

全部 24 条断言通过；每个仓库的索引、配置、refs、对象库和工作区文件前后均一致。原始运行记录位于本地忽略目录 `eval-workspaces/version-8`，正式归档的输出、复核结论和摘要见 `evals/results`。

跨 Skill 用例验证调用方可以取得完整消息文本，没有执行真实提交或真实 `finishing-a-development-branch` 收尾。调用顺序由上层 Agent 负责，没有全局注入、插件 hook 或自动调用保证。8 个场景每个只运行一次，不声称统计稳定性或实际 token/费用节省。

## 验证与交付范围

已运行结构/包检查：旧双文件运行时阶段出现预期失败，收敛为单文件后通过。文案质量与只读行为由真实 Agent 证据支持，不以静态匹配替代。

通用 quick_validate.py 依赖本机未安装的 PyYAML，未能执行；已通过仓库无依赖的入口/frontmatter、名称与描述一致性、包白名单和真实行为检查。没有为运行时引入 Python 或 npm 依赖。

本轮只交付工作树中的重构；未自动创建提交、合并或推送。检查发现全局 Codex 安装当前不存在、CC Switch 登记为禁用，本轮保留该启用选择，不修改其他 Git 管理 Skill。

<!-- scaffold-contract:delivery-report:v1 -->
```json
{
  "schema_version": 1,
  "requirement_version": 8,
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
      "verification": "eval:EVAL-001,EVAL-002,EVAL-003",
      "status": "pass"
    },
    {
      "id": "REQ-003",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-001,EVAL-004,EVAL-005",
      "status": "pass"
    },
    {
      "id": "REQ-004",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-004",
      "status": "pass"
    },
    {
      "id": "REQ-005",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-004,EVAL-006",
      "status": "pass"
    },
    {
      "id": "REQ-006",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-005,EVAL-007,EVAL-008",
      "status": "pass"
    },
    {
      "id": "REQ-007",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-001,EVAL-004",
      "status": "pass"
    },
    {
      "id": "REQ-008",
      "implementation": "path:SKILL.md",
      "verification": "eval:EVAL-004,EVAL-006,EVAL-008",
      "status": "pass"
    }
  ],
  "capability_claims": [
    {
      "name": "默认中文的清晰简洁 staged 提交说明",
      "evidence": "artifact:evals/results/EVAL-002.txt#sha256:585d6867050a2259bef605e07e1183aba3ab0d27c68bdda43608bf1e7d31bbef"
    },
    {
      "name": "只读文本交接给 Git 管理流程",
      "evidence": "artifact:evals/results/EVAL-004.txt#sha256:0b775c3512db76b8d59b80b2368687fbc248b1bd56cff729f8ad05a88128a38b"
    },
    {
      "name": "空暂存与证据不足时停止",
      "evidence": "artifact:evals/results/EVAL-005.txt#sha256:7b1eafcdeaf0307ebccf65ab5e83342fe0a570d153302d055d363db5304ef23c"
    }
  ]
}
```
