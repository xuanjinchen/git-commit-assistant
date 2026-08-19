# Agent Development Rules

1. 先读取 `package.json#scaffold.mode`。维护脚手架本身时不要初始化；只有在 Template 副本中开始新 Skill 才执行 `npm run init:skill -- --name <name> --description <objective>`。已有 `.scaffold/state.json` 时读取并沿用该状态，不用不同参数重复初始化。
2. `source` 模式只读取 `docs/mature-skill-development-design.md` 和 `docs/mature-skill-development-plan.md` 维护脚手架；`initialized` 模式再读取已生成的 `docs/skill-brief.md`，以当前 Brief 固定目标、边界与验收标准。
3. 最新用户要求优先。新要求与 Brief、计划或旧实现冲突时，先更新需求版本、冲突记录和受影响任务，再从最早受影响阶段继续。
4. 核心能力始终实现；增强轨道只使用 `enabled`、`disabled` 或 `blocked`。每条轨道都要有证据，`blocked` 还必须记录受影响能力和解除条件。
5. 确定性行为遵循 TDD：先写会因目标行为缺失而失败的测试，再做最小实现。Skill 行为先固定正向、负向和边界行为评测，不能用静态测试替代真实 Agent 结论。
6. 需求变更后只重跑受影响测试和评测；触发描述、核心工作流、资源选择或正式兼容声明变化时，更新对应评测证据。
7. 开发中运行 `npm run check`。只有 `.scaffold/state.json`、Skill Brief 和证据契约都达到 ready 后，才运行 `npm run gate:delivery` 并声明成熟交付。
8. 完成前审查完整 diff 和未跟踪交付文件，检查需求偏离、敏感信息、包白名单、失真文档和代码注释；代码改动按仓库规则记录关键维护意图。
9. 付费调用、破坏性操作、公开发布、Tag、Release、包注册表上传或凭据使用必须获得用户明确授权。没有授权时完成可逆的本地工作并报告阻塞项。
