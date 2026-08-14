import { getSupabaseAdmin } from "@/db/supabase-admin";

export type EvaluationStatus =
  | "queued"
  | "running"
  | "complete"
  | "failed";

export type EvaluationRecord = {
  id: string;
  owner_id: string;
  product_name: string;
  product_url: string;
  pack_id: string;
  depth: string;
  scopes_json: string;
  status: EvaluationStatus;
  progress: number;
  session_id: string | null;
  session_mode: string | null;
  report: string;
  report_source: string;
  evidence_json: string;
  error_message: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
};

export type EvaluationPatch = {
  status?: EvaluationStatus;
  progress?: number;
  sessionId?: string;
  sessionMode?: string;
  report?: string;
  reportSource?: string;
  evidence?: Record<string, unknown>;
  errorMessage?: string;
};

const CREATE_EVALUATIONS = `CREATE TABLE IF NOT EXISTS evaluations (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL DEFAULT '',
  product_name TEXT NOT NULL,
  product_url TEXT NOT NULL DEFAULT '',
  pack_id TEXT NOT NULL,
  depth TEXT NOT NULL,
  scopes_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  progress INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  session_mode TEXT,
  report TEXT NOT NULL DEFAULT '',
  report_source TEXT NOT NULL DEFAULT '',
  evidence_json TEXT NOT NULL DEFAULT '{}',
  error_message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
)`;

const ADD_OWNER_ID =
  "ALTER TABLE evaluations ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''";
const CREATE_OWNER_CREATED_INDEX =
  "CREATE INDEX IF NOT EXISTS evaluations_owner_created_at_idx ON evaluations(owner_id, created_at DESC)";
const CREATE_OWNER_STATUS_INDEX =
  "CREATE INDEX IF NOT EXISTS evaluations_owner_status_idx ON evaluations(owner_id, status)";
const DROP_UNSCOPED_CREATED_INDEX =
  "DROP INDEX IF EXISTS evaluations_created_at_idx";
const DROP_UNSCOPED_STATUS_INDEX =
  "DROP INDEX IF EXISTS evaluations_status_idx";

const isMeooImageRuntime = process.env.MEOO_RUNTIME === "image";
let schemaPromise: Promise<void> | null = null;

async function binding() {
  const { env } = await import("cloudflare:workers");
  if (!env.DB) throw new Error("D1 binding DB is unavailable");
  return env.DB;
}

async function initializeD1Schema() {
  const db = await binding();
  await db.prepare(CREATE_EVALUATIONS).run();
  const columns = await db
    .prepare("PRAGMA table_info(evaluations)")
    .all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "owner_id")) {
    await db.prepare(ADD_OWNER_ID).run();
  }
  await db.batch([
    db.prepare(DROP_UNSCOPED_CREATED_INDEX),
    db.prepare(DROP_UNSCOPED_STATUS_INDEX),
    db.prepare(CREATE_OWNER_CREATED_INDEX),
    db.prepare(CREATE_OWNER_STATUS_INDEX),
  ]);
}

export async function ensureEvaluationsSchema() {
  if (isMeooImageRuntime) return;
  if (!schemaPromise) {
    schemaPromise = initializeD1Schema().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
}

function supabaseFailure(operation: string, message: string) {
  return new Error(`Unable to ${operation} evaluation history: ${message}`);
}

type EvaluationUpdateValues = Partial<
  Pick<
    EvaluationRecord,
    | "status"
    | "progress"
    | "session_id"
    | "session_mode"
    | "report"
    | "report_source"
    | "evidence_json"
    | "error_message"
    | "updated_at"
    | "completed_at"
  >
>;

export type EvaluationUpdateAttempt = {
  values: EvaluationUpdateValues;
  allowedCurrentStatuses?: readonly EvaluationStatus[];
};

const ALL_EVALUATION_STATUSES = [
  "queued",
  "running",
  "complete",
  "failed",
] as const;
const NONTERMINAL_EVALUATION_STATUSES = ["queued", "running"] as const;

function evaluationUpdateValues(
  patch: EvaluationPatch,
  now: string,
  setCompletedAt: boolean,
) {
  const values: EvaluationUpdateValues = { updated_at: now };
  if (patch.status !== undefined) values.status = patch.status;
  if (patch.progress !== undefined) values.progress = patch.progress;
  if (patch.sessionId !== undefined) values.session_id = patch.sessionId;
  if (patch.sessionMode !== undefined) {
    values.session_mode = patch.sessionMode;
  }
  if (patch.report !== undefined) values.report = patch.report;
  if (patch.reportSource !== undefined) {
    values.report_source = patch.reportSource;
  }
  if (patch.evidence !== undefined) {
    values.evidence_json = JSON.stringify(patch.evidence);
  }
  if (patch.errorMessage !== undefined) {
    values.error_message = patch.errorMessage;
  }
  if (patch.status === "complete" && setCompletedAt) {
    values.completed_at = now;
  }
  return values;
}

export function buildEvaluationUpdatePlan(
  patch: EvaluationPatch,
  now: string,
): EvaluationUpdateAttempt[] {
  // queued → running → complete|failed. Terminal rows are absorbing, while
  // a same-terminal retry remains legal so callers can finish persisting data.
  if (patch.status === undefined) {
    return [
      {
        values: evaluationUpdateValues(patch, now, false),
        allowedCurrentStatuses: ALL_EVALUATION_STATUSES,
      },
    ];
  }
  if (patch.status === "queued") {
    return [
      {
        values: evaluationUpdateValues(patch, now, false),
        allowedCurrentStatuses: ["queued"],
      },
    ];
  }
  if (patch.status === "running") {
    return [
      {
        values: evaluationUpdateValues(patch, now, false),
        allowedCurrentStatuses: NONTERMINAL_EVALUATION_STATUSES,
      },
    ];
  }

  return [
    {
      values: evaluationUpdateValues(patch, now, true),
      allowedCurrentStatuses: NONTERMINAL_EVALUATION_STATUSES,
    },
    {
      values: evaluationUpdateValues(patch, now, false),
      allowedCurrentStatuses: [patch.status],
    },
  ];
}

export async function executeEvaluationUpdatePlan(
  plan: readonly EvaluationUpdateAttempt[],
  executeAttempt: (attempt: EvaluationUpdateAttempt) => Promise<boolean>,
) {
  for (const attempt of plan) {
    if (await executeAttempt(attempt)) return true;
  }
  return false;
}

export async function executeSupabaseEvaluationUpdateAttempt(
  client: ReturnType<typeof getSupabaseAdmin>,
  ownerId: string,
  id: string,
  attempt: EvaluationUpdateAttempt,
) {
  const query = client
    .from("evaluations")
    .update(attempt.values)
    .eq("owner_id", ownerId)
    .eq("id", id);
  const allowedStatuses = attempt.allowedCurrentStatuses;
  const filteredQuery =
    allowedStatuses?.length === 1
      ? query.eq("status", allowedStatuses[0])
      : allowedStatuses
        ? query.in("status", [...allowedStatuses])
        : query;
  const { data, error } = await filteredQuery.select("id").maybeSingle();
  if (error) throw supabaseFailure("update", error.message);
  return Boolean(data);
}

const D1_UPDATE_COLUMNS = [
  ["status", "status"],
  ["progress", "progress"],
  ["session_id", "session_id"],
  ["session_mode", "session_mode"],
  ["report", "report"],
  ["report_source", "report_source"],
  ["evidence_json", "evidence_json"],
  ["error_message", "error_message"],
  ["updated_at", "updated_at"],
  ["completed_at", "completed_at"],
] as const;

type D1UpdateBinding = string | number | null;

export function buildD1EvaluationUpdateStatement(
  ownerId: string,
  id: string,
  attempt: EvaluationUpdateAttempt,
) {
  const assignments: string[] = [];
  const bindings: D1UpdateBinding[] = [];
  for (const [key, column] of D1_UPDATE_COLUMNS) {
    if (!Object.prototype.hasOwnProperty.call(attempt.values, key)) continue;
    assignments.push(`${column} = ?`);
    bindings.push(attempt.values[key] ?? null);
  }
  let sql = `UPDATE evaluations SET ${assignments.join(", ")}
    WHERE owner_id = ? AND id = ?`;
  bindings.push(ownerId, id);
  const allowedStatuses = attempt.allowedCurrentStatuses;
  if (allowedStatuses?.length) {
    sql += ` AND status IN (${allowedStatuses.map(() => "?").join(", ")})`;
    bindings.push(...allowedStatuses);
  }
  return { sql, bindings };
}

export async function executeD1EvaluationUpdateAttempt(
  db: Awaited<ReturnType<typeof binding>>,
  ownerId: string,
  id: string,
  attempt: EvaluationUpdateAttempt,
) {
  const statement = buildD1EvaluationUpdateStatement(
    ownerId,
    id,
    attempt,
  );
  const result = await db
    .prepare(statement.sql)
    .bind(...statement.bindings)
    .run();
  return Number(result.meta.changes || 0) > 0;
}

export async function createEvaluation(
  ownerId: string,
  input: {
    productName: string;
    productUrl?: string;
    packId: string;
    depth: string;
    scopes: string[];
    status?: EvaluationStatus;
    progress?: number;
    report?: string;
    reportSource?: string;
    evidence?: Record<string, unknown>;
  },
) {
  const now = new Date().toISOString();
  const id = `run_${crypto.randomUUID().replaceAll("-", "")}`;
  const record: EvaluationRecord = {
    id,
    owner_id: ownerId,
    product_name: input.productName,
    product_url: input.productUrl || "",
    pack_id: input.packId,
    depth: input.depth,
    scopes_json: JSON.stringify(input.scopes),
    status: input.status || "queued",
    progress: input.progress || 0,
    session_id: null,
    session_mode: null,
    report: input.report || "",
    report_source: input.reportSource || "",
    evidence_json: JSON.stringify(input.evidence || {}),
    error_message: "",
    created_at: now,
    updated_at: now,
    completed_at: input.status === "complete" ? now : null,
  };

  if (isMeooImageRuntime) {
    const { error } = await getSupabaseAdmin()
      .from("evaluations")
      .insert(record);
    if (error) throw supabaseFailure("create", error.message);
    return id;
  }

  await ensureEvaluationsSchema();
  const db = await binding();
  await db
    .prepare(
      `INSERT INTO evaluations (
        id, owner_id, product_name, product_url, pack_id, depth, scopes_json,
        status, progress, session_id, session_mode, report, report_source,
        evidence_json, error_message, created_at, updated_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.id,
      record.owner_id,
      record.product_name,
      record.product_url,
      record.pack_id,
      record.depth,
      record.scopes_json,
      record.status,
      record.progress,
      record.session_id,
      record.session_mode,
      record.report,
      record.report_source,
      record.evidence_json,
      record.error_message,
      record.created_at,
      record.updated_at,
      record.completed_at,
    )
    .run();
  return id;
}

export async function updateEvaluation(
  ownerId: string,
  id: string,
  patch: EvaluationPatch,
): Promise<boolean> {
  // False means missing row, owner mismatch, or a rejected state transition.
  const plan = buildEvaluationUpdatePlan(patch, new Date().toISOString());

  if (isMeooImageRuntime) {
    const client = getSupabaseAdmin();
    return executeEvaluationUpdatePlan(plan, (attempt) =>
      executeSupabaseEvaluationUpdateAttempt(
        client,
        ownerId,
        id,
        attempt,
      ),
    );
  }

  await ensureEvaluationsSchema();
  const db = await binding();
  return executeEvaluationUpdatePlan(plan, (attempt) =>
    executeD1EvaluationUpdateAttempt(db, ownerId, id, attempt),
  );
}

export async function getEvaluation(ownerId: string, id: string) {
  if (isMeooImageRuntime) {
    const { data, error } = await getSupabaseAdmin()
      .from("evaluations")
      .select("*")
      .eq("owner_id", ownerId)
      .eq("id", id)
      .maybeSingle();
    if (error) throw supabaseFailure("read", error.message);
    return data as EvaluationRecord | null;
  }

  await ensureEvaluationsSchema();
  return (await binding())
    .prepare(
      "SELECT * FROM evaluations WHERE owner_id = ? AND id = ? LIMIT 1",
    )
    .bind(ownerId, id)
    .first<EvaluationRecord>();
}

export async function listEvaluations(ownerId: string, limit = 30) {
  const requestedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 30;
  const safeLimit = Math.min(Math.max(requestedLimit, 1), 100);
  if (isMeooImageRuntime) {
    const { data, error } = await getSupabaseAdmin()
      .from("evaluations")
      .select(
        "id, product_name, product_url, pack_id, depth, scopes_json, status, progress, session_id, session_mode, report_source, evidence_json, error_message, created_at, updated_at, completed_at, has_report",
      )
      .eq("owner_id", ownerId)
      .order("created_at", { ascending: false })
      .limit(safeLimit);
    if (error) throw supabaseFailure("list", error.message);
    return data || [];
  }

  await ensureEvaluationsSchema();
  const result = await (await binding())
    .prepare(
      `SELECT
        id, product_name, product_url, pack_id, depth, scopes_json,
        status, progress, session_id, session_mode, report_source,
        evidence_json, error_message, created_at, updated_at, completed_at,
        CASE WHEN LENGTH(report) > 0 THEN 1 ELSE 0 END AS has_report
      FROM evaluations
      WHERE owner_id = ?
      ORDER BY created_at DESC
      LIMIT ?`,
    )
    .bind(ownerId, safeLimit)
    .all();
  return result.results;
}

export async function evaluationStats(ownerId: string) {
  if (isMeooImageRuntime) {
    const { data, error } = await getSupabaseAdmin().rpc(
      "evaluation_stats_for_owner",
      { p_owner_id: ownerId },
    );
    if (error) throw supabaseFailure("summarize", error.message);
    const row = data?.[0];
    return {
      total: Number(row?.total || 0),
      complete: Number(row?.complete || 0),
      running: Number(row?.running || 0),
      failed: Number(row?.failed || 0),
    };
  }

  await ensureEvaluationsSchema();
  const row = await (await binding())
    .prepare(
      `SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS complete,
        SUM(CASE WHEN status = 'running' THEN 1 ELSE 0 END) AS running,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed
      FROM evaluations
      WHERE owner_id = ?`,
    )
    .bind(ownerId)
    .first<Record<string, number>>();
  return {
    total: Number(row?.total || 0),
    complete: Number(row?.complete || 0),
    running: Number(row?.running || 0),
    failed: Number(row?.failed || 0),
  };
}

export async function deleteEvaluations(ownerId: string) {
  if (isMeooImageRuntime) {
    const { count, error } = await getSupabaseAdmin()
      .from("evaluations")
      .delete({ count: "exact" })
      .eq("owner_id", ownerId);
    if (error) throw supabaseFailure("delete", error.message);
    return Number(count || 0);
  }

  await ensureEvaluationsSchema();
  const result = await (await binding())
    .prepare("DELETE FROM evaluations WHERE owner_id = ?")
    .bind(ownerId)
    .run();
  return Number(result.meta.changes || 0);
}
