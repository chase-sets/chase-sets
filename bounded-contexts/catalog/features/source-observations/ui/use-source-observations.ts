import type { CommandResponse, ListResponse } from "@chase-sets/http/responses";
import type {
  CatalogBulkActionProgress,
  CatalogIntegrationJob,
  CatalogBulkReviewJob,
} from "../../../support/shell-support/api/client";
import { api } from "../../../support/shell-support/api/client";
import { useFetch } from "../../../support/shell-support/ui/use-fetch";
import type {
  BulkSourceObservationPromotionResult,
  BulkSourceObservationReapplyResult,
  SourceObservationIntegrationScope,
  SourceObservationIntegrationJobResult,
  SourceObservationIntegrationOption,
  SourceObservationIntegrationJobScope,
  SourceObservationIntegrationOptionResponse,
  SourceObservationPromotionPreview,
  SourceObservationPromotionScope,
  SourceObservationReapplyPreview,
  CatalogProviderProfileEditableSectionKey,
  CatalogProviderProfileAuthoringModel,
  CatalogProviderProfileDryRunResult,
  CatalogIntegrationControlPlaneOverview,
  CatalogIntegrationControlPlaneReadiness,
  CatalogProviderProfileSectionUpdateCommand,
  CatalogProviderProfileVersionReview,
  SourceObservationDetail,
  SourceObservationListItem,
  TcgdexExpansionOption,
  TcgdexLanguageOption,
  TcgdexSeriesOption,
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
  cursor?: string;
  limit?: number;
  forceRefresh?: boolean;
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
  if (input.cursor) {
    query.set("cursor", input.cursor);
  }
  if (input.limit) {
    query.set("limit", String(input.limit));
  }
  if (input.forceRefresh) {
    query.set("forceRefresh", "true");
  }

  const queryString = query.toString();
  const enabled = input.enabled ?? true;

  return useFetch(
    () =>
      enabled
        ? api.listSourceObservationIntegrationOptions<SourceObservationIntegrationOptionResponse>(queryString)
        : Promise.resolve({ items: [], count: 0, total: 0 }),
    [enabled, queryString],
  );
}

export function useCatalogIntegrationControlPlaneReadiness() {
  return useFetch(() => api.getCatalogIntegrationControlPlaneReadiness<CatalogIntegrationControlPlaneReadiness>(), []);
}

export function useCatalogIntegrationControlPlaneOverview() {
  return useFetch(() => api.getCatalogIntegrationControlPlaneOverview<CatalogIntegrationControlPlaneOverview>(), []);
}

export function useSourceObservationProviderProfiles(
  initialData?: ListResponse<CatalogProviderProfileVersionReview> | null,
) {
  return useFetch(
    () => api.listSourceObservationProviderProfiles<ListResponse<CatalogProviderProfileVersionReview>>(),
    [],
    initialData,
  );
}

export function useSourceObservationProviderProfileAuthoringModel(
  providerKey: string,
  profileVersion: string,
  enabled = true,
) {
  return useFetch(
    () =>
      enabled
        ? api.getSourceObservationProviderProfileAuthoringModel<CatalogProviderProfileAuthoringModel>(
            providerKey,
            profileVersion,
          )
        : Promise.resolve(null),
    [enabled, providerKey, profileVersion],
  );
}

export function dryRunSourceObservationProviderProfile(providerKey: string, profileVersion: string, payload: unknown) {
  return api.dryRunSourceObservationProviderProfile<CatalogProviderProfileDryRunResult>(
    providerKey,
    profileVersion,
    payload,
  );
}

export function createSourceObservationProviderProfile(version: unknown) {
  return api.createSourceObservationProviderProfile<CatalogProviderProfileVersionReview>(version);
}

export function updateSourceObservationProviderProfileSection(
  providerKey: string,
  profileVersion: string,
  section: CatalogProviderProfileEditableSectionKey,
  command: CatalogProviderProfileSectionUpdateCommand,
) {
  return api.updateSourceObservationProviderProfileSection<CatalogProviderProfileVersionReview>(
    providerKey,
    profileVersion,
    section,
    command,
  );
}

export function cloneSourceObservationProviderProfile(providerKey: string, profileVersion: string, body: unknown) {
  return api.cloneSourceObservationProviderProfile<CatalogProviderProfileVersionReview>(
    providerKey,
    profileVersion,
    body,
  );
}

export function activateSourceObservationProviderProfile(providerKey: string, profileVersion: string) {
  return api.activateSourceObservationProviderProfile<CatalogProviderProfileVersionReview>(providerKey, profileVersion);
}

export function rollbackSourceObservationProviderProfile(providerKey: string, profileVersion: string) {
  return api.rollbackSourceObservationProviderProfile<CatalogProviderProfileVersionReview>(providerKey, profileVersion);
}

export function retireSourceObservationProviderProfile(providerKey: string, profileVersion: string) {
  return api.retireSourceObservationProviderProfile<CatalogProviderProfileVersionReview>(providerKey, profileVersion);
}

export function deprecateSourceObservationProviderProfile(providerKey: string, profileVersion: string) {
  return api.deprecateSourceObservationProviderProfile<CatalogProviderProfileVersionReview>(
    providerKey,
    profileVersion,
  );
}

export function useSourceObservation(id: string, initialData?: SourceObservationDetail | null) {
  return useFetch(() => api.getSourceObservation<SourceObservationDetail>(id), [id], initialData);
}

export function useTcgdexLanguages() {
  return useFetch(async () => {
    const response = await api.listSourceObservationIntegrationOptions<SourceObservationIntegrationOptionResponse>(
      new URLSearchParams({ providerKey: "tcgdex", queryKind: "languages" }).toString(),
    );
    return mapIntegrationOptions(response, (item) => ({ languageCode: item.value }));
  }, []);
}

export function useTcgdexSeries(languageCode: string) {
  const query = new URLSearchParams({ providerKey: "tcgdex", queryKind: "series", languageCode }).toString();
  return useFetch(async () => {
    const response =
      await api.listSourceObservationIntegrationOptions<SourceObservationIntegrationOptionResponse>(query);
    return mapIntegrationOptions(response, (item) => ({
      seriesId: item.value,
      name: item.label,
      logoUrl: metadataString(item.metadata.logoUrl),
    }));
  }, [query]);
}

export function useTcgdexExpansions(languageCode: string, seriesId: string) {
  const query = seriesId
    ? new URLSearchParams({
        providerKey: "tcgdex",
        queryKind: "expansions",
        languageCode,
        parentValue: seriesId,
      }).toString()
    : "";
  return useFetch(async () => {
    if (!query) {
      return { items: [], count: 0, total: 0 };
    }
    const response =
      await api.listSourceObservationIntegrationOptions<SourceObservationIntegrationOptionResponse>(query);
    return mapIntegrationOptions(response, (item) => ({
      expansionId: item.value,
      name: item.label,
      seriesId: item.parentValue ?? seriesId,
      seriesName: metadataString(item.metadata.seriesName),
      logoUrl: metadataString(item.metadata.logoUrl),
      symbolUrl: metadataString(item.metadata.symbolUrl),
      cardCount: metadataNumber(item.metadata.cardCount),
      officialCardCount: metadataNumber(item.metadata.officialCardCount),
    }));
  }, [query]);
}

function mapIntegrationOptions<T>(
  response: SourceObservationIntegrationOptionResponse,
  mapItem: (item: SourceObservationIntegrationOption) => T,
): ListResponse<T> {
  return {
    ...response,
    items: response.items.map(mapItem),
  };
}

function metadataString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function metadataNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
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

export function previewReapplySourceObservations(scope: SourceObservationPromotionScope) {
  return api.previewReapplySourceObservations<SourceObservationReapplyPreview>(scope);
}

export function reapplySourceObservations(
  observationIds: string[],
  options: { onProgress?: (progress: CatalogBulkActionProgress) => void } = {},
) {
  return api.reapplySourceObservations<BulkSourceObservationReapplyResult>(observationIds, options);
}

export function reapplySourceObservationsByScope(
  scope: SourceObservationPromotionScope,
  options: { onProgress?: (progress: CatalogBulkActionProgress) => void } = {},
) {
  return api.reapplySourceObservationsByScope<BulkSourceObservationReapplyResult>(scope, options);
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

export function enqueueSourceObservationIntegrationJob(
  action: "import" | "reapply",
  scope: SourceObservationIntegrationJobScope,
) {
  return api.enqueueSourceObservationIntegrationJob<CatalogIntegrationJob<SourceObservationIntegrationJobResult>>(
    action,
    scope,
  );
}

export function useActiveSourceObservationIntegrationJobs() {
  return useFetch(
    () =>
      api.listActiveSourceObservationIntegrationJobs<
        ListResponse<CatalogIntegrationJob<SourceObservationIntegrationJobResult>>
      >(),
    [],
  );
}

export function watchSourceObservationIntegrationJob(
  jobId: string,
  options: {
    onProgress?: (progress: CatalogBulkActionProgress) => void;
    signal?: AbortSignal;
  } = {},
) {
  return api.watchSourceObservationIntegrationJob<SourceObservationIntegrationJobResult>(jobId, options);
}

export function promoteSourceObservation(id: string) {
  return api.promoteSourceObservation<CommandResponse>(id);
}

export function rejectSourceObservation(id: string, reason: string) {
  return api.rejectSourceObservation<CommandResponse>(id, reason);
}
