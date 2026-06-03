import type { JsonValue } from "@chase-sets/primitives/json";
import type { SourceObservationNormalized } from "../domain/domain";

export interface SourceObservationListItem {
  observation_id: string;
  provider_key: string;
  external_key: string;
  source_url: string;
  language_code: string;
  source_record_hash: string;
  source_updated_at: string | null;
  observed_at: string;
  normalized: SourceObservationNormalized;
  status: string;
  status_reason: string | null;
  promoted_catalog_item_id: string | null;
  promoted_at: string | null;
  updated_at: string;
}

export interface SourceObservationDetail extends SourceObservationListItem {
  source_payload: JsonValue;
}

export interface SourceObservationIntegrationScope {
  provider_key: string;
  language_code: string;
  expansion_id: string;
  expansion_name: string;
  series_id: string;
  series_name: string;
  product_line_id: string;
  product_line_name: string;
  total_observations: number;
  observed_observations: number;
  changed_observations: number;
  promoted_observations: number;
  rejected_observations: number;
  first_observed_at: string;
  latest_observed_at: string;
  latest_source_updated_at: string | null;
}

export interface TcgdexSetImportResult {
  setId: string;
  expansionId: string;
  languageCode: string;
  observed: number;
  observationIds: string[];
}

export interface TcgdexLanguageOption {
  languageCode: string;
}

export interface TcgdexSeriesOption {
  seriesId: string;
  name: string;
  logoUrl: string | null;
}

export interface TcgdexExpansionOption {
  expansionId: string;
  name: string;
  seriesId: string | null;
  seriesName: string | null;
  logoUrl: string | null;
  symbolUrl: string | null;
  cardCount: number | null;
  officialCardCount: number | null;
}

export interface SourceObservationIntegrationOption {
  providerKey: string;
  queryKind: string;
  value: string;
  label: string;
  description: string | null;
  parentValue: string | null;
  imageUrl: string | null;
  metadata: Record<string, JsonValue>;
}

export interface CatalogProviderProfileReviewDiagnostic {
  code: string;
  path: string;
  diagnosticText: string;
  severity: "error" | "warning";
}

export interface CatalogProviderProfileDryRunDiagnostic {
  code: string;
  path: string;
  diagnosticText: string;
  redaction: string;
}

export interface CatalogProviderProfileVersionReview {
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  displayName: string;
  lifecycle: string;
  active: boolean;
  status: string;
  compatibilityMode: string;
  connectorKind: string;
  sourceContract: {
    owner: string;
    repository: string | null;
    commit: string | null;
    documentPath: string;
    fixtureSetVersion: string;
  };
  fixtures: {
    fixtureRoot: string;
    coveredFlows: string[];
    liveProviderCallsAllowed: false;
  };
  capabilities: string[];
  supportedScopes: string[];
  languageOptions: string[];
  mappingOutputKind: string;
  hasExecutableMappingContract: boolean;
  validation: {
    status: "valid" | "invalid";
    diagnostics: CatalogProviderProfileReviewDiagnostic[];
  };
}

export interface CatalogProviderProfileDryRunEvidence {
  path: string;
  owner: string;
  uses: string[];
  redaction: string;
  value: JsonValue;
  diagnostics: CatalogProviderProfileDryRunDiagnostic[];
}

export interface CatalogProviderProfileDryRunResult {
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  status: "completed" | "blocked";
  redactedPayload: JsonValue;
  observation: {
    observationId: string;
    providerKey: string;
    externalKey: string;
    sourceUrl: string;
    languageCode: string;
    sourceRecordHash: string;
    sourceUpdatedAt: string | null;
    observedAt: string;
    normalized: SourceObservationNormalized;
    sourcePayload: JsonValue;
  } | null;
  diagnostics: CatalogProviderProfileDryRunDiagnostic[];
  hashMaterial: CatalogProviderProfileDryRunEvidence[];
  externalReferences: {
    catalogItemReferences: JsonValue;
    productReferences: JsonValue;
  };
  selectedOptions: JsonValue;
  mergeCandidateEvidence: CatalogProviderProfileDryRunEvidence[];
  duplicatePreventionRules: {
    ruleKey: string;
    ruleKind: string;
    candidatePolicy: string;
    evidence: CatalogProviderProfileDryRunEvidence[];
  }[];
  promotionCommandPlan: {
    requiresReview: true;
    commands: {
      commandName: string;
      inputs: CatalogProviderProfileDryRunEvidence[];
    }[];
  };
}

export interface SourceObservationPromotionScope {
  search?: string;
  status?: string;
  provider?: string;
  language?: string;
  setId?: string;
}

export interface SourceObservationPromotionPreview {
  matched: number;
  eligible: number;
  terminal: number;
  scope: Required<SourceObservationPromotionScope>;
}

export interface SourceObservationReapplyPreview {
  matched: number;
  eligible: number;
  ineligible: number;
  scope: Required<SourceObservationPromotionScope>;
}

export type BulkSourceObservationPromotionStatus = "promoted" | "rejected" | "skipped" | "failed";

export interface BulkSourceObservationPromotionOutcome {
  observationId: string;
  status: BulkSourceObservationPromotionStatus;
  catalogItemId: string | null;
  reason: string | null;
}

export interface BulkSourceObservationPromotionResult {
  requested: number;
  promoted: number;
  rejected?: number;
  skipped: number;
  failed: number;
  outcomes: BulkSourceObservationPromotionOutcome[];
}

export type BulkSourceObservationReapplyStatus = "reapplied" | "skipped" | "failed";

export interface BulkSourceObservationReapplyOutcome {
  observationId: string;
  status: BulkSourceObservationReapplyStatus;
  catalogItemId: string | null;
  reason: string | null;
}

export interface BulkSourceObservationReapplyResult {
  requested: number;
  reapplied: number;
  skipped: number;
  failed: number;
  outcomes: BulkSourceObservationReapplyOutcome[];
}

export type SourceObservationIntegrationJobAction = "import" | "reapply";

export interface SourceObservationIntegrationJobScope {
  provider?: string;
  language?: string;
  seriesId?: string;
  setId?: string;
  productLineId?: string;
  setName?: string;
  productId?: string;
}

export interface SourceObservationIntegrationJobOutcome {
  providerKey: string;
  languageCode: string;
  expansionId: string | null;
  status: "imported" | "reapplied" | "skipped" | "failed";
  observed: number;
  reapplied: number;
  reason: string | null;
}

export interface SourceObservationIntegrationJobResult {
  requested: number;
  imported: number;
  observed: number;
  reapplied: number;
  skipped: number;
  failed: number;
  outcomes: SourceObservationIntegrationJobOutcome[];
}
