import { Hono } from "hono";
import { createDurableJobEventStream } from "@chase-sets/platform-runtime/durable-job-events";
import type { PricingApiEnv } from "../../../api";
import type { RepricingEngineServices } from "./runtime";
import type { RepricingDryRunBody } from "./dry-run";
import type { RepricingPolicyListingTrace } from "../domain/fact";

type Services = Pick<
  RepricingEngineServices,
  "enqueueDryRun" | "getDryRun" | "listDryRuns" | "listDryRunTraces" | "listDryRunEvents" | "waitForDryRunEvents"
>;

export function createRepricingDryRunRoutes(services: Services) {
  const app = new Hono<PricingApiEnv>();
  app.use("*", async (c, next) => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: { code: "authentication_required" } }, 401);
    const permission = c.req.method === "POST" ? "pricing.manage" : "pricing.view";
    if (!actor.permissions.includes(permission)) return c.json({ error: { code: "authorization_forbidden" } }, 403);
    return next();
  });
  app.post("/", async (c) => {
    const context = c.get("context");
    if (!context) return c.json({ error: { code: "authentication_required" } }, 401);
    try {
      const request = await c.req.json<RepricingDryRunBody & { replacingPolicyId?: string }>();
      if (request.replacingPolicyId !== undefined && typeof request.replacingPolicyId !== "string") {
        return c.json({ error: { code: "validation_failed" } }, 400);
      }
      const run = await services.enqueueDryRun(
        {
          sellerAccountId: c.get("actor")!.accountId,
          body: request,
          replacingPolicyId: request.replacingPolicyId,
        },
        context,
      );
      return run ? c.json(run, 202) : c.json({ error: { code: "not_found" } }, 404);
    } catch {
      return c.json({ error: { code: "validation_failed" } }, 400);
    }
  });
  app.get("/", async (c) => {
    const limit = parseLimit(c.req.query("limit"), 25);
    if (limit === null) return c.json({ error: { code: "validation_failed" } }, 400);
    return c.json(await services.listDryRuns(c.get("actor")!.accountId, limit));
  });
  app.get("/:dryRunId", async (c) => {
    const run = await services.getDryRun(c.get("actor")!.accountId, c.req.param("dryRunId"));
    return run ? c.json(run) : c.json({ error: { code: "not_found" } }, 404);
  });
  app.get("/:dryRunId/traces", async (c) => {
    const accountId = c.get("actor")!.accountId;
    const dryRunId = c.req.param("dryRunId");
    if (!(await services.getDryRun(accountId, dryRunId))) return c.json({ error: { code: "not_found" } }, 404);
    const limit = parseLimit(c.req.query("limit"), 100);
    const outcome = parseOutcome(c.req.query("outcome"));
    if (limit === null || outcome === null) return c.json({ error: { code: "validation_failed" } }, 400);
    return c.json(
      await services.listDryRunTraces(accountId, dryRunId, { outcome, after: c.req.query("after"), limit }),
    );
  });
  app.get("/:dryRunId/events", async (c) => {
    const accountId = c.get("actor")!.accountId;
    const dryRunId = c.req.param("dryRunId");
    if (!(await services.getDryRun(accountId, dryRunId))) return c.json({ error: { code: "not_found" } }, 404);
    return createDurableJobEventStream({
      request: c.req.raw,
      signal: c.req.raw.signal,
      streamLimitKey: `account:${accountId}`,
      loadEvents: (afterSequence) => services.listDryRunEvents(accountId, dryRunId, afterSequence),
      loadCurrentSnapshot: () => services.getDryRun(accountId, dryRunId),
      waitForEvents: (_after, signal) => services.waitForDryRunEvents(accountId, dryRunId, signal),
      isTerminal: (event) => event.data.status === "completed" || event.data.status === "failed",
      isTerminalSnapshot: (snapshot) => snapshot.status === "completed" || snapshot.status === "failed",
    });
  });
  return app;
}

function parseLimit(value: string | undefined, fallback: number): number | null {
  if (value === undefined) return fallback;
  return /^[1-9]\d*$/.test(value) && Number(value) <= 100 ? Number(value) : null;
}

function parseOutcome(value: string | undefined): RepricingPolicyListingTrace["outcome"] | undefined | null {
  if (value === undefined) return undefined;
  switch (value) {
    case "changed":
    case "skipped":
    case "pause-requested":
    case "notify-only":
      return value;
    default:
      return null;
  }
}
