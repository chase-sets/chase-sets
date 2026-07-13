import { api } from "../../../support/shell-support/api/client";
import { useFetch } from "../../../support/shell-support/ui/use-fetch";
import type { ScopeCoverageMatrix, UnmappedScopeInboxReadModel } from "./contracts";

export function useUnmappedScopeInbox(initialData?: UnmappedScopeInboxReadModel | null) {
  return useFetch(() => api.getUnmappedScopeInbox<UnmappedScopeInboxReadModel>(), [], initialData);
}

export function useScopeCoverageMatrix(scopeRecordId: string, initialData?: ScopeCoverageMatrix | null) {
  return useFetch(() => api.getScopeCoverageMatrix<ScopeCoverageMatrix>(scopeRecordId), [scopeRecordId], initialData);
}

export function acceptProviderScopeMappings(mappingIds: readonly string[]) {
  return api.dispatchProviderScopeMappingReviewCommand({ intent: "accept", mappingIds });
}

export function rejectProviderScopeMappings(mappingIds: readonly string[], reason: string) {
  return api.dispatchProviderScopeMappingReviewCommand({ intent: "reject", mappingIds, reason });
}

export function revokeProviderScopeMapping(mappingId: string, reason: string) {
  return api.dispatchProviderScopeMappingReviewCommand({ intent: "revoke", mappingIds: [mappingId], reason });
}

export function proposeProviderScopeMapping(body: {
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
}) {
  return api.proposeProviderScopeMapping(body);
}
