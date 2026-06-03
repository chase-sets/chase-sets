import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import type {
  CatalogProviderIntegrationProfileVersionDiagnostic,
  CatalogProviderIntegrationProfileVersionRecord,
} from "./provider-integration-profiles";
import { validateCatalogProviderIntegrationProfileVersion } from "./provider-integration-profiles";
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
} from "./provider-source-observation-normalizer";

type SourceObservationProfileVersionRecord = CatalogProviderIntegrationProfileVersionRecord &
  Readonly<{ executableMappingContract: CatalogProviderSourceObservationMappingContract }>;

export type CatalogProviderProfileReviewDiagnostic = Readonly<{
  code: string;
  path: string;
  diagnosticText: string;
  severity: "error" | "warning";
}>;

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
  sourceContract: CatalogProviderIntegrationProfileVersionRecord["sourceContract"];
  fixtures: CatalogProviderIntegrationProfileVersionRecord["fixtures"];
  capabilities: readonly string[];
  supportedScopes: readonly string[];
  languageOptions: readonly string[];
  mappingOutputKind: string;
  hasExecutableMappingContract: boolean;
  validation: Readonly<{
    status: "valid" | "invalid";
    diagnostics: readonly CatalogProviderProfileReviewDiagnostic[];
  }>;
}>;

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
  return versions.map(toProfileVersionReview);
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
}): Promise<CatalogProviderProfileVersionReview> {
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

function toProfileVersionReview(
  version: CatalogProviderIntegrationProfileVersionRecord,
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
    sourceContract: version.sourceContract,
    fixtures: version.fixtures,
    capabilities: version.profile.capabilities,
    supportedScopes: version.profile.supportedScopes,
    languageOptions: version.profile.languageOptions,
    mappingOutputKind: version.executableMappingContract?.normalizedObservation.outputKind ?? "unknown",
    hasExecutableMappingContract: Boolean(version.executableMappingContract),
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

  throw new Error(
    `Activating ${target.providerKey}@${target.profileVersion} changes Source Observation mapping fingerprint and requires explicit migration evidence before activation.`,
  );
}

function hasMigrationEvidence(version: CatalogProviderIntegrationProfileVersionRecord): boolean {
  const evidence = (version as { migrationEvidence?: unknown }).migrationEvidence;
  if (!isJsonObject(evidence)) {
    return false;
  }

  return typeof evidence.evidenceText === "string" && evidence.evidenceText.trim().length > 0;
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
