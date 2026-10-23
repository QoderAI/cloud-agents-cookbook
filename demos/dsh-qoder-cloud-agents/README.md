# DeepSeek Harness 云端模式插件 Demo

`dsh-qoder-cloud-agents` 是一个 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件，把任务交给 Qoder Cloud Agents 在云端沙箱里执行。它提供三个入口：

| 入口 | 用法 | 适合 |
|---|---|---|
| 云端模式 | 新会话输入框上方最右侧的「云端模式」开关 | 整个会话在云端执行，回复实时显示，可在同一个云端沙箱里连续追问 |
| 子代理工具 `subagent_qoder_cloud_agents` | 普通会话里由 DeepSeek 调用 | 把某个子任务委派到云端，跑完后结果交回 DeepSeek |
| 斜杠命令 `/qoder-cloud-agents` | 在对话框输入 | 查看和切换 Qoder 环境、Agent |

工作区是 git 仓库时，插件按 Qoder 控制台的方式把 `origin` 挂载到云端 `/data/workspace/<仓库名>`，并要求云端 Agent 把改动推送到新分支 `qoder-cloud-agents/<随机8位>`。

## 对应文章

- 标题：在 DeepSeek Harness 里用云端模式把任务交给 Qoder Cloud Agents
- Slug：`dsh-qoder-cloud-agents`

## 前置条件

- Node.js 22 或更高版本，以及 npm。
- DeepSeek Harness 0.2.x（`dsh --version` 可查看），或内置 dsh 0.2.x 的 Mac / Windows 客户端。
- Qoder 个人访问令牌（PAT）：登录 [qoder.com](https://qoder.com)，在 Settings → Personal Access Tokens 中创建，形如 `pt-…`，只显示一次。
- 可选：代码仓库令牌。仓库是私有的，或者要让云端 `git push` 时才需要：
  - GitHub：fine-grained PAT 授予 Contents 读写，或 classic PAT 授予 `repo`。
  - GitLab.com、Gitee 等通用 Git：该平台的个人访问令牌（GitLab 需要 `read_repository` 和 `write_repository`），并在插件配置里写上用户名 `gitUsername`。
- 在本机打开的 git 仓库需要配置好 `origin`，并且已经把要处理的提交推送到远端：云端只能拿到已推送的提交。

## 安装与配置

1. 在本目录构建安装包（`npm pack` 会先执行构建）：

   ```bash
   npm ci
   npm pack
   ```

   得到 `dsh-qoder-cloud-agents-0.1.0.tgz`。把它放到一个固定目录（例如 `~/dsh-plugins/`），profile 里记录的是这个路径。

2. 安装到 dsh 的 web profile（其他 profile 换成对应名字），路径必须是绝对路径：

   ```bash
   dsh plugin --profile web add ~/dsh-plugins/dsh-qoder-cloud-agents-0.1.0.tgz
   ```

   Mac / Windows 客户端：在侧边栏「插件」→ 安装插件，填 tgz 的绝对路径。

3. 把令牌写进 `~/.dsh/.env`，不要写进仓库或 yml 配置：

   ```bash
   echo 'QODER_PAT=pt-<your-qoder-pat>' >> ~/.dsh/.env
   echo 'QODER_GIT_TOKEN=<your-git-token>' >> ~/.dsh/.env   # 公开仓库、只读可以不配
   chmod 600 ~/.dsh/.env
   ```

4. 通用 Git（GitHub 跳过）：打开 `~/.dsh/profiles/web/cordis.patch.yml`，加上用户名。文件里已有 `id: qoder-cloud-agents` 时只在它的 `config` 下补字段；文件只有一行 `[]` 时先删掉它：

   ```yaml
   - id: qoder-cloud-agents
     name: dsh-qoder-cloud-agents
     config:
       gitUsername: your-git-user
   ```

5. 其他可选配置也写在同一段 `config` 下（patch 会整体替换 `config`，已有字段要一起保留）：

   ```yaml
   - id: qoder-cloud-agents
     name: dsh-qoder-cloud-agents
     config:
       baseURL: https://api.qoder.com/api/v1/cloud
       environmentId: env_xxx        # 不填：首次使用时弹窗选择并记住
       agentId: agent_xxx            # 不填：自动选择或新建插件管理的 Agent
       repository: auto              # auto | none
       branchPrefix: qoder-cloud-agents/
       archiveOnFinish: false        # true：子代理回合结束后归档云端 session
       timeoutMs: 7200000            # 单次委派上限，超时会取消云端回合
   ```

   全部字段见 [src/index.ts](src/index.ts) 中的 `Config`。

6. 重启 dsh：在 `dsh web` 的终端按 `Ctrl+C` 停掉再运行 `dsh web`；客户端用户完全退出（⌘Q）后重新打开。dsh 只在启动时读取插件和令牌。

## 运行

### 云端模式

1. 在 dsh web 左侧工作区选择一个本地 git 仓库，点击「新会话」。
2. 打开输入框上方最右侧的「云端模式」开关，左边的模式标签会同步变成「云端模式」。
3. 输入任务并发送，例如「把 README 的问候语改成中英双语，提交并推送到新分支」。第一次使用会弹窗选择 Qoder 环境，一般选托管 cloud 环境（如 Default），选择会保存到 profile。
4. 继续输入就是追问，始终在同一个云端沙箱里，上一轮的改动都还在。
5. 在本地拿回云端推送的分支，分支名写在回复里：

   ```bash
   git fetch origin && git checkout qoder-cloud-agents/xxxxxxxx
   ```

### 子代理工具

在普通会话里点名让 DeepSeek 使用这个工具最可靠：

```text
用 subagent_qoder_cloud_agents 把这个任务交给云端：给 src/utils/date.ts 补单元测试，跑通后推送到新分支。
```

工具调用立即返回，云端跑完后结果（含云端 session id、结果分支、交付文件和本地未推送提醒）自动回到对话。一次委派是一个独立的云端 session，不能追问；需要来回交流时用云端模式。

### 斜杠命令

| 命令 | 作用 |
|---|---|
| `/qoder-cloud-agents` | 查看当前环境、Agent 和网关 |
| `/qoder-cloud-agents env` | 列出环境（`*` 为当前） |
| `/qoder-cloud-agents env <id或名称>` | 切换环境并保存 |
| `/qoder-cloud-agents agent` | 列出 Agent |
| `/qoder-cloud-agents agent <id或名称或 new>` | 切换 Agent；`new` 使用插件管理的 Agent |
| `/qoder-cloud-agents reset` | 清除已保存的选择，下次重新选择 |

## 验证结果

单元测试不访问外部网络：它在本机起一个模拟 Qoder Cloud 网关，覆盖环境与 Agent 的选择、仓库挂载、SSE 断线续传、取消、云端模式的请求路由和系统提示词变量。

```bash
npm ci
npm test
```

预期 2 个测试文件、35 个测试全部通过。

端到端验证（会消耗 Qoder 额度）：

- 云端模式会话的输入框右下角显示「云端模式（Qoder Cloud Agents）」。
- 回复下展开「已完成」→「已完成分析」，能看到云端 session id、仓库地址、结果分支，以及 `› Read`、`› Bash: git push …` 这样的工具调用。
- 第二轮追问的回复说明仍在同一个沙箱，结果推送到同一个分支。
- 本地 `git fetch` 后 `git log --oneline -3` 能看到云端的提交。
- 轨迹页里，云端模式会话不会在第二轮出现「系统提示词已更新」。

## 清理资源

- 云端 session：子代理工具在配置 `archiveOnFinish: true` 时会自动归档；云端模式和默认配置下 session 保留在 Qoder 控制台，可在控制台归档或删除。
- 结果分支：不需要时删除远端分支，例如 `git push origin --delete qoder-cloud-agents/xxxxxxxx`。
- 插件：`dsh plugin --profile web remove dsh-qoder-cloud-agents`，然后重启 dsh。`cordis.patch.yml` 里保存的 `environmentId`、`agentId`、`gitUsername` 不会随卸载删除，不需要时手动删掉那一段。
- 令牌：从 `~/.dsh/.env` 删除 `QODER_PAT`、`QODER_GIT_TOKEN`，并在 Qoder 与 Git 平台吊销不再使用的令牌。
- 本地构建产物：删除本目录下的 `node_modules/`、`lib/` 和生成的 `.tgz`。

## 成本与安全

- 每次云端执行都会消耗 Qoder 额度。作者实测一个只读小任务加一次追问约 5.8 credits，实际消耗取决于任务和模型。
- `QODER_PAT` 可以代表你调用 Qoder Cloud Agents API；`QODER_GIT_TOKEN` 会作为仓库凭据随 session 发送到 Qoder Cloud，云端 Agent 可以用它向你的仓库推送。请使用最小权限、可随时吊销的令牌，只把令牌放在 `~/.dsh/.env`（`chmod 600`）或环境变量里。
- 云端 Agent 会在新分支上提交并推送，不会改动当前分支；合并前请像审查同事的 PR 一样审查改动。
- 云端模式只把你新输入的文字（以及首轮的仓库与分支说明）发送给 Qoder Cloud，不会发送 dsh 的系统提示词；本地附加的图片和文件不会上传。
- 插件以 dsh 宿主进程的权限运行。这是示例代码，用于生产前请自行评估错误处理、超时、额度和令牌轮换策略。
