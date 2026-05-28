import { hc } from "hono/client";
import type { HonoClientResource } from "@chase-sets/http/hono-client";
import type { buildCatalogAuthoringApi } from "../../authoring-support/api";

type CatalogAuthoringApiApp = ReturnType<typeof buildCatalogAuthoringApi>;

const DEFAULT_BASE_URL = "/api/catalog";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(
      typeof body === "object" && body !== null && "error" in body
        ? String((body as Record<string, unknown>).error)
        : `API error ${status}`,
    );
  }
}

export interface CatalogApiClientOptions {
  baseUrl?: string;
  fetch?: typeof globalThis.fetch;
  headers?: HeadersInit | (() => HeadersInit);
  credentials?: RequestCredentials;
}

export type CatalogImportProgress = Readonly<{
  phase: string;
  completed: number;
  total: number;
  currentName: string | null;
}>;

export type CatalogImportProgressOptions = Readonly<{
  onProgress?: (progress: CatalogImportProgress) => void;
}>;

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
  action: "promote" | "reject";
  selectionMode: "ids" | "filter";
  observationIds: readonly string[];
  scope: Readonly<Record<string, string | undefined>>;
  reason: string | null;
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

type CatalogTcgdexSetImportResult = Readonly<{
  setId: string;
  expansionId: string;
  languageCode: string;
  observed: number;
  observationIds: readonly string[];
}>;

type CatalogIntegrationJobScopeInput = Readonly<Record<string, string | undefined>>;

function queryFromString(query: string) {
  return Object.fromEntries(new URLSearchParams(query).entries());
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new ApiError(response.status, errorBody);
  }

  return response.json() as Promise<T>;
}

function resolveHeaders(headers?: HeadersInit | (() => HeadersInit)) {
  return typeof headers === "function" ? headers() : headers;
}

export function createCatalogApiClient({
  baseUrl = DEFAULT_BASE_URL,
  fetch = globalThis.fetch,
  headers: initialHeaders,
  credentials = "include",
}: CatalogApiClientOptions = {}) {
  const configuredFetch: typeof globalThis.fetch = (input, init = {}) =>
    fetch(input, {
      ...init,
      credentials: init.credentials ?? credentials,
    });
  const client = hc<CatalogAuthoringApiApp>(baseUrl, {
    fetch: configuredFetch,
  }) as unknown as HonoClientResource;
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
    async confirmBulkDimensionLifecycle<T>(action: string, selection: unknown): Promise<T> {
      const response = await client.dimensions["bulk-lifecycle"].confirm.$post({
        json: { action, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
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
    async confirmBulkFieldLifecycle<T>(action: string, selection: unknown): Promise<T> {
      const response = await client.fields["bulk-lifecycle"].confirm.$post({
        json: { action, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
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
    async confirmBulkComponentLifecycle<T>(action: string, selection: unknown): Promise<T> {
      const response = await client.components["bulk-lifecycle"].confirm.$post({
        json: { action, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
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
    async confirmBulkBlueprintLifecycle<T>(action: string, selection: unknown): Promise<T> {
      const response = await client.blueprints["bulk-lifecycle"].confirm.$post({
        json: { action, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
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
    async confirmBulkCategoryLifecycle<T>(action: string, selection: unknown): Promise<T> {
      const response = await client.categories["bulk-lifecycle"].confirm.$post({
        json: { action, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
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
    async confirmBulkReferenceTypeLifecycle<T>(action: string, selection: unknown): Promise<T> {
      const response = await client["reference-types"]["bulk-lifecycle"].confirm.$post({
        json: { action, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
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
    async confirmBulkReferenceRecordLifecycle<T>(action: string, selection: unknown): Promise<T> {
      const response = await client["reference-records"]["bulk-lifecycle"].confirm.$post({
        json: { action, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
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
    async confirmBulkPublishCatalogItems<T>(itemIds: readonly string[]): Promise<T> {
      const response = await client.items["bulk-publish"].confirm.$post({
        json: { itemIds },
        header: headers,
      });
      return parseJsonResponse<T>(response);
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
    async confirmBulkCatalogItemLifecycle<T>(action: string, selection: unknown): Promise<T> {
      const response = await client.items["bulk-lifecycle"].confirm.$post({
        json: { action, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async previewBulkCatalogItemEdit<T>(operation: unknown, selection: unknown): Promise<T> {
      const response = await client.items["bulk-edit"].preview.$post({
        json: { operation, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async confirmBulkCatalogItemEdit<T>(operation: unknown, selection: unknown): Promise<T> {
      const response = await client.items["bulk-edit"].confirm.$post({
        json: { operation, selection },
        header: headers,
      });
      return parseJsonResponse<T>(response);
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
    async getSourceObservation<T>(id: string): Promise<T> {
      const response = await client["source-observations"][":id"].$get({
        param: { id },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async importTcgdexSet<T>(body: unknown, options: CatalogImportProgressOptions = {}): Promise<T> {
      const scope = tcgdexImportScope(body);
      const job = await startIntegrationJob<CatalogSourceObservationIntegrationJobResult>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        action: "import",
        scope,
      });
      const result = await streamIntegrationJob<CatalogSourceObservationIntegrationJobResult>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        jobId: job.jobId,
        onProgress: options.onProgress ?? (() => {}),
        errorMessage: "TCGdex import failed.",
      });

      return integrationImportResultToTcgdexSetResult(scope, result) as T;
    },
    async listTcgdexLanguages<T>(): Promise<T> {
      const response = await client["source-observations"].tcgdex.languages.$get({
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async listTcgdexSeries<T>(query: string): Promise<T> {
      const response = await client["source-observations"].tcgdex.series.$get({
        query: queryFromString(query),
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async listTcgdexExpansions<T>(query: string): Promise<T> {
      const response = await client["source-observations"].tcgdex.expansions.$get({
        query: queryFromString(query),
        header: headers,
      });
      return parseJsonResponse<T>(response);
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
    async listActiveSourceObservationBulkJobs<T>(): Promise<T> {
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/source-observations/bulk-jobs/active`, {
        method: "GET",
        headers: headersToRecord(headers),
      });
      return parseJsonResponse<T>(response);
    },
    async watchSourceObservationBulkJob<T>(jobId: string, options: CatalogBulkActionProgressOptions = {}): Promise<T> {
      return streamBulkJob<T>({
        baseUrl,
        fetch: configuredFetch,
        headers,
        jobId,
        onProgress: options.onProgress ?? (() => {}),
        signal: options.signal,
        errorMessage: "Bulk Source Observation job failed.",
      });
    },
    async enqueueSourceObservationIntegrationJob<T>(action: "import" | "reapply", scope: unknown): Promise<T> {
      const response = await configuredFetch(`${baseUrl.replace(/\/$/, "")}/source-observations/integration-jobs`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...headersToRecord(headers),
        },
        body: JSON.stringify({ action, scope }),
      });
      return parseJsonResponse<T>(response);
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
  };
}

export const api = createCatalogApiClient();

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

  return response.json() as Promise<CatalogBulkReviewJob<T>>;
}

async function startIntegrationJob<T>(input: {
  baseUrl: string;
  fetch: typeof globalThis.fetch;
  headers?: HeadersInit;
  action: "import" | "reapply";
  scope: unknown;
}): Promise<CatalogIntegrationJob<T>> {
  const response = await input.fetch(`${input.baseUrl.replace(/\/$/, "")}/source-observations/integration-jobs`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headersToRecord(input.headers),
    },
    body: JSON.stringify({ action: input.action, scope: input.scope }),
  });

  if (!response.ok) {
    const errorBody = await response.json().catch(() => null);
    throw new ApiError(response.status, errorBody);
  }

  return response.json() as Promise<CatalogIntegrationJob<T>>;
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
  let dataLines: string[] = [];

  const dispatch = (): Readonly<{ done: true; result: TResult } | { done: false }> | null => {
    if (eventId) {
      input.setLastEventId(eventId);
    }
    if (dataLines.length === 0) {
      eventId = null;
      return null;
    }

    const job = JSON.parse(dataLines.join("\n")) as TJob;
    eventId = null;
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

function tcgdexImportScope(body: unknown): CatalogIntegrationJobScopeInput {
  const record = isRecord(body) ? body : {};
  return {
    provider: "tcgdex",
    language: String(record.languageCode ?? record.language ?? "en"),
    setId: String(record.expansionId ?? record.setId ?? ""),
  };
}

function integrationImportResultToTcgdexSetResult(
  scope: CatalogIntegrationJobScopeInput,
  result: CatalogSourceObservationIntegrationJobResult,
): CatalogTcgdexSetImportResult {
  const matchingOutcome =
    result.outcomes.find((outcome) => outcome.expansionId === scope.setId && outcome.languageCode === scope.language) ??
    result.outcomes[0];
  const expansionId = matchingOutcome?.expansionId ?? scope.setId ?? "";
  const languageCode = matchingOutcome?.languageCode || scope.language || "en";

  return {
    setId: expansionId,
    expansionId,
    languageCode,
    observed: matchingOutcome?.observed ?? result.observed,
    observationIds: [],
  };
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
