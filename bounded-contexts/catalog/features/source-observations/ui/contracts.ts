import type { JsonValue } from "@chase-sets/primitives/json";
import type { ProviderOptionAliasRecord } from "../api/provider-option-aliases";
import type {
  CatalogMergeCandidateConflict,
  CatalogMergeCandidateExternalCatalogItemReference,
  CatalogMergeCandidateExternalProductReference,
  CatalogMergeCandidateFieldProvenance,
  CatalogMergeCandidateIdentity,
  CatalogMergeCandidateObservationMember,
  CatalogMergeCandidatePromotionIntent,
  CatalogMergeCandidateStatus,
  CatalogMergeCandidateWarning,
} from "../domain/catalog-merge-candidate";
import type { SourceObservationNormalized } from "../domain/domain";
import type { CatalogAdminProfileVersionPointer } from "../api/admin-control-plane-read-model-contracts";
import type {
  CatalogProviderProfileBasicsUpdateCommand,
  CatalogProviderProfileCatalogFieldMappingUpdateCommand,
  CatalogProviderProfileConnectorUpdateCommand,
  CatalogProviderProfileDuplicatePreventionUpdateCommand,
  CatalogProviderProfileEditableSectionKey,
  CatalogProviderProfileExternalReferencesUpdateCommand,
  CatalogProviderProfileFixturesUpdateCommand,
  CatalogProviderProfileMigrationEvidenceUpdateCommand,
  CatalogProviderProfileNormalizedObservationUpdateCommand,
  CatalogProviderProfilePromotionPlanUpdateCommand,
  CatalogProviderProfileProviderOptionsUpdateCommand,
  CatalogProviderProfileReferenceHierarchyUpdateCommand,
  CatalogProviderProfileRetirementPlanUpdateCommand,
  CatalogProviderProfileSectionUpdateCommand,
  CatalogProviderProfileSelectedOptionsUpdateCommand,
  CatalogProviderProfileSourceContractUpdateCommand,
  CatalogProviderProfileSourceObservationUpdateCommand,
} from "../api/provider-profile-admin-contracts";
export { catalogProviderProfileEditableSectionKeys } from "../api/provider-profile-admin-contracts";

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
  promoted_reference_record_id: string | null;
  promoted_at: string | null;
  promotion_profile_key: string | null;
  promotion_profile_version: string | null;
  promotion_plan_fingerprint: string | null;
  updated_at: string;
}

export interface SourceObservationDetail extends SourceObservationListItem {
  source_payload: JsonValue;
}

export interface CatalogMergeCandidateListItem {
  candidate_id: string;
  identity_fingerprint: string;
  sync_run_ids_json: string[];
  status: CatalogMergeCandidateStatus;
  status_reason: string | null;
  identity_json: CatalogMergeCandidateIdentity;
  matched_catalog_item_id: string | null;
  matched_product_ids_json: string[];
  proposed_catalog_item_facts_json: JsonValue;
  proposed_external_catalog_item_references_json: CatalogMergeCandidateExternalCatalogItemReference[];
  proposed_external_product_references_json: CatalogMergeCandidateExternalProductReference[];
  conflicts_json: CatalogMergeCandidateConflict[];
  warnings_json: CatalogMergeCandidateWarning[];
  field_provenance_json: CatalogMergeCandidateFieldProvenance[];
  membership_json: CatalogMergeCandidateObservationMember[];
  promotion_intent: CatalogMergeCandidatePromotionIntent;
  created_at: string;
  updated_at: string;
  stale_at: string | null;
  observation_count: number;
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
  aliases: ProviderOptionAliasRecord[];
  metadata: Record<string, JsonValue>;
}

export interface SourceObservationIntegrationOptionQueryPage {
  cursor: string | null;
  nextCursor: string | null;
  limit: number;
  hasMore: boolean;
}

export interface SourceObservationIntegrationOptionQueryCache {
  status: "fresh" | "stale" | "miss" | "bypass" | "unavailable";
  source: "cache" | "live" | "none";
  cacheKey: string;
  fetchedAt: string | null;
  expiresAt: string | null;
  staleUntil: string | null;
  cacheOnly: boolean;
  forceRefresh: boolean;
  degraded: boolean;
  diagnostics: {
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
    retryAfterSeconds: number | null;
  }[];
}

export interface SourceObservationIntegrationOptionResponse {
  items: SourceObservationIntegrationOption[];
  total: number;
  count: number;
  page?: SourceObservationIntegrationOptionQueryPage;
  cache?: SourceObservationIntegrationOptionQueryCache;
}

export interface CatalogProviderSourceOptionKind {
  queryKind: string;
  queryKeySynonyms: string[];
  displayName: string;
  scope: string;
  parentScope: string | null;
  parentRequired: boolean;
  parentValueKind: string | null;
  parentDiagnosticText: string | null;
}

export interface CatalogIntegrationControlPlaneReadiness {
  generatedAt: string;
  rolloutControls: CatalogIntegrationRolloutControlSnapshot;
  units: CatalogIntegrationControlPlaneUnitReadiness[];
}

export interface CatalogIntegrationRolloutControlSnapshot {
  generatedAt: string;
  controls: CatalogIntegrationRolloutControl[];
}

export interface CatalogIntegrationRolloutControl {
  controlId: string;
  defaultState: "open" | "quarantined";
  status: "open" | "degraded" | "blocked";
  severity: "info" | "warning" | "error";
  capabilities: string[];
  providerKeys: string[];
  profileKeys: string[];
  unitKeys: string[];
  message: string;
  auditEventName: "rollout-control-evaluated" | "rollout-control-denied";
  metricKey: string;
}

export interface CatalogIntegrationControlPlaneUnitReadiness {
  unitKey: string;
  providerKey: string;
  displayName: string;
  productDomain: string;
  productForm: string;
  ingestionPurpose: string | null;
  profileVersion: string;
  semanticReadiness: "ready" | "blocked";
  credentialReadiness: "ready" | "blocked" | "not-required";
  credentialReadinessState: "not-required" | "configured" | "missing" | "invalid" | "expired" | "revoked" | "unknown";
  credentialRequirement: "not-required" | "required";
  credentialDiagnosticCode: string | null;
  transportReadiness: "ready" | "blocked";
  fixtureValidationStatus: "ready" | "blocked";
  dryRunStatus: "completed" | "blocked";
  observationFacts: number;
  diagnosticCounts: {
    info: number;
    warning: number;
    error: number;
  };
  diagnostics: CatalogIntegrationControlPlaneDiagnostic[];
  latestDiagnosticText: string | null;
  dryRunEvidence: {
    externalKey: string;
    sourceUrl: string | null;
    sourceHash: string | null;
    normalizedFacts: Record<string, string>;
  }[];
}

export interface CatalogIntegrationControlPlaneDiagnostic {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  unitKey: string | null;
  retryAfterSeconds: number | null;
  source: "catalog" | "provider-adapter";
}

export interface CatalogIntegrationControlPlaneOverview {
  generatedAt: string;
  readiness: CatalogIntegrationControlPlaneReadiness;
  unitActivity: {
    generatedAt: string;
    units: CatalogIntegrationUnitActivity[];
  };
  providerReadiness: {
    generatedAt: string;
    providers: CatalogIntegrationProviderReadiness[];
  };
  auditLifecycle: {
    generatedAt: string;
    projectionStatus: "partial" | "unavailable";
    statusMessage: string;
    entries: CatalogIntegrationAuditLifecycleEntry[];
  };
}

export interface CatalogIntegrationUnitActivity {
  unitKey: string;
  recentJobs: CatalogIntegrationRecentJobSummary[];
}

export interface CatalogIntegrationRecentJobSummary {
  jobId: string;
  action: SourceObservationIntegrationJobAction;
  operatorStatus: SourceObservationIntegrationJobOperatorStatus;
  phase: SourceObservationIntegrationJobPhase;
  completed: number;
  total: number;
  unitKey: string | null;
  providerKey: string;
  importScope: string | null;
  profileVersion: string | null;
  profileSnapshot: CatalogAdminProfileVersionPointer | null;
  reapplyProfileMode: SourceObservationReapplyProfileMode | null;
  result: CatalogIntegrationRecentJobResultSummary | null;
  startedAt: string | null;
  createdAt: string;
  summary: string;
}

export interface CatalogIntegrationRecentJobResultSummary {
  requested: number;
  imported: number;
  observed: number;
  reapplied: number;
  skipped: number;
  failed: number;
  outcomeCount: number;
  redactedFailureReasons?: string[];
}

export interface CatalogIntegrationProviderReadiness {
  providerKey: string;
  adapterKey: string;
  readiness: "ready" | "blocked" | "degraded";
  credentialReadiness: "ready" | "blocked" | "not-required";
  credentialReadinessState: CatalogIntegrationControlPlaneUnitReadiness["credentialReadinessState"];
  credentialRequirement: CatalogIntegrationControlPlaneUnitReadiness["credentialRequirement"];
  unitKeys: string[];
  apiReachability: CatalogIntegrationProviderCapabilityStatus;
  optionQueryHealth: CatalogIntegrationProviderCapabilityStatus;
  rateLimitStatus: CatalogIntegrationProviderCapabilityStatus;
  payloadAcquisition: CatalogIntegrationProviderCapabilityStatus;
  usageBudget: CatalogIntegrationProviderUsageBudget | null;
  diagnostics: CatalogIntegrationControlPlaneDiagnostic[];
}

export interface CatalogIntegrationProviderUsageBudget {
  creditBalance: number | null;
  creditUnit: string | null;
  readiness: "ready" | "degraded" | "blocked" | "unknown";
  estimatedCalls: number | null;
  estimatedScope: string | null;
  refreshedAt: string | null;
}

export interface CatalogIntegrationProviderCapabilityStatus {
  status: "ready" | "blocked" | "degraded" | "unknown";
  diagnosticCodes: string[];
  message: string | null;
}

export interface CatalogIntegrationAuditLifecycleEntry {
  eventId: string;
  occurredAt: string;
  eventName:
    | "profile-created"
    | "profile-section-edited"
    | "profile-activated"
    | "profile-deprecated"
    | "profile-rolled-back"
    | "profile-retired"
    | "import-job-started"
    | "reapply-run-executed";
  category: "profile" | "profile-section" | "activation" | "import-job" | "reapply";
  providerKey: string;
  unitKey: string | null;
  profileVersion: string | null;
  actorUserId: string | null;
  relatedJobId: string | null;
  summary: string;
  diagnosticCodes: string[];
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
  ingestionUnitKey: string;
  displayName: string;
  lifecycle: string;
  active: boolean;
  status: string;
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
  sourceOptionKinds: CatalogProviderSourceOptionKind[];
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

export type {
  CatalogProviderProfileBasicsUpdateCommand,
  CatalogProviderProfileCatalogFieldMappingUpdateCommand,
  CatalogProviderProfileConnectorUpdateCommand,
  CatalogProviderProfileDuplicatePreventionUpdateCommand,
  CatalogProviderProfileEditableSectionKey,
  CatalogProviderProfileExternalReferencesUpdateCommand,
  CatalogProviderProfileFixturesUpdateCommand,
  CatalogProviderProfileMigrationEvidenceUpdateCommand,
  CatalogProviderProfileNormalizedObservationUpdateCommand,
  CatalogProviderProfilePromotionPlanUpdateCommand,
  CatalogProviderProfileProviderOptionsUpdateCommand,
  CatalogProviderProfileReferenceHierarchyUpdateCommand,
  CatalogProviderProfileRetirementPlanUpdateCommand,
  CatalogProviderProfileSectionUpdateCommand,
  CatalogProviderProfileSelectedOptionsUpdateCommand,
  CatalogProviderProfileSourceContractUpdateCommand,
  CatalogProviderProfileSourceObservationUpdateCommand,
};

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
    sectionKey: string;
    domainConcept: string;
    severity: "info" | "warning" | "error";
    activationImpact: string;
  }[];
  sections: {
    sectionKey: string;
    domainConcept: string;
    status: "valid" | "warning" | "error";
    changes: CatalogProviderProfileSemanticDiff["changes"];
  }[];
}

export interface CatalogProviderProfileActivationReadiness {
  status: "ready" | "blocked";
  checks: {
    checkKey: string;
    code: string;
    sectionKey: string;
    domainConcept: string;
    status: "passed" | "blocked";
    path: string;
    diagnosticText: string;
    severity: "error" | "warning";
    remediation: string;
    blockingBehavior: string;
    flow?: string;
  }[];
  groups: {
    domainConcept: string;
    status: "ready" | "blocked";
    checks: CatalogProviderProfileActivationReadiness["checks"];
  }[];
  requiresMigrationEvidence: boolean;
  referenceCount: number;
}

export interface CatalogProviderProfileSectionSummary {
  sectionKey: string;
  domainConcept: string;
  editable: boolean;
  status: "valid" | "warning" | "error" | "blocked";
  diagnostics: {
    path: string;
    diagnosticText: string;
    severity: "error" | "warning";
  }[];
  semanticChanges: CatalogProviderProfileSemanticDiff["changes"];
  readinessChecks: CatalogProviderProfileActivationReadiness["checks"];
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
  sectionSummaries: CatalogProviderProfileSectionSummary[];
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
  diagnosticLinks: {
    code: string;
    path: string;
    sectionKey: string;
    domainConcept: string;
    fixtureFlow: string | null;
  }[];
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
  productLineId?: string;
  seriesId?: string;
  expansionId?: string;
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
  impact?: SourceObservationReplayImpactSummary;
}

export interface SourceObservationExternalReferenceImpactSample {
  observationId: string;
  referenceKind: "catalog-item-reference" | "product-reference";
  providerKey: string;
  externalKey: string;
  catalogItemId: string | null;
}

export interface SourceObservationReplayImpactSummary {
  matchedObservations: number;
  eligibleObservations: number;
  blockedObservations: number;
  impactedCatalogItemCount: number;
  impactedCatalogItemIds: string[];
  externalReferenceCount: number;
  externalReferenceSamples: SourceObservationExternalReferenceImpactSample[];
  sampleObservationIds: string[];
}

export type BulkSourceObservationPromotionStatus = "promoted" | "rejected" | "deferred" | "skipped" | "failed";

export interface BulkSourceObservationPromotionOutcome {
  observationId: string;
  status: BulkSourceObservationPromotionStatus;
  catalogItemId: string | null;
  referenceRecordId?: string | null;
  reason: string | null;
}

export interface BulkSourceObservationPromotionResult {
  requested: number;
  promoted: number;
  rejected?: number;
  deferred?: number;
  skipped: number;
  failed: number;
  outcomes: BulkSourceObservationPromotionOutcome[];
}

export type BulkSourceObservationReapplyStatus = "reapplied" | "skipped" | "failed";

export interface BulkSourceObservationReapplyOutcome {
  observationId: string;
  status: BulkSourceObservationReapplyStatus;
  catalogItemId: string | null;
  referenceRecordId?: string | null;
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
export type SourceObservationReapplyProfileMode = "original-source-profile" | "current-active-profile";
export type SourceObservationIntegrationJobPhase =
  | "enqueued"
  | "fetching"
  | "processing"
  | "persisting"
  | "completed"
  | "failed";
export type SourceObservationIntegrationJobOperatorStatus =
  | "queued"
  | "running"
  | "stale"
  | "retried"
  | "partial"
  | "failed"
  | "cancelled"
  | "completed";

export interface SourceObservationIntegrationProfileSnapshot {
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  lifecycle: string;
  connectorKind: string;
  connectorSourceVersion: string | null;
  sourceMappingFingerprint: string;
}

export interface SourceObservationIntegrationJobConsistency {
  duplicateSubmissionPolicy: "reuse-active-job";
  profileSnapshotPolicy: "snapshotted-at-enqueue";
  retryResumePolicy: "skip-completed-outcomes";
  partialFailurePolicy: "mixed-outcomes";
  workUnitClaimPolicy: "leased-job-turns" | "leased-work-units";
}

export interface SourceObservationIntegrationJobScope {
  provider?: string;
  profileKey?: string;
  ingestionUnitKey?: string;
  language?: string;
  seriesId?: string;
  setId?: string;
  productLineId?: string;
  setName?: string;
  productId?: string;
}

export type CatalogSyncScopeReferenceKind = "product-line" | "series" | "expansion" | "set" | "catalog-item";

export interface CatalogSyncScopeReference {
  kind: CatalogSyncScopeReferenceKind;
  id: string;
  name: string | null;
  seriesId?: string | null;
  seriesName?: string | null;
}

export interface CatalogSyncScope {
  scopeVersion: "catalog-sync-scope-v1";
  productDomain: string;
  productForm: string;
  languageCode: string;
  reference: CatalogSyncScopeReference;
  providerHints?: {
    providerKey: string;
    unitKey?: string | null;
    providerScope?: SourceObservationIntegrationJobScope | null;
  }[];
  providerParticipation?: {
    requiredUnitKeys?: string[];
    selectedUnitKeys?: string[];
    excludedUnitKeys?: string[];
  } | null;
}

export interface SourceObservationIntegrationJob {
  jobId: string;
  syncRunId: string | null;
  action: SourceObservationIntegrationJobAction;
  scope: SourceObservationIntegrationJobScope;
  profileSnapshot: SourceObservationIntegrationProfileSnapshot | null;
  reapplyProfileMode: SourceObservationReapplyProfileMode | null;
  status: "queued" | "running" | "completed" | "failed";
  operatorStatus: SourceObservationIntegrationJobOperatorStatus;
  consistency: SourceObservationIntegrationJobConsistency;
  progress: {
    phase: SourceObservationIntegrationJobPhase;
    completed: number;
    total: number;
    currentName: string | null;
    status: string | null;
  };
  result: SourceObservationIntegrationJobResult | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
}

export interface CatalogSyncProviderParticipationPreviewUnit {
  providerKey: string;
  unitKey: string;
  profileKey: string;
  profileVersion: string;
  displayName: string;
  role: "primary" | "supplementary" | "reference";
  requirement: "required" | "optional";
  selected: boolean;
  eligibility: "eligible" | "blocked";
  childExecutionScope: SourceObservationIntegrationJobScope | null;
  estimate: SourceObservationProviderUsageEstimate | null;
  blockers: {
    code: string;
    severity: "info" | "warning" | "error";
    message: string;
    providerKey: string;
    unitKey: string | null;
  }[];
}

export interface CatalogSyncProviderParticipationPreview {
  previewVersion: "catalog-sync-provider-participation-preview-v1";
  scope: CatalogSyncScope;
  status: "ready" | "blocked";
  startAllowed: boolean;
  units: CatalogSyncProviderParticipationPreviewUnit[];
  blockers: CatalogSyncProviderParticipationPreviewUnit["blockers"];
  explanation: string;
}

export type CatalogSyncRunOperatorStatus = "queued" | "running" | "completed" | "partial" | "failed" | "cancelled";

export interface CatalogSyncRun {
  syncRunId: string;
  scope: CatalogSyncScope;
  status: CatalogSyncRunOperatorStatus;
  progress: {
    childJobs: {
      total: number;
      queued: number;
      running: number;
      completed: number;
      partial: number;
      failed: number;
      cancelled: number;
      stale: number;
    };
    providerTargets: {
      completed: number;
      total: number;
    };
  };
  selectedUnits: {
    providerKey: string;
    unitKey: string;
    profileKey: string;
    profileVersion: string;
    displayName: string;
    role: CatalogSyncProviderParticipationPreviewUnit["role"];
    requirement: CatalogSyncProviderParticipationPreviewUnit["requirement"];
    childExecutionScope: SourceObservationIntegrationJobScope;
  }[];
  childJobs: {
    providerKey: string;
    unitKey: string;
    profileKey: string;
    profileVersion: string;
    displayName: string;
    childExecutionScope: SourceObservationIntegrationJobScope;
    childJobId: string | null;
    syncRunLinkState:
      | "attached-to-child-payload"
      | "reused-active-child-job"
      | "reused-settled-child-job"
      | "child-enqueue-failed";
    errorMessage: string | null;
    status: string;
    job: SourceObservationIntegrationJob | null;
  }[];
  preview: CatalogSyncProviderParticipationPreview;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
}

// Durable per-scope sync state: one row per (scope, provider unit), surviving
// across runs. This is what the scope page renders so a provider that
// settled two runs ago still shows as settled, and a failed provider can be
// retried individually via `lastJobId`.
export type CatalogScopeSyncUnitState = "never-synced" | "pending" | "running" | "settled" | "failed" | "stale";

export interface CatalogScopeSyncUnitStateReadModel {
  providerKey: string;
  unitKey: string;
  displayName: string;
  role: string;
  requirement: string;
  state: CatalogScopeSyncUnitState;
  lastSyncRunId: string | null;
  lastJobId: string | null;
  lastOperatorStatus: string | null;
  observedCount: number | null;
  changedCount: number | null;
  requestedCount: number | null;
  failedCount: number | null;
  errorMessage: string | null;
  lastStartedAt: string | null;
  lastCompletedAt: string | null;
  updatedAt: string;
}

export interface SourceObservationProviderUsageEstimate {
  requestStrategy: "bulk-first" | "single-record" | "unknown";
  estimateState: "estimated" | "estimate-unavailable";
  estimatedRequestCount: number | null;
  estimateReason: string | null;
  pageSize: number | null;
  selectedFields: string[];
  perRecordFallbackReason: string | null;
  usageCheckState: "checked" | "not-supported" | "not-configured" | "unavailable" | "unknown";
  creditDiagnostic: string | null;
  degradedDiagnostic: string | null;
}

export interface SourceObservationProviderUsageEvidence extends SourceObservationProviderUsageEstimate {
  unitKey: string;
  actualRequestCount: number | null;
  pageCount: number | null;
  cacheHitCount: number | null;
  cacheMissCount: number | null;
  bulkFirstConfirmed: boolean | null;
}

export interface SourceObservationIntegrationImportPreviewTarget {
  targetId: string;
  name: string;
  languageCode: string;
  scopeKey: string;
  planKey: string;
  estimatedPayloads: number | null;
  transportSteps: string[];
  usageEstimate: SourceObservationProviderUsageEstimate | null;
}

export interface SourceObservationIntegrationImportPreview {
  action: "import";
  providerKey: string;
  scope: SourceObservationIntegrationJobScope;
  profileSnapshot: SourceObservationIntegrationProfileSnapshot | null;
  targetCount: number;
  targets: SourceObservationIntegrationImportPreviewTarget[];
}

export interface SourceObservationIntegrationJobOutcome {
  providerKey: string;
  languageCode: string;
  expansionId: string | null;
  status: "imported" | "reapplied" | "skipped" | "failed";
  observed: number;
  reapplied: number;
  reason: string | null;
  providerUsageEvidence?: SourceObservationProviderUsageEvidence | null;
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
