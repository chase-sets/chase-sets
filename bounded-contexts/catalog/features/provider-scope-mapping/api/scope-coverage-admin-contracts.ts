import type { JsonObject } from "@chase-sets/primitives/json";
import type { CatalogLifecycleStatus } from "../../../support/runtime-support/common";
import type { CatalogScopeProductDomain, CatalogScopeRecordKind } from "../../scope-registry/domain/contract";
import type {
  ProviderScopeMappingWithScopeRow,
  ScopeObservationSyncStatus,
  ScopeRecordSummaryRow,
} from "../read-model/scope-coverage-queries";
import type { ProviderScopeMappingRow } from "../read-model/queries";
import type {
  ProviderScopeMappingConfidenceTier,
  ProviderScopeMappingCoordinates,
  ProviderScopeMappingProvenance,
  ProviderScopeMappingReviewStatus,
} from "../domain/mapping";

// ---------------------------------------------------------------------------
// Unmapped-scope inbox + scope coverage matrix — admin read-model contracts
//
// Pure transforms from DB rows to the operator-facing shapes the review UI
// renders. Mirrors the alias-review-admin-contracts.ts pattern: everything
// here is unit-testable without a database, and it is the single place the
// UI and its tests agree on vocabulary. Acceptance/rejection dispatch through
// the Provider Scope Mapping event-sourced aggregate (see api/route.ts); this
// module only reads.
// ---------------------------------------------------------------------------

export const scopeCoverageContractVersion = "catalog-scope-coverage-v1" as const;

export type ScopeCoverageContractVersion = typeof scopeCoverageContractVersion;

const HIGH_CONFIDENCE_TIERS: readonly ProviderScopeMappingConfidenceTier[] = ["exact", "high"];

/** A single Provider Scope Mapping as an operator sees it in review. */
export type ProviderScopeMappingCandidateSummary = Readonly<{
  mappingId: string;
  scopeRecordId: string;
  providerKey: string;
  unitKey: string;
  coordinates: ProviderScopeMappingCoordinates;
  confidence: ProviderScopeMappingConfidenceTier;
  reviewStatus: ProviderScopeMappingReviewStatus;
  provenance: ProviderScopeMappingProvenance;
  evidence: JsonObject;
  highConfidence: boolean;
  reviewable: boolean;
  lastActor: string | null;
  lastReason: string | null;
  proposedAt: string;
  reviewedAt: string | null;
  updatedAt: string;
}>;

export function mapProviderScopeMappingCandidate(row: ProviderScopeMappingRow): ProviderScopeMappingCandidateSummary {
  const confidence = row.confidence as ProviderScopeMappingConfidenceTier;
  return {
    mappingId: row.mapping_id,
    scopeRecordId: row.scope_record_id,
    providerKey: row.provider_key,
    unitKey: row.unit_key,
    coordinates: {
      productLineId: row.product_line_id,
      seriesId: row.series_id,
      setId: row.set_id,
      setName: row.set_name,
      language: readLanguageCoordinates(row.language_coordinates),
    },
    confidence,
    reviewStatus: row.review_status,
    provenance: readProvenance(row.provenance),
    evidence: readJsonObject(row.evidence),
    highConfidence: HIGH_CONFIDENCE_TIERS.includes(confidence),
    reviewable: row.review_status === "proposed",
    lastActor: row.last_actor,
    lastReason: row.last_reason,
    proposedAt: row.proposed_at,
    reviewedAt: row.reviewed_at,
    updatedAt: row.updated_at,
  };
}

// --- Unmapped-scope inbox ----------------------------------------------------

/** One canonical scope record's pending Provider Scope Mapping proposals. */
export type UnmappedScopeInboxGroup = Readonly<{
  scopeRecordId: string;
  scopeName: string;
  productDomain: CatalogScopeProductDomain;
  scopeKind: CatalogScopeRecordKind;
  officialSetCode: string | null;
  releaseDate: string | null;
  /** A canonical record the matcher tentatively created still needs confirming (publish). */
  isDraftCanonicalRecord: boolean;
  candidates: readonly ProviderScopeMappingCandidateSummary[];
  counts: Readonly<{ total: number; highConfidence: number }>;
}>;

export type UnmappedScopeInboxReadModel = Readonly<{
  schemaVersion: ScopeCoverageContractVersion;
  generatedAt: string;
  groups: readonly UnmappedScopeInboxGroup[];
  counts: Readonly<{ totalGroups: number; totalCandidates: number; highConfidenceCandidates: number }>;
}>;

export function buildUnmappedScopeInboxReadModel(input: {
  generatedAt: string;
  rows: readonly ProviderScopeMappingWithScopeRow[];
}): UnmappedScopeInboxReadModel {
  const byScope = new Map<
    string,
    { scope: ProviderScopeMappingWithScopeRow; candidates: ProviderScopeMappingCandidateSummary[] }
  >();

  for (const row of input.rows) {
    const bucket = byScope.get(row.scope_record_id) ?? { scope: row, candidates: [] };
    bucket.candidates.push(mapProviderScopeMappingCandidate(row));
    byScope.set(row.scope_record_id, bucket);
  }

  const groups = [...byScope.values()]
    .map(
      ({ scope, candidates }): UnmappedScopeInboxGroup => ({
        scopeRecordId: scope.scope_record_id,
        scopeName: scope.scope_name,
        productDomain: scope.scope_product_domain,
        scopeKind: scope.scope_kind,
        officialSetCode: scope.scope_official_set_code,
        releaseDate: scope.scope_release_date,
        isDraftCanonicalRecord: scope.scope_lifecycle_status === "draft",
        candidates,
        counts: {
          total: candidates.length,
          highConfidence: candidates.filter((candidate) => candidate.highConfidence).length,
        },
      }),
    )
    .sort((left, right) => left.scopeName.localeCompare(right.scopeName));

  return {
    schemaVersion: scopeCoverageContractVersion,
    generatedAt: input.generatedAt,
    groups,
    counts: {
      totalGroups: groups.length,
      totalCandidates: groups.reduce((sum, group) => sum + group.counts.total, 0),
      highConfidenceCandidates: groups.reduce((sum, group) => sum + group.counts.highConfidence, 0),
    },
  };
}

// --- Coverage matrix ----------------------------------------------------------

/**
 * A provider's coverage ladder for one canonical scope. `available` means a
 * mapping was proposed but not yet accepted; `mapped` means accepted with no
 * sync run yet; `synced` means observations exist; `settled` means at least
 * one has been promoted into a Catalog Item. `not-offered` is the default
 * when the only mapping history for this provider is rejected/revoked (or
 * there is none at all).
 */
export const scopeCoverageStates = ["not-offered", "available", "mapped", "synced", "settled"] as const;

export type ScopeCoverageState = (typeof scopeCoverageStates)[number];

export type ScopeCoverageProviderRow = Readonly<{
  providerKey: string;
  state: ScopeCoverageState;
  /** The mapping this row's state was computed from (latest, any status). */
  mapping: ProviderScopeMappingCandidateSummary | null;
  syncedObservations: number;
  promotedObservations: number;
}>;

export type ScopeCoverageMatrix = Readonly<{
  schemaVersion: ScopeCoverageContractVersion;
  generatedAt: string;
  scopeRecordId: string;
  scopeName: string;
  productDomain: CatalogScopeProductDomain;
  scopeKind: CatalogScopeRecordKind;
  officialSetCode: string | null;
  releaseDate: string | null;
  lifecycleStatus: CatalogLifecycleStatus;
  providers: readonly ScopeCoverageProviderRow[];
}>;

export function computeScopeCoverageState(input: {
  mapping: ProviderScopeMappingCandidateSummary | null;
  syncedObservations: number;
  promotedObservations: number;
}): ScopeCoverageState {
  const status = input.mapping?.reviewStatus ?? null;
  const isAccepted = status === "accepted" || status === "auto-accepted";

  if (isAccepted) {
    if (input.promotedObservations > 0) {
      return "settled";
    }
    if (input.syncedObservations > 0) {
      return "synced";
    }
    return "mapped";
  }

  if (status === "proposed") {
    return "available";
  }

  // rejected / revoked / no mapping at all: no active coverage signal.
  return "not-offered";
}

/** Picks the mapping row that best represents a provider's current coverage: an accepted one wins, else the most recent. */
function latestRelevantMapping(rows: readonly ProviderScopeMappingRow[]): ProviderScopeMappingRow {
  const accepted = rows.find((row) => row.review_status === "accepted" || row.review_status === "auto-accepted");
  return accepted ?? rows[0];
}

export async function buildScopeCoverageMatrix(input: {
  generatedAt: string;
  scope: ScopeRecordSummaryRow;
  mappingRows: readonly ProviderScopeMappingRow[];
  loadSyncStatus: (row: ProviderScopeMappingRow) => Promise<ScopeObservationSyncStatus>;
}): Promise<ScopeCoverageMatrix> {
  const byProvider = new Map<string, ProviderScopeMappingRow[]>();
  for (const row of input.mappingRows) {
    const bucket = byProvider.get(row.provider_key) ?? [];
    bucket.push(row);
    byProvider.set(row.provider_key, bucket);
  }

  const providers = await Promise.all(
    [...byProvider.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([providerKey, rows]): Promise<ScopeCoverageProviderRow> => {
        const representative = latestRelevantMapping(rows);
        const mapping = mapProviderScopeMappingCandidate(representative);
        const isAccepted = mapping.reviewStatus === "accepted" || mapping.reviewStatus === "auto-accepted";
        const syncStatus = isAccepted
          ? await input.loadSyncStatus(representative)
          : { totalObservations: 0, promotedObservations: 0 };

        return {
          providerKey,
          state: computeScopeCoverageState({
            mapping,
            syncedObservations: syncStatus.totalObservations,
            promotedObservations: syncStatus.promotedObservations,
          }),
          mapping,
          syncedObservations: syncStatus.totalObservations,
          promotedObservations: syncStatus.promotedObservations,
        };
      }),
  );

  return {
    schemaVersion: scopeCoverageContractVersion,
    generatedAt: input.generatedAt,
    scopeRecordId: input.scope.scope_record_id,
    scopeName: input.scope.name,
    productDomain: input.scope.product_domain,
    scopeKind: input.scope.scope_kind,
    officialSetCode: input.scope.official_set_code,
    releaseDate: input.scope.release_date,
    lifecycleStatus: input.scope.lifecycle_status,
    providers,
  };
}

// --- helpers -------------------------------------------------------------------

function readLanguageCoordinates(value: unknown): ProviderScopeMappingCoordinates["language"] {
  const record = isRecord(value) ? value : {};
  return {
    languageCode: stringOrNull(record.languageCode),
    providerLanguageCode: stringOrNull(record.providerLanguageCode),
    providerLanguageId: stringOrNull(record.providerLanguageId),
    providerLocale: stringOrNull(record.providerLocale),
    providerLanguageName: stringOrNull(record.providerLanguageName),
  };
}

function readProvenance(value: unknown): ProviderScopeMappingProvenance {
  const record = isRecord(value) ? value : {};
  return {
    source: typeof record.source === "string" ? record.source : "",
    sourceId: stringOrNull(record.sourceId),
    sourceProfileKey: stringOrNull(record.sourceProfileKey),
    sourceProfileVersion: stringOrNull(record.sourceProfileVersion),
    mappingFingerprint: stringOrNull(record.mappingFingerprint),
  };
}

function readJsonObject(value: unknown): JsonObject {
  return isRecord(value) ? (value as JsonObject) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}
