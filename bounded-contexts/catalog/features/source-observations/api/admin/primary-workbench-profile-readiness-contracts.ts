import type { CatalogAdminControlPlaneFreshnessState } from "./admin-control-plane-read-model-slos";
import type { CatalogIntegrationUnitKey } from "../governance/integration-unit";
import type { CatalogProviderProfileEditableSectionKey } from "../providers/provider-profile-section-registry";
import type {
  CatalogPrimaryWorkbenchCommandKey,
  CatalogPrimaryWorkbenchActionState,
  CatalogPrimaryWorkbenchBlockerCategory,
  CatalogPrimaryWorkbenchReadModel,
} from "./primary-workbench-shared-contracts";
import type { CatalogPrimaryWorkbenchProviderTransportCategory } from "./primary-workbench-selection-contracts";
import {
  assertCatalogPrimaryWorkbenchActionState,
  isSafePrimaryWorkbenchReturnPath,
  assertPrimaryWorkbenchBlockers,
} from "./primary-workbench-shared-contracts";

export type CatalogPrimaryWorkbenchReadinessReadModel = Readonly<{
  freshness: CatalogAdminControlPlaneFreshnessState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  providerTransport: readonly CatalogPrimaryWorkbenchProviderTransportCategory[];
  rolloutEnabled: boolean;
  rbacAllowed: boolean;
  auditEvidenceUrl: string | null;
}>;

export type CatalogPrimaryWorkbenchValidationReadinessStatus = "ready" | "degraded" | "blocked" | "unavailable";

export type CatalogPrimaryWorkbenchValidationFixtureFlowStatus = "ready" | "warning" | "blocked" | "not-covered";

export type CatalogPrimaryWorkbenchValidationReadinessReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchValidationReadinessStatus;
  freshness: CatalogAdminControlPlaneFreshnessState;
  generatedAt: string;
  selectedProviderKey: string | null;
  selectedUnitKey: CatalogIntegrationUnitKey | null;
  selectedProfileVersion: string | null;
  selectedFixtureFlow: string | null;
  returnToPrimaryHref: string;
  summary: Readonly<{
    readyFixtureFlows: number;
    totalFixtureFlows: number;
    blockedFixtureFlows: number;
    dryRunEvidenceCount: number;
    semanticChangeCount: number;
    unchangedSectionCount: number;
    blockingReadinessChecks: number;
    auditEvidenceCount: number;
  }>;
  fixtureFlows: readonly Readonly<{
    flow: string;
    label: string;
    status: CatalogPrimaryWorkbenchValidationFixtureFlowStatus;
    payloadFile: string | null;
    payloadPath: string | null;
    expectedStatus: string | null;
    expectedDiagnosticPaths: readonly string[];
    expectedHashEvidencePaths: readonly string[];
    expectedMergeEvidencePaths: readonly string[];
    expectedPromotionCommands: readonly string[];
    samplePayloadAvailable: boolean;
    diagnostics: readonly Readonly<{
      path: string;
      diagnosticText: string;
      severity: "error" | "warning";
    }>[];
    actionState: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  }>[];
  dryRunEvidence: readonly Readonly<{
    externalKey: string;
    sourceUrl: string | null;
    sourceHash: string | null;
    status: "completed" | "blocked" | "not-run";
    normalizedFacts: readonly Readonly<{ key: string; value: string }>[];
    redactionSummary: readonly Readonly<{ label: string; value: string }>[];
    duplicateCandidates: readonly CatalogPrimaryWorkbenchValidationEvidenceRow[];
    selectedOptions: readonly CatalogPrimaryWorkbenchValidationEvidenceRow[];
    promotionCommandPreview: readonly Readonly<{
      commandName: string;
      inputs: readonly CatalogPrimaryWorkbenchValidationEvidenceRow[];
    }>[];
    diagnostics: readonly Readonly<{
      code: string;
      path: string;
      sectionKey: string;
      domainConcept: string;
      diagnosticText: string;
      severity: "error" | "warning";
      fixtureFlow: string | null;
    }>[];
    auditEvidence: readonly string[];
  }>[];
  semanticCompare: Readonly<{
    mappingFingerprint: Readonly<{
      candidate: string | null;
      active: string | null;
      changed: boolean;
    }>;
    activationImpact: readonly string[];
    fixtureCoverage: readonly Readonly<{
      flow: string;
      status: CatalogPrimaryWorkbenchValidationFixtureFlowStatus;
    }>[];
    sections: readonly Readonly<{
      sectionKey: string;
      domainConcept: string;
      status: "valid" | "warning" | "error";
      changeCount: number;
      changes: readonly Readonly<{
        path: string;
        label: string;
        candidateSummary: string;
        activeSummary: string;
        changed: boolean;
        severity: "info" | "warning" | "error";
        activationImpact: string;
      }>[];
    }>[];
    unchangedSections: readonly Readonly<{
      sectionKey: string;
      domainConcept: string;
    }>[];
  }>;
  activationReadiness: Readonly<{
    status: "ready" | "blocked";
    requiresMigrationEvidence: boolean;
    referenceCount: number;
    groups: readonly Readonly<{
      domainConcept: string;
      status: "ready" | "blocked";
      checks: readonly Readonly<{
        checkKey: string;
        code: string;
        sectionKey: string;
        status: "passed" | "blocked";
        path: string;
        diagnosticText: string;
        severity: "error" | "warning";
        remediation: string;
        blockingBehavior: string;
        flow: string | null;
      }>[];
    }>[];
  }>;
  activationDecision: Readonly<{
    status: "ready" | "blocked" | "unavailable";
    actionState: CatalogPrimaryWorkbenchActionState;
    blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    saveEvidenceState: CatalogPrimaryWorkbenchActionState;
    saveEvidenceBlockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
    activationCommandKey: Extract<CatalogPrimaryWorkbenchCommandKey, "provider-profile.activate">;
    evidenceCommandKey: Extract<CatalogPrimaryWorkbenchCommandKey, "provider-profile.edit-section">;
    workspaceHref: string;
    providerKey: string | null;
    profileVersion: string | null;
    lifecycle: string | null;
    importEligibility: "eligible" | "blocked" | "not-selected";
    affectedReferences: Readonly<{
      referenceCount: number;
      requiresMigrationEvidence: boolean;
      replayImplications: readonly string[];
    }>;
    migrationEvidence: Readonly<{
      state: "recorded" | "required" | "not-required";
      evidenceText: string;
      fixtureRunId: string | null;
      mappingFingerprintBefore: string | null;
      mappingFingerprintAfter: string | null;
      recordedAt: string | null;
      recordedByUserId: string | null;
    }>;
    auditConsequences: Readonly<{
      auditEvidenceUrl: string;
      eventNames: readonly string[];
      summary: string;
    }>;
  }>;
}>;

export type CatalogPrimaryWorkbenchValidationEvidenceRow = Readonly<{
  key: string;
  label: string;
  path: string;
  summary: string;
  owner: string | null;
  uses: readonly string[];
  diagnostics: readonly Readonly<{
    path: string;
    diagnosticText: string;
    severity: "error" | "warning";
  }>[];
}>;

export type CatalogPrimaryWorkbenchProfileAuthoringStatus = "ready" | "missing-profile" | "stale-selection";

export type CatalogPrimaryWorkbenchProfileLifecycleRestrictionCode =
  | "draft-editable"
  | "test-editable"
  | "active-clone-required"
  | "deprecated-clone-required"
  | "retired-read-only"
  | "missing-profile"
  | "stale-selection";

export type CatalogPrimaryWorkbenchProfileImmutableFactKey =
  | "provider-key"
  | "profile-key"
  | "source-contract-owner"
  | "source-contract-repository"
  | "connector-kind"
  | "supported-scopes";

export type CatalogPrimaryWorkbenchProfileImmutableFact = Readonly<{
  key: CatalogPrimaryWorkbenchProfileImmutableFactKey;
  label: string;
  value: string;
}>;

export type CatalogPrimaryWorkbenchProfileLifecycleRestriction = Readonly<{
  code: CatalogPrimaryWorkbenchProfileLifecycleRestrictionCode;
  label: string;
  description: string;
  severity: "info" | "warning" | "blocked";
}>;

export type CatalogPrimaryWorkbenchProfileOption = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  displayName: string;
  lifecycle: string;
  active: boolean;
  status: string;
  href: string;
}>;

export type CatalogPrimaryWorkbenchProfileOverview = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  displayName: string;
  lifecycle: string;
  active: boolean;
  status: string;
  connectorKind: string;
  capabilities: readonly string[];
  supportedScopes: readonly string[];
  languageOptions: readonly string[];
  mappingOutputKind: string;
  hasExecutableMappingContract: boolean;
  mappingFingerprint: string | null;
  referenceCount: number;
  sourceContract: Readonly<{
    owner: string;
    repository: string | null;
    commit: string | null;
    documentPath: string;
    fixtureSetVersion: string;
  }>;
  fixtures: Readonly<{
    fixtureRoot: string;
    coveredFlows: readonly string[];
    liveProviderCallsAllowed: boolean;
  }>;
  validation: Readonly<{
    status: "valid" | "invalid";
    diagnosticCount: number;
    latestDiagnosticText: string | null;
  }>;
  migrationEvidence: Readonly<{
    state: "recorded" | "not-recorded";
    recordedAt: string | null;
    fixtureRunId: string | null;
    mappingFingerprintBefore: string | null;
    mappingFingerprintAfter: string | null;
  }>;
  authoringAudit: Readonly<{
    createdAt: string | null;
    createdByUserId: string | null;
    createdForAccountId: string | null;
    updatedAt: string | null;
    updatedByUserId: string | null;
    updatedForAccountId: string | null;
  }>;
  immutableIdentityFacts: readonly CatalogPrimaryWorkbenchProfileImmutableFact[];
}>;

export type CatalogPrimaryWorkbenchProfileSectionGroupKey =
  | "profile-foundation"
  | "provider-acquisition"
  | "observation-mapping"
  | "catalog-promotion"
  | "evidence-lifecycle";

export type CatalogPrimaryWorkbenchProfileSectionSaveOutcome =
  | "not-submitted"
  | "saved"
  | "conflict"
  | "invalid"
  | "failed";

export type CatalogPrimaryWorkbenchProfileSectionFieldControl = "text" | "textarea" | "select" | "checkbox" | "tags";

export type CatalogPrimaryWorkbenchProfileSectionField = Readonly<{
  key: string;
  label: string;
  value: string;
  control: CatalogPrimaryWorkbenchProfileSectionFieldControl;
  required: boolean;
  disabled: boolean;
  helpText: string | null;
  options: readonly Readonly<{ value: string; label: string }>[];
}>;

export type CatalogPrimaryWorkbenchProfileOptionQueryDetail = Readonly<{
  queryKind: string;
  queryKeySynonyms: readonly string[];
  displayName: string;
  scope: string;
  parentScope: string | null;
  parentRequired: boolean;
  parentValueKind: string | null;
  parentDiagnosticText: string | null;
  operation: string;
  outputMappings: readonly Readonly<{
    key: string;
    label: string;
    path: string;
  }>[];
  cacheState: Readonly<{
    status: "ready" | "degraded" | "blocked" | "unknown";
    label: string;
    description: string;
    diagnosticCodes: readonly string[];
    freshTtlMinutes: number;
    staleTtlHours: number;
    cacheOnly: boolean;
  }>;
}>;

export type CatalogPrimaryWorkbenchProfileImportScopeControl = Readonly<{
  scope: string;
  label: string;
  state: "selected" | "available" | "unavailable";
  reason: string | null;
  href: string | null;
  importScope: string | null;
  expectedObservationCount: number;
  observedCount: number;
  changedCount: number;
  promotedCount: number;
  rejectedCount: number;
}>;

export type CatalogPrimaryWorkbenchProfileMappingRow = Readonly<{
  key: string;
  label: string;
  path: string;
  summary: string;
  owner: string | null;
  redaction: string | null;
  uses: readonly string[];
  diagnostics: readonly Readonly<{
    path: string;
    diagnosticText: string;
    severity: "error" | "warning";
  }>[];
  previewAvailable: boolean;
  affordances: Readonly<{
    duplicate: boolean;
    reorder: boolean;
    remove: boolean;
    inlineDiagnostics: boolean;
    longPathSafe: boolean;
  }>;
}>;

export type CatalogPrimaryWorkbenchProfileSectionWorkspace = Readonly<{
  sectionKey: CatalogProviderProfileEditableSectionKey;
  displayName: string;
  group: CatalogPrimaryWorkbenchProfileSectionGroupKey;
  groupLabel: string;
  description: string;
  domainConcept: string;
  status: "valid" | "warning" | "error" | "blocked";
  editable: boolean;
  actionState: CatalogPrimaryWorkbenchActionState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  dirtyState: "clean";
  staleState: "fresh" | "stale" | "conflict";
  saveOutcome: CatalogPrimaryWorkbenchProfileSectionSaveOutcome;
  submitHref: string;
  commandKey: Extract<CatalogPrimaryWorkbenchCommandKey, "provider-profile.edit-section">;
  fields: readonly CatalogPrimaryWorkbenchProfileSectionField[];
  optionQueries: readonly CatalogPrimaryWorkbenchProfileOptionQueryDetail[];
  importScopeControls: readonly CatalogPrimaryWorkbenchProfileImportScopeControl[];
  mappingRows: readonly CatalogPrimaryWorkbenchProfileMappingRow[];
  diagnostics: readonly Readonly<{
    path: string;
    diagnosticText: string;
    severity: "error" | "warning";
  }>[];
  semanticChangeCount: number;
  readinessCheckCount: number;
  anchorId: string;
}>;

export type CatalogPrimaryWorkbenchProfileCloneDraftReadModel = Readonly<{
  commandKey: Extract<CatalogPrimaryWorkbenchCommandKey, "provider-profile.clone">;
  sourceProviderKey: string | null;
  sourceProfileVersion: string | null;
  targetProfileVersion: string | null;
  targetLifecycle: "draft";
  state: CatalogPrimaryWorkbenchActionState;
  blockers: readonly CatalogPrimaryWorkbenchBlockerCategory[];
  submitHref: string;
  lifecycleRestrictions: readonly CatalogPrimaryWorkbenchProfileLifecycleRestriction[];
  immutableIdentityFacts: readonly CatalogPrimaryWorkbenchProfileImmutableFact[];
}>;

export type CatalogPrimaryWorkbenchProfileAuthoringReadModel = Readonly<{
  status: CatalogPrimaryWorkbenchProfileAuthoringStatus;
  generatedAt: string;
  selectedProfile: CatalogPrimaryWorkbenchProfileOverview | null;
  activeProfile: CatalogPrimaryWorkbenchProfileOption | null;
  availableProfiles: readonly CatalogPrimaryWorkbenchProfileOption[];
  returnToPrimaryHref: string;
  sectionGroups: readonly Readonly<{
    key: CatalogPrimaryWorkbenchProfileSectionGroupKey;
    label: string;
    sections: readonly CatalogProviderProfileEditableSectionKey[];
  }>[];
  sectionWorkspaces: readonly CatalogPrimaryWorkbenchProfileSectionWorkspace[];
  cloneDraft: CatalogPrimaryWorkbenchProfileCloneDraftReadModel;
}>;

export function assertPrimaryWorkbenchProfileAuthoring(
  value: CatalogPrimaryWorkbenchReadModel["profileAuthoring"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench profile authoring contract is required.");
  }
  if (!["ready", "missing-profile", "stale-selection"].includes(value.status)) {
    throw new Error("Primary workbench profile authoring status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench profile authoring return link must target the rebuilt workbench.");
  }
  if (value.cloneDraft.commandKey !== "provider-profile.clone") {
    throw new Error("Primary workbench profile draft command must use the rebuilt provider-profile.clone boundary.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.cloneDraft.submitHref)) {
    throw new Error("Primary workbench profile draft submit link must target the rebuilt workbench.");
  }
  assertCatalogPrimaryWorkbenchActionState(value.cloneDraft.state);
  assertPrimaryWorkbenchBlockers(value.cloneDraft.blockers);
  if (value.status === "ready" && !value.selectedProfile) {
    throw new Error("Primary workbench profile authoring ready state requires a selected profile.");
  }
  if (value.status !== "ready" && value.cloneDraft.blockers.length === 0) {
    throw new Error("Primary workbench profile draft command must fail closed when profile selection is missing.");
  }
  if (value.selectedProfile) {
    if (
      !value.selectedProfile.providerKey ||
      !value.selectedProfile.profileKey ||
      !value.selectedProfile.profileVersion
    ) {
      throw new Error("Primary workbench selected profile must preserve provider, profile, and version identity.");
    }
    if (value.selectedProfile.immutableIdentityFacts.length === 0) {
      throw new Error("Primary workbench selected profile must expose immutable identity facts.");
    }
    if (
      value.cloneDraft.sourceProviderKey !== value.selectedProfile.providerKey ||
      value.cloneDraft.sourceProfileVersion !== value.selectedProfile.profileVersion
    ) {
      throw new Error("Primary workbench profile draft command must preserve source provider and version context.");
    }
  }
  if (value.selectedProfile && value.sectionWorkspaces.length === 0) {
    throw new Error("Primary workbench profile authoring must expose guided section workspaces.");
  }
  const groupedSections = new Set(value.sectionGroups.flatMap((group) => group.sections));
  for (const workspace of value.sectionWorkspaces) {
    if (!groupedSections.has(workspace.sectionKey)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} must belong to a navigation group.`);
    }
    if (workspace.commandKey !== "provider-profile.edit-section") {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} must use section-scoped saves.`);
    }
    if (!isSafePrimaryWorkbenchReturnPath(workspace.submitHref)) {
      throw new Error(
        `Primary workbench profile section ${workspace.sectionKey} submit link must stay in the rebuilt workbench.`,
      );
    }
    if (workspace.fields.length === 0) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} must expose guided controls.`);
    }
    if (workspace.fields.some((field) => /json/i.test(`${field.key} ${field.label} ${field.helpText ?? ""}`))) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} must not expose raw JSON controls.`);
    }
    if (!Array.isArray(workspace.optionQueries)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} option-query details are required.`);
    }
    if (!Array.isArray(workspace.importScopeControls)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} import-scope controls are required.`);
    }
    if (!Array.isArray(workspace.mappingRows)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} mapping rows are required.`);
    }
    for (const optionQuery of workspace.optionQueries) {
      if (!optionQuery.queryKind || !optionQuery.displayName || !optionQuery.scope || !optionQuery.operation) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} option queries must expose canonical query metadata.`,
        );
      }
      if (optionQuery.outputMappings.length === 0) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} option queries must expose output mappings.`,
        );
      }
      if (!optionQuery.cacheState.label || !optionQuery.cacheState.description) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} option-query cache state must be explainable.`,
        );
      }
    }
    for (const importScope of workspace.importScopeControls) {
      if (!importScope.scope || !importScope.label) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} import-scope controls must name the scope.`,
        );
      }
      if (importScope.state === "unavailable" && !importScope.reason) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} unavailable import scopes need a reason.`,
        );
      }
    }
    for (const mappingRow of workspace.mappingRows) {
      if (!mappingRow.key || !mappingRow.label || !mappingRow.path || !mappingRow.summary) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} mapping rows must expose row metadata.`,
        );
      }
      if (!mappingRow.affordances.inlineDiagnostics || !mappingRow.affordances.longPathSafe) {
        throw new Error(
          `Primary workbench profile section ${workspace.sectionKey} mapping rows must support diagnostics and long paths.`,
        );
      }
    }
    assertCatalogPrimaryWorkbenchActionState(workspace.actionState);
    assertPrimaryWorkbenchBlockers(workspace.blockers);
    if (!["fresh", "stale", "conflict"].includes(workspace.staleState)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} stale state must be explicit.`);
    }
    if (!["not-submitted", "saved", "conflict", "invalid", "failed"].includes(workspace.saveOutcome)) {
      throw new Error(`Primary workbench profile section ${workspace.sectionKey} save outcome must be explicit.`);
    }
  }
}

export function assertPrimaryWorkbenchValidationReadiness(
  value: CatalogPrimaryWorkbenchReadModel["validationReadiness"] | undefined,
): void {
  if (!value) {
    throw new Error("Primary workbench validation readiness contract is required.");
  }
  if (!["ready", "degraded", "blocked", "unavailable"].includes(value.status)) {
    throw new Error("Primary workbench validation readiness status must be explicit.");
  }
  if (!isSafePrimaryWorkbenchReturnPath(value.returnToPrimaryHref)) {
    throw new Error("Primary workbench validation readiness return link must target the rebuilt workbench.");
  }
  if (value.selectedProfileVersion && value.fixtureFlows.length === 0) {
    throw new Error("Primary workbench validation readiness must expose fixture flows for the selected profile.");
  }
  for (const flow of value.fixtureFlows) {
    if (!flow.flow || !["ready", "warning", "blocked", "not-covered"].includes(flow.status)) {
      throw new Error("Primary workbench validation fixture flows must be named and explicitly statused.");
    }
    assertPrimaryWorkbenchBlockers(flow.blockers);
    assertCatalogPrimaryWorkbenchActionState(flow.actionState);
  }
  for (const evidence of value.dryRunEvidence) {
    if (!["completed", "blocked", "not-run"].includes(evidence.status)) {
      throw new Error("Primary workbench validation dry-run evidence status must be explicit.");
    }
    if (evidence.redactionSummary.length === 0) {
      throw new Error("Primary workbench validation dry-run evidence must summarize redaction.");
    }
  }
  if (!["ready", "blocked"].includes(value.activationReadiness.status)) {
    throw new Error("Primary workbench activation readiness status must be explicit.");
  }
  if (!value.activationDecision || value.activationDecision.activationCommandKey !== "provider-profile.activate") {
    throw new Error("Primary workbench activation decision must expose the rebuilt activation command.");
  }
  if (value.activationDecision.evidenceCommandKey !== "provider-profile.edit-section") {
    throw new Error("Primary workbench activation decision must save evidence through typed profile sections.");
  }
  if (!["ready", "blocked", "unavailable"].includes(value.activationDecision.status)) {
    throw new Error("Primary workbench activation decision status must be explicit.");
  }
  assertCatalogPrimaryWorkbenchActionState(value.activationDecision.actionState);
  assertCatalogPrimaryWorkbenchActionState(value.activationDecision.saveEvidenceState);
  assertPrimaryWorkbenchBlockers(value.activationDecision.blockers);
  assertPrimaryWorkbenchBlockers(value.activationDecision.saveEvidenceBlockers);
  if (value.activationDecision.status === "ready" && value.activationDecision.actionState !== "available") {
    throw new Error("Primary workbench activation decision must make ready activation actionable.");
  }
  const validationText = JSON.stringify(value);
  if (/raw\s+json/i.test(validationText)) {
    throw new Error("Primary workbench validation readiness must not expose raw JSON workflow copy.");
  }
}
