---
schema_version: 1
slug: littlememeworld-qca-showcase
title: LittleMemeWorld：用 QCA 构建会持续生活、也会自我进化的软件
summary: 面向正在构建长期 Agent 产品的团队，分享 LittleMemeWorld 如何用 QCA 承载猫 Agent 的持续生活，并把用户反馈接入已经完整运行的软件自进化流水线。
type: showcase
category: build-deploy
tags:
  - agent
  - runtime
  - long-running-task
  - memory
  - workflow-automation
author:
  name: Anchen
  github: anchenqlw
locale: zh-CN
source_url: https://littlememeworld.com
cover: ./assets/littlememeworld-hero.png
---

## 场景与成果

在 [LittleMemeWorld（Me&Me · 我&猫）](https://littlememeworld.com) 里，每位用户都会拥有一只属于自己的小猫。用户离开页面后，小猫仍会按计划在云上世界旅行。它会积累经历和记忆，也会带回旅行手账、照片和成长结果。

![一只旅行猫准备进入 LittleMemeWorld 云上世界](./assets/littlememeworld-hero.png)

为了让这只猫持续生活，我们把 Qoder Cloud Agents（QCA）放在了产品的核心位置。小猫的身份、长期记忆、定时行为和工具能力都由 QCA 承载。用户每次回来，看到的都是同一只继续成长的猫，以及它离线期间留下的新故事。

![LittleMemeWorld 云上猫舍首页展示小猫身份、成长、云图志、手账和编年史入口](./assets/cloud-home-ui.png)

一段旅行结束后，结果会进入旅行手账。用户可以查看故事、照片和收获，也可以做出新的选择。这次回应会继续影响小猫接下来的行动。

![旅行手账展示小猫离线旅行后带回的故事、合照、收获和互动入口](./assets/travel-journal.png)

产品里同时运行着两个循环：

- **生命循环**：用户表达意图，小猫出发旅行，把手账和记忆带回来，再根据用户的选择继续生活；
- **进化循环**：用户提交反馈，系统形成提案和验收标准，完成隔离开发、测试、审批、灰度与观察，最后保留新版本、继续修复或执行回滚。

![LittleMemeWorld 的生命循环和软件进化循环共同运行在 QCA 与 Cloud Use 底座上](./assets/two-loops.png)

这两个循环都已经进入真实产品链路。QCA 一边承载每只猫每天的运行，一边承载持续维护 LittleMemeWorld 的多 Agent 工作流。猫在成长，软件也会跟着用户的反馈继续变化。

## 实现思路

### 一只猫由一组长期资源组成

在产品里，每只猫都由一组可以独立维护的 QCA 资源承载：

| QCA 资源 | 在 LittleMemeWorld 中的职责 |
|---|---|
| Template | 保存共享的人格边界、工具、文件和任务规则，并记录版本 |
| Identity | 为每只猫提供稳定身份，让多次运行始终属于同一个产品实体 |
| Schedule | 在用户离线时触发旅行、维护和其他周期任务 |
| Session | 在清晰的任务边界内保持执行连续性，并支持暂停和恢复 |
| Memory | 保存偏好、经历、日记和对世界的理解，让小猫持续成长 |
| Tools / Files | 让小猫在最小权限下读取世界、生成成果并回报应用 |

![QCA 通过 Template、Identity、Memory、Tools、Channels 和 Schedules 将 Agent 变成可持续运营的产品](./assets/qca-application-foundation.png)

这组资源给了小猫连续的身份和经历。与此同时，登录、权限、奖励、幂等和发布状态仍由确定性的应用控制面管理。Agent 可以自由规划旅行和讲述见闻，所有会改变产品事实的动作都要经过应用校验。

| QCA Agent 负责 | 应用控制面负责 |
|---|---|
| 理解用户意图和长期上下文 | 认证、授权和资源归属 |
| 规划旅行、形成观察和叙事 | 业务日期、唯一约束和幂等 |
| 使用 Memory 保持人格与经历连续 | 用户、奖励、发布状态等权威事实 |
| 调用受限工具并产出结构化结果 | 校验结果、应用副作用和用户可见状态 |

### 把一条反馈送到生产观察

我们在产品里做了一个很直接的入口，叫“告诉皮卡”。用户提交反馈后，可以看到它进入评估、实现或上线流程，也会收到后续回应。

![告诉皮卡界面说明用户反馈会被记录、评估并进入实现或上线流程](./assets/feedback-card.png)

这套自进化流水线已经完整运行。一条反馈会依次经过这些环节：

1. 收件 Agent 增量读取反馈，完成脱敏并写入追加式记录；
2. 评估 Agent 聚类问题，整理影响范围，形成提案和验收标准；
3. 开发 Agent 在隔离环境中实现变化，并运行自动测试；
4. 独立复核绑定具体版本和 exact SHA，历史结论不能直接复用；
5. 风险策略和人工审批决定能否合并以及能否进入生产；
6. 新版本进入灰度和观察窗口，系统持续监控真实产品结果；
7. 系统根据观察证据保留版本、继续修复或回滚，并向用户回信。

![完整的软件自进化流水线把反馈连接到提案、隔离实现、测试、审批、灰度、观察和回滚](./assets/self-evolution-pipeline.png)

我们把审批、灰度、回滚和熔断直接做进了流水线。不同职责使用各自的 Identity、Session、工具和权限。读取反馈的 Agent 没有生产修改权限，高风险变更也必须由独立角色和人来批准。

每次变化都会留下同样的证据链：

> feedback → work item → Agent run → branch / PR → exact SHA → staging → production bundle → observation → verified

缺少证据、测试失败、版本不匹配或核心指标恶化时，流水线会停下、冻结或回滚。团队可以沿着这条链回看一次变化从哪里开始、经过了哪些判断，以及最后为什么被保留或撤回。

### 两个循环在结构化事实处汇合

生命循环会产生旅行结果、运行信号和用户反馈。进化循环读取这些证据，把它们转化为经过验证的新版本，再将新版本交回生命循环。

两个循环交换的是结构化事实和版本证据。产品里的小猫只拥有完成旅行所需的权限；开发、发布和云资源操作由另外的 Identity 和工具承担。QCA 贯穿整个产品，同时保留了清晰的职责边界。

## 复用建议

LittleMemeWorld 这段实践留给我们的结论很直接：长期 Agent 的运行循环和软件进化循环可以共享一套 QCA 底座；两个循环通过结构化事实和版本证据交换结果，各自保留独立的 Identity、Session、工具和权限。这样的结构让产品持续生活，也让软件在清晰边界内持续演进。
