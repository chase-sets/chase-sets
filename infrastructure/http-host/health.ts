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

export function createHealthRoutes(
  options: Readonly<{
    getProjectionReplay?: () =>
      | HealthProjectionReplaySummary
      | Promise<HealthProjectionReplaySummary>;
  }> = {},
): Hono {
  const app = new Hono();

  app.get("/", async (c) => {
    const projectionReplay = await options.getProjectionReplay?.();

    return c.json({
      status: projectionReplay?.status ?? "ok",
      projectionReplay,
    });
  });

  return app;
}
