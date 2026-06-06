import { t } from "@chase-sets/localization";
import { createDurableJobEventStream } from "@chase-sets/platform-runtime/durable-job-events";
import type { JsonValue } from "@chase-sets/primitives/json";
import { Hono, type Context } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { CatalogProviderIntegrationProfileVersionStore } from "./provider-integration-profile-store";
import {
  CatalogProviderProfileSectionValidationError,
  parseCatalogProviderProfileSectionUpdateCommand,
} from "./provider-profile-admin-contracts";
import {
  activateCatalogProviderProfileVersionForReview,
  CatalogProviderProfileActivationValidationError,
  cloneCatalogProviderProfileVersionForReview,
  createCatalogProviderProfileVersionForReview,
  deprecateCatalogProviderProfileVersionForReview,
  dryRunCatalogProviderProfileVersion,
  getCatalogProviderProfileAuthoringModel,
  listCatalogProviderProfileVersionReviews,
  retireCatalogProviderProfileVersionForReview,
  rollbackCatalogProviderProfileVersionForReview,
  updateCatalogProviderProfileSectionForReview,
  updateCatalogProviderProfileVersionForReview,
} from "./provider-profile-review";
import type { CatalogProviderIntegrationProfileVersionRecord } from "./provider-integration-profiles";
import type {
  BulkReviewJobServices,
  CatalogIntegrationEngineServices,
  IntegrationJobServices,
  PromotionReapplyServices,
  ProviderImportOrchestrationServices,
  ProviderOptionQueryServices,
  ProviderProfileAdminServices,
  SourceObservationReadServices,
  SourceObservationReviewServices,
} from "./runtime";
import type { SourceObservationFilterScope } from "../read-model/queries";

export type SourceObservationRouteServices = SourceObservationReadServices &
  ProviderOptionQueryServices &
  ProviderProfileAdminServices &
  CatalogIntegrationEngineServices &
  ProviderImportOrchestrationServices &
  SourceObservationReviewServices &
  PromotionReapplyServices &
  BulkReviewJobServices &
  IntegrationJobServices;

export function sourceObservationRoutes(
  services: SourceObservationRouteServices,
  profileVersions?: CatalogProviderIntegrationProfileVersionStore,
) {
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

  app.get("/integration-control-plane/readiness", async (c) => {
    const result = await services.getCatalogIntegrationControlPlaneReadiness();
    return c.json(result);
  });

  app.get("/provider-profiles", async (c) => {
    const items = profileVersions ? await listCatalogProviderProfileVersionReviews(profileVersions) : [];
    return c.json({ items, total: items.length, count: items.length });
  });

  app.post("/provider-profiles", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    const body = await readJsonObject(c);
    if (body instanceof Response) {
      return body;
    }
    const result = await createCatalogProviderProfileVersionForReview({
      store: profileVersions,
      version: body.version as CatalogProviderIntegrationProfileVersionRecord,
      audit: authoringAuditFromContext(c.get("context")),
    });

    return c.json(result, 201);
  });

  app.get("/provider-profiles/:providerKey/:profileVersion/authoring", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    const result = await getCatalogProviderProfileAuthoringModel({
      store: profileVersions,
      providerKey: c.req.param("providerKey"),
      profileVersion: c.req.param("profileVersion"),
      selectedOptionSchema: await services.getSelectedOptionAuthoringSchema?.(),
      promotionTargetSchema: await services.getPromotionTargetAuthoringSchema?.(),
    });

    return c.json(result);
  });

  app.patch("/provider-profiles/:providerKey/:profileVersion", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    const body = await readJsonObject(c);
    if (body instanceof Response) {
      return body;
    }
    const result = await updateCatalogProviderProfileVersionForReview({
      store: profileVersions,
      providerKey: c.req.param("providerKey"),
      profileVersion: c.req.param("profileVersion"),
      patch: (body.patch ?? body) as never,
      audit: authoringAuditFromContext(c.get("context")),
    });

    return c.json(result);
  });

  app.patch("/provider-profiles/:providerKey/:profileVersion/sections/:section", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    const body = await readJsonObject(c);
    if (body instanceof Response) {
      return body;
    }

    try {
      const commandBody = isRecord(body.command) ? body.command : body;
      const command = parseCatalogProviderProfileSectionUpdateCommand(commandBody, c.req.param("section"));
      const result = await updateCatalogProviderProfileSectionForReview({
        store: profileVersions,
        providerKey: c.req.param("providerKey"),
        profileVersion: c.req.param("profileVersion"),
        command,
        audit: authoringAuditFromContext(c.get("context")),
      });

      return c.json(result);
    } catch (error) {
      if (!(error instanceof CatalogProviderProfileSectionValidationError)) {
        throw error;
      }

      return c.json(
        {
          error: {
            code: "invalid_profile_section_command",
            message: error.message,
          },
        },
        400,
      );
    }
  });

  app.post("/provider-profiles/:providerKey/:profileVersion/dry-run", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    const body = await readJsonObject(c);
    if (body instanceof Response) {
      return body;
    }
    const result = await dryRunCatalogProviderProfileVersion({
      store: profileVersions,
      providerKey: c.req.param("providerKey"),
      profileVersion: c.req.param("profileVersion"),
      payload: toJsonValue(body.payload),
      observedAt: new Date(0).toISOString(),
    });

    const duplicatePreventionCandidatePreview = await services.previewDuplicatePreventionCandidates?.({
      providerKey: c.req.param("providerKey"),
      profileVersion: c.req.param("profileVersion"),
      payload: toJsonValue(body.payload),
      observedAt: new Date(0).toISOString(),
    });

    return c.json({
      ...result,
      duplicatePreventionCandidatePreview:
        duplicatePreventionCandidatePreview ?? result.duplicatePreventionCandidatePreview,
    });
  });

  app.post("/provider-profiles/:providerKey/:profileVersion/activate", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    let result;
    try {
      result = await activateCatalogProviderProfileVersionForReview({
        store: profileVersions,
        providerKey: c.req.param("providerKey"),
        profileVersion: c.req.param("profileVersion"),
      });
    } catch (error) {
      if (!(error instanceof CatalogProviderProfileActivationValidationError)) {
        throw error;
      }

      return c.json(
        {
          error: {
            code: "profile_activation_blocked",
            message: error.message,
            diagnostics: error.diagnostics,
          },
        },
        400,
      );
    }

    return c.json(result);
  });

  app.post("/provider-profiles/:providerKey/:profileVersion/clone", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    const body = await readJsonObject(c);
    if (body instanceof Response) {
      return body;
    }
    const result = await cloneCatalogProviderProfileVersionForReview({
      store: profileVersions,
      providerKey: c.req.param("providerKey"),
      profileVersion: c.req.param("profileVersion"),
      targetProfileVersion: String(body.targetProfileVersion ?? ""),
      lifecycle: body.lifecycle === "test" ? "test" : "draft",
      audit: authoringAuditFromContext(c.get("context")),
    });

    return c.json(result, 201);
  });

  app.post("/provider-profiles/:providerKey/:profileVersion/rollback", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    const result = await rollbackCatalogProviderProfileVersionForReview({
      store: profileVersions,
      providerKey: c.req.param("providerKey"),
      profileVersion: c.req.param("profileVersion"),
    });

    return c.json(result);
  });

  app.post("/provider-profiles/:providerKey/:profileVersion/retire", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    const result = await retireCatalogProviderProfileVersionForReview({
      store: profileVersions,
      providerKey: c.req.param("providerKey"),
      profileVersion: c.req.param("profileVersion"),
      audit: authoringAuditFromContext(c.get("context")),
    });

    return c.json(result);
  });

  app.post("/provider-profiles/:providerKey/:profileVersion/deprecate", async (c) => {
    if (!profileVersions) {
      return c.json({ error: t("catalog.features.sourceObservations.api.route.profile.review.unavailable") }, 503);
    }

    const result = await deprecateCatalogProviderProfileVersionForReview({
      store: profileVersions,
      providerKey: c.req.param("providerKey"),
      profileVersion: c.req.param("profileVersion"),
    });

    return c.json(result);
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
    const job = await services.getBulkReviewJob(c.req.param("jobId"), c.get("context"));
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
    const job = await services.getBulkReviewJob(jobId, c.get("context"));
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

    return streamBulkJobEvents(services, jobId, c.req.raw, c.get("context"));
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

    let job;
    try {
      job = await services.enqueueIntegrationJob({
        action,
        scope: parseIntegrationJobScope(body.scope),
        context: c.get("context"),
      });
    } catch (error) {
      if (!isIntegrationJobValidationError(error)) {
        throw error;
      }

      return c.json(
        {
          error: {
            code: "invalid_scope",
            message: error.message,
          },
        },
        400,
      );
    }

    return c.json(job, 202);
  });

  app.get("/integration-jobs/active", async (c) => {
    const items = await services.listActiveIntegrationJobs({
      context: c.get("context"),
    });

    return c.json({ items, total: items.length, count: items.length });
  });

  app.get("/integration-jobs/:jobId", async (c) => {
    const job = await services.getIntegrationJob(c.req.param("jobId"), c.get("context"));
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
    const job = await services.getIntegrationJob(jobId, c.get("context"));
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

    return streamIntegrationJobEvents(services, jobId, c.req.raw, c.get("context"));
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
  const provider = stringField(record.provider) ?? stringField(record.source);
  const language = stringField(record.language) ?? stringField(record.languageCode);
  const seriesId = stringField(record.seriesId);
  const setId = stringField(record.expansionId) ?? stringField(record.setId);
  const scope = {
    ...(provider ? { provider } : {}),
    ...(language ? { language } : {}),
    ...(seriesId ? { seriesId } : {}),
    ...(setId ? { setId } : {}),
  };

  if (provider?.toLowerCase() !== "tcgplayer") {
    return scope;
  }

  const productLineId =
    stringField(record.productLineId) ?? stringField(record.categoryId) ?? stringField(record.seriesId);
  const setName = stringField(record.setName) ?? stringField(record.cleanSetName) ?? stringField(record.setId);
  const productId = stringField(record.productId) ?? stringField(record.tcgplayerProductId);

  return {
    ...scope,
    ...(productLineId ? { productLineId } : {}),
    ...(setName ? { setName } : {}),
    ...(productId ? { productId } : {}),
  };
}

function promotionScopeToIntegrationScope(scope: SourceObservationFilterScope) {
  return {
    provider: scope.provider,
    language: scope.language,
    setId: scope.setId,
  };
}

function isIntegrationJobValidationError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.includes("does not support background import") ||
      error.message.includes("No active Catalog source observation import provider is configured"))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readJsonObject(c: Context<CatalogAuthoringEnv>): Promise<Record<string, unknown> | Response> {
  try {
    const body = (await c.req.json()) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return c.json(
        {
          error: {
            code: "invalid_json_body",
            message: t("catalog.features.sourceObservations.api.route.profile.review.invalid.json.object"),
          },
        },
        400,
      );
    }
    return body as Record<string, unknown>;
  } catch {
    return c.json(
      {
        error: {
          code: "invalid_json_body",
          message: t("catalog.features.sourceObservations.api.route.profile.review.invalid.json.valid.object"),
        },
      },
      400,
    );
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function toJsonValue(value: unknown): JsonValue {
  return value === undefined ? null : (value as JsonValue);
}

function authoringAuditFromContext(context: CatalogAuthoringEnv["Variables"]["context"]) {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    createdByUserId: context.audit.performedByUserId,
    createdForAccountId: context.audit.forAccountId,
    updatedAt: now,
    updatedByUserId: context.audit.performedByUserId,
    updatedForAccountId: context.audit.forAccountId,
  };
}

function parseObservationIds(input: unknown): string[] {
  return Array.isArray(input) ? input.map((observationId: unknown) => String(observationId)) : [];
}

function streamBulkJobEvents(
  services: BulkReviewJobServices,
  jobId: string,
  request: Request,
  context: CatalogAuthoringEnv["Variables"]["context"],
) {
  return createDurableJobEventStream({
    request,
    signal: request.signal,
    streamLimitKey: sourceObservationStreamLimitKey(context),
    loadEvents: async (afterSequence) =>
      (await services.listBulkReviewJobEvents(jobId, afterSequence)).map((event) => ({
        sequence: event.sequence,
        eventName: event.eventName,
        data: event.job,
      })),
    loadCurrentSnapshot: () => services.getBulkReviewJob(jobId, context),
    waitForEvents: (_afterSequence, signal) => services.waitForBulkReviewJobEvents(jobId, signal),
    isTerminal: (event) => event.data.status === "completed" || event.data.status === "failed",
    isTerminalSnapshot: (snapshot) => snapshot.status === "completed" || snapshot.status === "failed",
  });
}

function streamIntegrationJobEvents(
  services: IntegrationJobServices,
  jobId: string,
  request: Request,
  context: CatalogAuthoringEnv["Variables"]["context"],
) {
  return createDurableJobEventStream({
    request,
    signal: request.signal,
    streamLimitKey: sourceObservationStreamLimitKey(context),
    loadEvents: async (afterSequence) =>
      (await services.listIntegrationJobEvents(jobId, afterSequence)).map((event) => ({
        sequence: event.sequence,
        eventName: event.eventName,
        data: event.job,
      })),
    loadCurrentSnapshot: () => services.getIntegrationJob(jobId, context),
    waitForEvents: (_afterSequence, signal) => services.waitForIntegrationJobEvents(jobId, signal),
    isTerminal: (event) => event.data.status === "completed" || event.data.status === "failed",
    isTerminalSnapshot: (snapshot) => snapshot.status === "completed" || snapshot.status === "failed",
  });
}

function sourceObservationStreamLimitKey(context: CatalogAuthoringEnv["Variables"]["context"]) {
  return `account:${context.audit.forAccountId}:user:${context.audit.performedByUserId}`;
}
