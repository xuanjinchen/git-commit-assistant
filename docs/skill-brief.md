# Skill Brief

## Requirement Version

Version 7 draft, aligned to the confirmed staged-diff simplification design on 2026-09-06.

## Objective

依据最终确切 staged diff 生成清晰简洁提交说明。

<!-- scaffold-contract:skill-brief:v1 -->
```json
{
  "schema_version": 1,
  "status": "draft",
  "conflicts": [
    {
      "id": "CONFLICT-007",
      "summary": "Version 6 的外部索引事务和通用脚手架范围超出新的单一提交说明目标。",
      "status": "resolved",
      "resolution": "以 Version 7 精简运行时取代旧事务实现；保留明确暂存、二次确认、当前任务 hunk 隔离和无损恢复要求。"
    }
  ],
  "acceptance_criteria": [
    {"id":"REQ-001","requirement":"候选说明只依据最终确切 staged diff，采用 Conventional Commits，简单修改仅主题，复杂或多项修改使用最少的简洁处理点。","verification":"EVAL-001、EVAL-002 和 Skill contract 测试。","status":"pending"},
    {"id":"REQ-002","requirement":"未指定语言时主题和正文使用简体中文，显式语言要求可以覆盖默认值。","verification":"EVAL-001、EVAL-002、EVAL-003。","status":"pending"},
    {"id":"REQ-003","requirement":"仅生成说明请求只读取真实暂存区且不修改仓库；空暂存区安全停止。","verification":"EVAL-001、EVAL-007 和只读快照测试。","status":"pending"},
    {"id":"REQ-004","requirement":"明确提交请求只准备当前任务文件或 hunk，同文件独立 hunk 可分离，混合原子 hunk安全停止。","verification":"EVAL-004、EVAL-005、EVAL-006 和脚本测试。","status":"pending"},
    {"id":"REQ-005","requirement":"提交前展示完整候选和绑定标识，只有第二次精确确认才执行一次保留 hook 的未签名提交。","verification":"EVAL-004、EVAL-008 和确认绑定测试。","status":"pending"},
    {"id":"REQ-006","requirement":"成功、取消、无效确认和 hook 失败均不丢失用户改动，并恢复可安全恢复的无关 staged 状态。","verification":"准备、取消、提交和 hook 回归测试。","status":"pending"},
    {"id":"REQ-007","requirement":"运行时只包含 SKILL.md 与 scripts/staged-commit.mjs，无第三方依赖，Skill 不超过 900 个保守 prompt token。","verification":"项目契约、npm pack 审计和 prompt-budget 证据。","status":"pending"},
    {"id":"REQ-008","requirement":"Skill 不扩展到 push、tag、release、amend、历史改写、签名、hook 绕过或配置写入。","verification":"EVAL-008、Skill contract 和进程调用测试。","status":"pending"}
  ],
  "tracks": {
    "references": {"status":"disabled","evidence":"精简工作流无需条件参考资料。","unblock_condition":""},
    "scripts": {"status":"enabled","evidence":"已批准设计要求一个确定性的暂存与恢复 helper。","unblock_condition":""},
    "assets": {"status":"disabled","evidence":"输出仅为文本。","unblock_condition":""},
    "implicit-trigger": {"status":"enabled","evidence":"提交说明和明确提交请求应通过描述自动发现。","unblock_condition":""},
    "multi-agent": {"status":"disabled","evidence":"运行时不依赖委派。","unblock_condition":""},
    "installer": {"status":"disabled","evidence":"标准 Skill 目录复制足够。","unblock_condition":""},
    "open-source-release": {"status":"disabled","evidence":"本次不创建 tag、release 或发布包。","unblock_condition":""}
  },
  "prompt_budget": {"limit_tokens":null,"measured_tokens":null,"evidence":""}
}
```
