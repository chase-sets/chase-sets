import { Hono } from "hono";
import { createDurableJobEventStream } from "@chase-sets/platform-runtime/durable-job-events";
import type { DiscoveryApiEnv } from "../../api";
import {
  toGoogleShoppingFullSyncJobStatus,
  type GoogleShoppingSyncMode,
  type GoogleShoppingSyncServices,
} from "./sync-job";

type AccessResult =
  | Readonly<{ response: Response; context: null }>
  | Readonly<{ response: null; context: NonNullable<DiscoveryApiEnv["Variables"]["context"]> }>;

export function createGoogleShoppingSyncRoutes(services: GoogleShoppingSyncServices) {
  const app = new Hono<DiscoveryApiEnv>();

  app.post("/sync-jobs", async (c) => {
    const access = requireGoogleShoppingSyncAccess(c);
    if (access.response) {
      return access.response;
    }

    const body = await c.req.json().catch(() => ({}));
    const mode = parseSyncMode((body as { mode?: unknown }).mode);
    const batchSize = parseBatchSize((body as { batchSize?: unknown }).batchSize);

    try {
      const job = await services.enqueueFullSyncJob({ mode, batchSize }, access.context);
      return c.json(toGoogleShoppingFullSyncJobStatus(job), 202);
    } catch (error) {
      return c.json(
        {
          error: {
            code: "validation_failed",
            message: error instanceof Error ? error.message : "Google Shopping full sync request failed.",
          },
        },
        400,
      );
    }
  });

  app.get("/sync-jobs/:jobId", async (c) => {
    const access = requireGoogleShoppingSyncAccess(c);
    if (access.response) {
      return access.response;
    }

    const job = await services.getFullSyncJob(c.req.param("jobId"));
    if (!job) {
      return c.json({ error: { code: "not_found", message: "Google Shopping full sync job not found." } }, 404);
    }

    return c.json(toGoogleShoppingFullSyncJobStatus(job));
  });

  app.get("/sync-jobs/:jobId/events", async (c) => {
    const access = requireGoogleShoppingSyncAccess(c);
    if (access.response) {
      return access.response;
    }

    const jobId = c.req.param("jobId");
    const job = await services.getFullSyncJob(jobId);
    if (!job) {
      return c.json({ error: { code: "not_found", message: "Google Shopping full sync job not found." } }, 404);
    }

    return createDurableJobEventStream({
      request: c.req.raw,
      signal: c.req.raw.signal,
      streamLimitKey: `google-shopping:${access.context.audit.forAccountId}`,
      loadEvents: async (afterSequence) =>
        (await services.listFullSyncJobEvents(jobId, afterSequence)).map((event) => ({
          sequence: event.sequence,
          eventName: event.eventName,
          data: event.job,
        })),
      loadCurrentSnapshot: async () => {
        const current = await services.getFullSyncJob(jobId);
        return current ? toGoogleShoppingFullSyncJobStatus(current) : null;
      },
      waitForEvents: (_afterSequence, signal) => services.waitForFullSyncJobEvents(jobId, signal),
      isTerminal: (event) => event.data.status === "completed" || event.data.status === "failed",
      isTerminalSnapshot: (snapshot) => snapshot.status === "completed" || snapshot.status === "failed",
    });
  });

  return app;
}

function requireGoogleShoppingSyncAccess(c: {
  get(key: "actor"): DiscoveryApiEnv["Variables"]["actor"];
  get(key: "context"): DiscoveryApiEnv["Variables"]["context"];
}): AccessResult {
  const actor = c.get("actor");
  if (!actor) {
    return {
      context: null,
      response: Response.json(
        { error: { code: "authentication_required", message: "Authentication is required." } },
        { status: 401 },
      ),
    };
  }

  if (!actor.permissions.includes("security.manage")) {
    return {
      context: null,
      response: Response.json(
        { error: { code: "authorization_forbidden", message: "Google Shopping sync requires security access." } },
        { status: 403 },
      ),
    };
  }

  const context = c.get("context");
  if (!context) {
    return {
      context: null,
      response: Response.json(
        { error: { code: "authentication_required", message: "Authentication context is required." } },
        { status: 401 },
      ),
    };
  }

  return { context, response: null };
}

function parseSyncMode(value: unknown): GoogleShoppingSyncMode {
  return value === "live" ? "live" : "dry-run";
}

function parseBatchSize(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}
