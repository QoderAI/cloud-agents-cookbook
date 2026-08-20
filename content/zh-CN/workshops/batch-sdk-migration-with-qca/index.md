---
schema_version: 1
slug: batch-sdk-migration-with-qca
title: 批量升级异构代码项目：用 QCA Batch Agent 完成迁移、测试与修复
summary: 在 90 分钟 Workshop 中批量迁移四个结构不同的 Python 服务，让 Agent 在独立沙箱里修改代码、运行测试、迭代修复并交付可验证结果。
type: workshop
category: build-deploy
tags:
  - code-execution
  - workflow-automation
  - testing
  - verification
  - api
author:
  name: 安陈
  github: anchenqlw
locale: zh-CN
---

## 学习目标

你将扮演一次 SDK 升级项目的负责人：四个 Python 服务都依赖 Legacy Shop SDK，但它们的调用方式、封装层和验收条件各不相同。你需要把四项迁移任务提交给 QCA Batch Agent，并用测试、Patch 和迁移报告验收结果。

完成 90 分钟练习后，你将能够：

- 用 Forward Environment 的 `packages` 和 `setup_script` 准备练习工作区，并配置 Template、Identity 和明确的工具权限。
- 把多个代码迁移任务写成 JSONL，上传文件、创建 Batch、轮询状态并下载结果。
- 根据 `custom_id` 跟踪每项任务，用测试和修改范围检查验收迁移结果。
- 读取 `error.jsonl`，修复输入问题并只重投失败任务。
- 说明离峰调度、Credit、结果保留、凭据和人工复核边界。

### 你将完成的任务

Workshop 使用合成的 Legacy Shop SDK 和四个相互隔离的示例服务，不包含客户代码或生产凭据：

| Batch Task | 迁移内容 | 预期交付物 |
|---|---|---|
| `migrate-catalog` | 适配新的 Product 和 Money 返回对象 | 通过测试的 Patch、迁移报告 |
| `migrate-orders` | 保留 Adapter，迁移幂等参数和异常映射 | 通过测试的 Patch、迁移报告 |
| `migrate-inventory` | 把同步库存接口迁移为异步接口 | 通过异步测试的 Patch、迁移报告 |
| `migrate-billing` | 识别缺失的业务舍入策略 | 人工复核说明、只新增该说明的 Patch |

每个 Agent 都按照同一条工作链执行：

```text
读取项目和迁移指南
→ 修改代码
→ 运行该项目的测试
→ 读取新的堆栈和断言差异
→ 调整实现
→ 再次运行测试
→ 通过，或带证据转人工复核
```

课程结束时，你应得到两次 Batch 记录：第一批包含三个正常执行任务和一个故意构造的输入错误；第二批只重投首次失败的 Billing 任务。最终产物包括 Batch 结果文件、四份 Patch、三份迁移报告和一份人工复核说明；Billing 的 Patch 只能新增复核说明。

## 课程安排

### 0～10 分钟：认识任务与验收标准

先查看四个示例服务和 [迁移指南](https://github.com/QoderAI/cloud-agents-cookbook/blob/main/demos/batch-sdk-migration-with-qca/MIGRATION_GUIDE.md)，运行预迁移检查：

```bash
cd demos/batch-sdk-migration-with-qca
python3 check_baseline.py
```

预期看到 Catalog、Orders、Inventory 因不同原因未通过迁移验收，Billing 被标记为缺少业务决策。这些结果构成四项任务的起点。随后查看 `tasks.json`，确认每个任务的项目目录、验收命令和预期交付物。

### 10～25 分钟：准备隔离环境

开始前需要：

- Python 3.11 或更高版本。
- QCA 账号和一个 Personal Access Token（PAT）。
- Git，用于本地克隆公开的 Cookbook 仓库。
- 能在 QCA 控制台创建 Environment、Forward Template 和 Identity 的权限。

先在本地克隆公开仓库：

```bash
git clone https://github.com/QoderAI/cloud-agents-cookbook.git
cd cloud-agents-cookbook/demos/batch-sdk-migration-with-qca
```

在 QCA 控制台创建一个专用于本练习的 Forward Environment。Packages 中添加 `git`，再把 Demo 的 `FORWARD_ENVIRONMENT_SETUP.sh` 完整复制到 `setup_script`。脚本会在 Environment 中执行：

```bash
git clone --depth 1 \
  https://github.com/QoderAI/cloud-agents-cookbook.git \
  /workspace/cloud-agents-cookbook
```

`setup_script` 由 `/bin/bash -lc` 执行，运行在 Packages 安装之后；非零退出会让 Environment 创建失败。脚本还会检查 Demo 是否存在，因此路径或网络不符合预期时会明确失败，而不是把不完整环境交给 Batch。[Create Forward Environment API](https://docs.qoder.com/cloud-agents/api/forward/environments/create)

Environment 就绪后，创建 Forward Template：

| 配置 | 本练习取值 |
|---|---|
| Environment | 刚创建的练习专用 Forward Environment |
| Model | `performance`；创建前可用 List Models API 确认账号当前可选模型 |
| System Prompt | 复制 Demo 中的 `TEMPLATE_SYSTEM_PROMPT.md` |
| 内置工具 | `Bash`、`Read`、`Write`、`Edit`、`Glob`、`Grep`、`DeliverArtifacts` |
| 工具权限 | 仅在这个无生产凭据的示例环境中设为 `always_allow` |

Forward Mode 在本练习中不挂载 GitHub 仓库；Agent 使用 Environment 已准备好的 `/workspace/cloud-agents-cookbook`。客户也不需要、不能为仓库挂载选择路径。

Batch 是无人值守执行。根据当前接口规则，只要所用工具配置为 `always_ask` 或 `always_deny`，对应 JSONL 行就会校验失败。不要为了绕过审批把相同配置照搬到生产仓库；生产任务应先重新设计最小权限、网络、凭据和人工审批边界。

再创建一个本练习专用 Identity，记下 `tmpl_` 和 `idn_` 前缀的 ID。QCA 的 [Template API](https://docs.qoder.com/cloud-agents/api/forward/templates/create) 和 [Identity API](https://docs.qoder.com/cloud-agents/api/forward/identities/create) 给出了字段定义。

在当前终端设置变量，不要把真实值写进仓库：

```bash
export QODER_PAT="<你的 QCA PAT>"
export QODER_TEMPLATE_ID="<tmpl_...>"
export QODER_IDENTITY_ID="<idn_...>"
```

### 25～40 分钟：读懂四个迁移任务

打开 `tasks.json`。每个任务只允许修改一个项目目录，并附带自己的验收命令。Agent 需要遵循三个共同约束：

1. 先读迁移指南和目标项目，不能修改测试、Modern SDK 模拟实现或其它项目。
2. 必须实际运行验收命令；不能用“代码看起来正确”代替测试结果。
3. 测试通过时交付 `changes.patch` 和 `migration-report.md`；缺少业务决策时交付 `manual-review.md`，不能自行编造策略。

这种任务拆分让每个 Batch Task 都有明确作用域和可执行的验收条件。四行任务可由独立 Session 调度；一个项目失败不会阻止其它合法 JSONL 行继续执行，结果按 `custom_id` 分别跟踪。

### 40～55 分钟：生成并提交 Batch

先运行 Demo 自带的离线单元测试。它使用本地 mock 服务，不访问 QCA，也不消耗 Credit：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
```

生成包含四行任务的 JSONL。为了演示“单行校验失败不阻塞其它行”，命令会故意删除 Billing 行的 `identity_id`：

```bash
python3 qca_batch.py prepare \
  --tasks tasks.json \
  --output .work/batch-input.jsonl \
  --inject-invalid migrate-billing
```

检查文件时应只看到任务说明和资源 ID，不应出现任何 token：

```bash
python3 qca_batch.py inspect --input .work/batch-input.jsonl
```

上传 JSONL 并创建 `24h` Batch：

```bash
export BATCH_ID="$(python3 qca_batch.py submit \
  --input .work/batch-input.jsonl)"
printf '%s\n' "$BATCH_ID"
```

客户端先向 `/api/v1/cloud/files` 上传文件，并显式使用 `purpose=session_resource`，再调用 `POST /api/v1/forward/batches`。`custom_id` 用于把每一行与结果重新对应；一次 Batch 最多支持 10,000 行，全局并发上限为 50。[Create Batch API](https://docs.qoder.com/cloud-agents/api/forward/batches/create)

> 现场与线上读者的执行时间不同：QCA Batch 当前默认只在服务端配置的离峰窗口 `22:00–08:00` 执行。线下 Workshop 可以在主办方明确确认临时开放即时执行后按课程时间操作；在线读者应预期 Batch 先停留在 `queued`，到下一离峰窗口才开始。`completion_window` 是最长完成期限，不代表立即执行。

### 55～70 分钟：观察任务并下载结果

轮询 Batch，直到进入 `completed`、`failed`、`cancelled` 或 `expired`：

```bash
python3 qca_batch.py wait \
  --batch-id "$BATCH_ID" \
  --output-dir .work/results
```

等待过程中，客户端打印聚合状态和任务计数；终态后下载 `output.jsonl`，存在失败行时再下载 `error.jsonl`，并通过 List Batch Tasks API 保存 `tasks.json`。预签名下载 URL 含临时访问参数，客户端不会打印它；也不要在启用 `set -x` 的终端执行下载。

使用 `custom_id` 检查每个任务：

```bash
python3 qca_batch.py summarize \
  --output .work/results/output.jsonl \
  --errors .work/results/error.jsonl \
  --tasks-report .work/results/tasks.json
```

任务列表中的 `usage.total_credits` 单位是 CAS Credit，不是 token 数或货币金额，应作为逐任务对账依据。Batch 详情也可能返回聚合 `usage.total_credits`，但客户端不应假定它始终存在。下载链接会过期，Batch 结果文件保留 30 天；需要审计的结果应及时保存到自己的受控存储中。[List Batch Tasks API](https://docs.qoder.com/cloud-agents/api/forward/batches/list-tasks)

如果合法行返回 `session_error`，先查看 `tasks.json` 中的 `custom_id`、错误码、Credit 和 artifacts：

- `All models failed` 或 `model queue recovery attempts exceeded` 属于执行层失败，不代表迁移测试失败。没有 artifacts 时，可以只重投这些行。
- 如果测试提示相对目录不存在，检查任务 Prompt 是否保留了 `cd /workspace/cloud-agents-cookbook/demos/batch-sdk-migration-with-qca && ...`；不要靠 Agent 猜测当前工作目录。
- 已经成功并交付 artifacts 的任务不要重复提交，避免重复消耗 Credit。

### 70～82 分钟：只重投失败任务

第一批的 Billing 行因为缺少 `identity_id` 应出现在 `error.jsonl`，其它合法行继续执行。根据失败行的 `custom_id`，从原任务清单重建有效 JSONL：

```bash
python3 qca_batch.py retry \
  --tasks tasks.json \
  --errors .work/results/error.jsonl \
  --output .work/retry-input.jsonl
```

再次提交：

```bash
export RETRY_BATCH_ID="$(python3 qca_batch.py submit \
  --input .work/retry-input.jsonl)"
python3 qca_batch.py wait \
  --batch-id "$RETRY_BATCH_ID" \
  --output-dir .work/retry-results
```

重投是一个新 Batch，可以复用上一批的 `custom_id`。不要把整批任务全部重跑，否则会重复消耗 Credit，也会模糊首次成功结果与重试结果的对应关系。

### 82～90 分钟：用确定性证据验收

下载每个完成任务交付的 Patch 和报告，在干净的本地 clone 分支上应用 Patch，再运行任务清单里的验收命令。至少检查：

- Agent 是否只修改被分配的项目目录。
- Catalog、Orders、Inventory 的验收测试是否真实通过。
- 测试文件和 Modern SDK 模拟实现是否保持不变。
- Billing 是否提交人工复核说明，而不是猜测舍入策略；它的 Patch 是否只新增该说明。
- 报告是否记录执行过的命令、测试结果和剩余风险。

Agent 的回复、Patch 和报告都只是候选结果；测试通过与人工审查共同构成质量门禁。Workshop 不要求把修改自动推回远端，也不授权 Agent 接触生产仓库。

## 练习与总结

### 必做练习

完成一次包含可控校验错误的四任务 Batch，并只重投失败的 Billing 行。用下面的清单验收：

- [ ] 已创建练习专用 Template 和 Identity，并记录自己的资源 ID。
- [ ] Environment 通过 `setup_script` 准备公开示例仓库，Template 不绑定 GitHub Repository，也不包含生产凭据。
- [ ] JSONL 每行有唯一 `custom_id`，PAT 未进入文件。
- [ ] 第一批的合法行继续执行，缺字段行单独进入 `error.jsonl`。
- [ ] 第二批只包含首次失败任务。
- [ ] 三个代码迁移任务均已检查 Patch、修改范围和测试结果。
- [ ] Billing 的业务歧义进入人工复核，没有被 Agent 静默猜测。
- [ ] 能从 List Batch Tasks 读出单任务 Credit，并理解 Batch 聚合 `usage` 可能存在但不保证返回，以及输出文件的 30 天保留边界。

### 延伸练习

为第五个服务增加一项迁移任务，例如分页接口、流式返回或配置初始化方式变化。为它准备独立项目目录和验收测试，在 `tasks.json` 中填写唯一 `custom_id`、可写目录、验收命令和预期结果，再单独提交该任务。完成后检查它是否按约定交付 Patch、报告和测试证据。

完成后删除本地 `.work/`，归档需要保留的 Patch 和报告，并在控制台停用或删除本练习专用 Identity、Template、Environment 和凭据。清理动作和实际 Credit 以你的账号控制台为准。

## Demo 源码

Demo 提供四个合成迁移项目、Template 系统提示词、任务清单、纯 Python 标准库 Batch 客户端和 mock 单元测试。完整的运行、验证、失败重投、清理和成本说明见 README。

[查看 Demo 源码](https://github.com/QoderAI/cloud-agents-cookbook/tree/main/demos/batch-sdk-migration-with-qca)
