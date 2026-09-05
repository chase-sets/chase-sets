import { hc } from "hono/client";
import { honoClientResource } from "@chase-sets/http/hono-client";
import { attachResponseMetadata } from "@chase-sets/http/responses";
import type { buildCatalogAuthoringApi } from "../../authoring-support/api";

type CatalogAuthoringApiApp = ReturnType<typeof buildCatalogAuthoringApi>;

const DEFAULT_BASE_URL = "/api/catalog";

function apiErrorMessage(status: number, body: unknown): string {
  if (typeof body === "object" && body !== null && "error" in body) {
    const error = (body as Record<string, unknown>).error;
    if (typeof error === "string" && error.trim()) {
      return error;
    }
    if (typeof error === "object" && error !== null && "message" in error) {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === "string" && message.trim()) {
        return message;
      }
    }
  }

  return `API error ${status}`;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(apiErrorMessage(status, body));
  }
}

export type CatalogItemPublicationApiErrorCode =
  | "display-identity-degraded"
  | "display-identity-unavailable"
  | "display-identity-outdated";

export class CatalogItemPublicationApiError extends ApiError {
  public constructor(
    status: number,
    body: unknown,
    public readonly code: CatalogItemPublicationApiErrorCode,
    public readonly readiness: "degraded" | "unavailable" | "outdated",
    public readonly missingTokens: readonly string[],
  ) {
    super(status, body);
    this.name = "CatalogItemPublicationApiError";
  }
}

export interface CatalogApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}

export type CatalogBulkActionProgress = Readonly<{
  phase: string;
  completed: number;
  total: number;
  currentName: string | null;
  status: string | null;
}>;

export type CatalogBulkActionProgressOptions = Readonly<{
  onProgress?: (progress: CatalogBulkActionProgress) => void;
  signal?: AbortSignal;
}>;

export type CatalogBulkReviewJob<T = unknown> = Readonly<{
  jobId: string;
  action: "promote" | "reject" | "defer" | "reapply";
  selectionMode: "ids" | "filter";
  observationIds: readonly string[];
  scope: Readonly<Record<string, string | undefined>>;
  reason: string | null;
  profileSnapshot: CatalogIntegrationJob["profileSnapshot"];
  reapplyProfileMode: "original-source-profile" | "current-active-profile" | null;
  status: "queued" | "running" | "completed" | "failed";
  progress: CatalogBulkActionProgress;
  result: T | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}>;

export type CatalogIntegrationJob<T = unknown> = Readonly<{
  jobId: string;
  action: "import" | "reapply";
  scope: Readonly<Record<string, string | undefined>>;
  profileSnapshot: Readonly<{
    providerKey: string;
    profileKey: string;
    profileVersion: string;
    lifecycle: string;
    connectorKind: string;
    connectorSourceVersion: string | null;
    sourceMappingFingerprint: string;
  }> | null;
  reapplyProfileMode: "original-source-profile" | "current-active-profile" | null;
  status: "queued" | "running" | "completed" | "failed";
  operatorStatus: "queued" | "running" | "stale" | "retried" | "partial" | "failed" | "cancelled" | "completed";
  consistency: Readonly<{
    duplicateSubmissionPolicy: "reuse-active-job";
    profileSnapshotPolicy: "snapshotted-at-enqueue";
    retryResumePolicy: "skip-completed-outcomes";
    partialFailurePolicy: "mixed-outcomes";
    workUnitClaimPolicy: "leased-job-turns" | "leased-work-units";
  }>;
  progress: CatalogBulkActionProgress;
  result: T | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}>;

export type CatalogAuthoringBulkJob<T = unknown> = Readonly<{
  jobId: string;
  kind: string;
  action: string;
  status: "queued" | "running" | "completed" | "failed";
  progress: CatalogBulkActionProgress;
  result: T | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}>;

type CatalogIntegrationJobOutcome = Readonly<{
  providerKey: string;
  languageCode: string;
  expansionId: string | null;
  status: "imported" | "reapplied" | "skipped" | "failed";
  observed: number;
  reapplied: number;
  reason: string | null;
}>;

type CatalogSourceObservationIntegrationJobResult = Readonly<{
  requested: number;
  imported: number;
  observed: number;
  reapplied: number;
  skipped: number;
  failed: number;
  outcomes: readonly CatalogIntegrationJobOutcome[];
}>;

function queryFromString(query: string) {
  return Object.fromEntries(new URLSearchParams(query).entries());
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    const publicationError = catalogItemPublicationApiError(response.status, errorBody);
    if (publicationError) {
      throw publicationError;
    }
    throw new ApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as T;
}

function catalogItemPublicationApiError(status: number, body: unknown): CatalogItemPublicationApiError | null {
  if (!body || typeof body !== "object" || !("error" in body)) {
    return null;
  }
  const error = (body as Record<string, unknown>).error;
  if (!error || typeof error !== "object") {
    return null;
  }
  const record = error as Record<string, unknown>;
  const code = record.code;
  const readiness = record.readiness;
  if (
    (code !== "display-identity-degraded" &&
      code !== "display-identity-unavailable" &&
      code !== "display-identity-outdated") ||
    (readiness !== "degraded" && readiness !== "unavailable" && readiness !== "outdated") ||
    !Array.isArray(record.missingTokens) ||
    record.missingTokens.some((token) => typeof token !== "string")
  ) {
    return null;
  }
  return new CatalogItemPublicationApiError(status, body, code, readiness, record.missingTokens);
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

export function createCatalogApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch: providedFetch,
  headers: initialHeaders,
  credentials = "include",
}: CatalogApiClientOptions = {}) {
  const fetchImpl: typeof globalThis.fetch = (input, init) => (providedFetch ?? globalThis.fetch)(input, init);
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetchImpl(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const client = honoClientResource(
    hc<CatalogAuthoringApiApp>(baseUrl, {
      fetch: configuredFetch,
    }),
  );
  const headers = resolveHeaders(initialHeaders);

  return {
    async listDimensions<T>(query: string): Promise<T> {
      const response = await client.dimensions.$get({
        query: queryFromString(query),
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async getDimension<T>(id: string): Promise<T> {
      const response = await client.dimensions[":id"].$get({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async createDimension<T>(body: unknown): Promise<T> {
      const response = await client.dimensions.$post({
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async reviseDimension<T>(id: string, body: unknown): Promise<T> {
      const response = await client.dimensions[":id"].$put({
        param: { id },
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async activateDimension<T>(id: string): Promise<T> {
      const response = await client.dimensions[":id"].activate.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async deprecateDimension<T>(id: string): Promise<T> {
      const response = await client.dimensions[":id"].deprecate.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async archiveDimension<T>(id: string): Promise<T> {
      const response = await client.dimensions[":id"].archive.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async previewBulkDimensionLifecycle<T>(action: string, selection: unknown): Promise<T> {
      const response = await client.dimensions["bulk-lifecycle"].preview.$post({
        json: { action, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async confirmBulkDimensionLifecycle<T>(
      action: string,
      selection: unknown,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      const response = await client.dimensions["bulk-lifecycle"].confirm.$post({
        json: { action, selection },
        header: headers,
      });
      return waitForAuthoringBulkJobResult<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        onProgress: options.onProgress,
        signal: options.signal,
        job: await parseJsonResponse<CatalogAuthoringBulkJob<T>>(response),
      });
    },
    async addOption<T>(dimensionId: string, body: unknown): Promise<T> {
      const response = await client.dimensions[":id"].options.$post({
        param: { id: dimensionId },
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async reviseOption<T>(dimensionId: string, optionId: string, body: unknown): Promise<T> {
      const response = await client.dimensions[":id"].options[":optionId"].$put({
        param: { id: dimensionId, optionId },
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async deprecateOption<T>(dimensionId: string, optionId: string): Promise<T> {
      const response = await client.dimensions[":id"].options[":optionId"].deprecate.$post({
        param: { id: dimensionId, optionId },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async reactivateOption<T>(dimensionId: string, optionId: string): Promise<T> {
      const response = await client.dimensions[":id"].options[":optionId"].reactivate.$post({
        param: { id: dimensionId, optionId },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async reorderOptions<T>(dimensionId: string, optionIds: string[]): Promise<T> {
      const response = await client.dimensions[":id"].options.order.$put({
        param: { id: dimensionId },
        json: { optionIds },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },

    async listFields<T>(query: string): Promise<T> {
      const response = await client.fields.$get({
        query: queryFromString(query),
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async getField<T>(id: string): Promise<T> {
      const response = await client.fields[":id"].$get({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async createField<T>(body: unknown): Promise<T> {
      const response = await client.fields.$post({
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async reviseField<T>(id: string, body: unknown): Promise<T> {
      const response = await client.fields[":id"].$put({
        param: { id },
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async activateField<T>(id: string): Promise<T> {
      const response = await client.fields[":id"].activate.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async deprecateField<T>(id: string): Promise<T> {
      const response = await client.fields[":id"].deprecate.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async archiveField<T>(id: string): Promise<T> {
      const response = await client.fields[":id"].archive.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async previewBulkFieldLifecycle<T>(action: string, selection: unknown): Promise<T> {
      const response = await client.fields["bulk-lifecycle"].preview.$post({
        json: { action, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async confirmBulkFieldLifecycle<T>(
      action: string,
      selection: unknown,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      const response = await client.fields["bulk-lifecycle"].confirm.$post({
        json: { action, selection },
        header: headers,
      });
      return waitForAuthoringBulkJobResult<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        onProgress: options.onProgress,
        signal: options.signal,
        job: await parseJsonResponse<CatalogAuthoringBulkJob<T>>(response),
      });
    },

    async listDisplayTemplates<T>(query: string): Promise<T> {
      const response = await client["display-templates"].$get({
        query: queryFromString(query),
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async getDisplayTemplate<T>(id: string): Promise<T> {
      const response = await client["display-templates"][":id"].$get({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async createDisplayTemplate<T>(body: unknown): Promise<T> {
      const response = await client["display-templates"].$post({
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async reviseDisplayTemplate<T>(id: string, body: unknown): Promise<T> {
      const response = await client["display-templates"][":id"].$put({
        param: { id },
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async publishDisplayTemplate<T>(id: string): Promise<T> {
      const response = await client["display-templates"][":id"].publish.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async deprecateDisplayTemplate<T>(id: string): Promise<T> {
      const response = await client["display-templates"][":id"].deprecate.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async archiveDisplayTemplate<T>(id: string): Promise<T> {
      const response = await client["display-templates"][":id"].archive.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },

    async listComponents<T>(query: string): Promise<T> {
      const response = await client.components.$get({
        query: queryFromString(query),
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async getComponent<T>(id: string): Promise<T> {
      const response = await client.components[":id"].$get({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async createComponent<T>(body: unknown): Promise<T> {
      const response = await client.components.$post({
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async reviseComponent<T>(id: string, body: unknown): Promise<T> {
      const response = await client.components[":id"].$put({
        param: { id },
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async addFieldRule<T>(id: string, body: unknown): Promise<T> {
      const response = await client.components[":id"]["field-rules"].$post({
        param: { id },
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async removeFieldRule<T>(id: string, fieldId: string): Promise<T> {
      const response = await client.components[":id"]["field-rules"][":fieldId"].$delete({
        param: { id, fieldId },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async addDimensionRule<T>(id: string, body: unknown): Promise<T> {
      const response = await client.components[":id"]["dimension-rules"].$post({
        param: { id },
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async removeDimensionRule<T>(id: string, dimensionId: string): Promise<T> {
      const response = await client.components[":id"]["dimension-rules"][":dimensionId"].$delete({
        param: { id, dimensionId },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async activateComponent<T>(id: string): Promise<T> {
      const response = await client.components[":id"].activate.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async deprecateComponent<T>(id: string): Promise<T> {
      const response = await client.components[":id"].deprecate.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async archiveComponent<T>(id: string): Promise<T> {
      const response = await client.components[":id"].archive.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async previewBulkComponentLifecycle<T>(action: string, selection: unknown): Promise<T> {
      const response = await client.components["bulk-lifecycle"].preview.$post({
        json: { action, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async confirmBulkComponentLifecycle<T>(
      action: string,
      selection: unknown,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      const response = await client.components["bulk-lifecycle"].confirm.$post({
        json: { action, selection },
        header: headers,
      });
      return waitForAuthoringBulkJobResult<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        onProgress: options.onProgress,
        signal: options.signal,
        job: await parseJsonResponse<CatalogAuthoringBulkJob<T>>(response),
      });
    },

    async listBlueprints<T>(query: string): Promise<T> {
      const response = await client.blueprints.$get({
        query: queryFromString(query),
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async getBlueprint<T>(id: string): Promise<T> {
      const response = await client.blueprints[":id"].$get({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async createBlueprint<T>(body: unknown): Promise<T> {
      const response = await client.blueprints.$post({
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async reviseBlueprint<T>(id: string, body: unknown): Promise<T> {
      const response = await client.blueprints[":id"].$put({
        param: { id },
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async attachComponent<T>(id: string, componentId: string): Promise<T> {
      const response = await client.blueprints[":id"].components[":componentId"].$post({
        param: { id, componentId },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async detachComponent<T>(id: string, componentId: string): Promise<T> {
      const response = await client.blueprints[":id"].components[":componentId"].$delete({
        param: { id, componentId },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async setBlueprintFields<T>(id: string, fieldRules: unknown): Promise<T> {
      const response = await client.blueprints[":id"].fields.$put({
        param: { id },
        json: { fieldRules },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async setBlueprintDimensions<T>(id: string, dimensionRules: unknown): Promise<T> {
      const response = await client.blueprints[":id"].dimensions.$put({
        param: { id },
        json: { dimensionRules },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async setBlueprintProductResolutionRules<T>(id: string, canonicalDimensionOrder: string[]): Promise<T> {
      const response = await client.blueprints[":id"]["product-resolution-rules"].$put({
        param: { id },
        json: { canonicalDimensionOrder },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async publishBlueprint<T>(id: string): Promise<T> {
      const response = await client.blueprints[":id"].publish.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async deprecateBlueprint<T>(id: string): Promise<T> {
      const response = await client.blueprints[":id"].deprecate.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async archiveBlueprint<T>(id: string): Promise<T> {
      const response = await client.blueprints[":id"].archive.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async previewBulkBlueprintLifecycle<T>(action: string, selection: unknown): Promise<T> {
      const response = await client.blueprints["bulk-lifecycle"].preview.$post({
        json: { action, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async confirmBulkBlueprintLifecycle<T>(
      action: string,
      selection: unknown,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      const response = await client.blueprints["bulk-lifecycle"].confirm.$post({
        json: { action, selection },
        header: headers,
      });
      return waitForAuthoringBulkJobResult<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        onProgress: options.onProgress,
        signal: options.signal,
        job: await parseJsonResponse<CatalogAuthoringBulkJob<T>>(response),
      });
    },

    async listCategories<T>(query: string): Promise<T> {
      const response = await client.categories.$get({
        query: queryFromString(query),
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async getCategory<T>(id: string): Promise<T> {
      const response = await client.categories[":id"].$get({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async createCategory<T>(body: unknown): Promise<T> {
      const response = await client.categories.$post({
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async reviseCategory<T>(id: string, body: unknown): Promise<T> {
      const response = await client.categories[":id"].$put({
        param: { id },
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async publishCategory<T>(id: string): Promise<T> {
      const response = await client.categories[":id"].publish.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async deprecateCategory<T>(id: string): Promise<T> {
      const response = await client.categories[":id"].deprecate.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async archiveCategory<T>(id: string): Promise<T> {
      const response = await client.categories[":id"].archive.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async previewBulkCategoryLifecycle<T>(action: string, selection: unknown): Promise<T> {
      const response = await client.categories["bulk-lifecycle"].preview.$post({
        json: { action, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async confirmBulkCategoryLifecycle<T>(
      action: string,
      selection: unknown,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      const response = await client.categories["bulk-lifecycle"].confirm.$post({
        json: { action, selection },
        header: headers,
      });
      return waitForAuthoringBulkJobResult<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        onProgress: options.onProgress,
        signal: options.signal,
        job: await parseJsonResponse<CatalogAuthoringBulkJob<T>>(response),
      });
    },

    async listReferenceTypes<T>(query: string): Promise<T> {
      const response = await client["reference-types"].$get({
        query: queryFromString(query),
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async getReferenceType<T>(id: string): Promise<T> {
      const response = await client["reference-types"][":id"].$get({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async createReferenceType<T>(body: unknown): Promise<T> {
      const response = await client["reference-types"].$post({
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async reviseReferenceType<T>(id: string, body: unknown): Promise<T> {
      const response = await client["reference-types"][":id"].$put({
        param: { id },
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async publishReferenceType<T>(id: string): Promise<T> {
      const response = await client["reference-types"][":id"].publish.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async deprecateReferenceType<T>(id: string): Promise<T> {
      const response = await client["reference-types"][":id"].deprecate.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async archiveReferenceType<T>(id: string): Promise<T> {
      const response = await client["reference-types"][":id"].archive.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async previewBulkReferenceTypeLifecycle<T>(action: string, selection: unknown): Promise<T> {
      const response = await client["reference-types"]["bulk-lifecycle"].preview.$post({
        json: { action, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async confirmBulkReferenceTypeLifecycle<T>(
      action: string,
      selection: unknown,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      const response = await client["reference-types"]["bulk-lifecycle"].confirm.$post({
        json: { action, selection },
        header: headers,
      });
      return waitForAuthoringBulkJobResult<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        onProgress: options.onProgress,
        signal: options.signal,
        job: await parseJsonResponse<CatalogAuthoringBulkJob<T>>(response),
      });
    },

    async listReferenceRecords<T>(query: string): Promise<T> {
      const response = await client["reference-records"].$get({
        query: queryFromString(query),
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async getReferenceRecord<T>(id: string): Promise<T> {
      const response = await client["reference-records"][":id"].$get({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async createReferenceRecord<T>(body: unknown): Promise<T> {
      const response = await client["reference-records"].$post({
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async reviseReferenceRecord<T>(id: string, body: unknown): Promise<T> {
      const response = await client["reference-records"][":id"].$put({
        param: { id },
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async publishReferenceRecord<T>(id: string): Promise<T> {
      const response = await client["reference-records"][":id"].publish.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async deprecateReferenceRecord<T>(id: string): Promise<T> {
      const response = await client["reference-records"][":id"].deprecate.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async archiveReferenceRecord<T>(id: string): Promise<T> {
      const response = await client["reference-records"][":id"].archive.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async previewBulkReferenceRecordLifecycle<T>(action: string, selection: unknown): Promise<T> {
      const response = await client["reference-records"]["bulk-lifecycle"].preview.$post({
        json: { action, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async confirmBulkReferenceRecordLifecycle<T>(
      action: string,
      selection: unknown,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      const response = await client["reference-records"]["bulk-lifecycle"].confirm.$post({
        json: { action, selection },
        header: headers,
      });
      return waitForAuthoringBulkJobResult<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        onProgress: options.onProgress,
        signal: options.signal,
        job: await parseJsonResponse<CatalogAuthoringBulkJob<T>>(response),
      });
    },

    async listCatalogItems<T>(query: string): Promise<T> {
      const response = await client.items.$get({
        query: queryFromString(query),
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async getCatalogItem<T>(id: string): Promise<T> {
      const response = await client.items[":id"].$get({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async listProductContentTypes<T>(): Promise<T> {
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/product-contents/content-types`, {
        method: "GET",
        headers: headersToRecord(headers),
      });
      return parseJsonResponse<T>(response);
    },
    async listProductContentInclusionPolicies<T>(): Promise<T> {
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/product-contents/inclusion-policies`, {
        method: "GET",
        headers: headersToRecord(headers),
      });
      return parseJsonResponse<T>(response);
    },
    async listProductContentsForContainer<T>(id: string): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/product-contents/containers/${encodeURIComponent(id)}`,
        {
          method: "GET",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async listProductContainersForContained<T>(id: string): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/product-contents/contained/${encodeURIComponent(id)}`,
        {
          method: "GET",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async replaceProductContents<T>(id: string, body: unknown): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/product-contents/containers/${encodeURIComponent(id)}`,
        {
          method: "PUT",
          headers: {
            "content-type": "application/json",
            ...headersToRecord(headers),
          },
          body: JSON.stringify(body),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async removeProductContents<T>(id: string, body: unknown): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/product-contents/containers/${encodeURIComponent(id)}`,
        {
          method: "DELETE",
          headers: {
            "content-type": "application/json",
            ...headersToRecord(headers),
          },
          body: JSON.stringify(body),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async createCatalogItem<T>(body: unknown): Promise<T> {
      const response = await client.items.$post({
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async assignBlueprint<T>(id: string, blueprintId: string): Promise<T> {
      const response = await client.items[":id"].blueprint.$post({
        param: { id },
        json: { blueprintId },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async setFieldValue<T>(id: string, fieldId: string, value: unknown): Promise<T> {
      const response = await client.items[":id"].fields[":fieldId"].$put({
        param: { id, fieldId },
        json: { value },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async clearFieldValue<T>(id: string, fieldId: string): Promise<T> {
      const response = await client.items[":id"].fields[":fieldId"].$delete({
        param: { id, fieldId },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async assignCategory<T>(id: string, categoryId: string): Promise<T> {
      const response = await client.items[":id"].categories[":categoryId"].$post({
        param: { id, categoryId },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async removeCategory<T>(id: string, categoryId: string): Promise<T> {
      const response = await client.items[":id"].categories[":categoryId"].$delete({
        param: { id, categoryId },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async publishCatalogItem<T>(id: string, blueprintIsActive: boolean, requiredFieldIds: string[]): Promise<T> {
      const response = await client.items[":id"].publish.$post({
        param: { id },
        json: { blueprintIsActive, requiredFieldIds },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async previewBulkPublishCatalogItems<T>(selection: unknown): Promise<T> {
      const response = await client.items["bulk-publish"].preview.$post({
        json: { selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async confirmBulkPublishCatalogItems<T>(
      itemIds: readonly string[],
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      const response = await client.items["bulk-publish"].confirm.$post({
        json: { itemIds },
        header: headers,
      });
      return waitForAuthoringBulkJobResult<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        onProgress: options.onProgress,
        signal: options.signal,
        job: await parseJsonResponse<CatalogAuthoringBulkJob<T>>(response),
      });
    },
    async reviseMetadata<T>(id: string, body: unknown): Promise<T> {
      const response = await client.items[":id"].metadata.$put({
        param: { id },
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async archiveCatalogItem<T>(id: string): Promise<T> {
      const response = await client.items[":id"].archive.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async removeDraftCatalogItem<T>(id: string): Promise<T> {
      const response = await client.items[":id"].$delete({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async previewBulkCatalogItemLifecycle<T>(action: string, selection: unknown): Promise<T> {
      const response = await client.items["bulk-lifecycle"].preview.$post({
        json: { action, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async confirmBulkCatalogItemLifecycle<T>(
      action: string,
      selection: unknown,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      const response = await client.items["bulk-lifecycle"].confirm.$post({
        json: { action, selection },
        header: headers,
      });
      return waitForAuthoringBulkJobResult<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        onProgress: options.onProgress,
        signal: options.signal,
        job: await parseJsonResponse<CatalogAuthoringBulkJob<T>>(response),
      });
    },
    async previewBulkCatalogItemEdit<T>(operation: unknown, selection: unknown): Promise<T> {
      const response = await client.items["bulk-edit"].preview.$post({
        json: { operation, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async confirmBulkCatalogItemEdit<T>(
      operation: unknown,
      selection: unknown,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      const response = await client.items["bulk-edit"].confirm.$post({
        json: { operation, selection },
        header: headers,
      });
      return waitForAuthoringBulkJobResult<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        onProgress: options.onProgress,
        signal: options.signal,
        job: await parseJsonResponse<CatalogAuthoringBulkJob<T>>(response),
      });
    },
    async setTags<T>(id: string, tags: string[]): Promise<T> {
      const response = await client.items[":id"].tags.$put({
        param: { id },
        json: { tags },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async setImageUrls<T>(id: string, imageUrls: string[]): Promise<T> {
      const response = await client.items[":id"]["image-urls"].$put({
        param: { id },
        json: { imageUrls },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async setImageFallback<T>(id: string, imageFallback: unknown): Promise<T> {
      const response = await client.items[":id"]["image-fallback"].$put({
        param: { id },
        json: { imageFallback },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async clearImageFallback<T>(id: string): Promise<T> {
      const response = await client.items[":id"]["image-fallback"].$delete({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async linkExternalProductReference<T>(
      id: string,
      providerKey: string,
      externalKey: string,
      selectedOptions: unknown,
    ): Promise<T> {
      const response = await client.items[":id"]["external-product-references"][":providerKey"][":externalKey"].$put({
        param: { id, providerKey, externalKey },
        json: { selectedOptions },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async unlinkExternalProductReference<T>(id: string, providerKey: string, externalKey: string): Promise<T> {
      const response = await client.items[":id"]["external-product-references"][":providerKey"][":externalKey"].$delete(
        {
          param: { id, providerKey, externalKey },
          header: headers,
        },
      );
      return parseJsonResponse<T>(response);
    },
    async linkExternalCatalogItemReference<T>(id: string, providerKey: string, externalKey: string): Promise<T> {
      const response = await client.items[":id"]["external-catalog-item-references"][":providerKey"][
        ":externalKey"
      ].$put({
        param: { id, providerKey, externalKey },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async unlinkExternalCatalogItemReference<T>(id: string, providerKey: string, externalKey: string): Promise<T> {
      const response = await client.items[":id"]["external-catalog-item-references"][":providerKey"][
        ":externalKey"
      ].$delete({
        param: { id, providerKey, externalKey },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },

    async listSourceObservations<T>(query: string): Promise<T> {
      const response = await client["source-observations"].$get({
        query: queryFromString(query),
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async listSourceObservationIntegrationScopes<T>(query: string): Promise<T> {
      const response = await client["source-observations"]["integration-scopes"].$get({
        query: queryFromString(query),
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async listSourceObservationIntegrationOptions<T>(query: string): Promise<T> {
      const response = await client["source-observations"]["integration-options"].$get({
        query: queryFromString(query),
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async getCatalogIntegrationControlPlaneReadiness<T>(): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/integration-control-plane/readiness`,
        {
          method: "GET",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async getCatalogIntegrationControlPlaneOverview<T>(audience?: "full" | "daily"): Promise<T> {
      // The daily import surface passes `daily` to fetch the audit-lifecycle-trimmed
      // overview it actually renders; the other surfaces omit it and receive
      // the full overview their evidence slices cite.
      const query = audience === "daily" ? "?audience=daily" : "";
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/integration-control-plane/overview${query}`,
        {
          method: "GET",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async recordCatalogControlPlaneEvent<T>(event: unknown): Promise<T> {
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/source-observations/control-plane-events`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headersToRecord(headers),
        },
        body: JSON.stringify(event),
      });
      return parseJsonResponse<T>(response);
    },
    async listSourceObservationProviderProfiles<T>(): Promise<T> {
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/source-observations/provider-profiles`, {
        method: "GET",
        headers: headersToRecord(headers),
      });
      return parseJsonResponse<T>(response);
    },
    async getSourceObservationProviderProfileAuthoringModel<T>(
      providerKey: string,
      profileVersion: string,
    ): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/provider-profiles/${encodeURIComponent(providerKey)}/${encodeURIComponent(profileVersion)}/authoring`,
        {
          method: "GET",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async createSourceObservationProviderProfile<T>(version: unknown): Promise<T> {
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/source-observations/provider-profiles`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headersToRecord(headers),
        },
        body: JSON.stringify({ version }),
      });
      return parseJsonResponse<T>(response);
    },
    async updateSourceObservationProviderProfileSection<T>(
      providerKey: string,
      profileVersion: string,
      section: string,
      command: unknown,
    ): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/provider-profiles/${encodeURIComponent(providerKey)}/${encodeURIComponent(profileVersion)}/sections/${encodeURIComponent(section)}`,
        {
          method: "PATCH",
          headers: {
            "content-type": "application/json",
            ...headersToRecord(headers),
          },
          body: JSON.stringify({ command }),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async dryRunSourceObservationProviderProfile<T>(
      providerKey: string,
      profileVersion: string,
      payload: unknown,
    ): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/provider-profiles/${encodeURIComponent(providerKey)}/${encodeURIComponent(profileVersion)}/dry-run`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headersToRecord(headers),
          },
          body: JSON.stringify({ payload }),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async cloneSourceObservationProviderProfile<T>(
      providerKey: string,
      profileVersion: string,
      body: unknown,
    ): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/provider-profiles/${encodeURIComponent(providerKey)}/${encodeURIComponent(profileVersion)}/clone`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headersToRecord(headers),
          },
          body: JSON.stringify(body),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async activateSourceObservationProviderProfile<T>(providerKey: string, profileVersion: string): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/provider-profiles/${encodeURIComponent(providerKey)}/${encodeURIComponent(profileVersion)}/activate`,
        {
          method: "POST",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async getSourceObservationProviderProfileLifecycleImpact<T>(
      providerKey: string,
      profileVersion: string,
      operation: "activation" | "rollback" | "deprecate" | "retire",
    ): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/provider-profiles/${encodeURIComponent(providerKey)}/${encodeURIComponent(profileVersion)}/lifecycle-impact?operation=${encodeURIComponent(operation)}`,
        {
          method: "GET",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async rollbackSourceObservationProviderProfile<T>(providerKey: string, profileVersion: string): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/provider-profiles/${encodeURIComponent(providerKey)}/${encodeURIComponent(profileVersion)}/rollback`,
        {
          method: "POST",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async retireSourceObservationProviderProfile<T>(providerKey: string, profileVersion: string): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/provider-profiles/${encodeURIComponent(providerKey)}/${encodeURIComponent(profileVersion)}/retire`,
        {
          method: "POST",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async deprecateSourceObservationProviderProfile<T>(providerKey: string, profileVersion: string): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/provider-profiles/${encodeURIComponent(providerKey)}/${encodeURIComponent(profileVersion)}/deprecate`,
        {
          method: "POST",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async getSourceObservation<T>(id: string): Promise<T> {
      const response = await client["source-observations"][":id"].$get({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async listCatalogMergeCandidates<T>(query = ""): Promise<T> {
      const search = query ? `?${new URLSearchParams(queryFromString(query)).toString()}` : "";
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/merge-candidates${search}`,
        {
          method: "GET",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async generateCatalogMergeCandidates<T>(body: unknown): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/merge-candidates/generate`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headersToRecord(headers),
          },
          body: JSON.stringify(body),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async promoteCatalogMergeCandidate<T>(candidateId: string, body: unknown): Promise<T> {
      return dispatchCatalogMergeCandidateAction<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        candidateId,
        action: "promote",
        body,
      });
    },
    async splitCatalogMergeCandidate<T>(candidateId: string, body: unknown): Promise<T> {
      return dispatchCatalogMergeCandidateAction<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        candidateId,
        action: "split",
        body,
      });
    },
    async updateCatalogMergeCandidate<T>(candidateId: string, body: unknown): Promise<T> {
      return dispatchCatalogMergeCandidateAction<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        candidateId,
        action: "update",
        body,
      });
    },
    async ignoreCatalogMergeCandidate<T>(candidateId: string, body: unknown): Promise<T> {
      return dispatchCatalogMergeCandidateAction<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        candidateId,
        action: "ignore",
        body,
      });
    },
    async deferCatalogMergeCandidate<T>(candidateId: string, body: unknown): Promise<T> {
      return dispatchCatalogMergeCandidateAction<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        candidateId,
        action: "defer",
        body,
      });
    },
    async bulkPromoteSourceObservations<T>(
      observationIds: string[],
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      if (options.onProgress) {
        const job = await startBulkJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          path: "/source-observations/bulk-promote/jobs",
          body: { observationIds },
          errorMessage: "Bulk Source Observation promotion failed.",
        });
        return streamBulkJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          jobId: job.jobId,
          onProgress: options.onProgress,
          signal: options.signal,
          errorMessage: "Bulk Source Observation promotion failed.",
        });
      }

      const response = await client["source-observations"]["bulk-promote"].$post({
        json: { observationIds },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async previewBulkPromoteSourceObservations<T>(scope: unknown): Promise<T> {
      const response = await client["source-observations"]["bulk-promote"].preview.$post({
        json: { scope },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async previewBulkPromoteSourceObservationIds<T>(observationIds: string[]): Promise<T> {
      const response = await client["source-observations"]["bulk-promote"].preview.$post({
        json: { observationIds },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async bulkPromoteSourceObservationsByScope<T>(
      scope: unknown,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      if (options.onProgress) {
        const job = await startBulkJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          path: "/source-observations/bulk-promote/jobs",
          body: { scope },
          errorMessage: "Bulk Source Observation promotion failed.",
        });
        return streamBulkJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          jobId: job.jobId,
          onProgress: options.onProgress,
          signal: options.signal,
          errorMessage: "Bulk Source Observation promotion failed.",
        });
      }

      const response = await client["source-observations"]["bulk-promote"].$post({
        json: { scope },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async previewReapplySourceObservations<T>(scope: unknown): Promise<T> {
      const response = await client["source-observations"].reapply.preview.$post({
        json: { scope },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async reapplySourceObservations<T>(
      observationIds: string[],
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      if (options.onProgress) {
        const job = await startBulkJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          path: "/source-observations/reapply",
          body: { observationIds },
          errorMessage: "Source Observation reapply failed.",
        });
        return streamBulkJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          jobId: job.jobId,
          onProgress: options.onProgress,
          signal: options.signal,
          errorMessage: "Source Observation reapply failed.",
        });
      }

      const response = await client["source-observations"].reapply.$post({
        json: { observationIds },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async replaySourceObservations<T>(
      observationIds: string[],
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      const body = { observationIds, reapplyProfileMode: "original-source-profile" };
      if (options.onProgress) {
        const job = await startBulkJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          path: "/source-observations/reapply",
          body,
          errorMessage: "Source Observation replay failed.",
        });
        return streamBulkJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          jobId: job.jobId,
          onProgress: options.onProgress,
          signal: options.signal,
          errorMessage: "Source Observation replay failed.",
        });
      }

      const response = await client["source-observations"].reapply.$post({
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async reapplySourceObservationsByScope<T>(
      scope: unknown,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      if (options.onProgress) {
        const job = await startIntegrationJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          action: "reapply",
          scope,
        });
        return streamIntegrationJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          jobId: job.jobId,
          onProgress: options.onProgress,
          signal: options.signal,
          errorMessage: "Source Observation reapply failed.",
        });
      }

      const response = await client["source-observations"].reapply.$post({
        json: { scope },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async replaySourceObservationsByScope<T>(
      scope: unknown,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      if (options.onProgress) {
        const job = await startIntegrationJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          action: "reapply",
          scope,
          reapplyProfileMode: "original-source-profile",
        });
        return streamIntegrationJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          jobId: job.jobId,
          onProgress: options.onProgress,
          signal: options.signal,
          errorMessage: "Source Observation replay failed.",
        });
      }

      const response = await client["source-observations"].reapply.$post({
        json: { scope, reapplyProfileMode: "original-source-profile" },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async promoteSourceObservation<T>(id: string): Promise<T> {
      const response = await client["source-observations"][":id"].promote.$post({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async rejectSourceObservation<T>(id: string, reason: string): Promise<T> {
      const response = await client["source-observations"][":id"].reject.$post({
        param: { id },
        json: { reason },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async bulkRejectSourceObservations<T>(
      observationIds: string[],
      reason: string,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      if (options.onProgress) {
        const job = await startBulkJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          path: "/source-observations/bulk-reject/jobs",
          body: { observationIds, reason },
          errorMessage: "Bulk Source Observation rejection failed.",
        });
        return streamBulkJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          jobId: job.jobId,
          onProgress: options.onProgress,
          signal: options.signal,
          errorMessage: "Bulk Source Observation rejection failed.",
        });
      }

      const response = await client["source-observations"]["bulk-reject"].$post({
        json: { observationIds, reason },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async bulkRejectSourceObservationsByScope<T>(
      scope: unknown,
      reason: string,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      if (options.onProgress) {
        const job = await startBulkJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          path: "/source-observations/bulk-reject/jobs",
          body: { scope, reason },
          errorMessage: "Bulk Source Observation rejection failed.",
        });
        return streamBulkJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          jobId: job.jobId,
          onProgress: options.onProgress,
          signal: options.signal,
          errorMessage: "Bulk Source Observation rejection failed.",
        });
      }

      const response = await client["source-observations"]["bulk-reject"].$post({
        json: { scope, reason },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async deferSourceObservations<T>(
      observationIds: string[],
      reason: string,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      if (options.onProgress) {
        const job = await startBulkJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          path: "/source-observations/bulk-defer/jobs",
          body: { observationIds, reason },
          errorMessage: "Bulk Source Observation deferral failed.",
        });
        return streamBulkJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          jobId: job.jobId,
          onProgress: options.onProgress,
          signal: options.signal,
          errorMessage: "Bulk Source Observation deferral failed.",
        });
      }

      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/source-observations/bulk-defer/jobs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headersToRecord(headers),
        },
        body: JSON.stringify({ observationIds, reason }),
      });
      return parseJsonResponse<T>(response);
    },
    async deferSourceObservationsByScope<T>(
      scope: unknown,
      reason: string,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      if (options.onProgress) {
        const job = await startBulkJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          path: "/source-observations/bulk-defer/jobs",
          body: { scope, reason },
          errorMessage: "Bulk Source Observation deferral failed.",
        });
        return streamBulkJob<T>({
          baseUrl,
          fetch: configuredFetch,
          headers,
          jobId: job.jobId,
          onProgress: options.onProgress,
          signal: options.signal,
          errorMessage: "Bulk Source Observation deferral failed.",
        });
      }

      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/source-observations/bulk-defer/jobs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headersToRecord(headers),
        },
        body: JSON.stringify({ scope, reason }),
      });
      return parseJsonResponse<T>(response);
    },
    async listActiveSourceObservationBulkJobs<T>(): Promise<T> {
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/source-observations/bulk-jobs/active`, {
        method: "GET",
        headers: headersToRecord(headers),
      });
      return parseJsonResponse<T>(response);
    },
    async getSourceObservationPromotionOutcome<T>(jobId: string): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/bulk-jobs/${encodeURIComponent(jobId)}/outcome`,
        {
          method: "GET",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async enqueueSourceObservationIntegrationJob<T>(
      action: "import" | "reapply",
      scope: unknown,
      options: { reapplyProfileMode?: "original-source-profile" | "current-active-profile" | null } = {},
    ): Promise<T> {
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/source-observations/integration-jobs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headersToRecord(headers),
        },
        body: JSON.stringify({
          action,
          scope,
          ...(action === "reapply" && options.reapplyProfileMode !== undefined
            ? { reapplyProfileMode: options.reapplyProfileMode }
            : {}),
        }),
      });
      return parseJsonResponse<T>(response);
    },
    async previewSourceObservationIntegrationImport<T>(scope: unknown): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/integration-jobs/preview`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headersToRecord(headers),
          },
          body: JSON.stringify({
            action: "import",
            scope,
          }),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async previewCatalogSyncScope<T>(scope: unknown): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/catalog-sync-scope/preview`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headersToRecord(headers),
          },
          body: JSON.stringify({ scope }),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async enqueueCatalogSyncRun<T>(scope: unknown): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/catalog-sync-scope/runs`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headersToRecord(headers),
          },
          body: JSON.stringify({ scope }),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async getCatalogSyncRun<T>(syncRunId: string): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/catalog-sync-scope/runs/${encodeURIComponent(syncRunId)}`,
        {
          method: "GET",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async getCatalogSyncScopeState<T>(scope: unknown): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/catalog-sync-scope/state`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headersToRecord(headers),
          },
          body: JSON.stringify({ scope }),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async retrySourceObservationIntegrationJob<T>(jobId: string): Promise<T> {
      return sourceObservationIntegrationJobLifecycleCommand<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        jobId,
        command: "retry",
      });
    },
    async resumeSourceObservationIntegrationJob<T>(jobId: string): Promise<T> {
      return sourceObservationIntegrationJobLifecycleCommand<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        jobId,
        command: "resume",
      });
    },
    async cancelSourceObservationIntegrationJob<T>(jobId: string): Promise<T> {
      return sourceObservationIntegrationJobLifecycleCommand<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        jobId,
        command: "cancel",
      });
    },
    async listActiveSourceObservationIntegrationJobs<T>(): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/source-observations/integration-jobs/active`,
        {
          method: "GET",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async watchSourceObservationIntegrationJob<T>(
      jobId: string,
      options: CatalogBulkActionProgressOptions = {},
    ): Promise<T> {
      return streamIntegrationJob<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        jobId,
        onProgress: options.onProgress ?? (() => {}),
        signal: options.signal,
        errorMessage: "Source Observation integration job failed.",
      });
    },
    async getCatalogScopeRecord<T>(id: string): Promise<T> {
      const response = await client["scope-records"][":id"].$get({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async listCatalogScopeRecords<T>(query = ""): Promise<T> {
      const search = query ? `?${new URLSearchParams(queryFromString(query)).toString()}` : "";
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/scope-records${search}`, {
        method: "GET",
        headers: headersToRecord(headers),
      });
      return parseJsonResponse<T>(response);
    },
    async previewScopeSyncBatch<T>(input: unknown): Promise<T> {
      return scopeSyncBatchRequest<T>(configuredFetch, headers, baseUrl, "/preview", input);
    },
    async confirmScopeSyncBatch<T>(input: unknown): Promise<T> {
      return scopeSyncBatchRequest<T>(configuredFetch, headers, baseUrl, "/confirm", input);
    },
    async getScopeSyncBatch<T>(batchId: string): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/scope-sync-batches/${encodeURIComponent(batchId)}`,
        { method: "GET", headers: headersToRecord(headers) },
      );
      return parseJsonResponse<T>(response);
    },
    async cancelScopeSyncBatch<T>(batchId: string): Promise<T> {
      return scopeSyncBatchRequest<T>(configuredFetch, headers, baseUrl, `/${encodeURIComponent(batchId)}/cancel`);
    },
    async resumeScopeSyncBatch<T>(batchId: string): Promise<T> {
      return scopeSyncBatchRequest<T>(configuredFetch, headers, baseUrl, `/${encodeURIComponent(batchId)}/resume`);
    },
    async retryScopeSyncBatchUnit<T>(batchId: string, scopeRecordId: string): Promise<T> {
      return scopeSyncBatchRequest<T>(
        configuredFetch,
        headers,
        baseUrl,
        `/${encodeURIComponent(batchId)}/units/${encodeURIComponent(scopeRecordId)}/retry`,
      );
    },
    async getCatalogAliasReviewReadModel<T>(query = ""): Promise<T> {
      const search = query ? `?${new URLSearchParams(queryFromString(query)).toString()}` : "";
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/alias-review${search}`, {
        method: "GET",
        headers: headersToRecord(headers),
      });
      return parseJsonResponse<T>(response);
    },
    async dispatchCatalogAliasReviewCommand<T>(input: {
      intent: "accept" | "reject" | "revoke";
      aliasHashes: readonly string[];
      reason?: string;
    }): Promise<T> {
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/alias-review/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headersToRecord(headers),
        },
        body: JSON.stringify({
          intent: input.intent,
          aliasHashes: input.aliasHashes.join(","),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        }),
      });
      return parseJsonResponse<T>(response);
    },
    async getCatalogAttentionQueueReadModel<T>(): Promise<T> {
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/attention-queue`, {
        method: "GET",
        headers: headersToRecord(headers),
      });
      return parseJsonResponse<T>(response);
    },
    async getUnmappedScopeInbox<T>(limit?: number): Promise<T> {
      const search = limit ? `?limit=${encodeURIComponent(String(limit))}` : "";
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/provider-scope-mappings/inbox${search}`, {
        method: "GET",
        headers: headersToRecord(headers),
      });
      return parseJsonResponse<T>(response);
    },
    async dispatchCatalogAttentionQueueCommand<T>(input: {
      intent: "dismiss" | "defer" | "restore";
      itemKey: string;
      kind?: string;
      reason?: string;
      deferredUntil?: string;
      deferHours?: number;
    }): Promise<T> {
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/attention-queue/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headersToRecord(headers),
        },
        body: JSON.stringify({
          intent: input.intent,
          itemKey: input.itemKey,
          ...(input.kind !== undefined ? { kind: input.kind } : {}),
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
          ...(input.deferredUntil !== undefined ? { deferredUntil: input.deferredUntil } : {}),
          ...(input.deferHours !== undefined ? { deferHours: input.deferHours } : {}),
        }),
      });
      return parseJsonResponse<T>(response);
    },
    async getScopeCoverageMatrix<T>(scopeRecordId: string): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/provider-scope-mappings/coverage/${encodeURIComponent(scopeRecordId)}`,
        {
          method: "GET",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async listCatalogProviderRefreshSchedules<T>(): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/provider-scope-discovery/refresh-schedule`,
        {
          method: "GET",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async dispatchProviderScopeMappingReviewCommand<T>(input: {
      intent: "accept" | "reject" | "revoke";
      mappingIds: readonly string[];
      reason?: string;
    }): Promise<T> {
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/provider-scope-mappings/commands`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headersToRecord(headers),
        },
        body: JSON.stringify({
          intent: input.intent,
          mappingIds: input.mappingIds,
          ...(input.reason !== undefined ? { reason: input.reason } : {}),
        }),
      });
      return parseJsonResponse<T>(response);
    },
    async proposeProviderScopeMapping<T>(input: {
      scopeRecordId: string;
      providerKey: string;
      unitKey: string;
      coordinates: {
        productLineId?: string | null;
        seriesId?: string | null;
        setId?: string | null;
        setName?: string | null;
      };
      confidence?: string;
      autoAccept?: boolean;
      reason?: string;
    }): Promise<T> {
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/provider-scope-mappings/propose`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headersToRecord(headers),
        },
        body: JSON.stringify(input),
      });
      return parseJsonResponse<T>(response);
    },
    async setCatalogProviderRefreshPaused<T>(input: {
      providerKey: string;
      paused: boolean;
      reason?: string | null;
    }): Promise<T> {
      const command = input.paused ? "pause" : "resume";
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/provider-scope-discovery/refresh-schedule/${encodeURIComponent(
          input.providerKey,
        )}/${command}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...headersToRecord(headers),
          },
          body: JSON.stringify(input.reason ? { reason: input.reason } : {}),
        },
      );
      return parseJsonResponse<T>(response);
    },
    async runCatalogProviderRefreshNow<T>(providerKey: string): Promise<T> {
      const response = await configuredFetch(
        `${baseUrl.replace(/\/$/, "")}/provider-scope-discovery/refresh-schedule/${encodeURIComponent(
          providerKey,
        )}/run`,
        {
          method: "POST",
          headers: headersToRecord(headers),
        },
      );
      return parseJsonResponse<T>(response);
    },
  };
}

export const api = createCatalogApiClient();

async function sourceObservationIntegrationJobLifecycleCommand<T>(input: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  headers?: HeadersInit;
  jobId: string;
  command: "retry" | "resume" | "cancel";
}): Promise<T> {
  const response = await input.fetch(
    `${input.baseUrl.replace(/\/$/, "")}/source-observations/integration-jobs/${encodeURIComponent(input.jobId)}/${
      input.command
    }`,
    {
      method: "POST",
      headers: headersToRecord(input.headers),
    },
  );
  return parseJsonResponse<T>(response);
}

async function dispatchCatalogMergeCandidateAction<T>(input: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  headers?: HeadersInit;
  candidateId: string;
  action: "promote" | "split" | "update" | "ignore" | "defer";
  body: unknown;
}): Promise<T> {
  const response = await input.fetch(
    `${input.baseUrl.replace(/\/$/, "")}/source-observations/admin/merge-candidates/${encodeURIComponent(
      input.candidateId,
    )}/${input.action}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...headersToRecord(input.headers),
      },
      body: JSON.stringify(input.body),
    },
  );
  return parseJsonResponse<T>(response);
}

async function startBulkJob<T>(input: {
  baseUrl: string;
  path: string;
  fetch: typeof globalThis.fetch;
  headers?: HeadersInit;
  body: unknown;
  errorMessage: string;
}): Promise<CatalogBulkReviewJob<T>> {
  const response = await input.fetch(`${input.baseUrl.replace(/\/$/, "")}${input.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headersToRecord(input.headers),
    },
    body: JSON.stringify(input.body),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new ApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as CatalogBulkReviewJob<T>;
}

async function startIntegrationJob<T>(input: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  headers?: HeadersInit;
  action: "import" | "reapply";
  scope: unknown;
  reapplyProfileMode?: "original-source-profile" | "current-active-profile" | null;
}): Promise<CatalogIntegrationJob<T>> {
  const response = await input.fetch(`${input.baseUrl.replace(/\/$/, "")}/source-observations/integration-jobs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headersToRecord(input.headers),
    },
    body: JSON.stringify({
      action: input.action,
      scope: input.scope,
      ...(input.reapplyProfileMode !== undefined ? { reapplyProfileMode: input.reapplyProfileMode } : {}),
    }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new ApiError(response.status, errorBody);
  }

  return attachResponseMetadata(await response.json(), response) as CatalogIntegrationJob<T>;
}

async function streamBulkJob<T>(input: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  headers?: HeadersInit;
  jobId: string;
  onProgress: (progress: CatalogBulkActionProgress) => void;
  signal?: AbortSignal;
  errorMessage: string;
}): Promise<T> {
  return streamJobEvents<CatalogBulkReviewJob<T>, T>({
    ...input,
    url: `${input.baseUrl.replace(/\/$/, "")}/source-observations/bulk-jobs/${encodeURIComponent(input.jobId)}/events`,
  });
}

async function streamIntegrationJob<T>(input: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  headers?: HeadersInit;
  jobId: string;
  onProgress: (progress: CatalogBulkActionProgress) => void;
  signal?: AbortSignal;
  errorMessage: string;
}): Promise<T> {
  return streamJobEvents<CatalogIntegrationJob<T>, T>({
    ...input,
    url: `${input.baseUrl.replace(/\/$/, "")}/source-observations/integration-jobs/${encodeURIComponent(input.jobId)}/events`,
  });
}

async function waitForAuthoringBulkJobResult<T>(input: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  headers?: HeadersInit;
  job: CatalogAuthoringBulkJob<T>;
  onProgress?: (progress: CatalogBulkActionProgress) => void;
  signal?: AbortSignal;
}): Promise<T> {
  input.onProgress?.(input.job.progress);

  if (input.job.status === "completed" && input.job.result) {
    return input.job.result;
  }

  if (input.job.status === "failed") {
    throw new Error(input.job.errorMessage ?? "Catalog authoring bulk job failed.");
  }

  return streamJobEvents<CatalogAuthoringBulkJob<T>, T>({
    url: `${input.baseUrl.replace(/\/$/, "")}/bulk-authoring-jobs/${encodeURIComponent(input.job.jobId)}/events`,
    fetch: input.fetch,
    headers: input.headers,
    onProgress: input.onProgress ?? (() => {}),
    signal: input.signal,
    errorMessage: "Catalog authoring bulk job failed.",
  });
}

async function streamJobEvents<
  TJob extends Readonly<{
    status: "queued" | "running" | "completed" | "failed";
    progress: CatalogBulkActionProgress;
    result: TResult | null;
    errorMessage: string | null;
  }>,
  TResult,
>(input: {
  url: string;
  fetch: typeof globalThis.fetch;
  headers?: HeadersInit;
  onProgress: (progress: CatalogBulkActionProgress) => void;
  signal?: AbortSignal;
  errorMessage: string;
}): Promise<TResult> {
  let lastEventId: string | null = null;

  for (;;) {
    if (input.signal?.aborted) {
      throw new DOMException("Job status stream was aborted.", "AbortError");
    }

    const requestHeaders: Record<string, string> = {
      accept: "text/event-stream",
      ...headersToRecord(input.headers),
    };
    if (lastEventId) {
      requestHeaders["last-event-id"] = lastEventId;
    }

    const response = await input.fetch(input.url, {
      method: "GET",
      signal: input.signal,
      headers: requestHeaders,
    });

    if (!response.ok) {
      const errorBody = await response.json().catch(() => null);
      if (response.status === 429 || response.status === 503) {
        await waitForJobReconnect(1_500, input.signal);
        continue;
      }
      throw new ApiError(response.status, errorBody);
    }

    if (!response.body) {
      throw new Error(`${input.errorMessage} Status stream was not available.`);
    }

    const result = await readJobEventStream<TJob, TResult>({
      body: response.body,
      onProgress: input.onProgress,
      setLastEventId: (eventId) => {
        lastEventId = eventId;
      },
      errorMessage: input.errorMessage,
    });

    if (result.done) {
      return result.result;
    }

    await waitForJobReconnect(750, input.signal);
  }
}

async function readJobEventStream<
  TJob extends Readonly<{
    status: "queued" | "running" | "completed" | "failed";
    progress: CatalogBulkActionProgress;
    result: TResult | null;
    errorMessage: string | null;
  }>,
  TResult,
>(input: {
  body: ReadableStream<Uint8Array>;
  onProgress: (progress: CatalogBulkActionProgress) => void;
  setLastEventId: (eventId: string) => void;
  errorMessage: string;
}): Promise<Readonly<{ done: true; result: TResult } | { done: false }>> {
  const reader = input.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let eventId: string | null = null;
  let eventName = "message";
  let dataLines: string[] = [];

  const dispatch = (): Readonly<{ done: true; result: TResult } | { done: false }> | null => {
    if (eventId) {
      input.setLastEventId(eventId);
    }
    if (dataLines.length === 0) {
      eventId = null;
      eventName = "message";
      return null;
    }

    const payload = JSON.parse(dataLines.join("\n")) as TJob | { kind: "sync.required"; snapshot: TJob };
    const job = eventName === "sync.required" ? (payload as { snapshot: TJob }).snapshot : (payload as TJob);
    eventId = null;
    eventName = "message";
    dataLines = [];
    input.onProgress(job.progress);

    if (job.status === "completed") {
      if (!job.result) {
        throw new Error(`${input.errorMessage} Finished without a result.`);
      }
      return { done: true, result: job.result };
    }

    if (job.status === "failed") {
      throw new Error(job.errorMessage ?? input.errorMessage);
    }

    return null;
  };

  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const rawLine of lines) {
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (line === "") {
        const result = dispatch();
        if (result?.done) {
          return result;
        }
        continue;
      }

      if (line.startsWith(":")) {
        continue;
      }

      if (line.startsWith("id:")) {
        eventId = line.slice("id:".length).trim();
        continue;
      }

      if (line.startsWith("event:")) {
        eventName = line.slice("event:".length).trim() || "message";
        continue;
      }

      if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }

    if (done) {
      const result = dispatch();
      return result?.done ? result : { done: false };
    }
  }
}

function waitForJobReconnect(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function scopeSyncBatchRequest<T>(
  fetch: typeof globalThis.fetch,
  headers: HeadersInit | undefined,
  baseUrl: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/scope-sync-batches${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headersToRecord(headers) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return parseJsonResponse<T>(response);
}

function headersToRecord(headers?: HeadersInit): Record<string, string> {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    return Object.fromEntries(headers.entries());
  }

  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }

  return headers;
}
