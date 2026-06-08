import type { CatalogProviderOptionQueryCacheStatus } from "./provider-option-query-cache";

export type CatalogIntegrationOptionQueryTelemetryEvent = Readonly<{
  providerKey: string;
  queryKind: string;
  cacheStatus: CatalogProviderOptionQueryCacheStatus | "error";
  cacheSource: "cache" | "live" | "none";
  result: "success" | "failure";
  degraded: boolean;
  cacheOnly: boolean;
  forceRefresh: boolean;
}>;

export type CatalogIntegrationJobTelemetryEvent = Readonly<{
  jobKind: "import" | "reapply" | "promote" | "reject";
  result: "completed" | "failed" | "skipped" | "cancelled" | "released" | "reconciled";
}>;

export type SourceObservationTelemetry = Readonly<{
  recordProviderOptionQuery?: (event: CatalogIntegrationOptionQueryTelemetryEvent) => void;
  recordIntegrationJob?: (event: CatalogIntegrationJobTelemetryEvent) => void;
  recordBulkReviewWorkUnit?: (event: CatalogIntegrationJobTelemetryEvent) => void;
}>;
