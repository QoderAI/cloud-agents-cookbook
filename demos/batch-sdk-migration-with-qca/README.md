# QCA Batch Agent SDK 迁移 Workshop Demo

这个 Demo 用四个合成 Python 服务演示 QCA Batch 的 Agent 执行闭环：每个任务读取同一份 SDK 迁移指南，但必须根据各自项目结构修改代码、运行测试、分析失败并继续修复。Catalog、Orders、Inventory 的目标是通过确定性测试；Billing 缺少业务舍入策略，目标是生成合格的人工复核材料而不是猜测。

Demo 的 Batch 客户端只使用 Python 标准库。本地单元测试用 mock HTTP 服务验证协议，不调用 QCA；真实 Batch 才会创建云端 Session 并消耗 Credit。

## 对应文章

- 标题：批量升级异构代码项目：用 QCA Batch Agent 完成迁移、测试与修复
- Slug：`batch-sdk-migration-with-qca`
- 正文路径：`content/zh-CN/workshops/batch-sdk-migration-with-qca/index.md`

## 前置条件

- Python 3.11 或更高版本。
- Git，用于克隆公开的 [QoderAI/cloud-agents-cookbook](https://github.com/QoderAI/cloud-agents-cookbook) 仓库。
- QCA 账号、Personal Access Token，以及创建 Environment、Forward Template、Identity 和 Batch 的权限。
- 现场练习若要在 90 分钟内完成，主办方必须确认服务端已临时开放即时执行；公开环境默认在 `22:00–08:00` 离峰窗口执行。

本 Demo 不需要数据库、容器或第三方 Python 包。

## 安装与配置

克隆公开仓库并进入 Demo：

```bash
git clone https://github.com/QoderAI/cloud-agents-cookbook.git
cd cloud-agents-cookbook/demos/batch-sdk-migration-with-qca
```

先运行完全离线的本地检查：

```bash
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s tests -v
python3 check_baseline.py
```

`check_baseline.py` 成功表示四个项目都处于设计好的“尚未迁移”状态；它不会修改项目。

在 QCA 控制台创建隔离的 Forward Environment：

1. Packages 中添加 `git`。
2. 把 `FORWARD_ENVIRONMENT_SETUP.sh` 的完整内容复制到 `setup_script`。
3. 等待 Environment 创建成功。脚本会把公开仓库克隆到 `/workspace/cloud-agents-cookbook`，并检查当前 Demo 是否存在。

`setup_script` 在 Packages 安装之后通过 `/bin/bash -lc` 执行；脚本非零退出时 Environment 创建会失败。不要把 PAT 或其它凭据写进脚本。

Environment 就绪后创建 Forward Template：

| 配置 | 取值 |
|---|---|
| Environment | 刚创建的练习专用 Forward Environment |
| Model | `performance`；创建前通过 List Models API 确认账号当前可用 |
| System Prompt | `TEMPLATE_SYSTEM_PROMPT.md` 的完整内容 |
| Built-in tools | `Bash`、`Read`、`Write`、`Edit`、`Glob`、`Grep`、`DeliverArtifacts` |
| Permission policy | 仅在本隔离 Demo 中为上述工具设置 `always_allow` |

Forward Mode 在本练习中不挂载 GitHub Repository，也不需要 GitHub token。Batch 无人值守执行不接受 `always_ask` 或 `always_deny` 工具策略。不要把这个练习 Template 用于生产仓库。再创建一个练习专用 Identity，复制 Template ID 和 Identity ID。

可以复制占位文件帮助检查变量名，但只在未跟踪的本地文件中填值：

```bash
cp .env.example workshop.env
```

编辑 `workshop.env` 后加载变量：

```bash
set -a
. ./workshop.env
set +a
```

`workshop.env` 和 `.work/` 已由本目录的 `.gitignore` 排除，仍应在使用后主动删除。PAT 不得进入 Batch JSONL 或 Prompt。

## 运行

生成四行 Batch JSONL，并故意让 Billing 行缺少 `identity_id`：

```bash
python3 qca_batch.py prepare \
  --tasks tasks.json \
  --output .work/batch-input.jsonl \
  --inject-invalid migrate-billing

python3 qca_batch.py inspect --input .work/batch-input.jsonl
```

`inspect` 只打印任务 ID、Template ID、Identity 是否存在和输入长度，不打印完整 Prompt 或任何 token。

上传 JSONL 并创建 Batch：

```bash
export BATCH_ID="$(python3 qca_batch.py submit \
  --input .work/batch-input.jsonl)"
printf '%s\n' "$BATCH_ID"
```

等待终态并下载结果：

```bash
python3 qca_batch.py wait \
  --batch-id "$BATCH_ID" \
  --output-dir .work/results
```

如果 Batch 处于 `queued`，可以按 `Ctrl-C` 停止本地轮询；Batch 不会因此取消。进入离峰窗口后重新运行同一条 `wait` 命令即可。

汇总成功行、失败行、Credit 和交付物名称：

```bash
python3 qca_batch.py summarize \
  --output .work/results/output.jsonl \
  --errors .work/results/error.jsonl \
  --tasks-report .work/results/tasks.json
```

`wait` 会额外调用 `GET /api/v1/forward/batches/{batch_id}/tasks` 并保存 `tasks.json`。任务级 `usage.total_credits`、错误摘要和 artifact 元数据以这个接口为准；Batch 详情也可能返回聚合 Credit，但客户端不应假定 `usage` 始终存在。

合法行若返回 `session_error`，先按 `custom_id` 查看任务记录。`All models failed`、`model queue recovery attempts exceeded` 等执行层错误不等于测试失败；没有 artifacts 时只重投受影响行。若测试报告 `projects/<name>` 不存在，确认 JSONL Prompt 中的远程验收命令以 `cd /workspace/cloud-agents-cookbook/demos/batch-sdk-migration-with-qca &&` 开头。

根据 `error.jsonl` 只重建失败任务。被故意破坏的 Billing 行会恢复当前 Template 和 Identity：

```bash
python3 qca_batch.py retry \
  --tasks tasks.json \
  --errors .work/results/error.jsonl \
  --output .work/retry-input.jsonl

export RETRY_BATCH_ID="$(python3 qca_batch.py submit \
  --input .work/retry-input.jsonl)"

python3 qca_batch.py wait \
  --batch-id "$RETRY_BATCH_ID" \
  --output-dir .work/retry-results
```

## 验证结果

本地测试应全部通过，`check_baseline.py` 应输出四行 `ready`。真实 Batch 的预期结果如下：

| `custom_id` | 首批预期 | Agent 任务的验收证据 |
|---|---|---|
| `migrate-catalog` | 执行 | Catalog 测试通过；Patch 使用 Modern Product/Money 对象 |
| `migrate-orders` | 执行 | Orders 测试通过；Adapter 保留且转发幂等键、映射新异常 |
| `migrate-inventory` | 执行 | Inventory 异步测试通过；公开函数变为协程 |
| `migrate-billing` | JSONL 校验失败 | 重投后交付 `manual-review.md` 和只新增该文件的 `changes.patch`，源码保持不变 |

对前三项，下载并人工检查 `changes.patch` 与 `migration-report.md`，在干净分支应用 Patch 后运行 `tasks.json` 中对应的验收命令。对 Billing，`manual-review.md` 必须包含 `status: blocked`、`decision: rounding_mode`、两个允许选项以及政策缺失证据。

不要把 Agent 的 `completed` 状态等同于代码正确。只有测试结果、修改范围检查和人工审查共同通过，迁移才算验收完成。

## 清理资源

保留需要审计的 Patch 和报告后，删除本地运行文件：

```bash
rm -rf .work
rm -f workshop.env
```

在 QCA 控制台停用或删除练习专用 Identity、Template 和 Environment。不要删除仍被其它任务使用的共享资源。

## 成本与安全

- 本地单元测试和基线检查不访问网络、不创建云资源、不消耗 Credit。
- 每个合法 Batch 行会创建独立 Agent Session 并产生 Credit。具体用量取决于模型、代码阅读、工具调用和修复轮次；以 List Batch Tasks 返回的任务级 `usage.total_credits` 为准，不把 Credit 换算成未经官方公布的货币价格。
- QCA Batch 当前默认在服务端配置的 `22:00–08:00` 离峰窗口执行。现场即时执行是临时安排，在线读者不能据此假定自己的 Batch 会立即启动。
- `QODER_PAT` 只用于 QCA API，不得进入 `setup_script`、JSONL、Prompt、日志、Patch、报告或提交记录。
- `always_allow` 仅适用于这个无生产数据、无生产凭据、只包含公开示例仓库的隔离环境。生产接入必须重新评估最小权限、网络访问、审计和人工审批。
- Batch 结果下载 URL 带临时访问参数。客户端不会打印 URL；不要在 `set -x` 下运行。结果文件保留 30 天，需要长期保存时应转移到自己的受控存储。
- 仓库自动化只静态检查 Demo，不安装或运行源码。本目录的真实可运行性、产品事实和安全操作仍需 Maintainer 人工审核。
