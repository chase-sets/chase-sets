import { existsSync } from "node:fs";
import path from "node:path";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type {
  CatalogProviderIntegrationProfileAuthoringAudit,
  CatalogProviderCapability,
  CatalogProviderIntegrationProfile,
  CatalogProviderIntegrationProfileCompatibilityMode,
  CatalogProviderIntegrationProfileMigrationEvidence,
  CatalogProviderIntegrationProfileRetirementPlan,
  CatalogProviderIntegrationProfileVersionDiagnostic,
  CatalogProviderIntegrationProfileVersionRecord,
  CatalogProviderScope,
} from "./provider-integration-profiles";
import { validateCatalogProviderIntegrationProfileVersion } from "./provider-integration-profiles";
import type { CatalogProviderIntegrationProfileVersionStore } from "./provider-integration-profile-store";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderMappingSourceContract,
  CatalogProviderMappingValueExpression,
  CatalogProviderProfileFixtureContract,
} from "./provider-integration-mapping-contract";
import { evaluateCatalogProviderMappingExpression } from "./provider-mapping-interpreter";
import type { CatalogProviderMappingInterpreterDiagnostic } from "./provider-mapping-interpreter";
import {
  catalogProviderSourceMappingFingerprint,
  normalizeCatalogProviderSourceObservation,
  type CatalogProviderSourceObservationMappingContract,
} from "./provider-source-observation-normalizer";
import {
  formatCatalogProviderProfileFixtureFailures,
  validateCatalogProviderProfileFixtures,
  type CatalogProviderProfileFixtureCase,
} from "./provider-profile-contract-harness";
import { catalogProviderProfileFixtureCases } from "./provider-profile-fixture-cases";

type SourceObservationProfileVersionRecord = CatalogProviderIntegrationProfileVersionRecord &
  Readonly<{ executableMappingContract: CatalogProviderSourceObservationMappingContract }>;

export type CatalogProviderProfileReviewDiagnostic = Readonly<{
  code: string;
  path: string;
  diagnosticText: string;
  severity: "error" | "warning";
}>;

export type CatalogProviderProfileActivationDiagnostic = CatalogProviderProfileReviewDiagnostic &
  Readonly<{
    flow?: string;
  }>;

export class CatalogProviderProfileActivationValidationError extends Error {
  readonly diagnostics: readonly CatalogProviderProfileActivationDiagnostic[];

  constructor(message: string, diagnostics: readonly CatalogProviderProfileActivationDiagnostic[]) {
    super(message);
    this.name = "CatalogProviderProfileActivationValidationError";
    this.diagnostics = diagnostics;
  }
}

export type CatalogProviderProfileVersionReview = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  displayName: string;
  lifecycle: string;
  active: boolean;
  status: string;
  compatibilityMode: string;
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
  mappingOutputKind: string;
  hasExecutableMappingContract: boolean;
  migrationEvidence: CatalogProviderIntegrationProfileMigrationEvidence | null;
  authoringAudit: CatalogProviderIntegrationProfileAuthoringAudit | null;
  validation: Readonly<{
    status: "valid" | "invalid";
    diagnostics: readonly CatalogProviderProfileReviewDiagnostic[];
  }>;
}>;

export type CatalogProviderProfileVersionUpdatePatch = Readonly<{
  lifecycle?: "draft" | "test";
  profile?: CatalogProviderIntegrationProfileVersionRecord["profile"];
  sourceContract?: CatalogProviderIntegrationProfileVersionRecord["sourceContract"];
  fixtures?: CatalogProviderIntegrationProfileVersionRecord["fixtures"];
  compatibilityMode?: CatalogProviderIntegrationProfileVersionRecord["compatibilityMode"];
  retirementPlan?: CatalogProviderIntegrationProfileVersionRecord["retirementPlan"];
  executableMappingContract?: CatalogProviderIntegrationProfileVersionRecord["executableMappingContract"] | null;
  migrationEvidence?: CatalogProviderIntegrationProfileMigrationEvidence | null;
}>;

export type CatalogProviderProfileEditableSectionKey =
  | "basics"
  | "source-contract"
  | "fixtures"
  | "retirement-plan"
  | "migration-evidence";

export type CatalogProviderProfileBasicsUpdateCommand = Readonly<{
  section: "basics";
  lifecycle?: "draft" | "test";
  displayName?: string;
  status?: CatalogProviderIntegrationProfile["status"];
  compatibilityMode?: CatalogProviderIntegrationProfileCompatibilityMode;
  capabilities?: readonly CatalogProviderCapability[];
  supportedScopes?: readonly CatalogProviderScope[];
  languageOptions?: readonly string[];
}>;

export type CatalogProviderProfileSourceContractUpdateCommand = Readonly<{
  section: "source-contract";
  sourceContract: CatalogProviderMappingSourceContract;
}>;

export type CatalogProviderProfileFixturesUpdateCommand = Readonly<{
  section: "fixtures";
  fixtures: CatalogProviderProfileFixtureContract;
}>;

export type CatalogProviderProfileRetirementPlanUpdateCommand = Readonly<{
  section: "retirement-plan";
  retirementPlan: CatalogProviderIntegrationProfileRetirementPlan | null;
}>;

export type CatalogProviderProfileMigrationEvidenceUpdateCommand = Readonly<{
  section: "migration-evidence";
  migrationEvidence: CatalogProviderIntegrationProfileMigrationEvidence | null;
}>;

export type CatalogProviderProfileSectionUpdateCommand =
  | CatalogProviderProfileBasicsUpdateCommand
  | CatalogProviderProfileSourceContractUpdateCommand
  | CatalogProviderProfileFixturesUpdateCommand
  | CatalogProviderProfileRetirementPlanUpdateCommand
  | CatalogProviderProfileMigrationEvidenceUpdateCommand;

export class CatalogProviderProfileSectionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CatalogProviderProfileSectionValidationError";
  }
}

export type CatalogProviderProfileDryRunEvidence = Readonly<{
  path: string;
  owner: string;
  uses: readonly string[];
  redaction: string;
  value: JsonValue;
  diagnostics: readonly CatalogProviderMappingInterpreterDiagnostic[];
}>;

export type CatalogProviderProfileDryRunResult = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  status: "completed" | "blocked";
  redactedPayload: JsonValue;
  observation: ReturnType<typeof normalizeCatalogProviderSourceObservation>["observation"];
  diagnostics: readonly CatalogProviderMappingInterpreterDiagnostic[];
  hashMaterial: readonly CatalogProviderProfileDryRunEvidence[];
  externalReferences: Readonly<{
    catalogItemReferences: JsonValue;
    productReferences: JsonValue;
  }>;
  selectedOptions: JsonValue;
  mergeCandidateEvidence: readonly CatalogProviderProfileDryRunEvidence[];
  duplicatePreventionRules: readonly Readonly<{
    ruleKey: string;
    ruleKind: string;
    candidatePolicy: string;
    evidence: readonly CatalogProviderProfileDryRunEvidence[];
  }>[];
  promotionCommandPlan: Readonly<{
    requiresReview: true;
    commands: readonly Readonly<{
      commandName: string;
      inputs: readonly CatalogProviderProfileDryRunEvidence[];
    }>[];
  }>;
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

export async function dryRunCatalogProviderProfileVersion(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
  payload: JsonValue;
  observedAt?: string;
}): Promise<CatalogProviderProfileDryRunResult> {
  const version = await input.store.getProfileVersion(input.providerKey, input.profileVersion);
  if (!version) {
    throw new Error(`Catalog provider profile version ${input.providerKey}@${input.profileVersion} was not found.`);
  }

  const contract = version.executableMappingContract;
  if (!isSourceObservationContract(contract)) {
    return blockedDryRun(version, input.payload, [
      {
        code: "missing-required-path",
        path: "executableMappingContract",
        redaction: "none",
        diagnosticText: "Profile version does not have an executable Source Observation mapping contract.",
      },
    ]);
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
  fixtureCases?: readonly CatalogProviderProfileFixtureCase[];
  repositoryRoot?: string;
  observedAt?: string;
}): Promise<CatalogProviderProfileVersionReview> {
  await assertFixtureHarnessForActivation(input);
  await assertMigrationEvidenceForActivation(input);
  const activated = await input.store.activateProfileVersion(input.providerKey, input.profileVersion);
  return toProfileVersionReview(activated);
}

export async function deprecateCatalogProviderProfileVersionForReview(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
}): Promise<CatalogProviderProfileVersionReview> {
  const deprecated = await input.store.deprecateProfileVersion(input.providerKey, input.profileVersion);
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
  targetProfileVersion: string;
  lifecycle?: "draft" | "test";
  audit?: CatalogProviderIntegrationProfileAuthoringAudit | null;
}): Promise<CatalogProviderProfileVersionReview> {
  const source = await requireProfileVersion(input.store, input.providerKey, input.profileVersion);
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
  patch: CatalogProviderProfileVersionUpdatePatch;
  audit?: CatalogProviderIntegrationProfileAuthoringAudit | null;
}): Promise<CatalogProviderProfileVersionReview> {
  const existing = await requireProfileVersion(input.store, input.providerKey, input.profileVersion);
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
    compatibilityMode: input.patch.compatibilityMode ?? existing.compatibilityMode,
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
  command: CatalogProviderProfileSectionUpdateCommand;
  audit?: CatalogProviderIntegrationProfileAuthoringAudit | null;
}): Promise<CatalogProviderProfileVersionReview> {
  const existing = await requireProfileVersion(input.store, input.providerKey, input.profileVersion);
  const patch = toProfileSectionPatch(existing, input.command);
  return updateCatalogProviderProfileVersionForReview({
    store: input.store,
    providerKey: input.providerKey,
    profileVersion: input.profileVersion,
    patch,
    audit: input.audit,
  });
}

export async function rollbackCatalogProviderProfileVersionForReview(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
}): Promise<CatalogProviderProfileVersionReview> {
  const rolledBack = await input.store.rollbackProfileVersion(input.providerKey, input.profileVersion);
  return toProfileVersionReview(rolledBack);
}

export async function retireCatalogProviderProfileVersionForReview(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
  audit?: CatalogProviderIntegrationProfileAuthoringAudit | null;
}): Promise<CatalogProviderProfileVersionReview> {
  const existing = await requireProfileVersion(input.store, input.providerKey, input.profileVersion);
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

function toProfileSectionPatch(
  existing: CatalogProviderIntegrationProfileVersionRecord,
  command: CatalogProviderProfileSectionUpdateCommand,
): CatalogProviderProfileVersionUpdatePatch {
  assertProfileSectionCommand(command);

  switch (command.section) {
    case "basics":
      return {
        lifecycle: command.lifecycle,
        compatibilityMode: command.compatibilityMode,
        profile: {
          ...existing.profile,
          displayName: command.displayName ?? existing.profile.displayName,
          status: command.status ?? existing.profile.status,
          capabilities: command.capabilities ?? existing.profile.capabilities,
          supportedScopes: command.supportedScopes ?? existing.profile.supportedScopes,
          languageOptions: command.languageOptions ?? existing.profile.languageOptions,
        },
        executableMappingContract: existing.executableMappingContract
          ? {
              ...existing.executableMappingContract,
              displayName: command.displayName ?? existing.executableMappingContract.displayName,
              lifecycle: command.lifecycle ?? existing.lifecycle,
            }
          : undefined,
      };
    case "source-contract":
      return {
        sourceContract: command.sourceContract,
        executableMappingContract: existing.executableMappingContract
          ? {
              ...existing.executableMappingContract,
              sourceContract: command.sourceContract,
            }
          : undefined,
      };
    case "fixtures":
      return {
        fixtures: command.fixtures,
        executableMappingContract: existing.executableMappingContract
          ? {
              ...existing.executableMappingContract,
              fixtures: command.fixtures,
            }
          : undefined,
      };
    case "retirement-plan":
      return { retirementPlan: command.retirementPlan };
    case "migration-evidence":
      return { migrationEvidence: command.migrationEvidence };
  }
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
    displayName: version.profile.displayName,
    lifecycle: version.lifecycle,
    active: version.active,
    status: version.profile.status,
    compatibilityMode: version.compatibilityMode,
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
): Promise<CatalogProviderIntegrationProfileVersionRecord> {
  const version = await store.getProfileVersion(providerKey, profileVersion);
  if (!version) {
    throw new Error(`Catalog provider profile version ${providerKey}@${profileVersion} was not found.`);
  }

  return version;
}

function assertMutableLifecycle(lifecycle: CatalogProviderIntegrationProfileVersionRecord["lifecycle"]): void {
  if (lifecycle !== "draft" && lifecycle !== "test") {
    throw new Error(`Only draft or test Catalog provider profile versions can be edited; '${lifecycle}' is immutable.`);
  }
}

function assertProfileSectionCommand(command: CatalogProviderProfileSectionUpdateCommand): void {
  if (!isJsonObject(command)) {
    throw new CatalogProviderProfileSectionValidationError("Profile section update command must be a JSON object.");
  }

  switch (command.section) {
    case "basics":
      assertOptionalString(command.displayName, "displayName");
      assertOptionalEnum(command.status, ["active", "planned"], "status");
      assertOptionalEnum(command.lifecycle, ["draft", "test"], "lifecycle");
      assertOptionalEnum(
        command.compatibilityMode,
        ["executable-mapping-contract", "transitional-static-profile"],
        "compatibilityMode",
      );
      assertOptionalStringArray(command.capabilities, "capabilities");
      assertOptionalStringArray(command.supportedScopes, "supportedScopes");
      assertOptionalStringArray(command.languageOptions, "languageOptions");
      break;
    case "source-contract":
      assertSourceContract(command.sourceContract);
      break;
    case "fixtures":
      assertFixtureContract(command.fixtures);
      break;
    case "retirement-plan":
      if (command.retirementPlan !== null) {
        assertRetirementPlan(command.retirementPlan);
      }
      break;
    case "migration-evidence":
      if (command.migrationEvidence !== null) {
        assertMigrationEvidence(command.migrationEvidence);
      }
      break;
    default:
      throw new CatalogProviderProfileSectionValidationError("Unsupported profile section update command.");
  }
}

function assertOptionalString(value: unknown, path: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new CatalogProviderProfileSectionValidationError(`${path} must be a string when provided.`);
  }
}

function assertOptionalStringArray(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new CatalogProviderProfileSectionValidationError(`${path} must be an array of strings when provided.`);
  }
}

function assertOptionalEnum(value: unknown, allowed: readonly string[], path: string): void {
  if (value !== undefined && (typeof value !== "string" || !allowed.includes(value))) {
    throw new CatalogProviderProfileSectionValidationError(`${path} is not a supported value.`);
  }
}

function assertRequiredString(value: unknown, path: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CatalogProviderProfileSectionValidationError(`${path} must be a non-empty string.`);
  }
}

function assertSourceContract(value: CatalogProviderMappingSourceContract): void {
  if (!isJsonObject(value)) {
    throw new CatalogProviderProfileSectionValidationError("sourceContract must be a JSON object.");
  }
  assertRequiredString(value.owner, "sourceContract.owner");
  if (value.repository !== null && typeof value.repository !== "string") {
    throw new CatalogProviderProfileSectionValidationError("sourceContract.repository must be a string or null.");
  }
  if (value.commit !== null && typeof value.commit !== "string") {
    throw new CatalogProviderProfileSectionValidationError("sourceContract.commit must be a string or null.");
  }
  assertRequiredString(value.documentPath, "sourceContract.documentPath");
  assertRequiredString(value.fixtureSetVersion, "sourceContract.fixtureSetVersion");
}

function assertFixtureContract(value: CatalogProviderProfileFixtureContract): void {
  if (!isJsonObject(value)) {
    throw new CatalogProviderProfileSectionValidationError("fixtures must be a JSON object.");
  }
  assertRequiredString(value.fixtureRoot, "fixtures.fixtureRoot");
  assertOptionalStringArray(value.coveredFlows, "fixtures.coveredFlows");
  if (value.liveProviderCallsAllowed !== false) {
    throw new CatalogProviderProfileSectionValidationError("fixtures.liveProviderCallsAllowed must remain false.");
  }
}

function assertRetirementPlan(value: CatalogProviderIntegrationProfileRetirementPlan): void {
  if (!isJsonObject(value)) {
    throw new CatalogProviderProfileSectionValidationError("retirementPlan must be a JSON object or null.");
  }
  if (typeof value.trackingIssue !== "number") {
    throw new CatalogProviderProfileSectionValidationError("retirementPlan.trackingIssue must be a number.");
  }
  if (value.removeAfter !== "executable-mapping-contract-activated") {
    throw new CatalogProviderProfileSectionValidationError("retirementPlan.removeAfter is not supported.");
  }
  assertRequiredString(value.diagnosticText, "retirementPlan.diagnosticText");
}

function assertMigrationEvidence(value: CatalogProviderIntegrationProfileMigrationEvidence): void {
  if (!isJsonObject(value)) {
    throw new CatalogProviderProfileSectionValidationError("migrationEvidence must be a JSON object or null.");
  }
  assertRequiredString(value.evidenceText, "migrationEvidence.evidenceText");
  assertRequiredString(value.recordedAt, "migrationEvidence.recordedAt");
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
): CatalogProviderProfileDryRunResult {
  return {
    providerKey: version.providerKey,
    profileKey: version.profileKey,
    profileVersion: version.profileVersion,
    status: "blocked",
    redactedPayload: redactJson(payload),
    observation: null,
    diagnostics,
    hashMaterial: [],
    externalReferences: {
      catalogItemReferences: [],
      productReferences: [],
    },
    selectedOptions: [],
    mergeCandidateEvidence: [],
    duplicatePreventionRules: [],
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

function isSourceObservationProfileVersion(
  version: CatalogProviderIntegrationProfileVersionRecord,
): version is SourceObservationProfileVersionRecord {
  return isSourceObservationContract(version.executableMappingContract);
}

async function assertMigrationEvidenceForActivation(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
}) {
  const versions = await input.store.listProfileVersions();
  const target = versions
    .filter(isSourceObservationProfileVersion)
    .find((version) => version.providerKey === input.providerKey && version.profileVersion === input.profileVersion);
  const active = versions
    .filter(isSourceObservationProfileVersion)
    .find((version) => version.providerKey === input.providerKey && version.active && version.lifecycle === "active");

  if (!target || !active || target.profileVersion === active.profileVersion) {
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

async function assertFixtureHarnessForActivation(input: {
  store: CatalogProviderIntegrationProfileVersionStore;
  providerKey: string;
  profileVersion: string;
  fixtureCases?: readonly CatalogProviderProfileFixtureCase[];
  repositoryRoot?: string;
  observedAt?: string;
}) {
  const target = await requireProfileVersion(input.store, input.providerKey, input.profileVersion);
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
