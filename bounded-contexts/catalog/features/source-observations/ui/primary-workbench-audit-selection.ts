import type { CatalogPrimaryWorkbenchRouteContext } from "../api/primary-workbench-admin-contracts";
import type { CatalogMergeCandidateListItem, SourceObservationListItem } from "./contracts";
import type { CatalogProviderProfileVersionReview } from "./contracts";
import type { CatalogAliasReviewCandidateSummary } from "../../alias-equivalence/api/alias-review-admin-contracts";
import type { AuditEvidence, AuditTimelineRow } from "./primary-workbench-audit-evidence";
import { parseCatalogEvidenceReference, type CatalogEvidenceReference } from "./primary-workbench-evidence-reference";

export function resolveCatalogAuditSelection(
  input: Readonly<{
    routeContext: CatalogPrimaryWorkbenchRouteContext;
    scopePageVerified: boolean;
    jobs: readonly Readonly<{ jobId: string; scopeMatchesRoute: boolean }>[];
    observations: readonly SourceObservationListItem[];
    candidates: readonly CatalogMergeCandidateListItem[];
    providerKeys: readonly string[];
    profiles: readonly CatalogProviderProfileVersionReview[];
    aliases: readonly CatalogAliasReviewCandidateSummary[];
  }>,
) {
  const context = input.routeContext;
  const reference = parseCatalogEvidenceReference(context.evidenceRef);
  const scopeCandidates = input.candidates.filter(
    (candidate) =>
      (!context.scopeRecordId || candidate.identity_json.scopeRecordId === context.scopeRecordId) &&
      (!context.providerKey || candidate.membership_json.some((member) => member.providerKey === context.providerKey)),
  );
  const scopeObservationIds = new Set(
    scopeCandidates.flatMap((candidate) =>
      candidate.membership_json
        .filter((member) => !context.providerKey || member.providerKey === context.providerKey)
        .map((member) => member.observationId),
    ),
  );
  const observations = input.observations.filter(
    (observation) =>
      (!context.providerKey || observation.provider_key === context.providerKey) &&
      (!context.scopeRecordId ||
        scopeObservationIds.has(observation.observation_id) ||
        observationMatchesScope(observation, context)),
  );
  const candidates =
    reference?.kind === "candidate"
      ? scopeCandidates.filter((candidate) => candidate.candidate_id === reference.id)
      : scopeCandidates;
  const observationIds = new Set(
    reference?.kind === "candidate"
      ? candidates.flatMap((candidate) =>
          candidate.membership_json
            .filter((member) => !context.providerKey || member.providerKey === context.providerKey)
            .map((member) => member.observationId),
        )
      : [
          ...observations.map((observation) => observation.observation_id),
          ...(!context.scopeRecordId
            ? input.aliases.flatMap((alias) =>
                alias.observationId && (!context.providerKey || alias.providerKey === context.providerKey)
                  ? [alias.observationId]
                  : [],
              )
            : []),
          ...scopeObservationIds,
        ],
  );
  const jobIds = new Set(
    input.jobs
      .filter((job) => !context.scopeRecordId || Boolean(context.importScope && job.scopeMatchesRoute))
      .map((job) => job.jobId),
  );
  const catalogItemIds = new Set(
    [
      ...observations
        .filter((observation) => observationIds.has(observation.observation_id))
        .map((observation) => observation.promoted_catalog_item_id),
      ...candidates.map((candidate) => candidate.matched_catalog_item_id),
      ...(!context.scopeRecordId
        ? input.aliases
            .filter(
              (alias) =>
                alias.targetKind === "catalog-item" &&
                (!context.providerKey || alias.providerKey === context.providerKey),
            )
            .map((alias) => alias.targetId)
        : []),
    ].filter((id): id is string => Boolean(id)),
  );
  const associated = (row: AuditTimelineRow) =>
    Boolean(
      (row.jobId && jobIds.has(row.jobId)) ||
      (row.observationId && observationIds.has(row.observationId)) ||
      (row.catalogItemId && catalogItemIds.has(row.catalogItemId)) ||
      (row.targetType === "import-job" && jobIds.has(row.targetId)) ||
      (row.targetType === "source-observation" && observationIds.has(row.targetId)) ||
      (row.targetType === "catalog-item" && catalogItemIds.has(row.targetId)),
    );
  const isMember = (ref: CatalogEvidenceReference): boolean => {
    switch (ref.kind) {
      case "provider":
        return (
          (!context.providerKey || ref.id === context.providerKey) &&
          input.providerKeys.includes(ref.id) &&
          !context.scopeRecordId
        );
      case "provider-profile":
        return (
          (!context.providerKey || ref.providerKey === context.providerKey) &&
          input.profiles.some(
            (profile) => profile.providerKey === ref.providerKey && profile.profileVersion === ref.id,
          ) &&
          !context.scopeRecordId
        );
      case "scope":
        return input.scopePageVerified && ref.id === context.scopeRecordId;
      case "candidate":
        return candidates.length > 0;
      case "source-observation":
        return observationIds.has(ref.id);
      case "import-job":
        return jobIds.has(ref.id);
      case "catalog-item":
        return catalogItemIds.has(ref.id);
      case "control-plane":
        return ref.id === "settings" && context.section === "governance-controls";
      case "alias":
        return false;
    }
  };
  const resolved = Boolean(reference && isMember(reference));
  const selection: AuditEvidence["selection"] = {
    reference: context.evidenceRef ?? null,
    state: context.evidenceRef ? (resolved ? "resolved" : "no-associated-evidence") : "not-requested",
    deepLinkOpen: Boolean(context.evidenceRef && resolved),
  };
  return {
    selection,
    matches: (row: AuditTimelineRow): boolean => {
      if (context.evidenceRef && (!reference || !resolved)) return false;
      if (context.providerKey && row.providerKey !== context.providerKey) return false;
      if (!reference) return context.scopeRecordId ? associated(row) : true;
      switch (reference.kind) {
        case "provider":
          return row.providerKey === reference.id;
        case "provider-profile":
          return (
            row.providerKey === reference.providerKey &&
            row.targetType === "provider-profile" &&
            (row.profileVersion === reference.id || row.targetId === reference.id)
          );
        case "scope":
          return associated(row);
        case "candidate":
          return Boolean(
            (row.observationId && observationIds.has(row.observationId)) ||
            (row.catalogItemId && catalogItemIds.has(row.catalogItemId)) ||
            (row.targetType === "source-observation" && observationIds.has(row.targetId)) ||
            (row.targetType === "catalog-item" && catalogItemIds.has(row.targetId)),
          );
        case "control-plane":
          return true;
        case "alias":
          return false;
        case "source-observation":
          return (
            row.observationId === reference.id || (row.targetType === reference.kind && row.targetId === reference.id)
          );
        case "import-job":
          return row.jobId === reference.id || (row.targetType === reference.kind && row.targetId === reference.id);
        case "catalog-item":
          return (
            row.catalogItemId === reference.id || (row.targetType === reference.kind && row.targetId === reference.id)
          );
      }
    },
  };
}

function observationMatchesScope(
  observation: SourceObservationListItem,
  context: CatalogPrimaryWorkbenchRouteContext,
): boolean {
  const normalized = observation.normalized;
  if (normalized.scopeRecordId === context.scopeRecordId && context.scopeRecordId) return true;
  const scope = context.scope;
  if (!scope) return false;
  const dimensions = [
    [scope.expansionId, "expansionId"],
    [scope.seriesId, "seriesId"],
  ] as const;
  const selected: readonly (readonly [string | null | undefined, string])[] = dimensions.filter(([value]) =>
    Boolean(value),
  );
  const membershipDimensions = selected.length ? selected : ([[scope.productLineId, "productLineId"]] as const);
  return (
    membershipDimensions.some(([value]) => Boolean(value)) &&
    membershipDimensions.every(([value, key]) => key in normalized && normalized[key] === value) &&
    (!scope.languageCode || observation.language_code === scope.languageCode)
  );
}
