import type { CommandResponse, ListResponse } from "@chase-sets/http/responses";
import { api } from "../../../support/shell-support/api/client";
import { useFetch } from "../../../support/shell-support/ui/use-fetch";
import type {
  BulkSourceObservationPromotionResult,
  SourceObservationDetail,
  SourceObservationListItem,
  TcgdexSetImportResult,
} from "./contracts";

export function useSourceObservationList(
  query: string,
  initialData?: ListResponse<SourceObservationListItem> | null,
) {
  return useFetch(
    () => api.listSourceObservations<ListResponse<SourceObservationListItem>>(query),
    [query],
    initialData,
  );
}

export function useSourceObservation(
  id: string,
  initialData?: SourceObservationDetail | null,
) {
  return useFetch(
    () => api.getSourceObservation<SourceObservationDetail>(id),
    [id],
    initialData,
  );
}

export function importTcgdexSet(body: { languageCode: string; setId: string }) {
  return api.importTcgdexSet<TcgdexSetImportResult>(body);
}

export function bulkPromoteSourceObservations(observationIds: string[]) {
  return api.bulkPromoteSourceObservations<BulkSourceObservationPromotionResult>(
    observationIds,
  );
}

export function promoteSourceObservation(id: string) {
  return api.promoteSourceObservation<CommandResponse>(id);
}

export function rejectSourceObservation(id: string, reason: string) {
  return api.rejectSourceObservation<CommandResponse>(id, reason);
}
