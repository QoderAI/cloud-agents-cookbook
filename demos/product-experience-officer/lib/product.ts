export const productPacks = [
  {
    id: "qca-v1",
    name: "Qoder Cloud Agents",
    short: "QCA 专项包",
    description: "覆盖文档、控制台、三层 API、BrowserUse、Memory、Cloud Use 与 IM。",
    accent: "orange",
    scopes: ["文档", "控制台", "API", "能力", "IM"],
    url: "https://qoder.com/cloud-agents",
  },
  {
    id: "generic-aliyun-v1",
    name: "通用阿里云产品",
    short: "阿里云通用包",
    description: "根据产品入口自动建立用户旅程、关键任务、API 与安全边界。",
    accent: "blue",
    scopes: ["文档", "控制台", "API", "关键任务"],
    url: "",
  },
] as const;

export const evaluationStages = [
  {
    short: "01",
    label: "建立产品地图",
    detail: "理解目标用户、产品概念、入口与关键旅程。",
    tool: "Docs",
  },
  {
    short: "02",
    label: "体验控制台",
    detail: "检查真实导航、配置、反馈与任务连续性。",
    tool: "BrowserUse",
  },
  {
    short: "03",
    label: "验证 API 契约",
    detail: "交叉核对接口、异常路径与运行时边界。",
    tool: "QCA API",
  },
  {
    short: "04",
    label: "验证核心能力",
    detail: "围绕真实任务组合工具、资源、记忆与渠道。",
    tool: "Cloud Agent",
  },
  {
    short: "05",
    label: "审计证据",
    detail: "去除无证据判断，校准问题优先级。",
    tool: "产品体验官",
  },
  {
    short: "06",
    label: "生成并交付",
    detail: "输出云知道深度稿与适合 IM 的摘要。",
    tool: "Forward",
  },
] as const;

export const baselineFindings = [
  {
    severity: "P1",
    tone: "critical",
    title: "BrowserUse 是关键差异化能力，但发现路径过深",
    summary:
      "用户需要进入创建流程的能力区才会看到 BrowserUse，快速开始没有提前建立“Agent 能自己操作网页”的价值预期。",
    evidence: "控制台创建入口 · BrowserUse（Beta）能力区",
  },
  {
    severity: "P1",
    tone: "critical",
    title: "多份资料之间存在 API 契约漂移",
    summary:
      "真实 Forward 调用拒绝了文档标为可选的空 file_attachments，Skill、文档和服务端需要统一真相源。",
    evidence: "真实 Forward Session · user.message 异常路径",
  },
  {
    severity: "P1",
    tone: "critical",
    title: "完整三层产品尚未形成一条首次成功旅程",
    summary:
      "Forward、Managed 与 Resources 已形成完整能力，但快速开始仍主要停留在运行时，业务交付价值出现得太晚。",
    evidence: "Templates · Identities · Sessions · Channels",
  },
  {
    severity: "P2",
    tone: "watch",
    title: "权限专业，但缺少任务视角的风险解释",
    summary:
      "用户需要自己把工具权限映射到真实后果，适合增加只读研究、受控体验、全自动沙箱三类模板。",
    evidence: "工具权限模板与逐工具审批策略",
  },
  {
    severity: "亮点",
    tone: "positive",
    title: "从运行时到 IM，产品体验官闭环已经具备",
    summary:
      "BrowserUse、Memory、Dreams、Identity 与 Channel 可以组合成会执行、会学习、能触达的长期 Agent。",
    evidence: "BrowserUse · Memory/Dreams · Forward Channel",
  },
] as const;

export const baselineReport = `# 让 Agent 自己打开浏览器之后，Qoder Cloud Agents 离“云上产品体验官”还有多远？

> 生成方：产品体验官
> 测评对象：Qoder Cloud Agents  
> 测评范围：文档、控制台、Managed / Forward / Resources API、BrowserUse、Memory、Cloud Use、IM  
> 证据边界：不把网页抓取冒充 BrowserUse；未实际观察到的响应、截图和数据不写成实测

## 覆盖声明

| 项目 | 状态 | 关键证据 |
|---|---|---|
| 登录 | 未作为本报告实测结论 | 证据边界声明 |
| 核心旅程 | 已覆盖产品地图，未声称端到端成功 | Managed / Resources / Forward 契约 |
| 清理 | 未涉及资源创建 | 本报告不声称创建或清理验证 |

## 结论先行

Qoder Cloud Agents 已经不只是一个“把模型放到云上”的运行容器。Managed Mode 提供 Agent 运行时，Resources 管理环境、Skill、Vault、文件与记忆，Forward Mode 再把能力封装成面向终端用户的网站、IM、定时和批量服务。

\`\`\`mermaid
flowchart LR
A["Managed 运行时"] --> B["Resources 共享资产"] --> C["Forward 业务交付"]
\`\`\`

BrowserUse 补上网页操作，Memory 与 Dreams 提供跨会话学习，Identity 与 Channel 解决终端用户隔离和触达。真正的挑战已经从“能力有没有”转向“用户能否在第一次成功中理解这些能力如何组合成长期工作的产品体验官”。

## 核心发现

1. BrowserUse 是关键差异化能力，但在新手路径中的发现成本偏高。
2. Marketplace Skill、在线文档与真实服务之间存在 API 契约漂移。
3. Forward、Managed、Resources 已形成完整三层产品，但入口叙事仍主要停留在运行时。
4. 权限控制足够专业，但缺少面向任务的统一风险解释。
5. BrowserUse、Memory、Dreams、Identity 与 IM 已构成很有潜力的长期 Agent 闭环。

## 最值得保留的亮点

### BrowserUse 让 Agent 真正拥有“眼睛和手”

导航、点击、输入、截图与实时预览构成可观察的网页执行闭环。对产品体验、运营巡检和后台管理场景，它比单纯抓取网页更接近真实用户。

### Forward 把“运行 Agent”推进到“交付 Agent”

Template 与 Identity 把企业基线、用户差异和审计上下文分开管理；Channel、Schedule 与 Batch 承接 IM、定时和批量场景。

### Memory、Dreams 与权限治理提供长期运行基础

Memory Store 让知识跨 Session 保存；Dreams 以副本方式整理记忆；Vault、权限策略与 Cloud Use 让 Agent 能受控连接外部系统。

## 优先改进建议

1. 把快速开始延伸为“创建 Agent → BrowserUse 完成任务 → Forward 接入网站 → 扫码接入 IM”。
2. 让 Skill、文档、控制台示例和 API Reference 共用版本与机器可读 schema。
3. 增加“只读研究、受控体验、全自动沙箱”任务模板。
4. 用两步向导明确区分渠道授权和 Identity Pairing。

## 最终判断

Qoder Cloud Agents 已经能运行、能操作、能记忆、能协作，也能以受治理的身份交付到网站、IM 和业务系统。下一阶段最值得投入的不是增加孤立能力，而是让用户在第一次使用时就看见完整组合路径。`;
