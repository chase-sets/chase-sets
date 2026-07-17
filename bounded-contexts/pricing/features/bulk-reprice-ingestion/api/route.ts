import { t } from "@chase-sets/localization";
import { Hono, type Context } from "hono";
import { createDurableJobEventStream } from "@chase-sets/platform-runtime/durable-job-events";
import type { PricingApiEnv } from "../../../api";
import { buildBulkRepriceCsvTemplate } from "../domain/csv";
import { toBulkRepriceJobStatus, type BulkRepriceIngestionServices } from "./runtime";

function requireBulkRepriceAccess(c: { get(key: "actor"): PricingApiEnv["Variables"]["actor"] }) {
  const actor = c.get("actor");
  if (!actor) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authentication_required",
            message: t("pricing.features.bulkRepriceIngestion.api.route.authentication.required"),
          },
        }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      ),
    };
  }

  if (!actor.permissions.includes("listings.manage")) {
    return {
      actor: null,
      response: new Response(
        JSON.stringify({
          error: {
            code: "authorization_forbidden",
            message: t("pricing.features.bulkRepriceIngestion.api.route.forbidden"),
          },
        }),
        { status: 403, headers: { "Content-Type": "application/json" } },
      ),
    };
  }

  return { actor, response: null };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : t("pricing.features.bulkRepriceIngestion.api.route.request.failed");
}

type BulkRepriceJsonRowInput = Readonly<{ sellerSku?: unknown; listingId?: unknown; newPriceAmount?: unknown }>;

async function parseCreateJobRequest(
  c: Context<PricingApiEnv>,
): Promise<Readonly<{ csvText?: string; rows?: readonly BulkRepriceJsonRowInput[]; sourceFilename: string | null }>> {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const formData = await c.req.formData();
    const file = formData.get("file");
    const uploadedFile = file instanceof File ? file : null;
    const csvText = uploadedFile ? await uploadedFile.text() : String(formData.get("csvText") ?? "");
    const sourceFilename = uploadedFile
      ? uploadedFile.name
      : String(formData.get("sourceFilename") ?? "").trim() || null;
    return { csvText, sourceFilename };
  }

  const body = (await c.req.json().catch(() => ({}))) as Readonly<{
    csvText?: unknown;
    rows?: readonly BulkRepriceJsonRowInput[];
    sourceFilename?: unknown;
  }>;
  return {
    csvText: typeof body.csvText === "string" ? body.csvText : undefined,
    rows: Array.isArray(body.rows) ? body.rows : undefined,
    sourceFilename: typeof body.sourceFilename === "string" ? body.sourceFilename : null,
  };
}

export function createBulkRepriceIngestionRoutes(services: BulkRepriceIngestionServices) {
  const app = new Hono<PricingApiEnv>();

  // The policy flag gates the whole mounted route tree, including the CSV
  // template and read endpoints. Disabled means the removable on-ramp is not
  // an addressable product surface, not merely that writes happen to fail.
  app.use("*", async (c, next) => {
    const policy = await services.resolvePolicy();
    if (!policy.enabled) {
      return c.notFound();
    }
    await next();
  });

  app.get("/template.csv", (c) =>
    c.body(buildBulkRepriceCsvTemplate(), 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="chase-sets-bulk-reprice-template.csv"',
    }),
  );

  app.post("/", async (c) => {
    const access = requireBulkRepriceAccess(c);
    if (access.response) {
      return access.response;
    }

    const rateLimit = await services.checkCreateJobRateLimit(access.actor.accountId);
    if (rateLimit.limited) {
      return c.json(
        {
          error: {
            code: "rate_limited",
            message: t("pricing.features.bulkRepriceIngestion.api.route.rate.limited"),
          },
        },
        429,
        { "Retry-After": String(rateLimit.retryAfterSeconds) },
      );
    }

    const context = c.get("context");
    if (!context) {
      return c.json(
        {
          error: {
            code: "authentication_required",
            message: t("pricing.features.bulkRepriceIngestion.api.route.authentication.context.missing"),
          },
        },
        401,
      );
    }

    try {
      const body = await parseCreateJobRequest(c);
      const job = await services.enqueueJob(
        {
          accountId: access.actor.accountId,
          csvText: body.csvText,
          rows: body.rows,
          sourceFilename: body.sourceFilename,
        },
        context,
      );
      return c.json(toBulkRepriceJobStatus(job), 202);
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/jobs/:jobId", async (c) => {
    const access = requireBulkRepriceAccess(c);
    if (access.response) {
      return access.response;
    }

    const job = await services.getJob(c.req.param("jobId"));
    if (!job || job.payload.accountId !== access.actor.accountId) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("pricing.features.bulkRepriceIngestion.api.route.job.not.found"),
          },
        },
        404,
      );
    }

    return c.json(toBulkRepriceJobStatus(job));
  });

  app.get("/jobs/:jobId/events", async (c) => {
    const access = requireBulkRepriceAccess(c);
    if (access.response) {
      return access.response;
    }

    const jobId = c.req.param("jobId");
    const job = await services.getJob(jobId);
    if (!job || job.payload.accountId !== access.actor.accountId) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("pricing.features.bulkRepriceIngestion.api.route.job.not.found"),
          },
        },
        404,
      );
    }

    return createDurableJobEventStream({
      request: c.req.raw,
      signal: c.req.raw.signal,
      streamLimitKey: `account:${access.actor.accountId}`,
      loadEvents: async (afterSequence) =>
        (await services.listJobEvents(jobId, afterSequence)).map((event) => ({
          sequence: event.sequence,
          eventName: event.eventName,
          data: event.job,
        })),
      loadCurrentSnapshot: async () => {
        const current = await services.getJob(jobId);
        return current && current.payload.accountId === access.actor.accountId ? toBulkRepriceJobStatus(current) : null;
      },
      waitForEvents: (_afterSequence, signal) => services.waitForJobEvents(jobId, signal),
      isTerminal: (event) => event.data.status === "completed" || event.data.status === "failed",
      isTerminalSnapshot: (snapshot) => snapshot.status === "completed" || snapshot.status === "failed",
    });
  });

  app.post("/jobs/:jobId/cancel", async (c) => {
    const access = requireBulkRepriceAccess(c);
    if (access.response) {
      return access.response;
    }

    try {
      const job = await services.cancelJob(c.req.param("jobId"), access.actor.accountId);
      return c.json(toBulkRepriceJobStatus(job));
    } catch (error) {
      return c.json({ error: { code: "validation_failed", message: errorMessage(error) } }, 400);
    }
  });

  app.get("/jobs/:jobId/results.csv", async (c) => {
    const access = requireBulkRepriceAccess(c);
    if (access.response) {
      return access.response;
    }

    const job = await services.getJob(c.req.param("jobId"));
    if (!job || job.payload.accountId !== access.actor.accountId) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("pricing.features.bulkRepriceIngestion.api.route.job.not.found"),
          },
        },
        404,
      );
    }

    const csv = await services.getResultsCsv(c.req.param("jobId"));
    return c.body(csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="bulk-reprice-${c.req.param("jobId")}-results.csv"`,
    });
  });

  return app;
}
