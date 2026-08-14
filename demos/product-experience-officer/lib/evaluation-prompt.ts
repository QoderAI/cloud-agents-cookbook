import {
  MANUAL_LOGIN_REQUIRED_MARKER,
  type ValidatedTestAccess,
} from "./test-access";
import { REPORT_COMPLETE_MARKER } from "./qca-report-finality";

export type EvaluationPromptInput = {
  product: string;
  productUrl: string;
  depth: string;
  packId: string;
  access: ValidatedTestAccess;
};

const QCA_PACK_ID = "qca-v1";

function packContext(product: string, packId: string) {
  if (packId === QCA_PACK_ID) {
    return `专项产品包：
- 产品入口：https://qoder.com/cloud-agents
- 文档入口：https://docs.qoder.com/zh/cloud-agents/overview
- 云端实践：https://docs.qoder.com/zh/cloud-agents/best-practices/cloud-use
- 必须建立 Managed（运行时）、Forward（业务交付）、Resources（共享资产）三层产品地图
- 必须覆盖 BrowserUse、Memory、Dreams、Managed Agents、Cloud Use、Channel/IM
- BrowserUse 是否可用只以当前 Managed Agent 的真实工具为准`;
  }

  return `通用阿里云产品包：
- 评测范围只围绕当前被测产品“${product}”
- 先识别产品入口、目标用户、文档、控制台与 OpenAPI
- 建立至少三条真实任务旅程：首次成功、核心任务、异常恢复
- 对涉及创建资源、改配、费用或删除的步骤，必须遵守下方访问与授权边界
- 不得套用其他产品的架构、能力清单或术语；只有当前被测产品自身的界面、文档或 API 明确呈现，且证据可复现时，才可纳入报告`;
}

function accessRules(access: ValidatedTestAccess) {
  if (access.mode === "read-only") {
    return "本轮是只读评测。Write/Bash 已由 Agent 工具策略拒绝；BrowserUse 没有细粒度权限策略，必须严格遵守只读契约，只导航、读取、截图和执行无副作用 GET。任何涉及创建资源、改配、费用或删除的步骤都保持只读并请求确认。";
  }

  return `本轮是用户预授权的端到端测试。允许来源（策略边界，不代表网络层 egress 限制）：${access.allowedOrigins.join(", ")}
测试资源前缀：${access.resourcePrefix}
费用上限：CNY ${access.costCapCny.toFixed(2)}
目标测试资源自动清理：${access.autoCleanup ? "是" : "否"}
允许：创建/更新带指定前缀的临时测试资源、提交测试表单、验证结果并清理自己创建的数据。
Vault 秘密别名：${access.secrets.map((secret) => secret.alias).join(", ") || "无"}。只可在 API/CLI 中以环境变量名引用，禁止读取或回显值。${
    access.requiresManualLogin
      ? `账号登录必须使用人工接管：BrowserUse 只导航到登录页，不输入账号、密码或 Token；随后原样输出 ${MANUAL_LOGIN_REQUIRED_MARKER} 并立即停止本轮。`
      : ""
  }
非敏感测试说明：${access.context || "无"}`;
}

function reportFormatContract() {
  return `报告格式契约：
- 全文只使用一个 H1 标题；标题后紧跟简短元信息引用块，且必须包含“生成方：产品体验官”。
- 第一个 H2 必须是“覆盖声明”，用精简、证据可追溯的表格说明登录、核心旅程与清理状态；正文使用短段落。
- 所有问题统一使用“### P0/P1/P2/P3｜问题标题”，并依次写清场景、操作、预期、实际、证据、影响、建议；表格仅用于需要横向比较的信息。
- 全文最多使用 0–2 个 Mermaid 流程图；仅当至少 3 个有序阶段或层级确实更易用图理解时才画图，并使用“mermaid”代码围栏。只允许以下可移植子集：第一行原样为“flowchart LR”，第二行是单一节点链，例如 A["定义 Agent"] --> B["启动 Session"] --> C["收到结果"]；最多 6 个节点，标签简短且有证据依据。禁止样式、class、click、URL 与原始 HTML。
- IM 摘要不超过 300 字。`;
}

function executionRequirements(packId: string) {
  const requirements = [
    "建立产品地图，覆盖产品文档、控制台、API、核心能力与交付渠道；",
    "若 BrowserUse 已在当前 Managed Agent 启用，使用它完成导航、点击、输入与截图；若未启用，明确标记“浏览器实操未执行”，不得把网页抓取写成 BrowserUse 实测；",
    "验证可访问的 API 契约与异常路径，重点关注真实任务能否端到端完成；",
    packId === QCA_PACK_ID
      ? "对 Qoder Cloud Agents 额外覆盖 Managed、Forward、Resources 三层，以及 BrowserUse、Memory、Dreams、Managed Agents、Cloud Use、Channel/IM；"
      : "只使用当前被测产品可复现的证据组织产品地图和结论，不得强加其他产品的架构、能力或术语；",
    "每个问题包含场景、操作、预期、实际、证据、影响与可执行建议；",
    "不得编造未实际观察到的数据、截图或 API 响应；",
    "输出一篇中文 Markdown 深度测评，结构依次为覆盖声明、结论先行、体验范围、实操过程、亮点、核心问题、改进建议、最终判断；",
    "最后附 300 字以内的 IM 摘要；",
    "永久删除、购买/支付、权限提升、凭证变更、对外消息、生产数据修改与不可逆操作始终禁止；",
    "报告第一节必须是“覆盖声明”，列出登录、核心旅程、清理的实测状态；三者未全部成功时禁止声称“端到端已验证”。",
    "报告必须直接完整输出在最后一条 agent.message 中；若 DeliverArtifacts 可用，也可同时交付 Markdown 原件。不得使用 Write/Bash 创建报告，不得只输出文件路径、写作计划或阶段性进度；",
    `只有完整报告和 IM 摘要都已输出后，才在最后一行原样输出 ${REPORT_COMPLETE_MARKER}；该标记不得提前出现在阶段性消息中。`,
  ];

  return requirements
    .map((requirement, index) => `${index + 1}. ${requirement}`)
    .join("\n");
}

export function buildEvaluationPrompt({
  product,
  productUrl,
  depth,
  packId,
  access,
}: EvaluationPromptInput) {
  return `请对“${product}”执行一次${depth}产品体验评测。
被测产品入口：${productUrl}

${packContext(product, packId)}

访问与授权边界：
${accessRules(access)}

${reportFormatContract()}

执行要求：
${executionRequirements(packId)}`;
}
