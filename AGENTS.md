# Agent Development Rules

1. 先读取 `.scaffold/state.json` 和 `docs/skill-brief.md`，沿用 initialized Skill 的当前目标、边界和状态，不初始化通用脚手架。
2. 最新用户要求优先；与 Brief 或既有决策冲突时，先更新需求版本和冲突记录，再从最早受影响阶段继续。
3. 核心能力始终实现；增强轨道只使用 `enabled`、`disabled` 或 `blocked`，并为每条轨道保留证据或解除条件。
4. 确定性行为遵循 TDD：先写会因目标行为缺失而失败的测试，再做最小实现；真实 Skill 行为必须使用评测证据。
5. 开发中运行 `npm run check`；只有状态、Brief 和证据契约 ready 后，`npm run gate:delivery` 才能通过。
6. 完成前审查完整 diff 和未跟踪交付文件，检查需求偏离、敏感信息、包白名单、失真文档和代码注释。
7. 付费调用、破坏性操作、公开发布、Tag、Release、包注册表上传或凭据使用必须获得用户明确授权。
