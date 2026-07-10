import { Hono } from "hono";

export type HealthProjectionReplaySummary = Readonly<{
  status: "ok" | "degraded";
  totalGroups: number;
  requiredGroups: number;
  initializedGroups: number;
  caughtUpGroups: number;
  behindGroups: number;
  staleGroups: number;
  runningGroups: number;
  errorGroups: number;
  contexts: readonly Readonly<{
    contextName: string;
    totalGroups: number;
    requiredGroups: number;
    initializedGroups: number;
    caughtUpGroups: number;
    behindGroups: number;
    staleGroups: number;
    runningGroups: number;
    errorGroups: number;
  }>[];
}>;

export type HealthProjectionReplayError = Readonly<{
  status: "degraded";
  message: string;
}>;

export type ReadinessCheck = Readonly<{
  name: string;
  check: () => Promise<void>;
}>;

export type ReadinessCheckResult = Readonly<{
  name: string;
  status: "ok" | "degraded";
  message?: string;
}>;

export type ReadinessStatus = Readonly<{
  status: "ok" | "degraded";
  checks: readonly ReadinessCheckResult[];
}>;

// The kubelet probes /health/ready every 10s, but under battery load a single
// probe competes with the projection-status fan-out and auth/actor traffic for
// the small control pool (DATABASE_POOL_MAX=6 on DOKS staging). Sharing one
// dependency evaluation across a short window keeps readiness off the pool's
// hot path: concurrent callers (both /health and /api/health aliases, kubelet
// retries, manual curls) collapse onto one round-trip, and a ≤1s stale window
// cannot meaningfully mask an outage against a 10s probe period. Mirrors the
// coalescing the refresh route already applies.
const READINESS_CHECK_CACHE_TTL_MS = 1_000;

export type HealthStatus = Readonly<{
  status: "ok" | "degraded";
  projectionReplay?: HealthProjectionReplaySummary;
  projectionReplayError?: HealthProjectionReplayError;
}>;

export function createHealthRoutes(
  options: Readonly<{
    getProjectionReplay?: () => HealthProjectionReplaySummary | Promise<HealthProjectionReplaySummary>;
    readinessChecks?: readonly ReadinessCheck[];
    isDraining?: () => boolean;
  }> = {},
): Hono {
  const app = new Hono();
  const evaluateReadinessChecks = createReadinessCheckEvaluator(options.readinessChecks ?? []);

  app.get("/live", (c) =>
    c.json({
      status: "ok",
    }),
  );

  app.get("/ready", async (c) => {
    const readiness = await resolveReadiness(options, evaluateReadinessChecks);

    return c.json(readiness, readiness.status === "ok" ? 200 : 503);
  });

  app.get("/", async (c) => {
    const health = await resolveHealthStatus(options.getProjectionReplay);

    return c.json(health);
  });

  return app;
}

async function resolveReadiness(
  options: Readonly<{
    isDraining?: () => boolean;
  }>,
  evaluateReadinessChecks: () => Promise<readonly ReadinessCheckResult[]>,
): Promise<ReadinessStatus> {
  // Draining is a cheap local flag and gates graceful shutdown, so it is
  // evaluated fresh on every probe (never cached) — the moment the preStop
  // hook flips it, readiness must fail so the pod leaves the endpoints.
  const processDrainingCheck = options.isDraining?.()
    ? [
        {
          name: "process.draining",
          status: "degraded" as const,
          message: "Process is draining for shutdown.",
        },
      ]
    : [];
  const checks = await evaluateReadinessChecks();
  const allChecks = [...processDrainingCheck, ...checks];
  const status = allChecks.some((check) => check.status === "degraded") ? "degraded" : "ok";

  return {
    status,
    checks: allChecks,
  };
}

// Cache + coalesce the dependency-check evaluation (the DB-touching part).
// A successful or degraded result is reused for READINESS_CHECK_CACHE_TTL_MS,
// and concurrent callers share the single in-flight evaluation. Checks never
// reject (each error is caught into a degraded result), so the cache always
// reflects the most recent completed evaluation; the short TTL bounds staleness
// well under the 10s probe period, keeping a genuinely-down dependency ejecting.
function createReadinessCheckEvaluator(
  readinessChecks: readonly ReadinessCheck[],
): () => Promise<readonly ReadinessCheckResult[]> {
  let cached: Readonly<{ results: readonly ReadinessCheckResult[]; evaluatedAtMs: number }> | undefined;
  let inFlight: Promise<readonly ReadinessCheckResult[]> | undefined;

  return () => {
    if (cached && Date.now() - cached.evaluatedAtMs < READINESS_CHECK_CACHE_TTL_MS) {
      return Promise.resolve(cached.results);
    }

    if (inFlight) {
      return inFlight;
    }

    const evaluation = Promise.all(
      readinessChecks.map(async (check): Promise<ReadinessCheckResult> => {
        try {
          await check.check();
          return {
            name: check.name,
            status: "ok",
          };
        } catch (error) {
          return {
            name: check.name,
            status: "degraded",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    )
      .then((results) => {
        cached = { results, evaluatedAtMs: Date.now() };
        return results;
      })
      .finally(() => {
        if (inFlight === evaluation) {
          inFlight = undefined;
        }
      });
    inFlight = evaluation;
    return evaluation;
  };
}

async function resolveHealthStatus(
  getProjectionReplay: (() => HealthProjectionReplaySummary | Promise<HealthProjectionReplaySummary>) | undefined,
): Promise<HealthStatus> {
  if (!getProjectionReplay) {
    return { status: "ok" };
  }

  try {
    const projectionReplay = await getProjectionReplay();

    return {
      status: projectionReplay.status,
      projectionReplay,
    };
  } catch (error) {
    return {
      status: "degraded",
      projectionReplayError: {
        status: "degraded",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
