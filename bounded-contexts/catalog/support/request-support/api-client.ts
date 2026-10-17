import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
export { ApiError as CatalogApiError, api as catalogApi, createCatalogApiClient } from "../shell-support/api/client";
export type {
  Blueprint,
  BlueprintDetail,
  BulkPublishCandidate,
  BulkPublishPreview,
  BulkPublishResult,
  CatalogItemDetail,
  CatalogItemListItem,
  CategoryDetail,
  CategoryListItem,
  Component,
  ComponentDetail,
  Dimension,
  DimensionDetail,
  DisplayTemplate,
  DisplayTemplateDetail,
  Field,
  ReferenceRecord,
  ReferenceType,
  CatalogScopeRecordDetail,
  BulkSourceObservationPromotionOutcome,
  BulkSourceObservationPromotionResult,
  SourceObservationIntegrationScope,
  SourceObservationPromotionPreview,
  SourceObservationPromotionScope,
  ProviderScopeMappingCandidateSummary,
  ScopeCoverageMatrix,
  ScopeCoverageProviderRow,
  ScopeCoverageState,
  UnmappedScopeInboxGroup,
  UnmappedScopeInboxReadModel,
} from "../client-support/contracts";
export type { CatalogApiClientOptions } from "../shell-support/api/client";
import { createCatalogApiClient } from "../shell-support/api/client";

export function createCatalogRequestApiClient(request: Request) {
  return createCatalogApiClient({
    headers: {
      ...(request.headers.has("origin") ? { origin: request.headers.get("origin")! } : {}),
      ...(request.headers.has("sec-fetch-site") ? { "sec-fetch-site": request.headers.get("sec-fetch-site")! } : {}),
    },
    baseUrl: resolveRequestApiBaseUrl(request, "/api/catalog"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "catalog" }),
  });
}
