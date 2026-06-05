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
  source_profile_key: string;
  source_profile_version: string;
  source_mapping_fingerprint: string;
  normalized: SourceObservationNormalized;
  status: string;
  status_reason: string | null;
  promoted_catalog_item_id: string | null;
  promoted_at: string | null;
  promotion_profile_key: string | null;
  promotion_profile_version: string | null;
  promotion_plan_fingerprint: string | null;
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
  profile: JsonValue;
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
  retirementPlan: JsonValue;
  executableMappingContract: JsonValue;
  referenceCount: number;
  capabilities: string[];
  supportedScopes: string[];
  languageOptions: string[];
  mappingOutputKind: string;
  hasExecutableMappingContract: boolean;
  migrationEvidence: {
    evidenceText: string;
    mappingFingerprintBefore?: string | null;
    mappingFingerprintAfter?: string | null;
    fixtureRunId?: string | null;
    recordedAt: string;
    recordedByUserId?: string | null;
    recordedForAccountId?: string | null;
  } | null;
  authoringAudit: {
    createdAt?: string | null;
    createdByUserId?: string | null;
    createdForAccountId?: string | null;
    updatedAt?: string | null;
    updatedByUserId?: string | null;
    updatedForAccountId?: string | null;
  } | null;
  validation: {
    status: "valid" | "invalid";
    diagnostics: CatalogProviderProfileReviewDiagnostic[];
  };
}

export type CatalogProviderProfileEditableSectionKey =
  | "basics"
  | "provider-options"
  | "connector"
  | "catalog-field-mapping"
  | "source-contract"
  | "fixtures"
  | "source-observation"
  | "normalized-observation"
  | "external-references"
  | "selected-options"
  | "reference-hierarchy"
  | "duplicate-prevention"
  | "promotion-plan"
  | "retirement-plan"
  | "migration-evidence";

export type CatalogProviderProfileSectionObject = Record<string, JsonValue>;

export interface CatalogProviderProfileBasicsUpdateCommand {
  section: "basics";
  lifecycle?: "draft" | "test";
  displayName?: string;
  status?: "active" | "planned";
  compatibilityMode?: "executable-mapping-contract" | "transitional-static-profile";
  capabilities?: string[];
  supportedScopes?: string[];
  languageOptions?: string[];
}

export interface CatalogProviderProfileProviderOptionsUpdateCommand {
  section: "provider-options";
  optionQueries: CatalogProviderProfileSectionObject[];
}

export interface CatalogProviderProfileConnectorUpdateCommand {
  section: "connector";
  connector: CatalogProviderProfileSectionObject;
  mappingConnector?: CatalogProviderProfileSectionObject;
}

export interface CatalogProviderProfileCatalogFieldMappingUpdateCommand {
  section: "catalog-field-mapping";
  catalogFieldMapping: CatalogProviderProfileSectionObject;
}

export interface CatalogProviderProfileSourceContractUpdateCommand {
  section: "source-contract";
  sourceContract: CatalogProviderProfileVersionReview["sourceContract"];
}

export interface CatalogProviderProfileFixturesUpdateCommand {
  section: "fixtures";
  fixtures: CatalogProviderProfileVersionReview["fixtures"];
}

export interface CatalogProviderProfileSourceObservationUpdateCommand {
  section: "source-observation";
  sourceObservation: CatalogProviderProfileSectionObject | null;
}

export interface CatalogProviderProfileNormalizedObservationUpdateCommand {
  section: "normalized-observation";
  normalizedObservationMapping?: CatalogProviderProfileSectionObject;
  normalizedObservationContract?: CatalogProviderProfileSectionObject;
}

export interface CatalogProviderProfileExternalReferencesUpdateCommand {
  section: "external-references";
  externalReferenceExtractionRules?: CatalogProviderProfileSectionObject;
  externalReferenceContracts?: CatalogProviderProfileSectionObject[];
}

export interface CatalogProviderProfileSelectedOptionsUpdateCommand {
  section: "selected-options";
  selectedOptionMapping: CatalogProviderProfileSectionObject | null;
}

export interface CatalogProviderProfileReferenceHierarchyUpdateCommand {
  section: "reference-hierarchy";
  referenceHierarchyMapping?: CatalogProviderProfileSectionObject;
  referenceHierarchyContracts?: CatalogProviderProfileSectionObject[];
}

export interface CatalogProviderProfileDuplicatePreventionUpdateCommand {
  section: "duplicate-prevention";
  duplicatePreventionMapping?: CatalogProviderProfileSectionObject;
  ambiguityRules?: CatalogProviderProfileSectionObject;
  duplicatePreventionContract?: CatalogProviderProfileSectionObject;
}

export interface CatalogProviderProfilePromotionPlanUpdateCommand {
  section: "promotion-plan";
  promotionCommandPlan: CatalogProviderProfileSectionObject;
}

export interface CatalogProviderProfileRetirementPlanUpdateCommand {
  section: "retirement-plan";
  retirementPlan: JsonValue;
}

export interface CatalogProviderProfileMigrationEvidenceUpdateCommand {
  section: "migration-evidence";
  migrationEvidence: CatalogProviderProfileVersionReview["migrationEvidence"];
}

export type CatalogProviderProfileSectionUpdateCommand =
  | CatalogProviderProfileBasicsUpdateCommand
  | CatalogProviderProfileProviderOptionsUpdateCommand
  | CatalogProviderProfileConnectorUpdateCommand
  | CatalogProviderProfileCatalogFieldMappingUpdateCommand
  | CatalogProviderProfileSourceContractUpdateCommand
  | CatalogProviderProfileFixturesUpdateCommand
  | CatalogProviderProfileSourceObservationUpdateCommand
  | CatalogProviderProfileNormalizedObservationUpdateCommand
  | CatalogProviderProfileExternalReferencesUpdateCommand
  | CatalogProviderProfileSelectedOptionsUpdateCommand
  | CatalogProviderProfileReferenceHierarchyUpdateCommand
  | CatalogProviderProfileDuplicatePreventionUpdateCommand
  | CatalogProviderProfilePromotionPlanUpdateCommand
  | CatalogProviderProfileRetirementPlanUpdateCommand
  | CatalogProviderProfileMigrationEvidenceUpdateCommand;

export interface CatalogProviderProfileEditableSection {
  section: CatalogProviderProfileEditableSectionKey;
  displayName: string;
  requiredPermission: "catalog.manage";
  rawJsonBacked: false;
}

export interface CatalogProviderProfileFixtureMetadata {
  flow: string;
  payloadFile: string;
  payloadPath: string;
  expectedStatus: "completed" | "blocked";
  expectedDiagnosticPaths: string[];
  expectedHashEvidencePaths: string[];
  expectedMergeEvidencePaths: string[];
  expectedPromotionCommands: string[];
  expectedObservation: JsonValue;
  samplePayload: JsonValue;
  samplePayloadAvailable: boolean;
}

export interface CatalogProviderProfileDryRunInputTemplate {
  observedAt: string;
  defaultFlow: string | null;
  payload: JsonValue;
  fixturePayloads: CatalogProviderProfileFixtureMetadata[];
}

export interface CatalogProviderProfileSemanticDiff {
  providerKey: string;
  candidateProfileVersion: string;
  activeProfileVersion: string | null;
  mappingFingerprint: {
    candidate: string | null;
    active: string | null;
    changed: boolean;
  };
  changes: {
    path: string;
    label: string;
    candidate: JsonValue;
    active: JsonValue;
    changed: boolean;
    severity: "info" | "warning" | "error";
    activationImpact: string;
  }[];
}

export interface CatalogProviderProfileActivationReadiness {
  status: "ready" | "blocked";
  checks: {
    checkKey: string;
    status: "passed" | "blocked";
    path: string;
    diagnosticText: string;
    severity: "error" | "warning";
    flow?: string;
  }[];
  requiresMigrationEvidence: boolean;
  referenceCount: number;
}

export interface CatalogProviderSelectedOptionAuthoringSchema {
  dimensions: {
    dimensionId: string;
    dimensionKey: string;
    dimensionName: string;
    status: string;
    options: {
      optionId: string;
      optionKey: string;
      optionLabel: string;
      status: string;
    }[];
  }[];
}

export interface CatalogProviderPromotionTargetAuthoringSchema {
  blueprints: CatalogProviderPromotionTargetAuthoringRecord[];
  categories: CatalogProviderPromotionTargetAuthoringRecord[];
  fields: CatalogProviderPromotionTargetAuthoringRecord[];
}

export interface CatalogProviderPromotionTargetAuthoringRecord {
  id: string;
  key: string;
  name: string;
  status: string;
}

export interface CatalogProviderProfileAuthoringModel {
  review: CatalogProviderProfileVersionReview;
  editableSections: CatalogProviderProfileEditableSection[];
  fixtureCases: CatalogProviderProfileFixtureMetadata[];
  dryRunInputTemplate: CatalogProviderProfileDryRunInputTemplate;
  semanticDiff: CatalogProviderProfileSemanticDiff;
  activationReadiness: CatalogProviderProfileActivationReadiness;
  selectedOptionSchema: CatalogProviderSelectedOptionAuthoringSchema | null;
  promotionTargetSchema: CatalogProviderPromotionTargetAuthoringSchema | null;
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
  duplicatePreventionPolicy: {
    ambiguousCandidatePolicy: string;
    replayPolicy: string;
    exactExternalCatalogItemReferencesFirst: boolean;
  };
  duplicatePreventionRules: {
    ruleKey: string;
    ruleKind: string;
    candidatePolicy: string;
    evidence: CatalogProviderProfileDryRunEvidence[];
  }[];
  duplicatePreventionCandidatePreview: {
    status: "matched" | "none" | "blocked" | "review-only" | "not-evaluated";
    ruleKey: string | null;
    candidateCount: number;
    candidateCatalogItemIds: string[];
    diagnosticText: string | null;
    evidenceSummary: JsonValue;
    evidenceSummaries: JsonValue;
  } | null;
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
