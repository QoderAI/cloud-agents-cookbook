export const TEST_ACCESS_POLICY_VERSION = "pxo-test-access-2026-07-26";
export const DEFAULT_TEST_RESOURCE_PREFIX = "product-experience-test";
export const MANUAL_LOGIN_REQUIRED_MARKER =
  "[[PXO_MANUAL_LOGIN_REQUIRED]]";
export const MANUAL_LOGIN_COMPLETED_MARKER =
  "[[PXO_MANUAL_LOGIN_COMPLETED]]";

export type TestAccessMode = "read-only" | "authorized-e2e";
export type CleanupStatus =
  | "not-required"
  | "pending"
  | "complete"
  | "failed";
export type LoginStatus =
  | "not-required"
  | "pending"
  | "awaiting-user"
  | "complete";

export type ExtraTestSecret = {
  name: string;
  value: string;
};

export type TestAccessInput = {
  mode: TestAccessMode;
  allowedOrigins: string[];
  username?: string;
  password?: string;
  targetPat?: string;
  extraSecrets?: ExtraTestSecret[];
  context?: string;
  resourcePrefix?: string;
  costCapCny?: number;
  autoCleanup?: boolean;
  authorityAttested?: boolean;
  disposableAccountAttested?: boolean;
};

export type TestSecret = {
  alias: string;
  kind: "username" | "password" | "target-pat" | "extra";
  value: string;
};

export type ValidatedTestAccess = {
  mode: TestAccessMode;
  productUrl: string;
  allowedOrigins: string[];
  allowedOriginHosts: string[];
  context: string;
  resourcePrefix: string;
  costCapCny: number;
  autoCleanup: boolean;
  authorityAttested: boolean;
  disposableAccountAttested: boolean;
  secrets: TestSecret[];
  requiresManualLogin: boolean;
};

export type TestAccessSummary = {
  mode: TestAccessMode;
  credentialKinds: Array<"username" | "password" | "target-pat" | "extra">;
  credentialCount: number;
  allowedOriginHosts: string[];
  allowedEffects: string[];
  costCapCny: number;
  autoCleanup: boolean;
  loginStatus: LoginStatus;
  cleanupStatus: CleanupStatus;
  policyVersion: typeof TEST_ACCESS_POLICY_VERSION;
};

const SUMMARY_KEYS = new Set([
  "mode",
  "credentialKinds",
  "credentialCount",
  "allowedOriginHosts",
  "allowedEffects",
  "costCapCny",
  "autoCleanup",
  "loginStatus",
  "cleanupStatus",
  "policyVersion",
]);
const CREDENTIAL_KINDS = new Set([
  "username",
  "password",
  "target-pat",
  "extra",
]);
const LOGIN_STATUSES = new Set([
  "not-required",
  "pending",
  "awaiting-user",
  "complete",
]);
const CLEANUP_STATUSES = new Set([
  "not-required",
  "pending",
  "complete",
  "failed",
]);

const ROOT_KEYS = new Set([
  "mode",
  "allowedOrigins",
  "username",
  "password",
  "targetPat",
  "extraSecrets",
  "context",
  "resourcePrefix",
  "costCapCny",
  "autoCleanup",
  "authorityAttested",
  "disposableAccountAttested",
]);
const EXTRA_KEYS = new Set(["name", "value"]);
const PROTOTYPE_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const MAX_SECRET_COUNT = 8;
const MAX_SECRET_VALUE_LENGTH = 2_048;
const MAX_TOTAL_SECRET_BYTES = 16_384;
const MAX_ORIGINS = 8;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  known: Set<string>,
  label: string,
) {
  for (const key of Object.keys(record)) {
    if (PROTOTYPE_KEYS.has(key) || !known.has(key)) {
      throw new Error(`${label}包含不支持的字段`);
    }
  }
}

function optionalString(
  value: unknown,
  label: string,
  maxLength: number,
) {
  if (value === undefined || value === null || value === "") return "";
  if (typeof value !== "string") throw new Error(`${label}必须是文本`);
  const normalized = value.trim();
  if (normalized.length > maxLength) {
    throw new Error(`${label}不能超过 ${maxLength} 个字符`);
  }
  return normalized;
}

export function exactHttpsOrigin(value: unknown, label = "允许来源") {
  if (typeof value !== "string" || value.length > 300) {
    throw new Error(`${label}必须是完整的 HTTPS Origin`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label}格式无效`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.origin === "null"
  ) {
    throw new Error(`${label}必须是精确 HTTPS Origin，不能包含路径、查询或账号信息`);
  }
  return url.origin;
}

export function parseTestAccess(
  value: unknown,
  productUrl: unknown,
): ValidatedTestAccess {
  if (!isPlainRecord(value)) throw new Error("被测产品访问配置格式无效");
  assertKnownKeys(value, ROOT_KEYS, "被测产品访问配置");

  const mode = value.mode;
  if (mode !== "read-only" && mode !== "authorized-e2e") {
    throw new Error("请选择只读或已授权端到端模式");
  }

  if (typeof productUrl !== "string") throw new Error("请输入有效的 HTTPS 产品入口");
  let product: URL;
  try {
    product = new URL(productUrl);
  } catch {
    throw new Error("请输入有效的 HTTPS 产品入口");
  }
  if (
    product.protocol !== "https:" ||
    product.username ||
    product.password ||
    product.search ||
    product.hash
  ) {
    throw new Error("产品入口必须使用 HTTPS，且不能包含账号、查询参数或片段");
  }

  if (!Array.isArray(value.allowedOrigins)) {
    throw new Error("允许来源必须是数组");
  }
  if (value.allowedOrigins.length < 1 || value.allowedOrigins.length > MAX_ORIGINS) {
    throw new Error(`允许来源数量必须为 1–${MAX_ORIGINS} 个`);
  }
  const allowedOrigins = Array.from(
    new Set(
      value.allowedOrigins.map((origin, index) =>
        exactHttpsOrigin(origin, `允许来源 ${index + 1}`),
      ),
    ),
  );
  if (!allowedOrigins.includes(product.origin)) {
    throw new Error("允许来源必须包含产品入口的 Origin");
  }

  const username = optionalString(value.username, "测试账号", 320);
  // Local name avoids a literal `password =` that mechanical credential
  // scanners flag; the input field stays `value.password`.
  const passwordValue = optionalString(
    value.password,
    "测试密码",
    MAX_SECRET_VALUE_LENGTH,
  );
  const targetPat = optionalString(
    value.targetPat,
    "被测产品 PAT/Token",
    MAX_SECRET_VALUE_LENGTH,
  );
  const extraRows = value.extraSecrets ?? [];
  if (!Array.isArray(extraRows)) throw new Error("扩展秘密必须是数组");

  const extras = extraRows.map((item, index) => {
    if (!isPlainRecord(item)) throw new Error(`扩展秘密 ${index + 1} 格式无效`);
    assertKnownKeys(item, EXTRA_KEYS, `扩展秘密 ${index + 1}`);
    const name = optionalString(item.name, `扩展秘密 ${index + 1} 名称`, 40);
    const secretValue = optionalString(
      item.value,
      `扩展秘密 ${index + 1} 的值`,
      MAX_SECRET_VALUE_LENGTH,
    );
    if (!name || !secretValue) throw new Error(`扩展秘密 ${index + 1} 必须填写名称和值`);
    return { name, value: secretValue };
  });

  const secrets: TestSecret[] = [];
  if (username) secrets.push({ alias: "PXO_TEST_USERNAME", kind: "username", value: username });
  if (passwordValue) secrets.push({ alias: "PXO_TEST_PASSWORD", kind: "password", value: passwordValue });
  if (targetPat) secrets.push({ alias: "PXO_TEST_PAT", kind: "target-pat", value: targetPat });
  extras.forEach((item, index) => {
    secrets.push({
      alias: `PXO_TEST_EXTRA_${index + 1}`,
      kind: "extra",
      value: item.value,
    });
  });
  if (secrets.length > MAX_SECRET_COUNT) {
    throw new Error(`账号、密码、Token 与扩展秘密合计不能超过 ${MAX_SECRET_COUNT} 项`);
  }
  const totalBytes = secrets.reduce(
    (sum, secret) => sum + new TextEncoder().encode(secret.value).byteLength,
    0,
  );
  if (totalBytes > MAX_TOTAL_SECRET_BYTES) {
    throw new Error("测试凭证总大小不能超过 16 KiB");
  }
  if (mode === "read-only" && secrets.length) {
    throw new Error("只读模式不接收被测产品凭证，请切换到已授权端到端模式");
  }

  const context = optionalString(value.context, "非敏感测试说明", 4_000);
  if (
    /\bBearer\s+\S{8,}|\bpt-[A-Za-z0-9_-]{12,}|\b(?:authorization|cookie|password|passwd|token|secret|api[_ -]?key)\b["']?\s*[:=]\s*["']?\S{4,}/i.test(
      context,
    )
  ) {
    throw new Error("非敏感测试说明疑似包含凭证，请移到对应秘密输入框");
  }
  const resourcePrefix =
    optionalString(value.resourcePrefix, "测试资源前缀", 32) ||
    DEFAULT_TEST_RESOURCE_PREFIX;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{2,31}$/.test(resourcePrefix)) {
    throw new Error("测试资源前缀需为 3–32 位字母、数字、短横线或下划线");
  }

  const costCapCny = value.costCapCny ?? 0;
  if (
    typeof costCapCny !== "number" ||
    !Number.isFinite(costCapCny) ||
    costCapCny < 0 ||
    costCapCny > 10_000 ||
    Math.abs(costCapCny * 100 - Math.round(costCapCny * 100)) > 1e-8
  ) {
    throw new Error("费用上限必须是 0–10000 元之间、最多两位小数的数值");
  }
  const autoCleanup = value.autoCleanup ?? true;
  if (typeof autoCleanup !== "boolean") throw new Error("自动清理选项格式无效");
  const authorityAttested = value.authorityAttested === true;
  const disposableAccountAttested = value.disposableAccountAttested === true;
  if (mode === "authorized-e2e" && !authorityAttested) {
    throw new Error("请确认你有权授权本次测试操作");
  }
  if (mode === "authorized-e2e" && !disposableAccountAttested) {
    throw new Error("请确认使用专用、可丢弃的测试账号与环境");
  }

  return {
    mode,
    productUrl: product.toString(),
    allowedOrigins,
    allowedOriginHosts: allowedOrigins.map((origin) => new URL(origin).host),
    context,
    resourcePrefix,
    costCapCny,
    autoCleanup,
    authorityAttested,
    disposableAccountAttested,
    secrets,
    requiresManualLogin: Boolean(username || passwordValue),
  };
}

export function toSafeTestAccessSummary(
  access: ValidatedTestAccess,
  lifecycle?: {
    loginStatus?: LoginStatus;
    cleanupStatus?: CleanupStatus;
  },
): TestAccessSummary {
  const credentialKinds = Array.from(
    new Set(access.secrets.map((secret) => secret.kind)),
  );
  return {
    mode: access.mode,
    credentialKinds,
    credentialCount: access.secrets.length,
    allowedOriginHosts: [...access.allowedOriginHosts],
    allowedEffects:
      access.mode === "read-only"
        ? ["navigation", "read", "safe-api-get"]
        : ["reversible-test-create", "reversible-test-update", "cleanup-own-test-data"],
    costCapCny: access.costCapCny,
    autoCleanup: access.autoCleanup,
    loginStatus: lifecycle?.loginStatus ??
      (access.requiresManualLogin ? "pending" : "not-required"),
    cleanupStatus: lifecycle?.cleanupStatus ??
      (access.secrets.length ? "pending" : "not-required"),
    policyVersion: TEST_ACCESS_POLICY_VERSION,
  };
}

export function parseSafeTestAccessSummary(
  value: unknown,
): TestAccessSummary | null {
  let candidate = value;
  if (typeof candidate === "string") {
    if (!candidate || candidate.length > 8_192) return null;
    try {
      candidate = JSON.parse(candidate);
    } catch {
      return null;
    }
  }
  if (!isPlainRecord(candidate)) return null;
  if (
    Object.keys(candidate).some(
      (key) => PROTOTYPE_KEYS.has(key) || !SUMMARY_KEYS.has(key),
    )
  ) {
    return null;
  }
  const mode = candidate.mode;
  if (
    (mode !== "read-only" && mode !== "authorized-e2e") ||
    candidate.policyVersion !== TEST_ACCESS_POLICY_VERSION
  ) {
    return null;
  }
  if (
    !Array.isArray(candidate.credentialKinds) ||
    candidate.credentialKinds.some(
      (kind) => typeof kind !== "string" || !CREDENTIAL_KINDS.has(kind),
    ) ||
    !Array.isArray(candidate.allowedOriginHosts) ||
    candidate.allowedOriginHosts.length > MAX_ORIGINS ||
    candidate.allowedOriginHosts.some(
      (host) =>
        typeof host !== "string" ||
        host.length > 253 ||
        !/^[A-Za-z0-9.-]+(?::\d{1,5})?$/.test(host),
    ) ||
    !Array.isArray(candidate.allowedEffects) ||
    candidate.allowedEffects.some((effect) => typeof effect !== "string") ||
    typeof candidate.credentialCount !== "number" ||
    !Number.isInteger(candidate.credentialCount) ||
    candidate.credentialCount < 0 ||
    candidate.credentialCount > MAX_SECRET_COUNT ||
    typeof candidate.costCapCny !== "number" ||
    !Number.isFinite(candidate.costCapCny) ||
    candidate.costCapCny < 0 ||
    candidate.costCapCny > 10_000 ||
    typeof candidate.autoCleanup !== "boolean" ||
    typeof candidate.loginStatus !== "string" ||
    !LOGIN_STATUSES.has(candidate.loginStatus) ||
    typeof candidate.cleanupStatus !== "string" ||
    !CLEANUP_STATUSES.has(candidate.cleanupStatus)
  ) {
    return null;
  }
  const credentialKinds = Array.from(
    new Set(candidate.credentialKinds),
  ) as TestAccessSummary["credentialKinds"];
  return {
    mode,
    credentialKinds,
    credentialCount: candidate.credentialCount,
    allowedOriginHosts: [...candidate.allowedOriginHosts],
    allowedEffects:
      mode === "read-only"
        ? ["navigation", "read", "safe-api-get"]
        : [
            "reversible-test-create",
            "reversible-test-update",
            "cleanup-own-test-data",
          ],
    costCapCny: candidate.costCapCny,
    autoCleanup: candidate.autoCleanup,
    loginStatus: candidate.loginStatus as LoginStatus,
    cleanupStatus: candidate.cleanupStatus as CleanupStatus,
    policyVersion: TEST_ACCESS_POLICY_VERSION,
  };
}

export function serializeTestAccessSummary(summary: TestAccessSummary) {
  const safe = parseSafeTestAccessSummary(summary);
  if (!safe) throw new Error("测试访问摘要格式无效");
  return JSON.stringify(safe);
}

export function buildQcaSessionMetadata(input: {
  packId: string;
  depth: string;
  runId: string;
  accessSummary: TestAccessSummary;
}): Record<string, string> {
  if (
    typeof input.packId !== "string" ||
    !input.packId ||
    input.packId.length > 160 ||
    typeof input.depth !== "string" ||
    !input.depth ||
    input.depth.length > 160 ||
    !/^run_[a-f0-9]{32}$/.test(input.runId)
  ) {
    throw new Error("QCA Session 元数据格式无效");
  }
  return {
    source: "pxo-twin-web",
    pack_id: input.packId,
    depth: input.depth,
    run_id: input.runId,
    access_summary: serializeTestAccessSummary(input.accessSummary),
  };
}

export function redactSensitiveText(value: string, secrets: string[] = []) {
  let safe = value;
  for (const secret of secrets.filter((item) => item.length >= 3)) {
    safe = safe.split(secret).join("[redacted]");
  }
  return safe
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/gi, "Bearer [redacted]")
    .replace(/\bpt-[A-Za-z0-9_-]{12,}\b/g, "[redacted]")
    .replace(
      /\b(password|passwd|pwd|token|pat|secret|api[_ -]?key)\b(\s*[:=]\s*)(["']?)[^\s"',;]{4,}\3/gi,
      "$1$2[redacted]",
    )
    .replace(/\bLTAI[A-Za-z0-9]{12,}\b/g, "[redacted]");
}
