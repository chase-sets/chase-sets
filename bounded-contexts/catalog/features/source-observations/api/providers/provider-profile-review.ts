import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { toJsonValue, type JsonObject, type JsonValue } from "@chase-sets/primitives/json";
import type {
  CatalogProviderOptionQuery,
  CatalogProviderIntegrationProfileAuthoringAudit,
  CatalogProviderIntegrationProfileMigrationEvidence,
  CatalogProviderIntegrationProfileVersionDiagnostic,
  CatalogProviderIntegrationProfileVersionRecord,
  CatalogProviderProfileVersionSelector,
} from "../provider-integration-profiles";
import {
  catalogProviderProfileVersionIngestionUnitKey,
  catalogProviderProfileVersionsCompete,
  validateCatalogProviderIntegrationProfileVersion,
} from "../provider-integration-profiles";
import type { CatalogProviderIntegrationProfileVersionStore } from "./provider-integration-profile-store";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderMappingValueExpression,
} from "./provider-integration-mapping-contract";
import { evaluateCatalogProviderMappingExpression } from "./provider-mapping-interpreter";
import type { CatalogProviderMappingInterpreterDiagnostic } from "./provider-mapping-interpreter";
import {
  catalogProviderSourceMappingFingerprint,
  normalizeCatalogProviderSourceObservation,
  type CatalogProviderSourceObservationMappingContract,
} from "../promotion/provider-source-observation-normalizer";
import {
  formatCatalogProviderProfileFixtureFailures,
  type CatalogProviderProfileFixtureHarnessFailure,
  validateCatalogProviderProfileFixtures,
  type CatalogProviderProfileFixtureCase,
} from "./provider-profile-contract-harness";
import { catalogProviderProfileFixtureCases } from "./provider-profile-fixture-cases";
import { catalogProviderRequiredFixtureFlows } from "./provider-integration-mapping-contract";
import {
  catalogProviderProfileEditableSectionMetadata,
  toCatalogProviderProfileSectionPatch,
  type CatalogProviderProfileEditableSectionMetadata,
  type CatalogProviderProfileSectionUpdateCommand,
  type CatalogProviderProfileVersionUpdatePatch,
} from "./provider-profile-section-registry";
import {
  assembleCatalogProviderIngestionUnitProfileSections,
  type CatalogProviderProfileSectionDiagnostic,
  type CatalogProviderProfileSectionKey,
} from "./provider-profile-sections";
import type {
  CatalogIntegrationDiagnosticBlockingBehavior,
  CatalogIntegrationDiagnosticCode,
} from "../governance/catalog-integration-diagnostic-taxonomy";
import { getCatalogIntegrationDiagnosticDefinition } from "../governance/catalog-integration-diagnostic-taxonomy";

type SourceObservationProfileVersionRecord = CatalogProviderIntegrationProfileVersionRecord &
  Readonly<{ executableMappingContract: CatalogProviderSourceObservationMappingContract }>;

type CatalogProviderProfileVersionSelectionInput = Readonly<{
  profileKey?: string | null;
  ingestionUnitKey?: string | null;
}>;

export type CatalogProviderProfileReviewDiagnostic = Readonly<{
  code: string;
  path: string;
  diagnosticText: string;
  severity: "error" | "warning";
}>;

export type CatalogProviderProfileSectionStatus = "valid" | "warning" | "error" | "blocked";

export type CatalogProviderProfileActivationDiagnostic = CatalogProviderProfileReviewDiagnostic &
  Readonly<{
    flow?: string;
  }>;

export class CatalogProviderProfileVersionNotFoundError extends Error {
  readonly code = "profile_version_not_found";
  readonly providerKey: string;
  readonly profileVersion: string;

  constructor(providerKey: string, profileVersion: string) {
    super(`Catalog provider profile version ${providerKey}@${profileVersion} was not found.`);
    this.name = "CatalogProviderProfileVersionNotFoundError";
    this.providerKey = providerKey;
    this.profileVersion = profileVersion;
  }
}

export class CatalogProviderProfileActivationValidationError extends Error {
  readonly diagnostics: readonly CatalogProviderProfileActivationDiagnostic[];

  constructor(message: string, diagnostics: readonly CatalogProviderProfileActivationDiagnostic[]) {
    super(message);
    this.name = "CatalogProviderProfileActivationValidationError";
    this.diagnostics = diagnostics;
  }
}

export type CatalogProviderProfileLifecycleBlockingJob = Readonly<{
  jobId: string;
  jobKind: "integration" | "bulk-review";
  action: "import" | "reapply" | "promote" | "reject" | "defer";
  status: "queued" | "running" | string;
  providerKey: string | null;
  profileVersion: string | null;
}>;

export class CatalogProviderProfileLifecycleConsistencyError extends Error {
  readonly code = "profile_lifecycle_job_conflict";
  readonly blockingJobs: readonly CatalogProviderProfileLifecycleBlockingJob[];

  constructor(
    providerKey: string,
    profileVersion: string,
    blockingJobs: readonly CatalogProviderProfileLifecycleBlockingJob[],
  ) {
    super(
      `Catalog provider profile version ${providerKey}@${profileVersion} cannot change while ${blockingJobs.length} matching integration or review job${blockingJobs.length === 1 ? " is" : "s are"} active.`,
    );
    this.name = "CatalogProviderProfileLifecycleConsistencyError";
    this.blockingJobs = blockingJobs;
  }
}

export type CatalogProviderProfileVersionReview = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  ingestionUnitKey: string;
  displayName: string;
  lifecycle: string;
  active: boolean;
  status: string;
  connectorKind: string;
  profile: CatalogProviderIntegrationProfileVersionRecord["profile"];
  sourceContract: CatalogProviderIntegrationProfileVersionRecord["sourceContract"];
  fixtures: CatalogProviderIntegrationProfileVersionRecord["fixtures"];
  retirementPlan: CatalogProviderIntegrationProfileVersionRecord["retirementPlan"];
  executableMappingContract: CatalogProviderIntegrationProfileVersionRecord["executableMappingContract"];
  referenceCount: number;
  capabilities: readonly string[];
  supportedScopes: readonly string[];
  languageOptions: readonly string[];
  sourceOptionKinds: readonly CatalogProviderSourceOptionKind[];
  mappingOutputKind: string;
  hasExecutableMappingContract: boolean;
  migrationEvidence: CatalogProviderIntegrationProfileMigrationEvidence | null;
  authoringAudit: CatalogProviderIntegrationProfileAuthoringAudit | null;
  validation: Readonly<{
    status: "valid" | "invalid";
    diagnostics: readonly CatalogProviderProfileReviewDiagnostic[];
  }>;
}>;

export type CatalogProviderSourceOptionKind = Readonly<{
  queryKind: string;
  queryKeySynonyms: readonly string[];
  displayName: string;
  scope: string;
  parentScope: string | null;
  parentRequired: boolean;
  parentValueKind: string | null;
  parentDiagnosticText: string | null;
}>;

export type CatalogProviderProfileDryRunEvidence = Readonly<{
  path: string;
  owner: string;
  uses: readonly string[];
  redaction: string;
  value: JsonValue;
  diagnostics: readonly CatalogProviderMappingInterpreterDiagnostic[];
}>;

export type CatalogProviderProfileDryRunDiagnosticLink = Readonly<{
  code: string;
  path: string;
  sectionKey: CatalogProviderProfileSectionKey;
  domainConcept: string;
  fixtureFlow: CatalogProviderProfileFixtureCase["flow"] | null;
}>;

export type CatalogProviderProfileDryRunResult = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  status: "completed" | "blocked";
  redactedPayload: JsonValue;
  observation: ReturnType<typeof normalizeCatalogProviderSourceObservation>["observation"];
  diagnostics: readonly CatalogProviderMappingInterpreterDiagnostic[];
  diagnosticLinks: readonly CatalogProviderProfileDryRunDiagnosticLink[];
  hashMaterial: readonly CatalogProviderProfileDryRunEvidence[];
  externalReferences: Readonly<{
    catalogItemReferences: JsonValue;
    productReferences: JsonValue;
  }>;
  selectedOptions: JsonValue;
  mergeCandidateEvidence: readonly CatalogProviderProfileDryRunEvidence[];
  duplicatePreventionPolicy: Readonly<{
    ambiguousCandidatePolicy: string;
    replayPolicy: string;
    exactExternalCatalogItemReferencesFirst: boolean;
  }>;
  duplicatePreventionRules: readonly Readonly<{
    ruleKey: string;
    ruleKind: string;
    candidatePolicy: string;
    evidence: readonly CatalogProviderProfileDryRunEvidence[];
  }>[];
  duplicatePreventionCandidatePreview: CatalogProviderProfileDuplicatePreventionCandidatePreview | null;
  promotionCommandPlan: Readonly<{
    requiresReview: true;
    commands: readonly Readonly<{
      commandName: string;
      inputs: readonly CatalogProviderProfileDryRunEvidence[];
    }>[];
  }>;
}>;

export type CatalogProviderProfileDuplicatePreventionCandidatePreview = Readonly<{
  status: "matched" | "none" | "blocked" | "review-only" | "not-evaluated";
  ruleKey: string | null;
  candidateCount: number;
  candidateCatalogItemIds: readonly string[];
  diagnosticText: string | null;
  evidenceSummary: JsonValue;
  evidenceSummaries: JsonValue;
}>;

export type CatalogProviderProfileEditableSection = CatalogProviderProfileEditableSectionMetadata;

export type CatalogProviderProfileFixtureMetadata = Readonly<{
  flow: CatalogProviderProfileFixtureCase["flow"];
  payloadFile: string;
  payloadPath: string;
  expectedStatus: CatalogProviderProfileFixtureCase["expectedStatus"];
  expectedDiagnosticPaths: readonly string[];
  expectedHashEvidencePaths: readonly string[];
  expectedMergeEvidencePaths: readonly string[];
  expectedPromotionCommands: readonly string[];
  expectedObservation: CatalogProviderProfileFixtureCase["expectedObservation"] | null;
  samplePayload: JsonValue | null;
  samplePayloadAvailable: boolean;
}>;

export type CatalogProviderProfileDryRunInputTemplate = Readonly<{
  observedAt: string;
  defaultFlow: CatalogProviderProfileFixtureCase["flow"] | null;
  payload: JsonValue;
  fixturePayloads: readonly CatalogProviderProfileFixtureMetadata[];
}>;

export type CatalogProviderProfileSemanticDiffChange = Readonly<{
  sectionKey: CatalogProviderProfileSectionKey;
  domainConcept: string;
  path: string;
  label: string;
  candidate: JsonValue;
  active: JsonValue;
  changed: boolean;
  severity: "info" | "warning" | "error";
  activationImpact: string;
}>;

export type CatalogProviderProfileSemanticDiff = Readonly<{
  providerKey: string;
  candidateProfileVersion: string;
  activeProfileVersion: string | null;
  mappingFingerprint: Readonly<{
    candidate: string | null;
    active: string | null;
    changed: boolean;
  }>;
  changes: readonly CatalogProviderProfileSemanticDiffChange[];
  sections: readonly Readonly<{
    sectionKey: CatalogProviderProfileSectionKey;
    domainConcept: string;
    status: Exclude<CatalogProviderProfileSectionStatus, "blocked">;
    changes: readonly CatalogProviderProfileSemanticDiffChange[];
  }>[];
}>;

export type CatalogProviderProfileActivationReadinessCheck = Readonly<{
  checkKey: string;
  code: CatalogIntegrationDiagnosticCode;
  sectionKey: CatalogProviderProfileSectionKey;
  domainConcept: string;
  status: "passed" | "blocked";
  path: string;
  diagnosticText: string;
  severity: "error" | "warning";
  remediation: string;
  blockingBehavior: CatalogIntegrationDiagnosticBlockingBehavior;
  flow?: string;
}>;

export type CatalogProviderProfileActivationReadiness = Readonly<{
  status: "ready" | "blocked";
  checks: readonly CatalogProviderProfileActivationReadinessCheck[];
  groups: readonly Readonly<{
    domainConcept: string;
    status: "ready" | "blocked";
    checks: readonly CatalogProviderProfileActivationReadinessCheck[];
  }>[];
  requiresMigrationEvidence: boolean;
  referenceCount: number;
}>;

export type CatalogProviderProfileSectionSummary = Readonly<{
  sectionKey: CatalogProviderProfileSectionKey;
  domainConcept: string;
  editable: boolean;
  status: CatalogProviderProfileSectionStatus;
  diagnostics: readonly CatalogProviderProfileSectionDiagnostic[];
  semanticChanges: readonly CatalogProviderProfileSemanticDiffChange[];
  readinessChecks: readonly CatalogProviderProfileActivationReadinessCheck[];
}>;

export type CatalogProviderSelectedOptionAuthoringSchema = Readonly<{
  dimensions: readonly Readonly<{
    dimensionId: string;
    dimensionKey: string;
    dimensionName: string;
    status: string;
    options: readonly Readonly<{
      optionId: string;
      optionKey: string;
      optionLabel: string;
      status: string;
    }>[];
  }>[];
}>;

export type CatalogProviderPromotionTargetAuthoringSchema = Readonly<{
  blueprints: readonly CatalogProviderPromotionTargetAuthoringRecord[];
  categories: readonly CatalogProviderPromotionTargetAuthoringRecord[];
  fields: readonly CatalogProviderPromotionTargetAuthoringRecord[];
}>;

export type CatalogProviderPromotionTargetAuthoringRecord = Readonly<{
  id: string;
  key: string;
  name: string;
  status: string;
}>;

export type CatalogProviderProfileAuthoringModel = Readonly<{
  review: CatalogProviderProfileVersionReview;
  editableSections: readonly CatalogProviderProfileEditableSection[];
  sectionSummaries: readonly CatalogProviderProfileSectionSummary[];
  fixtureCases: readonly CatalogProviderProfileFixtureMetadata[];
  dryRunInputTemplate: CatalogProviderProfileDryRunInputTemplate;
  semanticDiff: CatalogProviderProfileSemanticDiff;
  activationReadiness: CatalogProviderProfileActivationReadiness;
  selectedOptionSchema: CatalogProviderSelectedOptionAuthoringSchema | null;
  promotionTargetSchema: CatalogProviderPromotionTargetAuthoringSchema | null;
}>;

export async function listCatalogProviderProfileVersionReviews(
  store: CatalogProviderIntegrationProfileVersionStore,
): Promise<readonly CatalogProviderProfileVersionReview[]> {
  const versions = await store.listProfileVersions();
  return Promise.all(
    versions.map(async (version) =>
      toProfileVersionReview(
        version,
        await store.countProfileVersionReferences(version.providerKey, version.profileVersion),
      ),
    ),
  );
}

export async function getCatalogProviderProfileAuthoringModel(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
  profileKey?: string | null;
  ingestionUnitKey?: string | null;
  repositoryRoot?: string;
  observedAt?: string;
  fixtureCases?: readonly CatalogProviderProfileFixtureCase[];
  selectedOptionSchema?: CatalogProviderSelectedOptionAuthoringSchema | null;
  promotionTargetSchema?: CatalogProviderPromotionTargetAuthoringSchema | null;
}): Promise<CatalogProviderProfileAuthoringModel> {
  const selector = profileVersionSelectorFromInput(input);
  const version = await requireProfileVersion(input.store, input.providerKey, input.profileVersion, selector);
  const referenceCount = await input.store.countProfileVersionReferences(version.providerKey, version.profileVersion);
  const versions = await input.store.listProfileVersions(version.providerKey);
  const activeVersion =
    versions.find(
      (candidate) =>
        candidate.active &&
        candidate.lifecycle === "active" &&
        catalogProviderProfileVersionsCompete(candidate, version),
    ) ??
    (await input.store.getActiveProfileVersion(version.providerKey, {
      profileKey: version.profileKey,
      ingestionUnitKey: catalogProviderProfileVersionIngestionUnitKey(version),
    }));
  const fixtureCases = authoringFixtureCasesForVersion(
    version,
    input.fixtureCases ?? catalogProviderProfileFixtureCases(),
  );
  const fixtureMetadata = await Promise.all(
    fixtureCases.map((fixtureCase) =>
      toFixtureMetadata({
        version,
        fixtureCase,
        repositoryRoot: input.repositoryRoot ?? defaultRepositoryRoot(),
      }),
    ),
  );
  const semanticDiff = toSemanticDiff(version, activeVersion ?? null);
  const activationReadiness = toActivationReadiness({
    version,
    activeVersion: activeVersion ?? null,
    referenceCount,
    fixtureCases,
  });

  return {
    review: toProfileVersionReview(version, referenceCount),
    editableSections: catalogProviderProfileEditableSections(),
    sectionSummaries: toSectionSummaries({
      version,
      semanticDiff,
      activationReadiness,
    }),
    fixtureCases: fixtureMetadata,
    dryRunInputTemplate: toDryRunInputTemplate(fixtureMetadata, input.observedAt ?? new Date(0).toISOString()),
    semanticDiff,
    activationReadiness,
    selectedOptionSchema: input.selectedOptionSchema ?? null,
    promotionTargetSchema: input.promotionTargetSchema ?? null,
  };
}

export async function dryRunCatalogProviderProfileVersion(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
  profileKey?: string | null;
  ingestionUnitKey?: string | null;
  payload: JsonValue;
  observedAt?: string;
  fixtureFlow?: CatalogProviderProfileFixtureCase["flow"] | null;
}): Promise<CatalogProviderProfileDryRunResult> {
  const version = await input.store.getProfileVersion(
    input.providerKey,
    input.profileVersion,
    profileVersionSelectorFromInput(input),
  );
  if (!version) {
    throw new Error(`Catalog provider profile version ${input.providerKey}@${input.profileVersion} was not found.`);
  }

  const contract = version.executableMappingContract;
  if (!isSourceObservationContract(contract)) {
    return blockedDryRun(
      version,
      input.payload,
      [
        {
          code: "missing-required-path",
          path: "executableMappingContract",
          redaction: "none",
          diagnosticText: "Profile version does not have an executable Source Observation mapping contract.",
        },
      ],
      input.fixtureFlow ?? null,
    );
  }

  const normalization = normalizeCatalogProviderSourceObservation({
    contract,
    payload: input.payload,
    observedAt: input.observedAt ?? new Date(0).toISOString(),
  });
  const hashMaterial = evaluateEvidenceList(
    contract.normalizedObservation.hashMaterial,
    input.payload,
    "normalizedObservation.hashMaterial",
  );
  const mergeCandidateEvidence = evaluateEvidenceList(
    contract.duplicatePrevention.mergeCandidateEvidence,
    input.payload,
    "duplicatePrevention.mergeCandidateEvidence",
  );

  return {
    providerKey: version.providerKey,
    profileKey: version.profileKey,
    profileVersion: version.profileVersion,
    status: normalization.observation ? "completed" : "blocked",
    redactedPayload: redactJson(input.payload),
    observation: normalization.observation
      ? {
          ...normalization.observation,
          sourcePayload: redactJson(normalization.observation.sourcePayload),
        }
      : null,
    diagnostics: normalization.diagnostics,
    diagnosticLinks: toDryRunDiagnosticLinks(normalization.diagnostics, input.fixtureFlow ?? null),
    hashMaterial,
    externalReferences: {
      catalogItemReferences: redactJson(normalization.observation?.normalized.externalCatalogItemReferences ?? []),
      productReferences: redactJson(normalization.observation?.normalized.externalProductReferences ?? []),
    },
    selectedOptions: redactJson(
      normalization.observation?.normalized.externalProductReferences?.flatMap(
        (reference) => reference.selectedOptions ?? [],
      ) ?? [],
    ),
    mergeCandidateEvidence,
    duplicatePreventionPolicy: {
      ambiguousCandidatePolicy: contract.duplicatePrevention.ambiguousCandidatePolicy,
      replayPolicy: contract.duplicatePrevention.replayPolicy,
      exactExternalCatalogItemReferencesFirst: contract.duplicatePrevention.exactExternalCatalogItemReferencesFirst,
    },
    duplicatePreventionRules: contract.duplicatePrevention.identityRules.map((rule, index) => ({
      ruleKey: rule.ruleKey,
      ruleKind: rule.ruleKind,
      candidatePolicy: rule.candidatePolicy,
      evidence: evaluateEvidenceList(
        rule.evidence,
        input.payload,
        `duplicatePrevention.identityRules.${index}.evidence`,
      ),
    })),
    duplicatePreventionCandidatePreview: null,
    promotionCommandPlan: {
      requiresReview: contract.promotionCommandPlan.requiresReview,
      commands: contract.promotionCommandPlan.commands.map((command, commandIndex) => ({
        commandName: command.commandName,
        inputs: Object.entries(command.inputs).map(([inputKey, expression]) =>
          evaluateEvidence(
            `${command.commandName}.${inputKey}`,
            expression,
            input.payload,
            `promotionCommandPlan.commands.${commandIndex}.inputs.${inputKey}`,
          ),
        ),
      })),
    },
  };
}

export async function activateCatalogProviderProfileVersionForReview(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
  profileKey?: string | null;
  ingestionUnitKey?: string | null;
  activeJobs?: readonly CatalogProviderProfileLifecycleBlockingJob[];
  fixtureCases?: readonly CatalogProviderProfileFixtureCase[];
  repositoryRoot?: string;
  observedAt?: string;
}): Promise<CatalogProviderProfileVersionReview> {
  assertNoActiveProfileLifecycleBlockingJobs(input);
  await assertImportEligibilityForActivation(input);
  await assertFixtureHarnessForActivation(input);
  await assertMigrationEvidenceForActivation(input);
  const activated = await input.store.activateProfileVersion(
    input.providerKey,
    input.profileVersion,
    profileVersionSelectorFromInput(input),
  );
  return toProfileVersionReview(activated);
}

export async function deprecateCatalogProviderProfileVersionForReview(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
  profileKey?: string | null;
  ingestionUnitKey?: string | null;
  activeJobs?: readonly CatalogProviderProfileLifecycleBlockingJob[];
}): Promise<CatalogProviderProfileVersionReview> {
  assertNoActiveProfileLifecycleBlockingJobs(input);
  const deprecated = await input.store.deprecateProfileVersion(
    input.providerKey,
    input.profileVersion,
    profileVersionSelectorFromInput(input),
  );
  return toProfileVersionReview(deprecated);
}

export async function createCatalogProviderProfileVersionForReview(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  version: CatalogProviderIntegrationProfileVersionRecord;
  audit?: CatalogProviderIntegrationProfileAuthoringAudit | null;
}): Promise<CatalogProviderProfileVersionReview> {
  assertMutableLifecycle(input.version.lifecycle);
  const saved = await input.store.upsertProfileVersion({
    ...assertProfileVersionIdentity(input.version),
    active: false,
    authoringAudit: mergeAuthoringAudit(null, input.audit),
  });
  return toProfileVersionReview(saved);
}

export async function cloneCatalogProviderProfileVersionForReview(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
  profileKey?: string | null;
  ingestionUnitKey?: string | null;
  targetProfileVersion: string;
  lifecycle?: "draft" | "test";
  audit?: CatalogProviderIntegrationProfileAuthoringAudit | null;
}): Promise<CatalogProviderProfileVersionReview> {
  const source = await requireProfileVersion(
    input.store,
    input.providerKey,
    input.profileVersion,
    profileVersionSelectorFromInput(input),
  );
  const cloned = assertProfileVersionIdentity({
    ...source,
    profileVersion: input.targetProfileVersion,
    lifecycle: input.lifecycle ?? "draft",
    active: false,
    executableMappingContract: source.executableMappingContract
      ? {
          ...source.executableMappingContract,
          profileVersion: input.targetProfileVersion,
          lifecycle: input.lifecycle ?? "draft",
        }
      : undefined,
    migrationEvidence: null,
    authoringAudit: mergeAuthoringAudit(null, input.audit),
  });
  assertMutableLifecycle(cloned.lifecycle);
  const saved = await input.store.upsertProfileVersion(cloned);
  return toProfileVersionReview(saved);
}

export async function updateCatalogProviderProfileVersionForReview(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
  profileKey?: string | null;
  ingestionUnitKey?: string | null;
  patch: CatalogProviderProfileVersionUpdatePatch;
  audit?: CatalogProviderIntegrationProfileAuthoringAudit | null;
  activeJobs?: readonly CatalogProviderProfileLifecycleBlockingJob[];
}): Promise<CatalogProviderProfileVersionReview> {
  assertNoActiveProfileLifecycleBlockingJobs(input);
  const existing = await requireProfileVersion(
    input.store,
    input.providerKey,
    input.profileVersion,
    profileVersionSelectorFromInput(input),
  );
  assertMutableLifecycle(existing.lifecycle);
  const nextLifecycle = input.patch.lifecycle ?? existing.lifecycle;
  assertMutableLifecycle(nextLifecycle);
  const updated = assertProfileVersionIdentity({
    ...existing,
    lifecycle: nextLifecycle,
    active: false,
    profile: input.patch.profile ?? existing.profile,
    sourceContract: input.patch.sourceContract ?? existing.sourceContract,
    fixtures: input.patch.fixtures ?? existing.fixtures,
    retirementPlan: Object.prototype.hasOwnProperty.call(input.patch, "retirementPlan")
      ? (input.patch.retirementPlan ?? null)
      : existing.retirementPlan,
    executableMappingContract: Object.prototype.hasOwnProperty.call(input.patch, "executableMappingContract")
      ? (input.patch.executableMappingContract ?? undefined)
      : existing.executableMappingContract
        ? {
            ...existing.executableMappingContract,
            lifecycle: nextLifecycle,
          }
        : undefined,
    migrationEvidence: Object.prototype.hasOwnProperty.call(input.patch, "migrationEvidence")
      ? (input.patch.migrationEvidence ?? null)
      : (existing.migrationEvidence ?? null),
    authoringAudit: mergeAuthoringAudit(existing.authoringAudit ?? null, input.audit),
  });
  const saved = await input.store.upsertProfileVersion(updated);
  return toProfileVersionReview(saved);
}

export async function updateCatalogProviderProfileSectionForReview(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
  profileKey?: string | null;
  ingestionUnitKey?: string | null;
  command: CatalogProviderProfileSectionUpdateCommand;
  audit?: CatalogProviderIntegrationProfileAuthoringAudit | null;
  activeJobs?: readonly CatalogProviderProfileLifecycleBlockingJob[];
}): Promise<CatalogProviderProfileVersionReview> {
  const existing = await requireProfileVersion(
    input.store,
    input.providerKey,
    input.profileVersion,
    profileVersionSelectorFromInput(input),
  );
  const patch = toCatalogProviderProfileSectionPatch(existing, input.command);
  return updateCatalogProviderProfileVersionForReview({
    store: input.store,
    providerKey: input.providerKey,
    profileVersion: input.profileVersion,
    profileKey: input.profileKey,
    ingestionUnitKey: input.ingestionUnitKey,
    patch,
    audit: input.audit,
    activeJobs: input.activeJobs,
  });
}

export async function rollbackCatalogProviderProfileVersionForReview(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
  profileKey?: string | null;
  ingestionUnitKey?: string | null;
  activeJobs?: readonly CatalogProviderProfileLifecycleBlockingJob[];
}): Promise<CatalogProviderProfileVersionReview> {
  assertNoActiveProfileLifecycleBlockingJobs(input);
  const rolledBack = await input.store.rollbackProfileVersion(
    input.providerKey,
    input.profileVersion,
    profileVersionSelectorFromInput(input),
  );
  return toProfileVersionReview(rolledBack);
}

export async function retireCatalogProviderProfileVersionForReview(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
  profileKey?: string | null;
  ingestionUnitKey?: string | null;
  audit?: CatalogProviderIntegrationProfileAuthoringAudit | null;
  activeJobs?: readonly CatalogProviderProfileLifecycleBlockingJob[];
}): Promise<CatalogProviderProfileVersionReview> {
  assertNoActiveProfileLifecycleBlockingJobs(input);
  const existing = await requireProfileVersion(
    input.store,
    input.providerKey,
    input.profileVersion,
    profileVersionSelectorFromInput(input),
  );
  if (existing.active) {
    throw new Error(
      `Catalog provider profile version ${input.providerKey}@${input.profileVersion} must be deactivated before retirement.`,
    );
  }
  const referenceCount = await input.store.countProfileVersionReferences(input.providerKey, input.profileVersion);
  if (referenceCount > 0) {
    throw new Error(
      `Catalog provider profile version ${input.providerKey}@${input.profileVersion} is referenced by ${referenceCount} Source Observations and cannot be retired.`,
    );
  }
  const retired = await input.store.upsertProfileVersion({
    ...existing,
    lifecycle: "retired",
    active: false,
    executableMappingContract: existing.executableMappingContract
      ? {
          ...existing.executableMappingContract,
          lifecycle: "retired",
        }
      : undefined,
    authoringAudit: mergeAuthoringAudit(existing.authoringAudit ?? null, input.audit),
  });
  return toProfileVersionReview(retired);
}

function catalogProviderProfileEditableSections(): readonly CatalogProviderProfileEditableSection[] {
  return catalogProviderProfileEditableSectionMetadata();
}

function authoringFixtureCasesForVersion(
  version: CatalogProviderIntegrationProfileVersionRecord,
  fixtureCases: readonly CatalogProviderProfileFixtureCase[],
): readonly CatalogProviderProfileFixtureCase[] {
  const providerCases = fixtureCases.filter((fixtureCase) => fixtureCase.providerKey === version.providerKey);
  return catalogProviderRequiredFixtureFlows.map((flow) => {
    const fixtureCase = providerCases.find((candidate) => candidate.flow === flow);
    return {
      providerKey: version.providerKey,
      profileVersion: version.profileVersion,
      flow,
      payloadFile: fixtureCase?.payloadFile ?? `${flow}.json`,
      expectedStatus: fixtureCase?.expectedStatus ?? "completed",
      expectedObservation: fixtureCase?.expectedObservation,
      expectedDiagnosticPaths: fixtureCase?.expectedDiagnosticPaths,
      expectedHashEvidencePaths: fixtureCase?.expectedHashEvidencePaths,
      expectedMergeEvidencePaths: fixtureCase?.expectedMergeEvidencePaths,
      expectedPromotionCommands: fixtureCase?.expectedPromotionCommands,
    };
  });
}

async function toFixtureMetadata(input: {
  version: CatalogProviderIntegrationProfileVersionRecord;
  fixtureCase: CatalogProviderProfileFixtureCase;
  repositoryRoot: string;
}): Promise<CatalogProviderProfileFixtureMetadata> {
  const payloadPath = path.join(input.version.fixtures.fixtureRoot, input.fixtureCase.payloadFile);
  const absolutePayloadPath = path.join(input.repositoryRoot, payloadPath);
  const samplePayload = await readJsonFixture(absolutePayloadPath);

  return {
    flow: input.fixtureCase.flow,
    payloadFile: input.fixtureCase.payloadFile,
    payloadPath,
    expectedStatus: input.fixtureCase.expectedStatus,
    expectedDiagnosticPaths: input.fixtureCase.expectedDiagnosticPaths ?? [],
    expectedHashEvidencePaths: input.fixtureCase.expectedHashEvidencePaths ?? [],
    expectedMergeEvidencePaths: input.fixtureCase.expectedMergeEvidencePaths ?? [],
    expectedPromotionCommands: input.fixtureCase.expectedPromotionCommands ?? [],
    expectedObservation: input.fixtureCase.expectedObservation ?? null,
    samplePayload: samplePayload ? redactJson(samplePayload) : null,
    samplePayloadAvailable: Boolean(samplePayload),
  };
}

async function readJsonFixture(absolutePayloadPath: string): Promise<JsonValue | null> {
  try {
    return JSON.parse(await readFile(absolutePayloadPath, "utf8")) as JsonValue;
  } catch {
    return null;
  }
}

function toDryRunInputTemplate(
  fixtureMetadata: readonly CatalogProviderProfileFixtureMetadata[],
  observedAt: string,
): CatalogProviderProfileDryRunInputTemplate {
  const defaultFixture =
    fixtureMetadata.find((fixtureCase) => fixtureCase.flow === "normal" && fixtureCase.samplePayloadAvailable) ??
    fixtureMetadata.find((fixtureCase) => fixtureCase.samplePayloadAvailable) ??
    null;

  return {
    observedAt,
    defaultFlow: defaultFixture?.flow ?? null,
    payload: defaultFixture?.samplePayload ?? {},
    fixturePayloads: fixtureMetadata,
  };
}

function toSemanticDiff(
  candidate: CatalogProviderIntegrationProfileVersionRecord,
  active: CatalogProviderIntegrationProfileVersionRecord | null,
): CatalogProviderProfileSemanticDiff {
  const candidateFingerprint = sourceMappingFingerprint(candidate);
  const activeFingerprint = active ? sourceMappingFingerprint(active) : null;
  const compare = (
    path: string,
    label: string,
    candidateValue: JsonValue,
    activeValue: JsonValue,
    severity: CatalogProviderProfileSemanticDiffChange["severity"],
    activationImpact: string,
  ): CatalogProviderProfileSemanticDiffChange => {
    const sectionKey = sectionKeyForPath(path);
    return {
      sectionKey,
      domainConcept: domainConceptForSection(sectionKey),
      path,
      label,
      candidate: candidateValue,
      active: activeValue,
      changed: JSON.stringify(candidateValue) !== JSON.stringify(activeValue),
      severity,
      activationImpact,
    };
  };
  const contract = candidate.executableMappingContract;
  const activeContract = active?.executableMappingContract;
  const changes = [
    compare(
      "lifecycle",
      "Lifecycle",
      candidate.lifecycle,
      active?.lifecycle ?? null,
      "warning",
      "Controls whether the candidate can be activated or edited.",
    ),
    compare(
      "profile.status",
      "Status",
      candidate.profile.status,
      active?.profile.status ?? null,
      "info",
      "Changes profile visibility/status only.",
    ),
    compare(
      "profile.capabilities",
      "Capabilities",
      [...candidate.profile.capabilities],
      [...(active?.profile.capabilities ?? [])],
      "warning",
      "Changes available import, reference extraction, and promotion workflows.",
    ),
    compare(
      "profile.supportedScopes",
      "Supported Scopes",
      [...candidate.profile.supportedScopes],
      [...(active?.profile.supportedScopes ?? [])],
      "warning",
      "Changes which provider scopes operators can import.",
    ),
    compare(
      "profile.languageOptions",
      "Language Options",
      [...candidate.profile.languageOptions],
      [...(active?.profile.languageOptions ?? [])],
      "info",
      "Changes selectable import languages.",
    ),
    compare(
      "profile.optionQueries",
      "Provider Option Queries",
      toJsonValue(candidate.profile.optionQueries),
      toJsonValue(active?.profile.optionQueries ?? []),
      "warning",
      "Changes import filters, parent scopes, and option discovery behavior.",
    ),
    compare(
      "profile.connector.kind",
      "Connector",
      candidate.profile.connector.kind,
      active?.profile.connector.kind ?? null,
      "warning",
      "Changes the provider transport/integration implementation.",
    ),
    compare(
      "profile.connector",
      "Connector Contract",
      toJsonValue(candidate.profile.connector),
      toJsonValue(active?.profile.connector ?? null),
      "warning",
      "Changes provider endpoints, repository metadata, authentication, retry, or evidence settings.",
    ),
    compare(
      "sourceContract",
      "Source Contract",
      toJsonValue(candidate.sourceContract),
      toJsonValue(active?.sourceContract ?? null),
      "info",
      "Changes authored contract provenance and fixture set documentation.",
    ),
    compare(
      "fixtures.coveredFlows",
      "Fixture Coverage",
      [...candidate.fixtures.coveredFlows],
      [...(active?.fixtures.coveredFlows ?? [])],
      "warning",
      "Changes fixture validation coverage before activation.",
    ),
    compare(
      "fixtures",
      "Fixture Contract",
      toJsonValue(candidate.fixtures),
      toJsonValue(active?.fixtures ?? null),
      "warning",
      "Changes fixture root, covered flows, and live-call safety.",
    ),
    compare(
      "profile.normalizedObservationMapping",
      "Static Normalized Mapping",
      toJsonValue(candidate.profile.normalizedObservationMapping),
      toJsonValue(active?.profile.normalizedObservationMapping ?? null),
      "warning",
      "Changes normalized output kind, variant rules, and duplicate-reference handling.",
    ),
    compare(
      "profile.catalogFieldMapping",
      "Catalog Field Mapping",
      toJsonValue(candidate.profile.catalogFieldMapping),
      toJsonValue(active?.profile.catalogFieldMapping ?? null),
      "warning",
      "Changes Catalog blueprint, category, or field assignment behavior.",
    ),
    compare(
      "executableMappingContract.normalizedObservation.outputKind",
      "Normalized Output Kind",
      contract?.normalizedObservation.outputKind ?? null,
      activeContract?.normalizedObservation.outputKind ?? null,
      "error",
      "Changes the normalized Source Observation kind and replay/promotion expectations.",
    ),
    compare(
      "executableMappingContract.normalizedObservation.fields",
      "Normalized Fields",
      toJsonValue(contract?.normalizedObservation.fields ?? null),
      toJsonValue(activeContract?.normalizedObservation.fields ?? null),
      "warning",
      "Changes Catalog truth fields generated from provider payloads.",
    ),
    compare(
      "executableMappingContract.normalizedObservation.hashMaterial",
      "Hash Material",
      toJsonValue(contract?.normalizedObservation.hashMaterial ?? null),
      toJsonValue(activeContract?.normalizedObservation.hashMaterial ?? null),
      "error",
      "Changes replay identity/hash behavior and may require migration evidence.",
    ),
    compare(
      "executableMappingContract.normalizedObservation.mergeIdentity",
      "Merge Identity",
      toJsonValue(contract?.normalizedObservation.mergeIdentity ?? null),
      toJsonValue(activeContract?.normalizedObservation.mergeIdentity ?? null),
      "error",
      "Changes duplicate candidate matching and replay reuse behavior.",
    ),
    compare(
      "executableMappingContract.externalReferences",
      "External References",
      toJsonValue(contract?.externalReferences ?? null),
      toJsonValue(activeContract?.externalReferences ?? null),
      "warning",
      "Changes emitted external Catalog/Product references and selected-option evidence.",
    ),
    compare(
      "profile.selectedOptionMapping",
      "Selected Option Mapping",
      toJsonValue(candidate.profile.selectedOptionMapping ?? null),
      toJsonValue(active?.profile.selectedOptionMapping ?? null),
      "warning",
      "Changes provider option normalization used by product references.",
    ),
    compare(
      "executableMappingContract.referenceHierarchy",
      "Reference Hierarchy",
      toJsonValue(contract?.referenceHierarchy ?? null),
      toJsonValue(activeContract?.referenceHierarchy ?? null),
      "warning",
      "Changes provisioned Reference Records and parent chains.",
    ),
    compare(
      "executableMappingContract.duplicatePrevention",
      "Duplicate Prevention",
      toJsonValue(contract?.duplicatePrevention ?? null),
      toJsonValue(activeContract?.duplicatePrevention ?? null),
      "error",
      "Changes duplicate candidate order, evidence, or replay policy.",
    ),
    compare(
      "sourceMappingFingerprint",
      "Source Mapping Fingerprint",
      candidateFingerprint,
      activeFingerprint,
      candidateFingerprint !== activeFingerprint ? "error" : "info",
      "Summarizes whether replay/hash behavior changed and whether migration evidence is required.",
    ),
    compare(
      "promotionCommandPlan.commands",
      "Promotion Commands",
      promotionCommandNames(candidate),
      [...(active ? promotionCommandNames(active) : [])],
      "warning",
      "Changes ordered Catalog promotion commands.",
    ),
    compare(
      "retirementPlan",
      "Retirement Plan",
      toJsonValue(candidate.retirementPlan ?? null),
      toJsonValue(active?.retirementPlan ?? null),
      "info",
      "Changes planned cleanup tracking only.",
    ),
    compare(
      "migrationEvidence",
      "Migration Evidence",
      toJsonValue(candidate.migrationEvidence ?? null),
      toJsonValue(active?.migrationEvidence ?? null),
      "warning",
      "Records operator evidence for fingerprint-changing activation.",
    ),
    compare(
      "authoringAudit",
      "Authoring Audit",
      toJsonValue(candidate.authoringAudit ?? null),
      toJsonValue(active?.authoringAudit ?? null),
      "info",
      "Shows who authored the candidate and when.",
    ),
  ];

  return {
    providerKey: candidate.providerKey,
    candidateProfileVersion: candidate.profileVersion,
    activeProfileVersion: active?.profileVersion ?? null,
    mappingFingerprint: {
      candidate: candidateFingerprint,
      active: activeFingerprint,
      changed: candidateFingerprint !== activeFingerprint,
    },
    changes,
    sections: toSemanticDiffSections(changes),
  };
}

function toActivationReadiness(input: {
  version: CatalogProviderIntegrationProfileVersionRecord;
  activeVersion: CatalogProviderIntegrationProfileVersionRecord | null;
  referenceCount: number;
  fixtureCases: readonly CatalogProviderProfileFixtureCase[];
}): CatalogProviderProfileActivationReadiness {
  const checks: CatalogProviderProfileActivationReadinessCheck[] = [];
  const addBlocked = (
    checkKey: string,
    code: CatalogIntegrationDiagnosticCode,
    path: string,
    diagnosticText: string,
    flow?: string,
  ) => {
    checks.push(
      readinessCheck({
        checkKey,
        code,
        status: "blocked",
        path,
        diagnosticText,
        severity: "error",
        flow,
      }),
    );
  };
  const addPassed = (
    checkKey: string,
    code: CatalogIntegrationDiagnosticCode,
    path: string,
    diagnosticText: string,
  ) => {
    checks.push(
      readinessCheck({
        checkKey,
        code,
        status: "passed",
        path,
        diagnosticText,
        severity: "warning",
      }),
    );
  };

  if (input.version.lifecycle !== "draft" && input.version.lifecycle !== "test") {
    addBlocked(
      "mutable-lifecycle",
      "activation-mutable-lifecycle",
      "lifecycle",
      `Only draft or test profiles can be activated from the admin; '${input.version.lifecycle}' is immutable.`,
    );
  } else {
    addPassed(
      "mutable-lifecycle",
      "activation-mutable-lifecycle",
      "lifecycle",
      "Profile version is in an activation-ready lifecycle.",
    );
  }

  if (!input.version.executableMappingContract) {
    addBlocked(
      "executable-mapping-contract",
      "activation-executable-mapping-contract",
      "executableMappingContract",
      "Activation requires an executable mapping contract.",
    );
  } else {
    addPassed(
      "executable-mapping-contract",
      "activation-executable-mapping-contract",
      "executableMappingContract",
      "Executable mapping contract is present.",
    );
  }

  if (!input.version.profile.capabilities.includes("source-observation-import")) {
    addBlocked(
      "import-eligibility",
      "activation-import-eligibility",
      "profile.capabilities",
      "Activation requires the source-observation-import capability so new provider imports can use this profile.",
    );
  } else {
    addPassed(
      "import-eligibility",
      "activation-import-eligibility",
      "profile.capabilities",
      "Profile is eligible for new Source Observation imports.",
    );
  }

  if (input.version.fixtures.liveProviderCallsAllowed) {
    addBlocked(
      "fixture-live-calls",
      "activation-fixture-live-calls",
      "fixtures.liveProviderCallsAllowed",
      "Fixture validation must not require live provider calls.",
    );
  } else {
    addPassed(
      "fixture-live-calls",
      "activation-fixture-live-calls",
      "fixtures.liveProviderCallsAllowed",
      "Fixture validation is isolated from live provider calls.",
    );
  }

  for (const flow of catalogProviderRequiredFixtureFlows) {
    if (!input.version.fixtures.coveredFlows.includes(flow)) {
      addBlocked(
        "fixture-covered-flow",
        "activation-fixture-covered-flow",
        `fixtures.coveredFlows.${flow}`,
        `Profile fixture contract must cover ${flow}.`,
        flow,
      );
    } else if (!input.fixtureCases.some((fixtureCase) => fixtureCase.flow === flow)) {
      addBlocked(
        "fixture-case",
        "fixture-harness-failure",
        `fixtures.${flow}`,
        `Fixture metadata must include a ${flow} case.`,
        flow,
      );
    }
  }
  if (catalogProviderRequiredFixtureFlows.every((flow) => input.version.fixtures.coveredFlows.includes(flow))) {
    addPassed(
      "fixture-coverage",
      "activation-fixture-covered-flow",
      "fixtures.coveredFlows",
      "All required fixture flows are covered.",
    );
  }

  for (const diagnostic of validateCatalogProviderIntegrationProfileVersion(input.version)) {
    addBlocked("profile-validation", "activation-profile-validation", diagnostic.path, diagnostic.diagnosticText);
  }

  const requiresMigrationEvidence = migrationEvidenceRequired(input.version, input.activeVersion);
  if (requiresMigrationEvidence && !hasMigrationEvidence(input.version)) {
    addBlocked(
      "migration-evidence",
      "activation-migration-evidence",
      "migrationEvidence.evidenceText",
      "Source Observation mapping fingerprint changes require explicit migration evidence before activation.",
    );
  } else if (requiresMigrationEvidence) {
    addPassed(
      "migration-evidence",
      "activation-migration-evidence",
      "migrationEvidence.evidenceText",
      "Migration evidence is recorded for the fingerprint change.",
    );
  } else {
    addPassed(
      "migration-evidence",
      "activation-migration-evidence",
      "migrationEvidence",
      "No migration evidence is required for this activation.",
    );
  }

  return {
    status: checks.some((check) => check.status === "blocked") ? "blocked" : "ready",
    checks,
    groups: toActivationReadinessGroups(checks),
    requiresMigrationEvidence,
    referenceCount: input.referenceCount,
  };
}

function toSectionSummaries(input: {
  version: CatalogProviderIntegrationProfileVersionRecord;
  semanticDiff: CatalogProviderProfileSemanticDiff;
  activationReadiness: CatalogProviderProfileActivationReadiness;
}): readonly CatalogProviderProfileSectionSummary[] {
  const assembledSections = assembleCatalogProviderIngestionUnitProfileSections(input.version);
  return Object.values(assembledSections).map((section) => {
    const semanticChanges = input.semanticDiff.changes.filter((change) => change.sectionKey === section.sectionKey);
    const readinessChecks = input.activationReadiness.checks.filter((check) => check.sectionKey === section.sectionKey);
    return {
      sectionKey: section.sectionKey,
      domainConcept: domainConceptForSection(section.sectionKey),
      editable: section.editable,
      status: sectionStatus(section.validation.diagnostics, semanticChanges, readinessChecks),
      diagnostics: section.validation.diagnostics,
      semanticChanges,
      readinessChecks,
    };
  });
}

function sectionStatus(
  diagnostics: readonly CatalogProviderProfileSectionDiagnostic[],
  semanticChanges: readonly CatalogProviderProfileSemanticDiffChange[],
  readinessChecks: readonly CatalogProviderProfileActivationReadinessCheck[],
): CatalogProviderProfileSectionStatus {
  if (readinessChecks.some((check) => check.status === "blocked")) {
    return "blocked";
  }
  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
    return "error";
  }
  if (
    diagnostics.some((diagnostic) => diagnostic.severity === "warning") ||
    semanticChanges.some((change) => change.changed && change.severity !== "info")
  ) {
    return "warning";
  }

  return "valid";
}

function readinessCheck(
  input: Readonly<{
    checkKey: string;
    code: CatalogIntegrationDiagnosticCode;
    status: "passed" | "blocked";
    path: string;
    diagnosticText: string;
    severity: "error" | "warning";
    flow?: string;
  }>,
): CatalogProviderProfileActivationReadinessCheck {
  const definition = getCatalogIntegrationDiagnosticDefinition(input.code);
  const sectionKey = sectionKeyForPath(input.path);
  return {
    checkKey: input.checkKey,
    code: input.code,
    sectionKey,
    domainConcept: domainConceptForSection(sectionKey),
    status: input.status,
    path: input.path,
    diagnosticText: input.diagnosticText,
    severity: input.severity,
    remediation: definition.remediation,
    blockingBehavior: definition.blockingBehavior,
    ...(input.flow ? { flow: input.flow } : {}),
  };
}

function toActivationReadinessGroups(
  checks: readonly CatalogProviderProfileActivationReadinessCheck[],
): CatalogProviderProfileActivationReadiness["groups"] {
  return uniqueSections(checks.map((check) => check.sectionKey)).map((sectionKey) => {
    const sectionChecks = checks.filter((check) => check.sectionKey === sectionKey);
    return {
      domainConcept: domainConceptForSection(sectionKey),
      status: sectionChecks.some((check) => check.status === "blocked") ? "blocked" : "ready",
      checks: sectionChecks,
    };
  });
}

function toSemanticDiffSections(
  changes: readonly CatalogProviderProfileSemanticDiffChange[],
): CatalogProviderProfileSemanticDiff["sections"] {
  return uniqueSections(changes.map((change) => change.sectionKey)).map((sectionKey) => {
    const sectionChanges = changes.filter((change) => change.sectionKey === sectionKey);
    return {
      sectionKey,
      domainConcept: domainConceptForSection(sectionKey),
      status: semanticSectionStatus(sectionChanges),
      changes: sectionChanges,
    };
  });
}

function semanticSectionStatus(
  changes: readonly CatalogProviderProfileSemanticDiffChange[],
): Exclude<CatalogProviderProfileSectionStatus, "blocked"> {
  if (changes.some((change) => change.changed && change.severity === "error")) {
    return "error";
  }
  if (changes.some((change) => change.changed && change.severity === "warning")) {
    return "warning";
  }

  return "valid";
}

function toDryRunDiagnosticLinks(
  diagnostics: readonly CatalogProviderMappingInterpreterDiagnostic[],
  fixtureFlow: CatalogProviderProfileFixtureCase["flow"] | null,
): readonly CatalogProviderProfileDryRunDiagnosticLink[] {
  return diagnostics.map((diagnostic) => {
    const sectionKey = sectionKeyForPath(diagnostic.path);
    return {
      code: diagnostic.code,
      path: diagnostic.path,
      sectionKey,
      domainConcept: domainConceptForSection(sectionKey),
      fixtureFlow,
    };
  });
}

function uniqueSections(
  sectionKeys: readonly CatalogProviderProfileSectionKey[],
): readonly CatalogProviderProfileSectionKey[] {
  return [...new Set(sectionKeys)];
}

function domainConceptForSection(sectionKey: CatalogProviderProfileSectionKey): string {
  return catalogProviderProfileSectionDomainConcepts[sectionKey];
}

const catalogProviderProfileSectionDomainConcepts = {
  "ingestion-unit-identity": "Ingestion Unit",
  "profile-identity": "Profile Identity",
  "profile-lifecycle": "Lifecycle",
  "source-contract": "Source Contract",
  "fixture-contract": "Fixture Coverage",
  "provider-options": "Provider Options",
  "connector-binding": "Connector Binding",
  "normalized-observation": "Normalized Observation",
  "condition-certification-mapping": "Condition And Certification",
  "external-references": "External References",
  "selected-options": "Selected Options",
  "reference-hierarchy": "Reference Hierarchy",
  "duplicate-prevention": "Duplicate Prevention",
  "promotion-plan": "Promotion Plan",
  "migration-evidence": "Migration Evidence",
  "retirement-plan": "Retirement Plan",
} as const satisfies Record<CatalogProviderProfileSectionKey, string>;

function sectionKeyForPath(pathValue: string): CatalogProviderProfileSectionKey {
  if (pathValue.startsWith("ingestionUnit.")) {
    return "ingestion-unit-identity";
  }
  if (pathValue === "lifecycle" || pathValue === "active") {
    return "profile-lifecycle";
  }
  if (
    pathValue.startsWith("profile.capabilities") ||
    pathValue.startsWith("profile.supportedScopes") ||
    pathValue.startsWith("profile.languageOptions") ||
    pathValue === "profile.status"
  ) {
    return "profile-identity";
  }
  if (pathValue.startsWith("sourceContract")) {
    return "source-contract";
  }
  if (pathValue.startsWith("fixtures")) {
    return "fixture-contract";
  }
  if (pathValue.startsWith("profile.optionQueries")) {
    return "provider-options";
  }
  if (pathValue.startsWith("profile.connector") || pathValue.startsWith("executableMappingContract.connector")) {
    return "connector-binding";
  }
  if (
    pathValue.startsWith("profile.normalizedObservationMapping") ||
    pathValue.startsWith("profile.catalogFieldMapping") ||
    pathValue.startsWith("executableMappingContract.normalizedObservation") ||
    pathValue.startsWith("normalizedObservation.") ||
    pathValue === "sourceMappingFingerprint"
  ) {
    return "normalized-observation";
  }
  if (pathValue.startsWith("profile.condition") || pathValue.startsWith("conditionCertification")) {
    return "condition-certification-mapping";
  }
  if (
    pathValue.startsWith("executableMappingContract.externalReferences") ||
    pathValue.startsWith("externalReferences")
  ) {
    return "external-references";
  }
  if (pathValue.startsWith("profile.selectedOptionMapping") || pathValue.startsWith("selectedOptions")) {
    return "selected-options";
  }
  if (
    pathValue.startsWith("executableMappingContract.referenceHierarchy") ||
    pathValue.startsWith("referenceHierarchy")
  ) {
    return "reference-hierarchy";
  }
  if (
    pathValue.startsWith("executableMappingContract.duplicatePrevention") ||
    pathValue.startsWith("duplicatePrevention.")
  ) {
    return "duplicate-prevention";
  }
  if (pathValue.startsWith("promotionCommandPlan")) {
    return "promotion-plan";
  }
  if (pathValue.startsWith("migrationEvidence")) {
    return "migration-evidence";
  }
  if (pathValue.startsWith("retirementPlan") || pathValue === "referenceCount") {
    return "retirement-plan";
  }
  if (pathValue.startsWith("authoringAudit")) {
    return "profile-lifecycle";
  }

  return "normalized-observation";
}

function toProfileVersionReview(
  version: CatalogProviderIntegrationProfileVersionRecord,
  referenceCount = 0,
): CatalogProviderProfileVersionReview {
  const diagnostics = validateCatalogProviderIntegrationProfileVersion(version).map(toReviewDiagnostic);
  return {
    providerKey: version.providerKey,
    profileKey: version.profileKey,
    profileVersion: version.profileVersion,
    ingestionUnitKey: catalogProviderProfileVersionIngestionUnitKey(version),
    displayName: version.profile.displayName,
    lifecycle: version.lifecycle,
    active: version.active,
    status: version.profile.status,
    connectorKind: version.profile.connector.kind,
    profile: version.profile,
    sourceContract: version.sourceContract,
    fixtures: version.fixtures,
    retirementPlan: version.retirementPlan,
    executableMappingContract: version.executableMappingContract,
    referenceCount,
    capabilities: version.profile.capabilities,
    supportedScopes: version.profile.supportedScopes,
    languageOptions: version.profile.languageOptions,
    sourceOptionKinds: version.profile.optionQueries.map(toSourceOptionKind),
    mappingOutputKind: version.executableMappingContract?.normalizedObservation.outputKind ?? "unknown",
    hasExecutableMappingContract: Boolean(version.executableMappingContract),
    migrationEvidence: version.migrationEvidence ?? null,
    authoringAudit: version.authoringAudit ?? null,
    validation: {
      status: diagnostics.length === 0 ? "valid" : "invalid",
      diagnostics,
    },
  };
}

function toSourceOptionKind(query: CatalogProviderOptionQuery): CatalogProviderSourceOptionKind {
  return {
    queryKind: query.queryKind,
    queryKeySynonyms: query.queryKeySynonyms ?? [],
    displayName: query.displayName,
    scope: query.scope,
    parentScope: query.parentScope,
    parentRequired: query.parentValue?.required ?? false,
    parentValueKind: query.parentValue?.valueKind ?? null,
    parentDiagnosticText: query.parentValue?.diagnosticText ?? null,
  };
}

function toReviewDiagnostic(
  diagnostic: CatalogProviderIntegrationProfileVersionDiagnostic,
): CatalogProviderProfileReviewDiagnostic {
  return {
    code: diagnostic.mappingDiagnostic?.code ?? diagnostic.code,
    path: diagnostic.mappingDiagnostic?.path ?? diagnostic.path,
    diagnosticText: diagnostic.mappingDiagnostic?.diagnosticText ?? diagnostic.diagnosticText,
    severity: "error",
  };
}

async function requireProfileVersion(
  store: CatalogProviderIntegrationProfileVersionStore,
  providerKey: string,
  profileVersion: string,
  selector?: CatalogProviderProfileVersionSelector | null,
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const version = await store.getProfileVersion(providerKey, profileVersion, selector);
  if (!version) {
    throw new CatalogProviderProfileVersionNotFoundError(providerKey, profileVersion);
  }

  return version;
}

function profileVersionSelectorFromInput(
  input: CatalogProviderProfileVersionSelectionInput,
): CatalogProviderProfileVersionSelector | null {
  const profileKey = input.profileKey?.trim();
  const ingestionUnitKey = input.ingestionUnitKey?.trim();
  return profileKey || ingestionUnitKey
    ? {
        ...(profileKey ? { profileKey } : {}),
        ...(ingestionUnitKey ? { ingestionUnitKey } : {}),
      }
    : null;
}

function assertMutableLifecycle(lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"]): void {
  if (lifecycle !== "draft" && lifecycle !== "test") {
    throw new Error(`Only draft or test Catalog provider profile versions can be edited; '${lifecycle}' is immutable.`);
  }
}

function assertNoActiveProfileLifecycleBlockingJobs(input: {
  providerKey: string;
  profileVersion: string;
  activeJobs?: readonly CatalogProviderProfileLifecycleBlockingJob[];
}): void {
  const providerKey = input.providerKey.trim().toLowerCase();
  const profileVersion = input.profileVersion.trim();
  const blockingJobs = (input.activeJobs ?? []).filter((job) => {
    if (job.status !== "queued" && job.status !== "running") {
      return false;
    }
    if (job.action === "reject") {
      return false;
    }
    const jobProviderKey = job.providerKey?.trim().toLowerCase() ?? null;

    if (jobProviderKey && jobProviderKey !== providerKey) {
      return false;
    }

    return true;
  });

  if (blockingJobs.length > 0) {
    throw new CatalogProviderProfileLifecycleConsistencyError(providerKey, profileVersion, blockingJobs);
  }
}

function assertProfileVersionIdentity(
  version: CatalogProviderIntegrationProfileVersionRecord,
): CatalogProviderIntegrationProfileVersionRecord {
  if (version.profile.providerKey !== version.providerKey) {
    throw new Error(
      `Profile providerKey '${version.profile.providerKey}' must match version providerKey '${version.providerKey}'.`,
    );
  }
  if (version.executableMappingContract) {
    if (
      version.executableMappingContract.providerKey !== version.providerKey ||
      version.executableMappingContract.profileKey !== version.profileKey ||
      version.executableMappingContract.profileVersion !== version.profileVersion ||
      version.executableMappingContract.lifecycle !== version.lifecycle
    ) {
      throw new Error(
        "Executable mapping contract identity must match providerKey, profileKey, profileVersion, and lifecycle.",
      );
    }
  }

  return version;
}

function mergeAuthoringAudit(
  existing: CatalogProviderIntegrationProfileAuthoringAudit | null,
  next: CatalogProviderIntegrationProfileAuthoringAudit | null | undefined,
): CatalogProviderIntegrationProfileAuthoringAudit | null {
  if (!existing && !next) {
    return null;
  }

  return {
    createdAt: existing?.createdAt ?? next?.createdAt ?? null,
    createdByUserId: existing?.createdByUserId ?? next?.createdByUserId ?? null,
    createdForAccountId: existing?.createdForAccountId ?? next?.createdForAccountId ?? null,
    updatedAt: next?.updatedAt ?? existing?.updatedAt ?? null,
    updatedByUserId: next?.updatedByUserId ?? existing?.updatedByUserId ?? null,
    updatedForAccountId: next?.updatedForAccountId ?? existing?.updatedForAccountId ?? null,
  };
}

function blockedDryRun(
  version: CatalogProviderIntegrationProfileVersionRecord,
  payload: JsonValue,
  diagnostics: readonly CatalogProviderMappingInterpreterDiagnostic[],
  fixtureFlow: CatalogProviderProfileFixtureCase["flow"] | null = null,
): CatalogProviderProfileDryRunResult {
  return {
    providerKey: version.providerKey,
    profileKey: version.profileKey,
    profileVersion: version.profileVersion,
    status: "blocked",
    redactedPayload: redactJson(payload),
    observation: null,
    diagnostics,
    diagnosticLinks: toDryRunDiagnosticLinks(diagnostics, fixtureFlow),
    hashMaterial: [],
    externalReferences: {
      catalogItemReferences: [],
      productReferences: [],
    },
    selectedOptions: [],
    mergeCandidateEvidence: [],
    duplicatePreventionPolicy: {
      ambiguousCandidatePolicy: "not-evaluated",
      replayPolicy: "not-evaluated",
      exactExternalCatalogItemReferencesFirst: false,
    },
    duplicatePreventionRules: [],
    duplicatePreventionCandidatePreview: null,
    promotionCommandPlan: {
      requiresReview: true,
      commands: [],
    },
  };
}

function evaluateEvidenceList(
  expressions: readonly CatalogProviderMappingValueExpression[],
  payload: JsonValue,
  path: string,
): readonly CatalogProviderProfileDryRunEvidence[] {
  return expressions.map((expression, index) =>
    evaluateEvidence(`${path}.${index}`, expression, payload, `${path}.${index}`),
  );
}

function evaluateEvidence(
  evidencePath: string,
  expression: CatalogProviderMappingValueExpression,
  payload: JsonValue,
  evaluationPath: string,
): CatalogProviderProfileDryRunEvidence {
  const result = evaluateCatalogProviderMappingExpression(expression, payload, {}, evaluationPath);
  return {
    path: evidencePath,
    owner: expression.owner,
    uses: expression.uses,
    redaction: expression.redaction,
    value: result.evidence ? redactJson(result.evidence.value, expression.redaction) : null,
    diagnostics: result.diagnostics,
  };
}

function isSourceObservationContract(
  contract: CatalogProviderExecutableMappingContract | undefined,
): contract is CatalogProviderSourceObservationMappingContract {
  return Boolean(contract?.sourceObservation);
}

function sourceMappingFingerprint(version: CatalogProviderIntegrationProfileVersionRecord): string | null {
  return isSourceObservationContract(version.executableMappingContract)
    ? catalogProviderSourceMappingFingerprint(version.executableMappingContract)
    : null;
}

function promotionCommandNames(version: CatalogProviderIntegrationProfileVersionRecord): readonly string[] {
  return version.executableMappingContract?.promotionCommandPlan.commands.map((command) => command.commandName) ?? [];
}

function migrationEvidenceRequired(
  target: CatalogProviderIntegrationProfileVersionRecord,
  active: CatalogProviderIntegrationProfileVersionRecord | null,
): boolean {
  const targetFingerprint = sourceMappingFingerprint(target);
  const activeFingerprint = active ? sourceMappingFingerprint(active) : null;
  return Boolean(targetFingerprint && activeFingerprint && targetFingerprint !== activeFingerprint);
}

function isSourceObservationProfileVersion(
  version: CatalogProviderIntegrationProfileVersionRecord,
): version is SourceObservationProfileVersionRecord {
  return isSourceObservationContract(version.executableMappingContract);
}

async function assertMigrationEvidenceForActivation(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
  profileKey?: string | null;
  ingestionUnitKey?: string | null;
}) {
  const versions = await input.store.listProfileVersions();
  const target = await requireProfileVersion(
    input.store,
    input.providerKey,
    input.profileVersion,
    profileVersionSelectorFromInput(input),
  );
  if (!isSourceObservationProfileVersion(target)) {
    return;
  }
  const active = versions
    .filter(isSourceObservationProfileVersion)
    .find(
      (version) =>
        version.providerKey === input.providerKey &&
        version.active &&
        version.lifecycle === "active" &&
        catalogProviderProfileVersionsCompete(version, target),
    );

  if (!active || (target.profileKey === active.profileKey && target.profileVersion === active.profileVersion)) {
    return;
  }

  const targetFingerprint = catalogProviderSourceMappingFingerprint(target.executableMappingContract);
  const activeFingerprint = catalogProviderSourceMappingFingerprint(active.executableMappingContract);
  if (targetFingerprint === activeFingerprint || hasMigrationEvidence(target)) {
    return;
  }

  throw new CatalogProviderProfileActivationValidationError(
    `Activating ${target.providerKey}@${target.profileVersion} changes Source Observation mapping fingerprint and requires explicit migration evidence before activation.`,
    [
      {
        code: "missing-migration-evidence",
        path: "migrationEvidence.evidenceText",
        diagnosticText:
          "Source Observation mapping fingerprint changes require explicit migration evidence before activation.",
        severity: "error",
      },
    ],
  );
}

async function assertImportEligibilityForActivation(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
  profileKey?: string | null;
  ingestionUnitKey?: string | null;
}) {
  const target = await requireProfileVersion(
    input.store,
    input.providerKey,
    input.profileVersion,
    profileVersionSelectorFromInput(input),
  );
  if (target.profile.capabilities.includes("source-observation-import")) {
    return;
  }

  throw new CatalogProviderProfileActivationValidationError(
    `Activating ${target.providerKey}@${target.profileVersion} requires the source-observation-import capability so new provider imports can use this profile.`,
    [
      {
        code: "import-eligibility",
        path: "profile.capabilities",
        diagnosticText:
          "Activation requires the source-observation-import capability so new provider imports can use this profile.",
        severity: "error",
      },
    ],
  );
}

async function assertFixtureHarnessForActivation(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
  profileKey?: string | null;
  ingestionUnitKey?: string | null;
  fixtureCases?: readonly CatalogProviderProfileFixtureCase[];
  repositoryRoot?: string;
  observedAt?: string;
}) {
  const target = await requireProfileVersion(
    input.store,
    input.providerKey,
    input.profileVersion,
    profileVersionSelectorFromInput(input),
  );
  if (!target.executableMappingContract) {
    throw new Error(
      `Activating ${target.providerKey}@${target.profileVersion} requires an executable Source Observation mapping contract.`,
    );
  }

  const fixtureResults = await validateCatalogProviderProfileFixtures({
    versions: [target],
    fixtureCases: input.fixtureCases ?? catalogProviderProfileFixtureCases(),
    repositoryRoot: input.repositoryRoot ?? defaultRepositoryRoot(),
    observedAt: input.observedAt ?? "2026-06-03T00:00:00.000Z",
  });
  const failureText = formatCatalogProviderProfileFixtureFailures(fixtureResults);
  if (failureText) {
    throw new CatalogProviderProfileActivationValidationError(
      `Activating ${target.providerKey}@${target.profileVersion} failed fixture harness validation:\n${failureText}`,
      fixtureResults.flatMap((result) =>
        result.failures.map((failure) => ({
          code: "fixture-harness-failure",
          path: failure.path,
          diagnosticText: failure.diagnosticText,
          severity: "error" as const,
          flow: failure.flow,
        })),
      ),
    );
  }
}

function hasMigrationEvidence(version: CatalogProviderIntegrationProfileVersionRecord): boolean {
  const evidence = version.migrationEvidence;
  if (!isJsonObject(evidence)) {
    return false;
  }

  return typeof evidence.evidenceText === "string" && evidence.evidenceText.trim().length > 0;
}

function defaultRepositoryRoot(): string {
  let candidate = process.cwd();
  while (true) {
    if (existsSync(path.join(candidate, "bounded-contexts", "catalog", "README.md"))) {
      return candidate;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) {
      return process.cwd();
    }
    candidate = parent;
  }
}

function redactJson(value: JsonValue, redaction: string = "none"): JsonValue {
  if (redaction !== "none") {
    return `[redacted:${redaction}]`;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => redactJson(entry));
  }

  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, shouldRedactKey(key) ? "[redacted]" : redactJson(entry)]),
    ) as JsonObject;
  }

  return value;
}

function shouldRedactKey(key: string): boolean {
  return /cookie|auth|secret|token|password|seller|listing|price|inventory/i.test(key);
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
