import { hc } from "hono/client";
import type { buildCatalogAuthoringApi } from "../../api";

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

function resolveHeaders(
  headers?: HeadersInit | (() => HeadersInit),
) {
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
  const client = hc<CatalogAuthoringApiApp>(baseUrl, { fetch: configuredFetch }) as any;
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
    async addChoice<T>(dimensionId: string, body: unknown): Promise<T> {
      const response = await client.dimensions[":id"].choices.$post({
        param: { id: dimensionId },
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async reviseChoice<T>(dimensionId: string, choiceId: string, body: unknown): Promise<T> {
      const response = await client.dimensions[":id"].choices[":choiceId"].$put({
        param: { id: dimensionId, choiceId },
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async deprecateChoice<T>(dimensionId: string, choiceId: string): Promise<T> {
      const response = await client.dimensions[":id"].choices[":choiceId"].deprecate.$post({
        param: { id: dimensionId, choiceId },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async reactivateChoice<T>(dimensionId: string, choiceId: string): Promise<T> {
      const response = await client.dimensions[":id"].choices[":choiceId"].reactivate.$post({
        param: { id: dimensionId, choiceId },
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async reorderChoices<T>(dimensionId: string, choiceIds: string[]): Promise<T> {
      const response = await client.dimensions[":id"].choices.order.$put({
        param: { id: dimensionId },
        json: { choiceIds },
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
    async setBlueprintVersionRules<T>(id: string, canonicalDimensionOrder: string[]): Promise<T> {
      const response = await client.blueprints[":id"]["version-rules"].$put({
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
    async setFieldValue<T>(id: string, fieldId: string, value: string): Promise<T> {
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
    async reviseMetadata<T>(id: string, body: unknown): Promise<T> {
      const response = await client.items[":id"].metadata.$put({
        param: { id },
        json: body,
        header: headers,
      });
      return parseJsonResponse<T>(response);
    },
    async retireCatalogItem<T>(id: string): Promise<T> {
      const response = await client.items[":id"].retire.$post({
        param: { id },
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
  };
}

export const api = createCatalogApiClient();
