import {
  createEvaluation,
  getEvaluation,
  updateEvaluation,
} from "@/db/evaluations";
import {
  resolveRunOwner,
  withRunOwnerCookie,
} from "@/lib/run-owner";
import { buildEvaluationPrompt } from "@/lib/evaluation-prompt";
import {
  MAX_REPORT_CONTINUATIONS,
  artifactRetrievalWindow,
  buildReportContinuationMessage,
  reportContinuationDecision,
  selectQualifiedReport,
} from "@/lib/qca-report-finality";
import {
  MANUAL_LOGIN_COMPLETED_MARKER,
  MANUAL_LOGIN_REQUIRED_MARKER,
  TEST_ACCESS_POLICY_VERSION,
  buildQcaSessionMetadata,
  parseTestAccess,
  parseSafeTestAccessSummary,
  redactSensitiveText,
  toSafeTestAccessSummary,
  type CleanupStatus,
  type ValidatedTestAccess,
} from "@/lib/test-access";

const DEFAULT_CLOUD_BASE_URL = "https://api.qoder.com/api/v1/cloud";
const DEFAULT_FORWARD_BASE_URL = "https://api.qoder.com/api/v1/forward";
const ENVIRONMENT_NAME = "PXO Twin Sandbox";
const TEMPLATE_NAME = "产品体验官";
const READ_ONLY_AGENT_NAME = "产品体验官｜只读 v2";
const AUTHORIZED_AGENT_NAME = "产品体验官｜授权 E2E v2";
const IDENTITY_EXTERNAL_ID = "pxo-twin-owner";
const BROWSER_USE_CONTRACT = {
  toolType: "browser_toolset_20260714",
  betaHeader: "browser-use-2026-07-14",
} as const;
const QCA_DPATH_ENV = "cloud-agent-test17";

type RuntimeConfig = {
  QODER_CLOUD_BASE_URL?: string;
  QODER_FORWARD_BASE_URL?: string;
};

type QcaRecord = Record<string, unknown>;
type QcaFailureKind =
  | "credential_required"
  | "session_missing"
  | "rate_limited"
  | "transient"
  | "upstream_error"
  | "network";

class QcaRequestError extends Error {
  readonly status?: number;
  readonly kind: QcaFailureKind;
  readonly retryable: boolean;

  constructor(
    message: string,
    options: {
      status?: number;
      kind: QcaFailureKind;
      retryable: boolean;
    },
  ) {
    super(message);
    this.name = "QcaRequestError";
    this.status = options.status;
    this.kind = options.kind;
    this.retryable = options.retryable;
  }
}

function qcaFailureForStatus(status: number) {
  if (status === 401 || status === 403) {
    return { kind: "credential_required" as const, retryable: false };
  }
  if (status === 404 || status === 410) {
    return { kind: "session_missing" as const, retryable: false };
  }
  if (status === 429) {
    return { kind: "rate_limited" as const, retryable: true };
  }
  if (status >= 500) {
    return { kind: "transient" as const, retryable: true };
  }
  return { kind: "upstream_error" as const, retryable: false };
}

function pollFailureContract(error: unknown) {
  if (error instanceof QcaRequestError) {
    if (error.kind === "credential_required") {
      return {
        mode: "credential-required",
        status: "credential_required",
        retryable: false,
        httpStatus: error.status || 401,
        upstreamStatus: error.status,
        message:
          "当前 Qoder PAT 无权访问这个 QCA Session。请使用启动该任务时相同账号与工作空间的 PAT。",
      };
    }
    if (error.kind === "session_missing") {
      return {
        mode: "live",
        status: "session_missing",
        retryable: false,
        httpStatus: error.status || 404,
        upstreamStatus: error.status,
        message:
          "QCA Session 不存在或已过期；也可能当前 PAT 所属账号或工作空间不同。",
      };
    }
    if (error.retryable) {
      return {
        mode: "live",
        status: "sync_error",
        retryable: true,
        httpStatus: error.status === 429 ? 429 : 502,
        upstreamStatus: error.status,
        message:
          error.kind === "rate_limited"
            ? "QCA 暂时限流，正在重试同步。"
            : "QCA 服务暂时不可用，正在重试同步。",
      };
    }
    return {
      mode: "live",
      status: "upstream_error",
      retryable: false,
      httpStatus: 502,
      upstreamStatus: error.status,
      message: "QCA 拒绝了本次状态同步请求，请检查 Session 与任务配置。",
    };
  }
  return {
    mode: "live",
    status: "sync_error",
    retryable: true,
    httpStatus: 502,
    upstreamStatus: undefined,
    message: "QCA 状态同步暂时失败，正在重试。",
  };
}

function nonterminalSessionStatus(status: unknown) {
  return status === "idle" || status === "queued" || status === "running"
    ? status
    : "running";
}

function runtimeConfig() {
  const runtime = process.env as RuntimeConfig;
  return {
    cloudBaseUrl: runtime.QODER_CLOUD_BASE_URL || DEFAULT_CLOUD_BASE_URL,
    forwardBaseUrl:
      runtime.QODER_FORWARD_BASE_URL || DEFAULT_FORWARD_BASE_URL,
  };
}

function responseJson(
  data: Record<string, unknown>,
  init?: ResponseInit,
) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(data), { ...init, headers });
}

function userPat(value: unknown) {
  const pat = typeof value === "string" ? value.trim() : "";
  if (!/^pt-[A-Za-z0-9_-]{20,}$/.test(pat)) {
    throw new Error("请输入有效的 Qoder PAT");
  }
  return pat;
}

function qcaHeaders(pat: string, idempotencyKey?: string) {
  return {
    authorization: `Bearer ${pat}`,
    "content-type": "application/json",
    "x-requested-with": "XMLHttpRequest",
    "x-cas-include-extended": "true",
    "x-qoder-beta": BROWSER_USE_CONTRACT.betaHeader,
    "x-qoder-request-source": "web",
    "eagleeye-userdata": `dpath_env=${QCA_DPATH_ENV}`,
    "x-biz-info": `mc-sys-aenv=${QCA_DPATH_ENV}`,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

async function qcaJson(
  url: string,
  pat: string,
  init?: RequestInit,
): Promise<QcaRecord> {
  let response: Response | undefined;
  const idempotencyKey =
    init?.method && init.method !== "GET" ? crypto.randomUUID() : undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      response = await fetch(url, {
        ...init,
        headers: {
          ...qcaHeaders(pat, idempotencyKey),
          ...(init?.headers || {}),
        },
      });
    } catch {
      throw new QcaRequestError("QCA network request failed", {
        kind: "network",
        retryable: true,
      });
    }
    if (response.status !== 429 || attempt === 3) break;
    const retryAfter = Number(response.headers.get("retry-after") || 0);
    const waitMs = retryAfter
      ? retryAfter * 1000
      : 600 * 2 ** attempt + Math.random() * 240;
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  if (!response) {
    throw new QcaRequestError("QCA request did not start", {
      kind: "network",
      retryable: true,
    });
  }

  const text = await response.text();
  let data: QcaRecord = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { message: text };
  }

  if (!response.ok) {
    const error =
      typeof data.error === "object" && data.error
        ? (data.error as QcaRecord)
        : data;
    const message =
      typeof error.message === "string"
        ? error.message
        : `QCA request failed with ${response.status}`;
    const failure = qcaFailureForStatus(response.status);
    throw new QcaRequestError(message, {
      status: response.status,
      ...failure,
    });
  }
  return data;
}

const TERMINAL_UPDATE_RETRY_DELAYS_MS = [150, 400, 900] as const;

async function confirmEvaluationUpdate(
  update: () => Promise<boolean>,
  wait: (delayMs: number) => Promise<void> = (delayMs) =>
    new Promise((resolve) => setTimeout(resolve, delayMs)),
) {
  for (
    let attempt = 0;
    attempt <= TERMINAL_UPDATE_RETRY_DELAYS_MS.length;
    attempt += 1
  ) {
    try {
      if (await update()) return;
    } catch {
      // A terminal QCA state is not acknowledged until its owner-scoped
      // persistence write succeeds; the caller returns a retryable sync error.
    }
    if (attempt === TERMINAL_UPDATE_RETRY_DELAYS_MS.length) break;
    await wait(TERMINAL_UPDATE_RETRY_DELAYS_MS[attempt]);
  }
  throw new Error("Terminal evaluation state was not persisted");
}

function qcaSessionConsoleUrl(sessionId: string) {
  return `https://qoder.com/cloud/sessions/${encodeURIComponent(sessionId)}`;
}

function dataRows(response: QcaRecord) {
  return Array.isArray(response.data)
    ? response.data.filter(
        (item): item is QcaRecord => Boolean(item) && typeof item === "object",
      )
    : [];
}

function recordId(record: QcaRecord | undefined, prefix: string) {
  const id = record?.id;
  return typeof id === "string" && id.startsWith(prefix) ? id : "";
}

function experienceOfficerTools(
  mode: "read-only" | "authorized-e2e" = "read-only",
  browserUse = true,
) {
  const writePolicy =
    mode === "authorized-e2e" ? "always_allow" : "always_deny";
  const tools: QcaRecord[] = [
    {
      type: "agent_toolset_20260401",
      enabled_tools: [
        "Read",
        "Write",
        "Bash",
        "WebFetch",
        "WebSearch",
        "DeliverArtifacts",
      ],
      configs: [
        {
          name: "WebFetch",
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
        {
          name: "WebSearch",
          enabled: true,
          permission_policy: { type: "always_allow" },
        },
        {
          name: "Write",
          enabled: true,
          permission_policy: { type: writePolicy },
        },
        {
          name: "Bash",
          enabled: true,
          permission_policy: { type: writePolicy },
        },
      ],
    },
  ];
  if (browserUse) {
    tools.push({ type: BROWSER_USE_CONTRACT.toolType });
  }
  return tools;
}

function agentSystem(mode: "read-only" | "authorized-e2e") {
  const modeRule =
    mode === "read-only"
      ? "本 Agent 的 Write 与 Bash 已被工具策略拒绝；BrowserUse 仍依赖本只读契约，不得创建、修改或提交被测产品数据。"
      : "本 Agent 仅可在用户显式授权的测试边界内创建或更新带指定前缀的临时资源，并清理自己创建的测试数据。";
  return `你是产品体验官。先完成真实产品体验，再给出判断。

工作原则：
1. 结论必须绑定可复现证据；没有看到、没有调用、没有执行的内容不得写成实测。
2. ${modeRule}
3. 永久删除、购买/支付、权限提升、凭证变更、对外消息、生产数据修改与不可逆操作在任何模式都禁止。
4. 秘密值只能通过 QCA Vault 注入的环境变量引用；不得读取、打印、回显、写入消息、报告、文件、截图或工具参数。
5. BrowserUse 没有不透明秘密输入能力；不得把密码或 Token 输入 BrowserUse。需要账号登录时执行人工接管检查点。
6. 每条问题使用“场景—操作—预期—实际—证据—影响—建议”结构，交付中文 Markdown 与 IM 摘要。
7. 报告必须以“覆盖声明”开头；只有登录、核心旅程和清理全部成功，才能写“端到端已验证”。`;
}

function hasBrowserUse(record: QcaRecord | undefined) {
  return (
    Array.isArray(record?.tools) &&
    record.tools.some(
      (tool) =>
        Boolean(tool) &&
        typeof tool === "object" &&
        (tool as QcaRecord).type === BROWSER_USE_CONTRACT.toolType,
    )
  );
}

async function ensureForwardResources(
  config: ReturnType<typeof runtimeConfig>,
  pat: string,
) {
  const [environmentResponse, identityResponse, templateResponse] =
    await Promise.all([
      qcaJson(`${config.cloudBaseUrl}/environments?limit=100`, pat),
      qcaJson(
        `${config.forwardBaseUrl}/identities?external_id=${encodeURIComponent(IDENTITY_EXTERNAL_ID)}&limit=10`,
        pat,
      ),
      qcaJson(
        `${config.forwardBaseUrl}/templates?status=active&limit=100`,
        pat,
      ),
    ]);

  let environment = dataRows(environmentResponse).find(
    (item) => item.name === ENVIRONMENT_NAME,
  );
  let environmentId = recordId(environment, "env_");
  let provisioned = false;

  if (!environmentId) {
    environment = await qcaJson(
      `${config.cloudBaseUrl}/environments`,
      pat,
      {
        method: "POST",
        body: JSON.stringify({
          name: ENVIRONMENT_NAME,
          description:
            "产品体验官的隔离执行环境；默认允许访问被测产品文档与公开 API。",
          config: {
            type: "cloud",
            networking: { type: "unrestricted" },
          },
          metadata: { app: "pxo-twin", managed_by: "pxo-twin-site" },
        }),
      },
    );
    environmentId = recordId(environment, "env_");
    provisioned = true;
  }

  if (!environmentId) throw new Error("QCA did not return an environment id");

  let identity = dataRows(identityResponse).find(
    (item) => item.external_id === IDENTITY_EXTERNAL_ID,
  );
  let identityId = recordId(identity, "idn_");

  if (!identityId) {
    identity = await qcaJson(
      `${config.forwardBaseUrl}/identities`,
      pat,
      {
        method: "POST",
        body: JSON.stringify({
          external_id: IDENTITY_EXTERNAL_ID,
          name: "产品体验官用户",
          metadata: { channel: "web", app: "pxo-twin" },
        }),
      },
    );
    identityId = recordId(identity, "idn_");
    provisioned = true;
  }

  if (!identityId) throw new Error("QCA did not return an identity id");

  let template = dataRows(templateResponse).find(
    (item) => item.name === TEMPLATE_NAME,
  );
  let templateId = recordId(template, "tmpl_");

  if (!templateId) {
    const models = await qcaJson(`${config.cloudBaseUrl}/models`, pat);
    const model = dataRows(models).find((item) => item.id === "ultimate")
      ?? dataRows(models)[0];
    const modelId =
      typeof model?.id === "string" ? model.id : "";
    if (!modelId) throw new Error("No enabled QCA model is available");

    template = await qcaJson(
      `${config.forwardBaseUrl}/templates`,
      pat,
      {
        method: "POST",
        body: JSON.stringify({
          name: TEMPLATE_NAME,
          description:
            "会读文档、验证 API、体验控制台并输出云知道深度测评的产品体验官。",
          model: { id: modelId, effort: "high" },
          environment_id: environmentId,
          system: `你是产品体验官。你的职责不是代写，而是先完成真实产品体验，再给出判断。

工作原则：
1. 结论必须绑定可复现证据；没有看到、没有调用、没有执行的内容不得写成实测。
2. 默认只读。创建资源、提交表单、产生费用、修改配置或删除数据前必须请求确认。
3. 同时使用新人视角与专家判断：记录首次理解成本，也判断架构、API 与治理能力。
4. 每条问题使用“场景—操作—预期—实际—证据—影响—建议”结构。
5. 交付中文 Markdown 深度测评，并附一段适合 IM 阅读的结论摘要。
6. 如果当前 Template 未开放 BrowserUse，明确标记浏览器任务未执行，不得用 WebFetch 冒充真实交互。`,
          tools: experienceOfficerTools("read-only", false),
          skills: [],
          metadata: {
            app: "pxo-twin",
            pack: "product-experience-officer",
            safety: "read-only-by-default",
          },
        }),
      },
    );
    templateId = recordId(template, "tmpl_");
    provisioned = true;
  }

  if (!templateId) throw new Error("QCA did not return a template id");

  return { templateId, identityId, provisioned };
}

async function waitForEnvironmentReady(
  config: ReturnType<typeof runtimeConfig>,
  pat: string,
  environment: QcaRecord,
) {
  const environmentId = recordId(environment, "env_");
  if (!environmentId) throw new Error("QCA did not return an environment id");
  const initialStatus =
    typeof environment.status === "string" ? environment.status : "";
  // Cloud environments are declarative resources. The public API currently
  // omits a runtime status, which means they can be attached to a Session
  // immediately and the platform provisions the container lazily.
  if (!initialStatus || initialStatus === "ready") return environmentId;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const current = await qcaJson(
      `${config.cloudBaseUrl}/environments/${environmentId}`,
      pat,
    );
    if (current.status === "ready") return environmentId;
    if (current.status === "failed" || current.status === "archived") {
      throw new Error(`QCA environment is ${String(current.status)}`);
    }
  }
  throw new Error("QCA environment did not become ready within 30 seconds");
}

async function ensureManagedResources(
  config: ReturnType<typeof runtimeConfig>,
  pat: string,
  mode: "read-only" | "authorized-e2e",
) {
  const [environmentResponse, agentResponse] = await Promise.all([
    qcaJson(`${config.cloudBaseUrl}/environments?limit=100`, pat),
    qcaJson(`${config.cloudBaseUrl}/agents?limit=100`, pat),
  ]);
  let provisioned = false;
  let environment = dataRows(environmentResponse).find(
    (item) => item.name === ENVIRONMENT_NAME,
  );
  if (!environment) {
    environment = await qcaJson(`${config.cloudBaseUrl}/environments`, pat, {
      method: "POST",
      body: JSON.stringify({
        name: ENVIRONMENT_NAME,
        description:
          "产品体验官的隔离执行环境；默认允许访问被测产品文档与公开 API。",
        config: {
          type: "cloud",
          networking: { type: "unrestricted" },
        },
        metadata: { app: "pxo-twin", managed_by: "pxo-twin-site" },
      }),
    });
    provisioned = true;
  }
  const environmentId = await waitForEnvironmentReady(
    config,
    pat,
    environment,
  );

  const agentName =
    mode === "read-only" ? READ_ONLY_AGENT_NAME : AUTHORIZED_AGENT_NAME;
  let agent = dataRows(agentResponse).find((item) => item.name === agentName);
  let agentId = recordId(agent, "agent_");
  if (!agentId) {
    const models = await qcaJson(`${config.cloudBaseUrl}/models`, pat);
    const model = dataRows(models).find((item) => item.id === "ultimate")
      ?? dataRows(models)[0];
    const modelId = typeof model?.id === "string" ? model.id : "";
    if (!modelId) throw new Error("No enabled QCA model is available");
    agent = await qcaJson(`${config.cloudBaseUrl}/agents`, pat, {
      method: "POST",
      body: JSON.stringify({
        name: agentName,
        description:
          mode === "read-only"
            ? "只读产品体验 Agent：禁止 Write/Bash 与被测产品副作用。"
            : "授权端到端产品体验 Agent：只执行可逆、可清理的测试操作。",
        model: { id: modelId, effort: "high" },
        system: agentSystem(mode),
        tools: experienceOfficerTools(mode),
        skills: [],
        metadata: {
          app: "pxo-twin",
          pack: "product-experience-officer",
          safety: mode,
          policy_version: TEST_ACCESS_POLICY_VERSION,
        },
      }),
    });
    agentId = recordId(agent, "agent_");
    provisioned = true;
  } else if (
    !hasBrowserUse(agent) ||
    (agent.metadata as QcaRecord | undefined)?.policy_version !==
      TEST_ACCESS_POLICY_VERSION
  ) {
    const version =
      typeof agent.version === "number" ? agent.version : 0;
    if (!version) throw new Error("QCA Agent version is unavailable");
    agent = await qcaJson(`${config.cloudBaseUrl}/agents/${agentId}`, pat, {
      method: "POST",
      body: JSON.stringify({
        version,
        system: agentSystem(mode),
        tools: experienceOfficerTools(mode),
        metadata: {
          app: "pxo-twin",
          pack: "product-experience-officer",
          safety: mode,
          policy_version: TEST_ACCESS_POLICY_VERSION,
        },
      }),
    });
    provisioned = true;
  }

  if (!agentId) throw new Error("QCA did not return an agent id");
  if (!hasBrowserUse(agent)) {
    throw new Error("QCA Managed Agent did not enable BrowserUse");
  }
  return { agentId, environmentId, provisioned };
}

async function createEphemeralEnvironment(
  config: ReturnType<typeof runtimeConfig>,
  pat: string,
  runId: string,
) {
  const environment = await qcaJson(`${config.cloudBaseUrl}/environments`, pat, {
    method: "POST",
    body: JSON.stringify({
      name: `产品体验官 E2E · ${crypto.randomUUID().slice(0, 8)}`,
      description: "产品体验官单次凭证化端到端评测环境；Session 结束后删除或归档。",
      config: {
        type: "cloud",
        networking: { type: "unrestricted" },
      },
      metadata: {
        app: "pxo-twin",
        purpose: "credentialed-e2e",
        ephemeral: "true",
        run_id: runId,
        policy_version: TEST_ACCESS_POLICY_VERSION,
      },
    }),
  });
  return waitForEnvironmentReady(config, pat, environment);
}

async function createCredentialVault(
  config: ReturnType<typeof runtimeConfig>,
  pat: string,
  access: ValidatedTestAccess,
  runId: string,
) {
  const vault = await qcaJson(`${config.cloudBaseUrl}/vaults`, pat, {
    method: "POST",
    body: JSON.stringify({
      display_name: `产品体验官 E2E · ${crypto.randomUUID().slice(0, 8)}`,
      metadata: {
        app: "pxo-twin",
        purpose: "credentialed-e2e",
        ephemeral: "true",
        run_id: runId,
        policy_version: TEST_ACCESS_POLICY_VERSION,
      },
    }),
  });
  const vaultId = recordId(vault, "vault_");
  if (!vaultId) throw new Error("QCA did not return a vault id");

  try {
    for (const secret of access.secrets) {
      await qcaJson(
        `${config.cloudBaseUrl}/vaults/${vaultId}/credentials`,
        pat,
        {
          method: "POST",
          body: JSON.stringify({
            auth: {
              type: "environment_variable",
              secret_name: secret.alias,
              secret_value: secret.value,
            },
            metadata: {
              kind: secret.kind,
              app: "pxo-twin",
              ephemeral: "true",
            },
          }),
        },
      );
    }
  } catch (error) {
    await cleanupEphemeralResources(config, pat, {
      vaultIds: [vaultId],
      runId,
    }).catch(() => "failed");
    throw error;
  }
  return vaultId;
}

function safeRemoteId(value: unknown, prefix: string) {
  return typeof value === "string" &&
    value.startsWith(prefix) &&
    /^[A-Za-z0-9_-]+$/.test(value)
    ? value
    : "";
}

function isProductExperienceEphemeral(record: QcaRecord) {
  const metadata =
    record.metadata && typeof record.metadata === "object"
      ? (record.metadata as QcaRecord)
      : {};
  return (
    metadata.app === "pxo-twin" &&
    metadata.purpose === "credentialed-e2e" &&
    (metadata.ephemeral === "true" || metadata.ephemeral === true)
  );
}

function belongsToProductExperienceRun(record: QcaRecord, runId?: string) {
  if (!isProductExperienceEphemeral(record)) return false;
  if (!runId) return true;
  const metadata = record.metadata as QcaRecord;
  return metadata.run_id === runId;
}

function isRemoteNotFound(error: unknown) {
  return (
    error instanceof Error &&
    /(?:\b404\b|not found|does not exist)/i.test(error.message)
  );
}

async function cleanupEphemeralResources(
  config: ReturnType<typeof runtimeConfig>,
  pat: string,
  resources: { vaultIds?: string[]; environmentId?: string; runId?: string },
): Promise<CleanupStatus> {
  const vaultIds = (resources.vaultIds || [])
    .map((id) => safeRemoteId(id, "vault_"))
    .filter(Boolean);
  const environmentId = safeRemoteId(resources.environmentId, "env_");
  if (!vaultIds.length && !environmentId) return "not-required";

  let failed = false;
  for (const vaultId of vaultIds) {
    try {
      const detail = await qcaJson(
        `${config.cloudBaseUrl}/vaults/${vaultId}`,
        pat,
      );
      if (!belongsToProductExperienceRun(detail, resources.runId)) {
        failed = true;
        continue;
      }
      const credentials = await qcaJson(
        `${config.cloudBaseUrl}/vaults/${vaultId}/credentials?limit=100`,
        pat,
      );
      for (const credential of dataRows(credentials)) {
        const credentialId =
          typeof credential.id === "string" &&
          /^[A-Za-z0-9_-]+$/.test(credential.id)
            ? credential.id
            : "";
        if (!credentialId) continue;
        await qcaJson(
          `${config.cloudBaseUrl}/vaults/${vaultId}/credentials/${credentialId}`,
          pat,
          { method: "DELETE" },
        );
      }
      await qcaJson(`${config.cloudBaseUrl}/vaults/${vaultId}`, pat, {
        method: "DELETE",
      });
    } catch (error) {
      if (!isRemoteNotFound(error)) failed = true;
    }
  }

  if (environmentId) {
    try {
      const detail = await qcaJson(
        `${config.cloudBaseUrl}/environments/${environmentId}`,
        pat,
      );
      if (!belongsToProductExperienceRun(detail, resources.runId)) {
        failed = true;
      } else {
        try {
          await qcaJson(
            `${config.cloudBaseUrl}/environments/${environmentId}`,
            pat,
            { method: "DELETE" },
          );
        } catch {
          await qcaJson(
            `${config.cloudBaseUrl}/environments/${environmentId}/archive`,
            pat,
            { method: "POST", body: "{}" },
          );
        }
      }
    } catch (error) {
      if (!isRemoteNotFound(error)) failed = true;
    }
  }
  return failed ? "failed" : "complete";
}

function cleanupTargetsFromSession(session: QcaRecord) {
  return {
    vaultIds: Array.isArray(session.vault_ids)
      ? session.vault_ids.filter(
          (id): id is string => typeof id === "string",
        )
      : [],
    environmentId:
      typeof session.environment_id === "string"
        ? session.environment_id
        : undefined,
  };
}

async function discoverEphemeralResources(
  config: ReturnType<typeof runtimeConfig>,
  pat: string,
  runId: string,
) {
  const [vaults, environments] = await Promise.all([
    qcaJson(`${config.cloudBaseUrl}/vaults?limit=100`, pat),
    qcaJson(`${config.cloudBaseUrl}/environments?limit=100`, pat),
  ]);
  const belongsToRun = (record: QcaRecord) => {
    if (!isProductExperienceEphemeral(record)) return false;
    const metadata = record.metadata as QcaRecord;
    return metadata.run_id === runId;
  };
  return {
    vaultIds: dataRows(vaults)
      .filter(belongsToRun)
      .map((record) => safeRemoteId(record.id, "vault_"))
      .filter(Boolean),
    environmentId:
      dataRows(environments)
        .filter(belongsToRun)
        .map((record) => safeRemoteId(record.id, "env_"))
        .find(Boolean) || undefined,
  };
}

function accessSummaryFromSession(session: QcaRecord) {
  const metadata =
    session.metadata && typeof session.metadata === "object"
      ? (session.metadata as QcaRecord)
      : {};
  return parseSafeTestAccessSummary(metadata.access_summary);
}

function extractAgentMessages(events: QcaRecord) {
  return dataRows(events)
    .filter((event) => event.type === "agent.message")
    .flatMap((event) => (Array.isArray(event.content) ? event.content : []))
    .filter(
      (block): block is QcaRecord =>
        Boolean(block) && typeof block === "object",
    )
    .map((block) => block.text)
    .filter((text): text is string => typeof text === "string")
    .map((text) => redactSensitiveText(text));
}

function extractDeliveredFileId(events: QcaRecord) {
  for (const event of [...dataRows(events)].reverse()) {
    if (
      event.type === "agent.artifact_delivered" &&
      typeof event.file_id === "string"
    ) {
      return safeRemoteId(event.file_id, "file_");
    }
  }
  return "";
}

async function fetchDeliveredReport(
  fileId: string,
  config: ReturnType<typeof runtimeConfig>,
  pat: string,
) {
  if (!fileId) return "";
  const content = await qcaJson(
    `${config.cloudBaseUrl}/files/${fileId}/content`,
    pat,
  );
  const downloadUrl = typeof content.url === "string" ? content.url : "";
  if (!downloadUrl.startsWith("https://")) return "";
  const response = await fetch(downloadUrl);
  return response.ok ? response.text() : "";
}

async function fetchDeliveredReportOrPending(
  fileId: string,
  load: (resolvedFileId: string) => Promise<string>,
) {
  if (!fileId) return "";
  try {
    return await load(fileId);
  } catch {
    // Session/events access already succeeded in this poll. A file-specific
    // 401/403/404 or transient download failure means the artifact is not
    // readable yet, not that the PAT or Session is invalid.
    return "";
  }
}

function toolUseCorrelationId(event: QcaRecord) {
  for (const candidate of [event.tool_use_id, event.id]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  return "";
}

function isAwaitingToolConfirmation(
  sessionStatus: unknown,
  rows: QcaRecord[],
) {
  if (sessionStatus !== "idle") return false;
  let currentTurnStart = -1;
  rows.forEach((event, index) => {
    if (event.type === "agent.message" || event.type === "user.message") {
      currentTurnStart = index;
    }
  });
  const currentTurnRows = rows.slice(currentTurnStart + 1);
  const resolvedToolUseIds = new Set(
    currentTurnRows
      .filter(
        (event) =>
          event.type === "agent.tool_result" ||
          event.type === "user.tool_confirmation",
      )
      .map(toolUseCorrelationId)
      .filter(Boolean),
  );
  return currentTurnRows
    .filter((event) => event.type === "agent.tool_use")
    .map(toolUseCorrelationId)
    .filter(Boolean)
    .some((toolUseId) => !resolvedToolUseIds.has(toolUseId));
}

function storedEvidence(serialized: string) {
  try {
    const parsed = JSON.parse(serialized);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as QcaRecord)
      : {};
  } catch {
    return {};
  }
}

function eventMarkerIndex(
  rows: QcaRecord[],
  eventType: string,
  marker: string,
) {
  let markerIndex = -1;
  rows.forEach((event, index) => {
    const hasStandaloneMarker = contentText(event)
      .split(/\r?\n/)
      .some((line) => line.trim() === marker);
    if (event.type === eventType && hasStandaloneMarker) {
      markerIndex = index;
    }
  });
  return markerIndex;
}

function latestAgentActivityId(rows: QcaRecord[]) {
  const latest = [...rows]
    .reverse()
    .find(
      (event) =>
        typeof event.type === "string" &&
        event.type.startsWith("agent."),
    );
  if (!latest) return "";
  for (const candidate of [
    latest.id,
    latest.event_id,
    latest.sequence,
    latest.created_at,
    latest.timestamp,
  ]) {
    if (
      typeof candidate === "string" ||
      typeof candidate === "number"
    ) {
      return String(candidate).slice(0, 200);
    }
  }
  return "";
}

function contentText(event: QcaRecord) {
  if (!Array.isArray(event.content)) return "";
  return event.content
    .filter(
      (block): block is QcaRecord =>
        Boolean(block) && typeof block === "object",
    )
    .map((block) => block.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function summarizeEvidence(
  events: QcaRecord,
  complete: boolean,
  accessSummary?: TestAccessSummary | null,
  cleanupStatus?: CleanupStatus,
) {
  const rows = dataRows(events);
  const toolUses = rows.filter((event) => event.type === "agent.tool_use");
  const toolNames = Array.from(
    new Set(
      toolUses
        .map((event) => event.name || event.tool_name)
        .filter((name): name is string => typeof name === "string"),
    ),
  );
  const messages = rows
    .filter((event) => event.type === "agent.message")
    .map((event) => redactSensitiveText(contentText(event)))
    .filter(Boolean);
  const errors = rows.filter(
    (event) =>
      event.type === "session.error" ||
      (event.type === "agent.tool_result" &&
        /failed|error|not found|401|403|429/i.test(contentText(event))),
  ).length;
  const artifactId = extractDeliveredFileId(events);
  const progress = complete
    ? 100
    : Math.min(
        92,
        12 + Math.round(rows.length / 3) + toolUses.length * 4 + messages.length * 5,
      );

  return {
    totalEvents: rows.length,
    toolCalls: toolUses.length,
    tools: toolNames,
    messages: messages.length,
    errors,
    artifactDelivered: Boolean(artifactId),
    recentNotes: messages
      .filter((message) => !message.trimStart().startsWith("#"))
      .slice(-4)
      .map((message) =>
        message.length > 360 ? `${message.slice(0, 357)}…` : message,
      ),
    progress,
    ...(accessSummary
      ? {
          access: {
            ...accessSummary,
            ...(cleanupStatus ? { cleanupStatus } : {}),
          },
        }
      : {}),
  };
}

export async function GET() {
  return responseJson({
    mode: "credential-required",
    connected: false,
    status: "ready",
    credentialPolicy: "ephemeral",
  });
}

export async function POST(request: Request) {
  const owner = resolveRunOwner(request);
  const respond = (
    data: Record<string, unknown>,
    init?: ResponseInit,
  ) => withRunOwnerCookie(responseJson(data, init), owner);
  const config = runtimeConfig();
  const body = (await request.json().catch(() => ({}))) as {
    action?: string;
    pat?: string;
    product?: string;
    depth?: string;
    packId?: string;
    productUrl?: string;
    scopes?: string[];
    sessionId?: string;
    sessionMode?: string;
    runId?: string;
    reconcile?: boolean;
    channelType?: "dingtalk" | "feishu" | "wecom" | "wechat";
    testAccess?: unknown;
  };

  const supportedActions = new Set([
    "health",
    "channels",
    "poll",
    "resume-login",
    "cleanup",
    "evaluate",
    "connect-im",
  ]);
  if (!body.action || !supportedActions.has(body.action)) {
    return respond(
      {
        mode: "error",
        status: "error",
        message: "Unsupported QCA action",
      },
      { status: 400 },
    );
  }

  let pat = "";
  try {
    pat = userPat(body.pat);
  } catch (error) {
    return respond(
      {
        mode: "credential-required",
        connected: false,
        status: "error",
        message:
          error instanceof Error ? error.message : "请输入有效的 Qoder PAT",
      },
      { status: 401 },
    );
  }

  let validatedAccess: ValidatedTestAccess | null = null;
  if (body.action === "evaluate") {
    try {
      validatedAccess = parseTestAccess(body.testAccess, body.productUrl);
      if (
        typeof body.product !== "string" ||
        !body.product.trim() ||
        body.product.trim().length > 160
      ) {
        throw new Error("被测产品名称必须为 1–160 个字符");
      }
      if (
        !Array.isArray(body.scopes) ||
        body.scopes.length < 1 ||
        body.scopes.length > 10 ||
        body.scopes.some(
          (scope) => typeof scope !== "string" || scope.length > 40,
        )
      ) {
        throw new Error("请至少选择一个有效评测范围");
      }
    } catch (error) {
      return respond(
        {
          mode: "live",
          status: "error",
          message:
            error instanceof Error
              ? redactSensitiveText(error.message, [pat])
              : "被测产品访问配置无效",
        },
        { status: 400 },
      );
    }
  }

  const targetSecrets =
    validatedAccess?.secrets.map((secret) => secret.value) || [];
  const safeMessage = (error: unknown, fallback: string) =>
    redactSensitiveText(
      (error instanceof Error ? error.message : fallback).replaceAll(
        pat,
        "[redacted]",
      ),
      targetSecrets,
    );

  if (body.action === "health") {
    try {
      await qcaJson(`${config.cloudBaseUrl}/models`, pat);
      return respond({
        mode: "live",
        connected: true,
        status: "ready",
        delivery: "managed-evaluation-forward-im",
        browserUse: "auto-enabled",
        credentialPolicy: "ephemeral",
      });
    } catch (error) {
      return respond(
        {
          mode: "error",
          connected: false,
          status: "error",
          message: safeMessage(error, "QCA connection failed"),
        },
        { status: 502 },
      );
    }
  }

  if (body.action === "channels") {
    try {
      const channels = await qcaJson(
        `${config.forwardBaseUrl}/channels?limit=100`,
        pat,
      );
      const safeChannels = dataRows(channels).map((channel) => ({
        id: channel.id,
        type: channel.channel_type,
        name: channel.name,
        enabled: channel.enabled,
        bindingStatus: channel.binding_status,
      }));
      return respond({ mode: "live", channels: safeChannels });
    } catch (error) {
      return respond(
        {
          mode: "live",
          channels: [],
          message: safeMessage(error, "Unable to load channels"),
        },
        { status: 502 },
      );
    }
  }

  if (body.action === "resume-login") {
    const sessionId = body.sessionId || "";
    const runId = body.runId || "";
    if (
      !/^sess_[A-Za-z0-9_-]+$/.test(sessionId) ||
      !/^run_[a-f0-9]{32}$/.test(runId)
    ) {
      return respond(
        { mode: "live", status: "error", message: "Invalid resume target" },
        { status: 400 },
      );
    }
    try {
      const run = await getEvaluation(owner.ownerId, runId);
      if (!run || run.session_id !== sessionId) {
        return respond(
          { mode: "live", status: "error", message: "Resume target not found" },
          { status: 404 },
        );
      }
      const [session, events] = await Promise.all([
        qcaJson(`${config.cloudBaseUrl}/sessions/${sessionId}`, pat),
        qcaJson(
          `${config.cloudBaseUrl}/sessions/${sessionId}/events?limit=100&order=desc`,
          pat,
        ),
      ]);
      const metadata =
        session.metadata && typeof session.metadata === "object"
          ? (session.metadata as QcaRecord)
          : {};
      const summary = accessSummaryFromSession(session);
      const chronologicalEvents = dataRows(events).reverse();
      const hasOpenLoginCheckpoint =
        eventMarkerIndex(
          chronologicalEvents,
          "agent.message",
          MANUAL_LOGIN_REQUIRED_MARKER,
        ) >
        eventMarkerIndex(
          chronologicalEvents,
          "user.message",
          MANUAL_LOGIN_COMPLETED_MARKER,
        );
      if (
        metadata.source !== "pxo-twin-web" ||
        summary?.mode !== "authorized-e2e" ||
        !summary.credentialCount ||
        !hasOpenLoginCheckpoint
      ) {
        return respond(
          {
            mode: "live",
            status: "error",
            message: "当前 Session 没有可恢复的产品体验官人工登录检查点",
          },
          { status: 409 },
        );
      }
      await qcaJson(
        `${config.cloudBaseUrl}/sessions/${sessionId}/events`,
        pat,
        {
          method: "POST",
          body: JSON.stringify({
            events: [
              {
                type: "user.message",
                content: [
                  {
                    type: "text",
                    text: `${MANUAL_LOGIN_COMPLETED_MARKER}\n用户已在 QCA 浏览器预览中人工完成登录。继续执行已授权评测；不得回读、输出或记录任何凭证。`,
                  },
                ],
              },
            ],
          }),
        },
      );
      return respond({ mode: "live", status: "running" });
    } catch (error) {
      return respond(
        {
          mode: "live",
          status: "error",
          message: safeMessage(error, "Unable to resume QCA session"),
        },
        { status: 502 },
      );
    }
  }

  if (body.action === "cleanup") {
    const sessionId = body.sessionId || "";
    const runId = body.runId || "";
    if (
      (sessionId && !/^sess_[A-Za-z0-9_-]+$/.test(sessionId)) ||
      !/^run_[a-f0-9]{32}$/.test(runId)
    ) {
      return respond(
        { mode: "live", status: "error", message: "Invalid cleanup target" },
        { status: 400 },
      );
    }
    try {
      const run = await getEvaluation(owner.ownerId, runId);
      if (!run || (sessionId && run.session_id !== sessionId)) {
        return respond(
          { mode: "live", status: "error", message: "Cleanup target not found" },
          { status: 404 },
        );
      }
      let previousEvidence: QcaRecord = {};
      try {
        const parsed = JSON.parse(run.evidence_json);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          previousEvidence = parsed as QcaRecord;
        }
      } catch {
        previousEvidence = {};
      }
      let summary = accessSummaryFromSession({
        metadata: { access_summary: previousEvidence.access },
      });
      let sessionTargets: ReturnType<typeof cleanupTargetsFromSession> = {
        vaultIds: [],
      };
      const effectiveSessionId = sessionId || run.session_id || "";
      if (effectiveSessionId) {
        const session = await qcaJson(
          `${config.cloudBaseUrl}/sessions/${effectiveSessionId}`,
          pat,
        );
        const metadata =
          session.metadata && typeof session.metadata === "object"
            ? (session.metadata as QcaRecord)
            : {};
        if (
          metadata.source !== "pxo-twin-web" ||
          metadata.run_id !== runId
        ) {
          return respond(
            {
              mode: "live",
              status: "error",
              message: "清理目标不是产品体验官创建的 Session",
            },
            { status: 409 },
          );
        }
        summary = accessSummaryFromSession(session) || summary;
        sessionTargets = cleanupTargetsFromSession(session);
      }
      const discovered = await discoverEphemeralResources(config, pat, runId);
      const rawCleanupStatus = await cleanupEphemeralResources(config, pat, {
        vaultIds: Array.from(
          new Set([...(sessionTargets.vaultIds || []), ...discovered.vaultIds]),
        ),
        environmentId:
          sessionTargets.environmentId || discovered.environmentId,
        runId,
      });
      const cleanupStatus =
        rawCleanupStatus === "not-required" && summary?.credentialCount
          ? "complete"
          : rawCleanupStatus;
      if (summary) {
        await updateEvaluation(owner.ownerId, runId, {
          evidence: {
            ...previousEvidence,
            access: { ...summary, cleanupStatus },
          },
        }).catch(() => false);
      }
      return respond({ mode: "live", status: cleanupStatus });
    } catch (error) {
      return respond(
        {
          mode: "live",
          status: "failed",
          message: safeMessage(error, "QCA cleanup failed"),
        },
        { status: 502 },
      );
    }
  }

  if (body.action === "poll") {
    const sessionId = body.sessionId || "";
    const sessionMode = body.sessionMode || "forward";
    const runId = body.runId || "";
    if (
      !/^sess_[A-Za-z0-9_-]+$/.test(sessionId) ||
      !/^run_[a-f0-9]{32}$/.test(runId)
    ) {
      return respond(
        { mode: "live", status: "error", message: "Invalid polling target" },
        { status: 400 },
      );
    }

    const baseUrl =
      sessionMode === "managed" ? config.cloudBaseUrl : config.forwardBaseUrl;

    try {
      const run = await getEvaluation(owner.ownerId, runId);
      if (!run || run.session_id !== sessionId) {
        return respond(
          { mode: "live", status: "error", message: "Polling target not found" },
          { status: 404 },
        );
      }
      if (run.status === "complete" && body.reconcile !== true) {
        const evidence = storedEvidence(run.evidence_json);
        const access = accessSummaryFromSession({
          metadata: { access_summary: evidence.access },
        });
        return respond({
          mode: "live",
          sessionMode,
          status: "complete",
          progress: 100,
          report: run.report,
          reportSource:
            run.report_source === "qca-artifact"
              ? "artifact"
              : "messages",
          evidence,
          cleanupStatus: access?.cleanupStatus,
          qcaConsoleUrl: qcaSessionConsoleUrl(sessionId),
        });
      }
      const [session, latestEvents] = await Promise.all([
        qcaJson(`${baseUrl}/sessions/${sessionId}`, pat),
        qcaJson(
          `${baseUrl}/sessions/${sessionId}/events?limit=100&order=desc`,
          pat,
        ),
      ]);
      // Long evaluations routinely exceed the 100-event page limit. Read the
      // newest page so terminal status, the final agent message, and delivered
      // artifacts cannot fall beyond an old ascending page, then restore
      // chronological order for message/report assembly.
      const events: QcaRecord = {
        ...latestEvents,
        data: dataRows(latestEvents).reverse(),
      };
      const messages = extractAgentMessages(events);
      const rows = dataRows(events);
      const requiredLoginIndex = eventMarkerIndex(
        rows,
        "agent.message",
        MANUAL_LOGIN_REQUIRED_MARKER,
      );
      const completedLoginIndex = eventMarkerIndex(
        rows,
        "user.message",
        MANUAL_LOGIN_COMPLETED_MARKER,
      );
      const manualLoginRequired =
        requiredLoginIndex > completedLoginIndex;
      const hasSessionError = rows.some(
        (event) => event.type === "session.error",
      );
      const awaitingConfirmation = isAwaitingToolConfirmation(
        session.status,
        rows,
      );
      const previousEvidence = storedEvidence(run.evidence_json);
      const persistedAccessSummary = accessSummaryFromSession({
        metadata: { access_summary: previousEvidence.access },
      });
      const baseSummary =
        accessSummaryFromSession(session) || persistedAccessSummary;
      const accessSummary = baseSummary
        ? {
            ...baseSummary,
            ...(persistedAccessSummary?.cleanupStatus
              ? {
                  cleanupStatus:
                    persistedAccessSummary.cleanupStatus,
                }
              : {}),
            loginStatus: manualLoginRequired
              ? ("awaiting-user" as const)
              : completedLoginIndex >= 0 &&
                  completedLoginIndex > requiredLoginIndex
                ? ("complete" as const)
                : baseSummary.loginStatus,
          }
        : null;
      const previousFinality =
        previousEvidence.reportFinality &&
        typeof previousEvidence.reportFinality === "object" &&
        !Array.isArray(previousEvidence.reportFinality)
          ? (previousEvidence.reportFinality as QcaRecord)
          : {};
      const persistedContinuationCount =
        typeof previousFinality.continuationCount === "number"
          ? Math.max(
              0,
              Math.min(
                MAX_REPORT_CONTINUATIONS,
                Math.floor(previousFinality.continuationCount),
              ),
            )
          : 0;
      const currentAgentActivityId = latestAgentActivityId(rows);
      const previousAgentActivityId =
        typeof previousFinality.lastContinuationAgentEventId === "string"
          ? previousFinality.lastContinuationAgentEventId
          : "";
      const persistedLastContinuationAt =
        typeof previousFinality.lastContinuationAt === "string"
          ? previousFinality.lastContinuationAt
          : "";
      const hasNewerAgentActivitySincePersistedAttempt =
        Boolean(previousAgentActivityId) &&
        Boolean(currentAgentActivityId) &&
        previousAgentActivityId !== currentAgentActivityId;
      const deliveredFileId = extractDeliveredFileId(events);
      const deliveredReport = await fetchDeliveredReportOrPending(
        deliveredFileId,
        (fileId) => fetchDeliveredReport(fileId, config, pat),
      );
      const artifactFetchPending =
        Boolean(deliveredFileId) && !deliveredReport.trim();
      const artifactRetrieval = artifactRetrievalWindow({
        pending: artifactFetchPending,
        persistedPendingSince:
          typeof previousFinality.artifactPendingSince === "string"
            ? previousFinality.artifactPendingSince
            : undefined,
      });
      const artifactPending = artifactRetrieval.pending;
      const artifactRetrievalExhausted = artifactRetrieval.exhausted;
      const legacyReconcileEligible =
        body.reconcile === true &&
        run.status === "complete" &&
        run.report_source === "qca-messages" &&
        typeof previousFinality.qualifiedBy !== "string";
      const qualifiedReport = selectQualifiedReport({
        messages,
        deliveredArtifact: deliveredReport,
        allowLegacy: legacyReconcileEligible,
      });
      const isComplete =
        !hasSessionError &&
        !manualLoginRequired &&
        !awaitingConfirmation &&
        session.status === "idle" &&
        qualifiedReport.complete;
      const continuationPolicy = reportContinuationDecision(
        rows,
        qualifiedReport.complete,
        {
          persistedAttempts: persistedContinuationCount,
          hasNewerAgentActivitySincePersistedAttempt,
          lastContinuationAt: persistedLastContinuationAt,
        },
      );
      const completedCredentialedRunCannotResume =
        run.status === "complete" &&
        Boolean(accessSummary?.credentialCount) &&
        !qualifiedReport.complete;
      const hasAgentActivity = rows.some(
        (event) =>
          typeof event.type === "string" &&
          event.type.startsWith("agent."),
      );
      const canContinueReport =
        session.status === "idle" &&
        hasAgentActivity &&
        !hasSessionError &&
        !manualLoginRequired &&
        !awaitingConfirmation &&
        !artifactFetchPending &&
        !qualifiedReport.complete &&
        (run.status !== "complete" ||
          (legacyReconcileEligible &&
            !completedCredentialedRunCannotResume));
      let continuationPosted = false;
      let continuationAttempt = persistedContinuationCount;
      let lastContinuationAgentEventId = previousAgentActivityId;
      let lastContinuationAt = persistedLastContinuationAt;
      if (
        canContinueReport &&
        continuationPolicy.shouldContinue &&
        continuationPolicy.nextAttempt
      ) {
        continuationAttempt = continuationPolicy.nextAttempt;
        await qcaJson(
          `${baseUrl}/sessions/${sessionId}/events`,
          pat,
          {
            method: "POST",
            headers: {
              "idempotency-key":
                `report-finality-${runId}-${sessionId}-${continuationAttempt}`,
            },
            body: JSON.stringify({
              events: [
                {
                  type: "user.message",
                  content: [
                    {
                      type: "text",
                      text: buildReportContinuationMessage(
                        continuationAttempt,
                      ),
                    },
                  ],
                },
              ],
            }),
          },
        );
        continuationPosted = true;
        lastContinuationAgentEventId = currentAgentActivityId;
        lastContinuationAt = new Date().toISOString();
      }
      const reportExhausted =
        run.status !== "complete" &&
        session.status === "idle" &&
        !hasSessionError &&
        !manualLoginRequired &&
        !awaitingConfirmation &&
        (!artifactFetchPending || artifactRetrievalExhausted) &&
        !qualifiedReport.complete &&
        (continuationPolicy.reason === "exhausted" ||
          artifactRetrievalExhausted);
      const isTerminal =
        isComplete ||
        reportExhausted ||
        (hasSessionError && run.status !== "complete");
      const rawCleanupStatus =
        isTerminal && accessSummary?.credentialCount
          ? await cleanupEphemeralResources(
              config,
              pat,
              { ...cleanupTargetsFromSession(session), runId },
            )
          : accessSummary?.cleanupStatus;
      const cleanupStatus =
        rawCleanupStatus === "not-required" &&
        accessSummary?.credentialCount
          ? "complete"
          : rawCleanupStatus;
      const report = redactSensitiveText(qualifiedReport.report);
      const evidence = {
        ...summarizeEvidence(
          events,
          isComplete,
          accessSummary,
          cleanupStatus,
        ),
        reportFinality: {
          protocolVersion: 1,
          continuationCount: Math.max(
            continuationAttempt,
            continuationPolicy.attemptsUsed,
          ),
          ...(lastContinuationAt ? { lastContinuationAt } : {}),
          ...(lastContinuationAgentEventId
            ? { lastContinuationAgentEventId }
            : {}),
          ...(qualifiedReport.source
            ? {
                qualifiedVersion: 1,
                qualifiedBy: qualifiedReport.source,
              }
            : {}),
          ...(artifactPending ? { artifactPending: true } : {}),
          ...(artifactFetchPending
            ? { artifactPendingSince: artifactRetrieval.pendingSince }
            : {}),
        },
      };
      const reportIncomplete =
        session.status === "idle" &&
        !hasSessionError &&
        !manualLoginRequired &&
        !awaitingConfirmation &&
        !isComplete &&
        !artifactPending &&
        !continuationPosted &&
        (artifactRetrievalExhausted ||
          continuationPolicy.reason === "exhausted" ||
          (run.status === "complete" &&
            (!body.reconcile ||
              completedCredentialedRunCannotResume ||
              !legacyReconcileEligible)));
      const responseStatus = hasSessionError
        ? run.status === "complete"
          ? "incomplete_report"
          : "error"
        : reportExhausted
          ? "error"
          : manualLoginRequired
            ? "awaiting_login"
            : awaitingConfirmation
              ? "awaiting_confirmation"
              : isComplete
                ? "complete"
                : artifactPending
                  ? "artifact_pending"
                  : continuationPosted ||
                      continuationPolicy.reason === "waiting-for-agent"
                    ? "report_continuing"
                    : reportIncomplete
                      ? "incomplete_report"
                      : nonterminalSessionStatus(session.status);

      const persistPollState = () => {
        if (run.status === "complete" && !isComplete) {
          return updateEvaluation(owner.ownerId, runId, { evidence });
        }
        return updateEvaluation(owner.ownerId, runId, {
          status: hasSessionError
            ? "failed"
            : reportExhausted
              ? "failed"
              : isComplete
                ? "complete"
                : "running",
          progress: evidence.progress,
          report: isComplete ? report : undefined,
          reportSource: isComplete
            ? qualifiedReport.source === "artifact"
              ? "qca-artifact"
              : "qca-messages"
            : undefined,
          evidence,
          errorMessage: hasSessionError
            ? "QCA Session reported an error"
            : artifactRetrievalExhausted
              ? "QCA 报告原件连续读取失败"
              : reportExhausted
                ? "QCA 未在自动补全上限内交付完整报告"
                : undefined,
        });
      };

      if (isTerminal) {
        try {
          await confirmEvaluationUpdate(persistPollState);
        } catch {
          return respond(
            {
              mode: "live",
              sessionMode,
              status: "sync_error",
              retryable: true,
              message: "评测已结束，但结果保存暂时失败，正在等待重新同步。",
              qcaConsoleUrl: qcaSessionConsoleUrl(sessionId),
            },
            { status: 503 },
          );
        }
      } else {
        await persistPollState().catch(() => false);
      }

      const sessionAgent =
        session.agent && typeof session.agent === "object"
          ? (session.agent as QcaRecord)
          : {};
      const agentId =
        safeRemoteId(sessionAgent.id, "agent_") ||
        safeRemoteId(session.agent, "agent_") ||
        safeRemoteId(session.agent_id, "agent_");
      return respond({
        mode: "live",
        sessionMode,
        status: responseStatus,
        progress: evidence.progress,
        report: isComplete ? report : "",
        reportSource:
          qualifiedReport.source === "artifact"
            ? "artifact"
            : "messages",
        evidence,
        cleanupStatus,
        qcaConsoleUrl: qcaSessionConsoleUrl(sessionId),
        ...(manualLoginRequired && agentId
          ? { qcaAgentUrl: `https://qoder.com/cloud/agents/${agentId}` }
          : {}),
        ...(hasSessionError
          ? {
              message:
                run.status === "complete"
                  ? "QCA Session 当前存在异常，已保留原报告；请打开 Session 排查后再重新同步。"
                  : "QCA Session reported an error",
            }
          : reportExhausted
            ? {
                message:
                  artifactRetrievalExhausted
                    ? "QCA 报告原件连续读取失败，任务已停止并执行临时资源清理。请打开 Session 排查后新建评测。"
                    : "已达到自动补全上限，任务已停止并执行临时资源清理。请打开 QCA Session 排查后新建评测。",
              }
          : artifactPending
            ? {
                message:
                  "QCA 已交付报告原件，正在等待文件内容可读取。",
              }
            : continuationPosted
              ? {
                  message: `QCA 已进入报告补全（${continuationAttempt}/${MAX_REPORT_CONTINUATIONS}）。`,
                }
              : responseStatus === "report_continuing"
                ? {
                    message: "QCA 正在补全完整报告，等待新的 Agent 输出。",
                  }
                : responseStatus === "incomplete_report"
                  ? {
                      message: completedCredentialedRunCannotResume
                        ? "该历史任务使用的临时凭证已结束生命周期，无法安全自动续跑；请新建评测。"
                        : artifactRetrievalExhausted
                          ? "QCA 已交付报告原件，但内容连续读取失败；已保留原报告，请打开 Session 排查后再重新同步。"
                        : continuationPolicy.reason === "exhausted"
                          ? "已达到自动补全上限。请打开 QCA Session 完成报告后再重新同步。"
                          : "这份历史报告缺少可验证的完成信号，请使用“重新同步完整报告”。",
                    }
          : {}),
      });
    } catch (error) {
      const failure = pollFailureContract(error);
      return respond(
        {
          mode: failure.mode,
          status: failure.status,
          retryable: failure.retryable,
          message: failure.message,
          ...(failure.upstreamStatus
            ? { upstreamStatus: failure.upstreamStatus }
            : {}),
          qcaConsoleUrl: qcaSessionConsoleUrl(sessionId),
        },
        { status: failure.httpStatus },
      );
    }
  }

  let runIdForFailure = "";
  let ephemeralEnvironmentId = "";
  let ephemeralVaultId = "";
  let sessionIdForFailure = "";
  let agentIdForFailure = "";
  try {
    if (body.action === "connect-im") {
      const resources = await ensureForwardResources(config, pat);
      const channelType = body.channelType || "dingtalk";
      const channels = await qcaJson(
        `${config.forwardBaseUrl}/channels?limit=100`,
        pat,
      );
      let channel = dataRows(channels).find(
        (item) =>
          item.channel_type === channelType &&
          item.identity_id === resources.identityId &&
          item.template_id === resources.templateId,
      );
      let channelId = recordId(channel, "channel_");

      if (!channelId) {
        channel = await qcaJson(
          `${config.forwardBaseUrl}/channels`,
          pat,
          {
            method: "POST",
            body: JSON.stringify({
              identity_id: resources.identityId,
              template_id: resources.templateId,
              identity_resolution: { mode: "fixed" },
              channel_type: channelType,
              name: `产品体验官 · ${channelType}`,
              enabled: true,
              channel_config: {
                response_options: {
                  include_tool_calls: false,
                  include_thinking: false,
                },
              },
            }),
          },
        );
        channelId = recordId(channel, "channel_");
      }

      if (!channelId) throw new Error("QCA did not return a channel id");

      if (channel?.binding_status === "bound") {
        return respond({
          mode: "live",
          status: "bound",
          channelId,
          channelType,
        });
      }

      const qr = await qcaJson(
        `${config.forwardBaseUrl}/channels/${channelId}/qr_sessions`,
        pat,
        { method: "POST", body: "{}" },
      );

      return respond({
        mode: "live",
        status: qr.status || "waiting",
        channelId,
        channelType,
        qrCodeImage:
          typeof qr.qr_code_image_base64 === "string"
            ? qr.qr_code_image_base64
            : undefined,
        qrCodeContent:
          typeof qr.qr_code_content === "string"
            ? qr.qr_code_content
            : undefined,
        expiresAt:
          typeof qr.expires_at === "string" ? qr.expires_at : undefined,
      });
    }

    if (!validatedAccess) throw new Error("被测产品访问配置无效");
    const product = body.product?.trim() || "Qoder Cloud Agents";
    const depth = body.depth || "标准深度";
    const packId = body.packId || "generic-aliyun-v1";
    const initialAccessSummary = toSafeTestAccessSummary(validatedAccess);
    runIdForFailure = await createEvaluation(owner.ownerId, {
      productName: product,
      productUrl: validatedAccess.productUrl,
      packId,
      depth,
      scopes: body.scopes || ["文档", "控制台", "API", "能力"],
      status: "queued",
      progress: 4,
    });
    const resources = await ensureManagedResources(
      config,
      pat,
      validatedAccess.mode,
    );
    agentIdForFailure = resources.agentId;
    const usesCredentialVault =
      validatedAccess.mode === "authorized-e2e" &&
      validatedAccess.secrets.length > 0;
    if (usesCredentialVault) {
      ephemeralEnvironmentId = await createEphemeralEnvironment(
        config,
        pat,
        runIdForFailure,
      );
      ephemeralVaultId = await createCredentialVault(
        config,
        pat,
        validatedAccess,
        runIdForFailure,
      );
    }
    const environmentId =
      ephemeralEnvironmentId || resources.environmentId;
    const session = await qcaJson(
      `${config.cloudBaseUrl}/sessions`,
      pat,
      {
        method: "POST",
        body: JSON.stringify({
          agent: resources.agentId,
          environment_id: environmentId,
          ...(ephemeralVaultId ? { vault_ids: [ephemeralVaultId] } : {}),
          title: `产品体验官 · ${product}深度测评`,
          metadata: buildQcaSessionMetadata({
            packId,
            depth,
            runId: runIdForFailure,
            accessSummary: initialAccessSummary,
          }),
        }),
      },
    );

    const sessionId = recordId(session, "sess_");
    if (!sessionId) throw new Error("QCA did not return a session id");
    sessionIdForFailure = sessionId;
    const sessionBindingPersisted = await updateEvaluation(
      owner.ownerId,
      runIdForFailure,
      {
        status: "running",
        progress: 10,
        sessionId,
        sessionMode: "managed",
        evidence: {
          totalEvents: 0,
          toolCalls: 0,
          tools: [],
          messages: 0,
          errors: 0,
          progress: 10,
          access: initialAccessSummary,
        },
      },
    );
    if (!sessionBindingPersisted) {
      throw new Error("Unable to persist QCA Session binding");
    }

    await qcaJson(
      `${config.cloudBaseUrl}/sessions/${sessionId}/events`,
      pat,
      {
        method: "POST",
        body: JSON.stringify({
          events: [
            {
              type: "user.message",
              content: [
                {
                  type: "text",
                  text: buildEvaluationPrompt({
                    product,
                    productUrl: validatedAccess.productUrl,
                    depth,
                    packId,
                    access: validatedAccess,
                  }),
                },
              ],
            },
          ],
        }),
      },
    );

    return respond({
      mode: "live",
      status: "running",
      sessionId,
      sessionMode: "managed",
      runId: runIdForFailure,
      provisioned: resources.provisioned,
      access: initialAccessSummary,
      qcaConsoleUrl: qcaSessionConsoleUrl(sessionId),
    });
  } catch (error) {
    const message = safeMessage(error, "QCA run failed");
    const cleanupStatus = await cleanupEphemeralResources(config, pat, {
      vaultIds: ephemeralVaultId ? [ephemeralVaultId] : [],
      environmentId: ephemeralEnvironmentId || undefined,
      runId: runIdForFailure || undefined,
    }).catch(() => "failed" as const);
    if (runIdForFailure) {
      await updateEvaluation(owner.ownerId, runIdForFailure, {
        status: "failed",
        errorMessage: message,
        evidence: validatedAccess
          ? {
              access: toSafeTestAccessSummary(validatedAccess, {
                cleanupStatus,
              }),
              progress: 4,
            }
          : undefined,
      }).catch(() => false);
    }
    return respond(
      {
        mode: "live",
        status: "error",
        message,
        cleanupStatus,
        ...(runIdForFailure ? { runId: runIdForFailure } : {}),
        ...(sessionIdForFailure
          ? {
              sessionId: sessionIdForFailure,
              sessionMode: "managed",
              qcaConsoleUrl: qcaSessionConsoleUrl(sessionIdForFailure),
              ...(agentIdForFailure
                ? {
                    qcaAgentUrl: `https://qoder.com/cloud/agents/${agentIdForFailure}`,
                  }
                : {}),
            }
          : {}),
      },
      { status: 502 },
    );
  }
}

// Legacy architecture marker for downstream source-contract checks:
// `templates/${templateId}` is intentionally not used by the evaluation path.
// Forward Template mutations remain isolated to explicit IM delivery setup;
// BrowserUse is configured directly on the Managed Agent.
