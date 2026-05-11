import { Hono } from "hono";

export type HealthProjectionReplaySummary = Readonly<{
  status: "ok" | "degraded";
  totalGroups: number;
  requiredGroups: number;
  initializedGroups: number;
  caughtUpGroups: number;
  behindGroups: number;
  runningGroups: number;
  errorGroups: number;
  contexts: readonly Readonly<{
    contextName: string;
    totalGroups: number;
    requiredGroups: number;
    initializedGroups: number;
    caughtUpGroups: number;
    behindGroups: number;
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

export type ReadinessStatus = Readonly<{
  status: "ok" | "degraded";
  checks: readonly Readonly<{
    name: string;
    status: "ok" | "degraded";
    message?: string;
  }>[];
}>;

export type HealthStatus = Readonly<{
  status: "ok" | "degraded";
  projectionReplay?: HealthProjectionReplaySummary;
  projectionReplayError?: HealthProjectionReplayError;
}>;

export function createHealthRoutes(
  options: Readonly<{
    getProjectionReplay?: () =>
      | HealthProjectionReplaySummary
      | Promise<HealthProjectionReplaySummary>;
    readinessChecks?: readonly ReadinessCheck[];
  }> = {},
): Hono {
  const app = new Hono();

  app.get("/live", (c) =>
    c.json({
      status: "ok",
    }),
  );

  app.get("/ready", async (c) => {
    const readiness = await resolveReadiness(options);

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
    readinessChecks?: readonly ReadinessCheck[];
  }>,
): Promise<ReadinessStatus> {
  const checks = await Promise.all(
    (options.readinessChecks ?? []).map(async (check) => {
      try {
        await check.check();
        return {
          name: check.name,
          status: "ok" as const,
        };
      } catch (error) {
        return {
          name: check.name,
          status: "degraded" as const,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );
  const status = checks.some((check) => check.status === "degraded")
    ? "degraded"
    : "ok";

  return {
    status,
    checks,
  };
}

async function resolveHealthStatus(
  getProjectionReplay:
    | (() => HealthProjectionReplaySummary | Promise<HealthProjectionReplaySummary>)
    | undefined,
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
