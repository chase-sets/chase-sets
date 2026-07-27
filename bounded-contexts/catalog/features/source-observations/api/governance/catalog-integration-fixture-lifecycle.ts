import type { JsonValue } from "@chase-sets/primitives/json";
import type { CatalogIntegrationGovernedDataClassKey } from "./catalog-integration-data-governance";
import {
  evaluateCatalogIntegrationProviderDataUse,
  redactCatalogIntegrationProviderData,
} from "./catalog-integration-data-governance";
import type { CatalogIntegrationDiagnosticBlockingBehavior } from "./catalog-integration-diagnostic-taxonomy";
import type { CatalogIntegrationUnitKey } from "./integration-unit";
import {
  catalogProviderRequiredFixtureFlows,
  type CatalogProviderProfileFixtureContract,
  type CatalogProviderProfileFixtureFlow,
} from "../providers/provider-integration-mapping-contract";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../provider-integration-profiles";
import {
  catalogProviderSourceMappingFingerprint,
  type CatalogProviderSourceObservationMappingContract,
} from "../promotion/provider-source-observation-normalizer";

export type CatalogIntegrationFixtureRepositoryRecordVersion = "catalog-fixture-repository-record-v1";

export type CatalogIntegrationFixtureProvenanceKind = "sampled-provider" | "generated" | "manual";

export type CatalogIntegrationFixturePayloadReference = Readonly<{
  kind: "repository-path" | "sample-id" | "external-evidence";
  value: string;
}>;

export type CatalogIntegrationFixturePayloadRedactionState = "not-needed" | "redacted" | "excluded";

export type CatalogIntegrationFixturePayloadPolicy = Readonly<{
  dataClass: Extract<CatalogIntegrationGovernedDataClassKey, "fixture-payload" | "sampled-provider-payload">;
  redactionState: CatalogIntegrationFixturePayloadRedactionState;
  retainsBody: boolean;
  includesProviderImagery: boolean;
  redactedPreview?: JsonValue;
}>;

export type CatalogIntegrationFixtureProvenance = Readonly<{
  sourceKind: CatalogIntegrationFixtureProvenanceKind;
  sampledAt: string | null;
  sampledByActorKind: "operator" | "system" | "job-worker" | "provider-adapter" | null;
  sourceUrl: string | null;
  sourceHash: string | null;
  sourceJobId: string | null;
  operatorUserId: string | null;
  accountId: string | null;
  policyLegalSignoff: boolean;
  retainedDataExceptionIssue: number | null;
}>;

export type CatalogIntegrationFixtureProfileCompatibility = Readonly<{
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  fixtureSetVersion: string;
  sourceMappingFingerprint: string | null;
}>;

export type CatalogIntegrationFixtureRepositoryRecord = Readonly<{
  schemaVersion: CatalogIntegrationFixtureRepositoryRecordVersion;
  fixtureId: string;
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey;
  flow: CatalogProviderProfileFixtureFlow;
  payload: CatalogIntegrationFixturePayloadReference;
  payloadPolicy: CatalogIntegrationFixturePayloadPolicy;
  provenance: CatalogIntegrationFixtureProvenance;
  compatibility: CatalogIntegrationFixtureProfileCompatibility;
  validationStatus: "candidate" | "valid" | "invalid" | "deprecated";
}>;

export type CatalogIntegrationFixtureCoverageRequirement = Readonly<{
  flow: CatalogProviderProfileFixtureFlow;
  required: true;
  minimumFixtureCount: 1;
  acceptedProvenance: readonly CatalogIntegrationFixtureProvenanceKind[];
}>;

export type CatalogIntegrationFixtureLifecycleDiagnosticCode =
  | "fixture-missing-flow"
  | "fixture-live-provider-calls"
  | "fixture-provider-key-mismatch"
  | "fixture-profile-version-mismatch"
  | "fixture-payload-reference-missing"
  | "fixture-governance-signoff-required"
  | "fixture-retained-data-exception-required"
  | "fixture-raw-body-forbidden"
  | "fixture-provider-content-export-forbidden";

export type CatalogIntegrationFixtureLifecycleDiagnostic = Readonly<{
  code: CatalogIntegrationFixtureLifecycleDiagnosticCode;
  severity: "error" | "warning";
  blockingBehavior: CatalogIntegrationDiagnosticBlockingBehavior;
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey | null;
  profileVersion: string;
  flow: CatalogProviderProfileFixtureFlow | null;
  path: string;
  diagnosticText: string;
}>;

export type CatalogIntegrationFixtureValidationInput = Readonly<{
  fixtureId: string;
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey;
  profileVersion: string;
  flow: CatalogProviderProfileFixtureFlow;
  payload: CatalogIntegrationFixturePayloadReference;
}>;

export type CatalogIntegrationFixtureCoverageEvaluation = Readonly<{
  status: "sufficient" | "blocked";
  requiredFlows: readonly CatalogProviderProfileFixtureFlow[];
  coveredFlows: readonly CatalogProviderProfileFixtureFlow[];
  validationInputs: readonly CatalogIntegrationFixtureValidationInput[];
  diagnostics: readonly CatalogIntegrationFixtureLifecycleDiagnostic[];
}>;

export type CatalogIntegrationFixtureCaseReference = Readonly<{
  providerKey: string;
  profileVersion: string;
  flow: CatalogProviderProfileFixtureFlow;
  payloadFile: string;
  expectedStatus?: string;
}>;

export function catalogIntegrationFixtureCoverageRequirements(
  flows: readonly CatalogProviderProfileFixtureFlow[] = catalogProviderRequiredFixtureFlows,
): readonly CatalogIntegrationFixtureCoverageRequirement[] {
  return flows.map((flow) => ({
    flow,
    required: true,
    minimumFixtureCount: 1,
    acceptedProvenance: ["generated", "manual", "sampled-provider"],
  }));
}

export function buildCatalogIntegrationFixtureRepositoryRecords(input: {
  version: CatalogProviderIntegrationProfileVersionRecord;
  unitKey: CatalogIntegrationUnitKey;
  fixtureCases: readonly CatalogIntegrationFixtureCaseReference[];
  provenance?: Partial<CatalogIntegrationFixtureProvenance>;
  retainedBody?: boolean;
  includesProviderImagery?: boolean;
  payloadPreviewByFlow?: Partial<Record<CatalogProviderProfileFixtureFlow, JsonValue>>;
}): readonly CatalogIntegrationFixtureRepositoryRecord[] {
  const providerKey = normalizeProviderKey(input.version.providerKey);
  return input.fixtureCases
    .filter(
      (fixtureCase) =>
        normalizeProviderKey(fixtureCase.providerKey) === providerKey &&
        fixtureCase.profileVersion === input.version.profileVersion,
    )
    .map((fixtureCase) =>
      createCatalogIntegrationFixtureRepositoryRecord({
        providerKey,
        unitKey: input.unitKey,
        profileKey: input.version.profileKey,
        profileVersion: input.version.profileVersion,
        fixtureSetVersion: input.version.sourceContract.fixtureSetVersion,
        sourceMappingFingerprint: sourceMappingFingerprint(input.version),
        flow: fixtureCase.flow,
        payload: {
          kind: "repository-path",
          value: `${input.version.fixtures.fixtureRoot}/${fixtureCase.payloadFile}`,
        },
        provenance: input.provenance,
        retainedBody: input.retainedBody ?? false,
        includesProviderImagery: input.includesProviderImagery ?? false,
        payloadPreview: input.payloadPreviewByFlow?.[fixtureCase.flow],
      }),
    );
}

export function createCatalogIntegrationFixtureRepositoryRecord(input: {
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey;
  profileKey: string;
  profileVersion: string;
  fixtureSetVersion: string;
  sourceMappingFingerprint?: string | null;
  flow: CatalogProviderProfileFixtureFlow;
  payload: CatalogIntegrationFixturePayloadReference;
  provenance?: Partial<CatalogIntegrationFixtureProvenance>;
  retainedBody?: boolean;
  includesProviderImagery?: boolean;
  payloadPreview?: JsonValue;
  validationStatus?: CatalogIntegrationFixtureRepositoryRecord["validationStatus"];
}): CatalogIntegrationFixtureRepositoryRecord {
  const provenance = normalizeProvenance(input.provenance);
  const dataClass: CatalogIntegrationFixturePayloadPolicy["dataClass"] =
    provenance.sourceKind === "sampled-provider" ? "sampled-provider-payload" : "fixture-payload";
  const redactedPreview =
    input.payloadPreview === undefined ? undefined : redactCatalogIntegrationProviderData(input.payloadPreview);
  const redactionState =
    input.payloadPreview === undefined
      ? "excluded"
      : JSON.stringify(input.payloadPreview) === JSON.stringify(redactedPreview)
        ? "not-needed"
        : "redacted";

  return {
    schemaVersion: "catalog-fixture-repository-record-v1",
    fixtureId: [
      normalizeRequired(input.providerKey, "providerKey"),
      normalizeRequired(input.profileVersion, "profileVersion"),
      input.flow,
    ].join(":"),
    providerKey: normalizeProviderKey(input.providerKey),
    unitKey: input.unitKey,
    flow: input.flow,
    payload: input.payload,
    payloadPolicy: {
      dataClass,
      redactionState,
      retainsBody: input.retainedBody ?? false,
      includesProviderImagery: input.includesProviderImagery ?? false,
      ...(redactedPreview === undefined ? {} : { redactedPreview }),
    },
    provenance,
    compatibility: {
      providerKey: normalizeProviderKey(input.providerKey),
      profileKey: normalizeRequired(input.profileKey, "profileKey"),
      profileVersion: normalizeRequired(input.profileVersion, "profileVersion"),
      fixtureSetVersion: normalizeRequired(input.fixtureSetVersion, "fixtureSetVersion"),
      sourceMappingFingerprint: normalizeOptional(input.sourceMappingFingerprint),
    },
    validationStatus: input.validationStatus ?? "candidate",
  };
}

export function evaluateCatalogIntegrationFixtureCoverage(input: {
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  unitKey: CatalogIntegrationUnitKey;
  fixtureContract: CatalogProviderProfileFixtureContract;
  records?: readonly CatalogIntegrationFixtureRepositoryRecord[];
  requiredFlows?: readonly CatalogProviderProfileFixtureFlow[];
}): CatalogIntegrationFixtureCoverageEvaluation {
  const providerKey = normalizeProviderKey(input.providerKey);
  const requiredFlows = input.requiredFlows ?? catalogProviderRequiredFixtureFlows;
  const contractDiagnostics = evaluateFixtureContract({
    providerKey,
    profileVersion: input.profileVersion,
    unitKey: input.unitKey,
    fixtureContract: input.fixtureContract,
    requiredFlows,
  });

  const records = input.records ?? [];
  const recordDiagnostics = records.flatMap((record) =>
    evaluateFixtureRecord({
      record,
      providerKey,
      profileKey: input.profileKey,
      profileVersion: input.profileVersion,
      unitKey: input.unitKey,
    }),
  );

  const validationInputs = records
    .filter(
      (record) =>
        record.providerKey === providerKey &&
        record.unitKey === input.unitKey &&
        record.compatibility.profileKey === input.profileKey &&
        record.compatibility.profileVersion === input.profileVersion &&
        requiredFlows.includes(record.flow),
    )
    .sort((left, right) => requiredFlows.indexOf(left.flow) - requiredFlows.indexOf(right.flow))
    .map((record) => validationInput(record));

  const coveredFlows = uniqueFlows([
    ...input.fixtureContract.coveredFlows.filter((flow) => requiredFlows.includes(flow)),
    ...validationInputs.map((validationInput) => validationInput.flow),
  ]);
  const diagnostics = [...contractDiagnostics, ...recordDiagnostics];

  return {
    status: diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "blocked" : "sufficient",
    requiredFlows,
    coveredFlows,
    validationInputs,
    diagnostics,
  };
}

export function evaluateCatalogIntegrationFixtureCoverageFromProfileVersion(input: {
  version: CatalogProviderIntegrationProfileVersionRecord;
  unitKey?: CatalogIntegrationUnitKey | null;
  requiredFlows?: readonly CatalogProviderProfileFixtureFlow[];
}): readonly CatalogIntegrationFixtureLifecycleDiagnostic[] {
  return evaluateFixtureContract({
    providerKey: input.version.providerKey,
    profileVersion: input.version.profileVersion,
    unitKey: input.unitKey ?? null,
    fixtureContract: input.version.fixtures,
    requiredFlows: input.requiredFlows ?? catalogProviderRequiredFixtureFlows,
  });
}

export function buildCatalogIntegrationFixtureValidationInputs(input: {
  records: readonly CatalogIntegrationFixtureRepositoryRecord[];
  providerKey: string;
  profileVersion: string;
  unitKey: CatalogIntegrationUnitKey;
  requiredFlows?: readonly CatalogProviderProfileFixtureFlow[];
}): readonly CatalogIntegrationFixtureValidationInput[] {
  const requiredFlows = input.requiredFlows ?? catalogProviderRequiredFixtureFlows;
  return input.records
    .filter(
      (record) =>
        record.providerKey === normalizeProviderKey(input.providerKey) &&
        record.compatibility.profileVersion === input.profileVersion &&
        record.unitKey === input.unitKey &&
        requiredFlows.includes(record.flow),
    )
    .sort((left, right) => requiredFlows.indexOf(left.flow) - requiredFlows.indexOf(right.flow))
    .map(validationInput);
}

function evaluateFixtureContract(input: {
  providerKey: string;
  profileVersion: string;
  unitKey: CatalogIntegrationUnitKey | null;
  fixtureContract: CatalogProviderProfileFixtureContract;
  requiredFlows: readonly CatalogProviderProfileFixtureFlow[];
}): readonly CatalogIntegrationFixtureLifecycleDiagnostic[] {
  const diagnostics: CatalogIntegrationFixtureLifecycleDiagnostic[] = [];

  if (input.fixtureContract.liveProviderCallsAllowed) {
    diagnostics.push(
      diagnostic({
        code: "fixture-live-provider-calls",
        providerKey: input.providerKey,
        unitKey: input.unitKey,
        profileVersion: input.profileVersion,
        flow: null,
        path: "fixtures.liveProviderCallsAllowed",
        diagnosticText: "Fixture validation must not require live provider calls.",
      }),
    );
  }

  for (const flow of input.requiredFlows) {
    if (!input.fixtureContract.coveredFlows.includes(flow)) {
      diagnostics.push(
        diagnostic({
          code: "fixture-missing-flow",
          providerKey: input.providerKey,
          unitKey: input.unitKey,
          profileVersion: input.profileVersion,
          flow,
          path: `fixtures.coveredFlows.${flow}`,
          diagnosticText: `Provider profile fixtures must cover the ${flow} flow before activation.`,
        }),
      );
    }
  }

  return diagnostics;
}

function evaluateFixtureRecord(input: {
  record: CatalogIntegrationFixtureRepositoryRecord;
  providerKey: string;
  profileKey: string;
  profileVersion: string;
  unitKey: CatalogIntegrationUnitKey;
}): readonly CatalogIntegrationFixtureLifecycleDiagnostic[] {
  const diagnostics: CatalogIntegrationFixtureLifecycleDiagnostic[] = [];
  const record = input.record;

  if (record.providerKey !== input.providerKey || record.compatibility.providerKey !== input.providerKey) {
    diagnostics.push(
      diagnostic({
        code: "fixture-provider-key-mismatch",
        providerKey: input.providerKey,
        unitKey: input.unitKey,
        profileVersion: input.profileVersion,
        flow: record.flow,
        path: `${record.fixtureId}.providerKey`,
        diagnosticText: "Fixture provider key must match the profile version provider key.",
      }),
    );
  }

  if (
    record.compatibility.profileKey !== input.profileKey ||
    record.compatibility.profileVersion !== input.profileVersion
  ) {
    diagnostics.push(
      diagnostic({
        code: "fixture-profile-version-mismatch",
        providerKey: input.providerKey,
        unitKey: input.unitKey,
        profileVersion: input.profileVersion,
        flow: record.flow,
        path: `${record.fixtureId}.compatibility`,
        diagnosticText: "Fixture compatibility must match the selected profile version.",
      }),
    );
  }

  if (record.payload.value.trim().length === 0) {
    diagnostics.push(
      diagnostic({
        code: "fixture-payload-reference-missing",
        providerKey: input.providerKey,
        unitKey: input.unitKey,
        profileVersion: input.profileVersion,
        flow: record.flow,
        path: `${record.fixtureId}.payload.value`,
        diagnosticText: "Fixture validation input must reference a deterministic payload.",
      }),
    );
  }

  diagnostics.push(...governanceDiagnostics(record));
  return diagnostics;
}

function governanceDiagnostics(
  record: CatalogIntegrationFixtureRepositoryRecord,
): readonly CatalogIntegrationFixtureLifecycleDiagnostic[] {
  return evaluateCatalogIntegrationProviderDataUse({
    dataClass: record.payloadPolicy.dataClass,
    providerKey: record.providerKey,
    retainsRealProviderSample: record.provenance.sourceKind === "sampled-provider" && record.payloadPolicy.retainsBody,
    retainsFixtureBody: record.payloadPolicy.dataClass === "fixture-payload" && record.payloadPolicy.retainsBody,
    includesProviderImagery: record.payloadPolicy.includesProviderImagery,
    hasPolicyLegalSignoff: record.provenance.policyLegalSignoff,
    retainedDataExceptionIssue: record.provenance.retainedDataExceptionIssue,
  }).map((finding) =>
    diagnostic({
      code: governanceFindingCode(finding.code),
      providerKey: record.providerKey,
      unitKey: record.unitKey,
      profileVersion: record.compatibility.profileVersion,
      flow: record.flow,
      path: `${record.fixtureId}.payloadPolicy`,
      diagnosticText: finding.message,
    }),
  );
}

function governanceFindingCode(
  code: ReturnType<typeof evaluateCatalogIntegrationProviderDataUse>[number]["code"],
): CatalogIntegrationFixtureLifecycleDiagnosticCode {
  switch (code) {
    case "provider-data-signoff-required":
      return "fixture-governance-signoff-required";
    case "retained-data-exception-required":
      return "fixture-retained-data-exception-required";
    case "raw-body-storage-forbidden":
      return "fixture-raw-body-forbidden";
    case "provider-content-export-forbidden":
    case "raw-admin-display-forbidden":
      return "fixture-provider-content-export-forbidden";
  }
}

function validationInput(record: CatalogIntegrationFixtureRepositoryRecord): CatalogIntegrationFixtureValidationInput {
  return {
    fixtureId: record.fixtureId,
    providerKey: record.providerKey,
    unitKey: record.unitKey,
    profileVersion: record.compatibility.profileVersion,
    flow: record.flow,
    payload: record.payload,
  };
}

function diagnostic(input: {
  code: CatalogIntegrationFixtureLifecycleDiagnosticCode;
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey | null;
  profileVersion: string;
  flow: CatalogProviderProfileFixtureFlow | null;
  path: string;
  diagnosticText: string;
}): CatalogIntegrationFixtureLifecycleDiagnostic {
  return {
    ...input,
    providerKey: normalizeProviderKey(input.providerKey),
    severity: "error",
    blockingBehavior: "activation-blocking",
  };
}

function normalizeProvenance(
  provenance: Partial<CatalogIntegrationFixtureProvenance> | undefined,
): CatalogIntegrationFixtureProvenance {
  return {
    sourceKind: provenance?.sourceKind ?? "generated",
    sampledAt: normalizeOptional(provenance?.sampledAt),
    sampledByActorKind: provenance?.sampledByActorKind ?? null,
    sourceUrl: normalizeOptional(provenance?.sourceUrl),
    sourceHash: normalizeOptional(provenance?.sourceHash),
    sourceJobId: normalizeOptional(provenance?.sourceJobId),
    operatorUserId: normalizeOptional(provenance?.operatorUserId),
    accountId: normalizeOptional(provenance?.accountId),
    policyLegalSignoff: provenance?.policyLegalSignoff ?? false,
    retainedDataExceptionIssue: provenance?.retainedDataExceptionIssue ?? null,
  };
}

function uniqueFlows(
  flows: readonly CatalogProviderProfileFixtureFlow[],
): readonly CatalogProviderProfileFixtureFlow[] {
  return catalogProviderRequiredFixtureFlows.filter((flow) => flows.includes(flow));
}

function sourceMappingFingerprint(version: CatalogProviderIntegrationProfileVersionRecord): string | null {
  return isSourceObservationContract(version.executableMappingContract)
    ? catalogProviderSourceMappingFingerprint(version.executableMappingContract)
    : null;
}

function isSourceObservationContract(
  contract: CatalogProviderIntegrationProfileVersionRecord["executableMappingContract"],
): contract is CatalogProviderSourceObservationMappingContract {
  return Boolean(contract && "sourceObservation" in contract);
}

function normalizeProviderKey(providerKey: string): string {
  return normalizeRequired(providerKey, "providerKey").toLowerCase();
}

function normalizeRequired(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(`Catalog fixture lifecycle ${field} is required.`);
  }
  return normalized;
}

function normalizeOptional(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : null;
}
