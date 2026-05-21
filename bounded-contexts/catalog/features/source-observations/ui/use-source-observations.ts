import type { CommandResponse, ListResponse } from "@chase-sets/http/responses";
import type {
  CatalogBulkActionProgress,
  CatalogBulkReviewJob,
  CatalogImportProgress,
} from "../../../support/shell-support/api/client";
import { api } from "../../../support/shell-support/api/client";
import { useFetch } from "../../../support/shell-support/ui/use-fetch";
import type {
  BulkSourceObservationPromotionResult,
  SourceObservationIntegrationScope,
  SourceObservationIntegrationOption,
  SourceObservationPromotionPreview,
  SourceObservationPromotionScope,
  SourceObservationDetail,
  SourceObservationListItem,
  TcgdexExpansionOption,
  TcgdexLanguageOption,
  TcgdexSeriesOption,
  TcgdexSetImportResult,
} from "./contracts";

export function useSourceObservationList(query: string, initialData?: ListResponse<SourceObservationListItem> | null) {
  return useFetch(
    () => api.listSourceObservations<ListResponse<SourceObservationListItem>>(query),
    [query],
    initialData,
  );
}

export function useSourceObservationIntegrationScopes(
  query: string,
  initialData?: ListResponse<SourceObservationIntegrationScope> | null,
) {
  return useFetch(
    () => api.listSourceObservationIntegrationScopes<ListResponse<SourceObservationIntegrationScope>>(query),
    [query],
    initialData,
  );
}

export function useSourceObservationIntegrationOptions(input: {
  providerKey: string;
  queryKind: string;
  languageCode?: string;
  parentValue?: string;
  enabled?: boolean;
}) {
  const query = new URLSearchParams({
    providerKey: input.providerKey,
    queryKind: input.queryKind,
  });

  if (input.languageCode) {
    query.set("languageCode", input.languageCode);
  }

  if (input.parentValue) {
    query.set("parentValue", input.parentValue);
  }

  const queryString = query.toString();
  const enabled = input.enabled ?? true;

  return useFetch(
    () =>
      enabled
        ? api.listSourceObservationIntegrationOptions<ListResponse<SourceObservationIntegrationOption>>(queryString)
        : Promise.resolve({ items: [], count: 0, total: 0 }),
    [enabled, queryString],
  );
}

export function useSourceObservation(id: string, initialData?: SourceObservationDetail | null) {
  return useFetch(() => api.getSourceObservation<SourceObservationDetail>(id), [id], initialData);
}

export function importTcgdexSet(
  body: { languageCode: string; setId: string },
  options: { onProgress?: (progress: CatalogImportProgress) => void } = {},
) {
  return api.importTcgdexSet<TcgdexSetImportResult>(body, options);
}

export function useTcgdexLanguages() {
  return useFetch(() => api.listTcgdexLanguages<ListResponse<TcgdexLanguageOption>>(), []);
}

export function useTcgdexSeries(languageCode: string) {
  const query = new URLSearchParams({ languageCode }).toString();
  return useFetch(() => api.listTcgdexSeries<ListResponse<TcgdexSeriesOption>>(query), [query]);
}

export function useTcgdexExpansions(languageCode: string, seriesId: string) {
  const query = seriesId ? new URLSearchParams({ languageCode, seriesId }).toString() : "";
  return useFetch(
    () =>
      query
        ? api.listTcgdexExpansions<ListResponse<TcgdexExpansionOption>>(query)
        : Promise.resolve({ items: [], count: 0, total: 0 }),
    [query],
  );
}

export function bulkPromoteSourceObservations(
  observationIds: string[],
  options: { onProgress?: (progress: CatalogBulkActionProgress) => void } = {},
) {
  return api.bulkPromoteSourceObservations<BulkSourceObservationPromotionResult>(observationIds, options);
}

export function previewBulkPromoteSourceObservations(scope: SourceObservationPromotionScope) {
  return api.previewBulkPromoteSourceObservations<SourceObservationPromotionPreview>(scope);
}

export function bulkPromoteSourceObservationsByScope(
  scope: SourceObservationPromotionScope,
  options: { onProgress?: (progress: CatalogBulkActionProgress) => void } = {},
) {
  return api.bulkPromoteSourceObservationsByScope<BulkSourceObservationPromotionResult>(scope, options);
}

export function bulkRejectSourceObservations(
  observationIds: string[],
  reason: string,
  options: { onProgress?: (progress: CatalogBulkActionProgress) => void } = {},
) {
  return api.bulkRejectSourceObservations<BulkSourceObservationPromotionResult>(observationIds, reason, options);
}

export function bulkRejectSourceObservationsByScope(
  scope: SourceObservationPromotionScope,
  reason: string,
  options: { onProgress?: (progress: CatalogBulkActionProgress) => void } = {},
) {
  return api.bulkRejectSourceObservationsByScope<BulkSourceObservationPromotionResult>(scope, reason, options);
}

export function useActiveSourceObservationBulkJobs() {
  return useFetch(
    () =>
      api.listActiveSourceObservationBulkJobs<
        ListResponse<CatalogBulkReviewJob<BulkSourceObservationPromotionResult>>
      >(),
    [],
  );
}

export function watchSourceObservationBulkJob(
  jobId: string,
  options: {
    onProgress?: (progress: CatalogBulkActionProgress) => void;
    signal?: AbortSignal;
  } = {},
) {
  return api.watchSourceObservationBulkJob<BulkSourceObservationPromotionResult>(jobId, options);
}

export function promoteSourceObservation(id: string) {
  return api.promoteSourceObservation<CommandResponse>(id);
}

export function rejectSourceObservation(id: string, reason: string) {
  return api.rejectSourceObservation<CommandResponse>(id, reason);
}
