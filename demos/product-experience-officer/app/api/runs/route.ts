import {
  deleteEvaluations,
  evaluationStats,
  getEvaluation,
  listEvaluations,
} from "@/db/evaluations";
import {
  resolveRunOwner,
  type RunOwner,
  withRunOwnerCookie,
} from "@/lib/run-owner";

function parseJson(value: unknown, fallback: unknown) {
  if (typeof value !== "string") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function serializeRun(run: Record<string, unknown>, includeReport = false) {
  return {
    id: run.id,
    productName: run.product_name,
    productUrl: run.product_url,
    packId: run.pack_id,
    depth: run.depth,
    scopes: parseJson(run.scopes_json, []),
    status: run.status,
    progress: run.progress,
    sessionId: run.session_id,
    sessionMode: run.session_mode,
    reportSource: run.report_source,
    evidence: parseJson(run.evidence_json, {}),
    errorMessage: run.error_message,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
    completedAt: run.completed_at,
    hasReport:
      run.has_report === true ||
      run.has_report === 1 ||
      (typeof run.report === "string" && run.report.length > 0),
    ...(includeReport ? { report: run.report || "" } : {}),
  };
}

function ownerJson(
  owner: RunOwner,
  data: Record<string, unknown>,
  init?: ResponseInit,
) {
  const headers = new Headers(init?.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json");
  return withRunOwnerCookie(
    new Response(JSON.stringify(data), { ...init, headers }),
    owner,
  );
}

export async function GET(request: Request) {
  const owner = resolveRunOwner(request);
  try {
    const url = new URL(request.url);
    const id = url.searchParams.get("id");
    if (id) {
      if (!/^run_[a-f0-9]{32}$/.test(id)) {
        return ownerJson(owner, { error: "Invalid run id" }, { status: 400 });
      }
      const run = await getEvaluation(owner.ownerId, id);
      if (!run) {
        return ownerJson(owner, { error: "Run not found" }, { status: 404 });
      }
      return ownerJson(owner, {
        run: serializeRun(
          run as unknown as Record<string, unknown>,
          true,
        ),
      });
    }

    const [runs, stats] = await Promise.all([
      listEvaluations(
        owner.ownerId,
        Number(url.searchParams.get("limit") || 30),
      ),
      evaluationStats(owner.ownerId),
    ]);
    return ownerJson(owner, {
      runs: runs.map((run) =>
        serializeRun(run as Record<string, unknown>, false),
      ),
      stats,
    });
  } catch (error) {
    return ownerJson(
      owner,
      {
        error:
          error instanceof Error ? error.message : "Unable to load run history",
      },
      { status: 500 },
    );
  }
}

export async function DELETE(request: Request) {
  const owner = resolveRunOwner(request);
  try {
    const deleted = await deleteEvaluations(owner.ownerId);
    const stats = await evaluationStats(owner.ownerId);
    return ownerJson(owner, { deleted, stats });
  } catch (error) {
    return ownerJson(
      owner,
      {
        error:
          error instanceof Error
            ? error.message
            : "Unable to clear run history",
      },
      { status: 500 },
    );
  }
}
