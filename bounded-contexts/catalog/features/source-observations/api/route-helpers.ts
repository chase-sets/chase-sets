import { t } from "@chase-sets/localization";
import { createDurableJobEventStream } from "@chase-sets/platform-runtime/durable-job-events";
import type { JsonValue } from "@chase-sets/primitives/json";
import type { Context } from "hono";
import type { CatalogAuthoringEnv } from "../../../support/authoring-support/api";
import type { SourceObservationFilterScope } from "../read-model/queries";
import type { BulkReviewJobServices, IntegrationJobServices, SourceObservationIntegrationJobScope } from "./runtime";

export function parsePromotionScope(input: unknown): SourceObservationFilterScope {
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

export function parseIntegrationJobScope(input: unknown): SourceObservationIntegrationJobScope {
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

export function promotionScopeToIntegrationScope(
  scope: SourceObservationFilterScope,
): SourceObservationIntegrationJobScope {
  return {
    provider: scope.provider,
    language: scope.language,
    setId: scope.setId,
  };
}

export function isIntegrationJobValidationError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.message.includes("does not support background import") ||
      error.message.includes("No active Catalog source observation import provider is configured"))
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function readJsonObject(c: Context<CatalogAuthoringEnv>): Promise<Record<string, unknown> | Response> {
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

export function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function toJsonValue(value: unknown): JsonValue {
  return value === undefined ? null : (value as JsonValue);
}

export function authoringAuditFromContext(context: CatalogAuthoringEnv["Variables"]["context"]) {
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

export function parseObservationIds(input: unknown): string[] {
  return Array.isArray(input) ? input.map((observationId: unknown) => String(observationId)) : [];
}

export function streamBulkJobEvents(
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

export function streamIntegrationJobEvents(
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
