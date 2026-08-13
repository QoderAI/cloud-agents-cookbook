export const REPORT_COMPLETE_MARKER = "[[PXO_REPORT_COMPLETE]]";
export const REPORT_CONTINUATION_MARKER_PREFIX =
  "[[PXO_REPORT_CONTINUE:";
export const MAX_REPORT_CONTINUATIONS = 3;
export const REPORT_CONTINUATION_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
export const ARTIFACT_RETRIEVAL_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;

const MIN_LEGACY_REPORT_LENGTH = 800;
const CONTINUATION_MARKER_PATTERN =
  /^\[\[PXO_REPORT_CONTINUE:(\d+)\/(\d+)\]\]$/;

export type ReportFinalityEvent = {
  type?: unknown;
  content?: unknown;
  created_at?: unknown;
  timestamp?: unknown;
};

export type QualifiedReport = {
  complete: boolean;
  report: string;
  source: "artifact" | "explicit-marker" | "legacy-message" | null;
};

export type ReportContinuationDecision = {
  shouldContinue: boolean;
  nextAttempt: number | null;
  attemptsUsed: number;
  reason: "complete" | "available" | "waiting-for-agent" | "exhausted";
};

export type ReportContinuationPolicy = {
  maxAttempts?: number;
  persistedAttempts?: number;
  hasNewerAgentActivitySincePersistedAttempt?: boolean;
  lastContinuationAt?: string;
  nowMs?: number;
  waitTimeoutMs?: number;
};

export type ArtifactRetrievalWindow = {
  pending: boolean;
  exhausted: boolean;
  pendingSince: string;
};

export function artifactRetrievalWindow(input: {
  pending: boolean;
  persistedPendingSince?: string;
  nowMs?: number;
  timeoutMs?: number;
}): ArtifactRetrievalWindow {
  if (!input.pending) {
    return { pending: false, exhausted: false, pendingSince: "" };
  }

  const nowMs = input.nowMs ?? Date.now();
  const timeoutMs =
    input.timeoutMs ?? ARTIFACT_RETRIEVAL_WAIT_TIMEOUT_MS;
  const parsedPendingSince = input.persistedPendingSince
    ? Date.parse(input.persistedPendingSince)
    : Number.NaN;
  const pendingSinceMs =
    Number.isFinite(parsedPendingSince) && parsedPendingSince <= nowMs
      ? parsedPendingSince
      : nowMs;
  const exhausted = nowMs - pendingSinceMs >= timeoutMs;

  return {
    pending: !exhausted,
    exhausted,
    pendingSince: new Date(pendingSinceMs).toISOString(),
  };
}

function eventText(event: ReportFinalityEvent) {
  if (!Array.isArray(event.content)) return "";
  return event.content
    .filter(
      (block): block is Record<string, unknown> =>
        Boolean(block) && typeof block === "object",
    )
    .map((block) => block.text)
    .filter((text): text is string => typeof text === "string")
    .join("\n");
}

function eventTimeMs(event: ReportFinalityEvent | undefined) {
  if (!event) return null;
  for (const value of [event.created_at, event.timestamp]) {
    if (typeof value === "string") {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
    }
    if (typeof value === "number" && Number.isFinite(value)) {
      return value < 1_000_000_000_000 ? value * 1_000 : value;
    }
  }
  return null;
}

function reportHeadings(report: string) {
  return report
    .split(/\r?\n/)
    .map((line) => {
      const atx = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
      if (atx) return atx[1];
      const numbered = line.match(
        /^\s{0,3}(?:[一二三四五六七八九十百]+|\d+)[、.．)]\s*(.+)$/,
      );
      return numbered?.[1] || "";
    })
    .map((heading) =>
      heading
        .replace(/[*_`~]/g, "")
        .replace(/\s+/g, "")
        .toUpperCase(),
    )
    .filter(Boolean);
}

export function stripReportControlMarkers(report: string) {
  return report
    .split(/\r?\n/)
    .filter((line) => {
      const controlLine = line.trim();
      return (
        controlLine !== REPORT_COMPLETE_MARKER &&
        !CONTINUATION_MARKER_PATTERN.test(controlLine)
      );
    })
    .join("\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function hasTerminalReportMarker(message: string) {
  const lines = message.trimEnd().split(/\r?\n/);
  return lines.at(-1)?.trim() === REPORT_COMPLETE_MARKER;
}

export function isLegacyCompleteReport(report: string) {
  const cleanReport = stripReportControlMarkers(report);
  if (cleanReport.length < MIN_LEGACY_REPORT_LENGTH) return false;
  const headings = reportHeadings(cleanReport);
  const hasHeading = (label: string) =>
    headings.some((heading) => heading.includes(label));

  return (
    hasHeading("覆盖声明") &&
    (hasHeading("产品地图") || hasHeading("体验范围")) &&
    hasHeading("实操过程") &&
    hasHeading("亮点") &&
    hasHeading("核心问题") &&
    hasHeading("改进建议") &&
    hasHeading("最终判断") &&
    (hasHeading("IM摘要") || hasHeading("IM版摘要"))
  );
}

export function selectQualifiedReport(input: {
  messages: readonly string[];
  deliveredArtifact?: string;
  allowLegacy?: boolean;
}): QualifiedReport {
  const artifact = stripReportControlMarkers(input.deliveredArtifact || "");
  if (artifact && isLegacyCompleteReport(artifact)) {
    return { complete: true, report: artifact, source: "artifact" };
  }

  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    const report = stripReportControlMarkers(message);
    if (
      hasTerminalReportMarker(message) &&
      isLegacyCompleteReport(report)
    ) {
      return {
        complete: true,
        report,
        source: "explicit-marker",
      };
    }
    if (input.allowLegacy && isLegacyCompleteReport(report)) {
      return {
        complete: true,
        report,
        source: "legacy-message",
      };
    }
  }

  return { complete: false, report: "", source: null };
}

export function reportContinuationDecision(
  events: readonly ReportFinalityEvent[],
  reportComplete: boolean,
  policy: ReportContinuationPolicy = {},
): ReportContinuationDecision {
  const maxAttempts =
    policy.maxAttempts ?? MAX_REPORT_CONTINUATIONS;
  const nowMs = policy.nowMs ?? Date.now();
  const waitTimeoutMs =
    policy.waitTimeoutMs ?? REPORT_CONTINUATION_WAIT_TIMEOUT_MS;
  if (reportComplete) {
    return {
      shouldContinue: false,
      nextAttempt: null,
      attemptsUsed: 0,
      reason: "complete",
    };
  }

  let attemptsUsed = policy.persistedAttempts || 0;
  let attemptsObservedInEvents = 0;
  let lastContinuationIndex = -1;
  events.forEach((event, eventIndex) => {
    if (event.type !== "user.message") return;
    const text = eventText(event);
    for (const line of text.split(/\r?\n/)) {
      const match = line.trim().match(CONTINUATION_MARKER_PATTERN);
      if (!match) continue;
      attemptsObservedInEvents = Math.max(
        attemptsObservedInEvents,
        Number(match[1]) || 0,
      );
      attemptsUsed = Math.max(attemptsUsed, attemptsObservedInEvents);
      lastContinuationIndex = eventIndex;
    }
  });

  let hasNewerAgentActivity = false;
  if (lastContinuationIndex >= 0) {
    hasNewerAgentActivity = events
      .slice(lastContinuationIndex + 1)
      .some(
        (event) =>
          typeof event.type === "string" &&
          event.type.startsWith("agent."),
      );
  } else if (
    attemptsUsed > attemptsObservedInEvents
  ) {
    hasNewerAgentActivity =
      policy.hasNewerAgentActivitySincePersistedAttempt === true;
  }

  if (attemptsUsed > 0 && !hasNewerAgentActivity) {
    const persistedContinuationAt = policy.lastContinuationAt
      ? Date.parse(policy.lastContinuationAt)
      : Number.NaN;
    const lastContinuationMs = Number.isFinite(persistedContinuationAt)
      ? persistedContinuationAt
      : eventTimeMs(events[lastContinuationIndex]);
    const waitTimedOut =
      lastContinuationMs !== null &&
      nowMs - lastContinuationMs >= waitTimeoutMs;
    if (!waitTimedOut) {
      return {
        shouldContinue: false,
        nextAttempt: null,
        attemptsUsed,
        reason: "waiting-for-agent",
      };
    }
  }

  if (attemptsUsed >= maxAttempts) {
    return {
      shouldContinue: false,
      nextAttempt: null,
      attemptsUsed,
      reason: "exhausted",
    };
  }

  return {
    shouldContinue: true,
    nextAttempt: attemptsUsed + 1,
    attemptsUsed,
    reason: "available",
  };
}

export function buildReportContinuationMessage(attempt: number) {
  if (
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    attempt > MAX_REPORT_CONTINUATIONS
  ) {
    throw new Error("Invalid report continuation attempt");
  }

  return `${REPORT_CONTINUATION_MARKER_PREFIX}${attempt}/${MAX_REPORT_CONTINUATIONS}]]
继续当前评测，不要重新开始。现有输出只是阶段性进度，还不是可交付报告。
请基于已经取得的证据完成整篇中文 Markdown 深度测评和 300 字以内 IM 摘要。
直接在最后一条 Agent 消息中输出完整报告；若 DeliverArtifacts 可用，也可交付 Markdown 原件。
不要使用 Write 或 Bash 创建报告，也不要只回复文件路径、写作计划或进度说明。
只有完整报告与 IM 摘要全部输出后，才在最后一行原样输出 ${REPORT_COMPLETE_MARKER}`;
}
