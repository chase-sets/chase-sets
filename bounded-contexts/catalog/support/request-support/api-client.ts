import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
export { CatalogApiError, catalogApi, createCatalogApiClient } from "../../client";
export type {
  Blueprint,
  BlueprintDetail,
  BulkPublishCandidate,
  BulkPublishPreview,
  BulkPublishResult,
  CatalogApiClientOptions,
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
} from "../../client";
import { createCatalogApiClient } from "../../client";

export function createCatalogRequestApiClient(request: Request) {
  return createCatalogApiClient({
    baseUrl: resolveRequestApiBaseUrl(request, "/api/catalog"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "catalog" }),
  });
}
