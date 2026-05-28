import { t } from "@chase-sets/localization";
import { createDurableJobEventStream } from "@chase-sets/platform-runtime/durable-job-events";
import { Hono } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { SourceObservationServices } from "./runtime";
import type { SourceObservationFilterScope } from "../read-model/queries";

export function sourceObservationRoutes(services: SourceObservationServices) {
  const app = new Hono<CatalogAuthoringEnv>();

  app.get("/", async (c) => {
    const { search, status, limit, offset, provider, source, language, setId, expansionId } = c.req.query();
    const result = await services.listSourceObservations({
      search,
      status,
      limit: Number(limit) || undefined,
      offset: Number(offset) || undefined,
      provider: provider ?? source,
      language,
      setId: expansionId ?? setId,
    });
    return c.json({ items: result.items, total: result.total, count: result.items.length });
  });

  app.get("/integration-scopes", async (c) => {
    const { provider, source, language, setId, expansionId } = c.req.query();
    const items = await services.listIntegrationScopes({
      provider: provider ?? source,
      language,
      setId: expansionId ?? setId,
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/integration-options", async (c) => {
    const items = await services.listIntegrationOptions({
      providerKey: String(c.req.query("providerKey") ?? c.req.query("provider") ?? "tcgdex"),
      queryKind: String(c.req.query("queryKind") ?? c.req.query("kind") ?? ""),
      languageCode: c.req.query("languageCode") ?? c.req.query("language"),
      parentValue: c.req.query("parentValue") ?? c.req.query("seriesId") ?? c.req.query("series"),
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.post("/imports/tcgdex-set", async (c) => {
    const body = await c.req.json();
    const job = await services.enqueueIntegrationJob({
      action: "import",
      scope: {
        provider: "tcgdex",
        language: String(body.languageCode ?? "en"),
        setId: String(body.expansionId ?? body.setId ?? ""),
      },
      context: c.get("context"),
    });

    return c.json(job, 202);
  });

  app.get("/tcgdex/languages", async (c) => {
    const items = await services.listTcgdexLanguages();
    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/tcgdex/series", async (c) => {
    const languageCode = String(c.req.query("languageCode") ?? c.req.query("language") ?? "en");
    const items = await services.listTcgdexSeries({ languageCode });
    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/tcgdex/expansions", async (c) => {
    const languageCode = String(c.req.query("languageCode") ?? c.req.query("language") ?? "en");
    const seriesId = c.req.query("seriesId") ?? c.req.query("series");
    const items = await services.listTcgdexExpansions({ languageCode, seriesId });
    return c.json({ items, total: items.length, count: items.length });
  });

  app.post("/bulk-promote/preview", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: unknown;
    };
    const result = await services.previewPromoteObservationScope({
      scope: parsePromotionScope(body.scope),
    });

    return c.json(result);
  });

  app.post("/reapply/preview", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      scope?: unknown;
    };
    const result = await services.previewReapplyObservationScope({
      scope: parsePromotionScope(body.scope),
    });

    return c.json(result);
  });

  app.post("/reapply", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
    };

    if (body.scope) {
      const job = await services.enqueueIntegrationJob({
        action: "reapply",
        scope: promotionScopeToIntegrationScope(parsePromotionScope(body.scope)),
        context: c.get("context"),
      });

      return c.json(job, 202);
    }

    const job = await services.enqueueBulkReviewJob({
      action: "reapply",
      observationIds: parseObservationIds(body.observationIds),
      context: c.get("context"),
    });

    return c.json(job, 202);
  });

  app.post("/bulk-promote/jobs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
    };
    const job = await services.enqueueBulkReviewJob({
      action: "promote",
      observationIds: parseObservationIds(body.observationIds),
      scope: body.scope ? parsePromotionScope(body.scope) : undefined,
      context: c.get("context"),
    });

    return c.json(job, 202);
  });

  app.post("/bulk-promote", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
    };

    const job = await services.enqueueBulkReviewJob({
      action: "promote",
      observationIds: parseObservationIds(body.observationIds),
      scope: body.scope ? parsePromotionScope(body.scope) : undefined,
      context: c.get("context"),
    });

    return c.json(job, 202);
  });

  app.post("/bulk-reject", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
      reason?: unknown;
    };
    const reason = String(body.reason ?? "").trim();

    if (!reason) {
      return c.json(
        {
          error: t("catalog.features.sourceObservations.api.route.bulk.rejection.requires.reason"),
        },
        400,
      );
    }

    const job = await services.enqueueBulkReviewJob({
      action: "reject",
      observationIds: parseObservationIds(body.observationIds),
      scope: body.scope ? parsePromotionScope(body.scope) : undefined,
      reason,
      context: c.get("context"),
    });

    return c.json(job, 202);
  });

  app.post("/bulk-reject/jobs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      observationIds?: unknown;
      scope?: unknown;
      reason?: unknown;
    };
    const reason = String(body.reason ?? "").trim();

    if (!reason) {
      return c.json(
        {
          error: t("catalog.features.sourceObservations.api.route.bulk.rejection.requires.reason"),
        },
        400,
      );
    }

    const job = await services.enqueueBulkReviewJob({
      action: "reject",
      observationIds: parseObservationIds(body.observationIds),
      scope: body.scope ? parsePromotionScope(body.scope) : undefined,
      reason,
      context: c.get("context"),
    });

    return c.json(job, 202);
  });

  app.get("/bulk-jobs/active", async (c) => {
    const items = await services.listActiveBulkReviewJobs({
      context: c.get("context"),
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/bulk-jobs/:jobId", async (c) => {
    const job = await services.getBulkReviewJob(c.req.param("jobId"));
    if (!job) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.features.sourceObservations.api.route.bulk.job.not.found"),
          },
        },
        404,
      );
    }

    return c.json(job);
  });

  app.get("/bulk-jobs/:jobId/events", async (c) => {
    const jobId = c.req.param("jobId");
    const job = await services.getBulkReviewJob(jobId);
    if (!job) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.features.sourceObservations.api.route.bulk.job.not.found"),
          },
        },
        404,
      );
    }

    return streamBulkJobEvents(services, jobId, c.req.raw);
  });

  app.post("/integration-jobs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as {
      action?: unknown;
      scope?: unknown;
    };
    const action = String(body.action ?? "");

    if (action !== "import" && action !== "reapply") {
      return c.json(
        {
          error: {
            code: "invalid_action",
            message: t("catalog.features.sourceObservations.api.route.integration.job.invalid.action"),
          },
        },
        400,
      );
    }

    const job = await services.enqueueIntegrationJob({
      action,
      scope: parseIntegrationJobScope(body.scope),
      context: c.get("context"),
    });

    return c.json(job, 202);
  });

  app.get("/integration-jobs/active", async (c) => {
    const items = await services.listActiveIntegrationJobs({
      context: c.get("context"),
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/integration-jobs/:jobId", async (c) => {
    const job = await services.getIntegrationJob(c.req.param("jobId"));
    if (!job) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.features.sourceObservations.api.route.integration.job.not.found"),
          },
        },
        404,
      );
    }

    return c.json(job);
  });

  app.get("/integration-jobs/:jobId/events", async (c) => {
    const jobId = c.req.param("jobId");
    const job = await services.getIntegrationJob(jobId);
    if (!job) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.features.sourceObservations.api.route.integration.job.not.found"),
          },
        },
        404,
      );
    }

    return streamIntegrationJobEvents(services, jobId, c.req.raw);
  });

  app.get("/:id", async (c) => {
    const observation = await services.getSourceObservationDetail(c.req.param("id"));
    if (!observation) {
      return c.json(
        {
          error: {
            code: "not_found",
            message: t("catalog.features.sourceObservations.api.route.source.observation.not.found"),
          },
        },
        404,
      );
    }

    return c.json(observation);
  });

  app.post("/:id/promote", async (c) => {
    const result = await services.promoteObservation({
      observationId: c.req.param("id"),
      context: c.get("context"),
    });

    return c.json(result);
  });

  app.post("/:id/reject", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const result = await services.rejectObservation({
      observationId: c.req.param("id"),
      reason: String(body.reason ?? "Rejected during review."),
      context: c.get("context"),
    });

    return c.json(result);
  });

  return app;
}

function parsePromotionScope(input: unknown): SourceObservationFilterScope {
  if (!input || typeof input !== "object") {
    return {};
  }

  const record = input as Record<string, unknown>;

  return {
    search: stringField(record.search),
    status: stringField(record.status),
    provider: stringField(record.provider) ?? stringField(record.source),
    language: stringField(record.language),
    setId: stringField(record.expansionId) ?? stringField(record.setId),
  };
}

function parseIntegrationJobScope(input: unknown) {
  if (!input || typeof input !== "object") {
    return {};
  }

  const record = input as Record<string, unknown>;

  return {
    provider: stringField(record.provider) ?? stringField(record.source),
    language: stringField(record.language) ?? stringField(record.languageCode),
    seriesId: stringField(record.seriesId),
    setId: stringField(record.expansionId) ?? stringField(record.setId),
  };
}

function promotionScopeToIntegrationScope(scope: SourceObservationFilterScope) {
  return {
    provider: scope.provider,
    language: scope.language,
    setId: scope.setId,
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseObservationIds(input: unknown): string[] {
  return Array.isArray(input) ? input.map((observationId: unknown) => String(observationId)) : [];
}

function streamBulkJobEvents(services: SourceObservationServices, jobId: string, request: Request) {
  return createDurableJobEventStream({
    request,
    signal: request.signal,
    loadEvents: async (afterSequence) =>
      (await services.listBulkReviewJobEvents(jobId, afterSequence)).map((event) => ({
        sequence: event.sequence,
        eventName: event.eventName,
        data: event.job,
      })),
    waitForEvents: (_afterSequence, signal) => services.waitForBulkReviewJobEvents(jobId, signal),
    isTerminal: (event) => event.data.status === "completed" || event.data.status === "failed",
  });
}

function streamIntegrationJobEvents(services: SourceObservationServices, jobId: string, request: Request) {
  return createDurableJobEventStream({
    request,
    signal: request.signal,
    loadEvents: async (afterSequence) =>
      (await services.listIntegrationJobEvents(jobId, afterSequence)).map((event) => ({
        sequence: event.sequence,
        eventName: event.eventName,
        data: event.job,
      })),
    waitForEvents: (_afterSequence, signal) => services.waitForIntegrationJobEvents(jobId, signal),
    isTerminal: (event) => event.data.status === "completed" || event.data.status === "failed",
  });
}
