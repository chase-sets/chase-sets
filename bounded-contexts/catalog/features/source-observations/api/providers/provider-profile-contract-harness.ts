import { readFile } from "node:fs/promises";
import path from "node:path";
import type { JsonObject, JsonValue } from "@chase-sets/primitives/json";
import {
  catalogProviderRequiredFixtureFlows,
  validateCatalogProviderExecutableMappingContract,
  type CatalogProviderProfileFixtureFlow,
} from "./provider-integration-mapping-contract";
import type { CatalogProviderIntegrationProfileVersionRecord } from "../provider-integration-profiles";
import {
  dryRunCatalogProviderProfileVersion,
  type CatalogProviderProfileDryRunEvidence,
  type CatalogProviderProfileDryRunResult,
} from "./provider-profile-review";
import type { CatalogProviderIntegrationProfileVersionStore } from "./provider-integration-profile-store";

export type CatalogProviderProfileFixtureCase = Readonly<{
  providerKey: string;
  profileKey?: string | null;
  ingestionUnitKey?: string | null;
  profileVersion: string;
  flow: CatalogProviderProfileFixtureFlow;
  payloadFile: string;
  expectedStatus: CatalogProviderProfileDryRunResult["status"];
  expectedDiagnosticPaths?: readonly string[];
  expectedObservation?: Readonly<{
    externalKey?: string;
    normalizedKind?: string;
    normalizedFields?: Readonly<Record<string, JsonValue>>;
    externalCatalogItemReferences?: readonly Readonly<{ providerKey: string; externalKey: string }>[];
    externalProductReferences?: readonly Readonly<{
      providerKey: string;
      externalKey: string;
      selectedOptions?: readonly Readonly<{ dimensionKey: string; optionKey: string | null; providerValue: string }>[];
    }>[];
  }>;
  expectedHashEvidencePaths?: readonly string[];
  expectedMergeEvidencePaths?: readonly string[];
  expectedPromotionCommands?: readonly string[];
  forbiddenPromotionCommands?: readonly string[];
  expectedPromotionInputPaths?: readonly string[];
  expectedDuplicatePrevention?: Readonly<{
    ambiguousCandidatePolicy?: string;
    replayPolicy?: string;
    exactExternalCatalogItemReferencesFirst?: boolean;
    rulePolicies?: readonly Readonly<{ ruleKey: string; candidatePolicy: string }>[];
  }>;
}>;

export type CatalogProviderProfileFixtureHarnessFailure = Readonly<{
  providerKey: string;
  profileVersion: string;
  flow: CatalogProviderProfileFixtureFlow | "profile";
  path: string;
  diagnosticText: string;
}>;

export type CatalogProviderProfileFixtureHarnessResult = Readonly<{
  providerKey: string;
  profileVersion: string;
  failures: readonly CatalogProviderProfileFixtureHarnessFailure[];
}>;

export async function validateCatalogProviderProfileFixtures(input: {
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[];
  fixtureCases: readonly CatalogProviderProfileFixtureCase[];
  repositoryRoot: string;
  observedAt?: string;
}): Promise<readonly CatalogProviderProfileFixtureHarnessResult[]> {
  const results: CatalogProviderProfileFixtureHarnessResult[] = [];

  for (const version of input.versions.filter((candidate) => candidate.executableMappingContract)) {
    const failures: CatalogProviderProfileFixtureHarnessFailure[] = [];
    const contract = version.executableMappingContract;
    if (!contract) {
      continue;
    }

    for (const diagnostic of validateCatalogProviderExecutableMappingContract(contract)) {
      failures.push(profileFailure(version, `executableMappingContract.${diagnostic.path}`, diagnostic.diagnosticText));
    }

    if (version.fixtures.liveProviderCallsAllowed) {
      failures.push(
        profileFailure(version, "fixtures.liveProviderCallsAllowed", "Fixture harness forbids live provider calls."),
      );
    }

    const cases = input.fixtureCases.filter((fixtureCase) => fixtureCaseMatchesVersion(fixtureCase, version));
    const caseFlows = new Set(cases.map((fixtureCase) => fixtureCase.flow));

    for (const flow of catalogProviderRequiredFixtureFlows) {
      if (!caseFlows.has(flow)) {
        failures.push(profileFailure(version, `fixtures.coveredFlows.${flow}`, `Missing fixture case for ${flow}.`));
      }
    }

    for (const fixtureCase of cases) {
      failures.push(
        ...(await validateFixtureCase({
          version,
          fixtureCase,
          store: profileStore(input.versions),
          repositoryRoot: input.repositoryRoot,
          observedAt: input.observedAt ?? "2026-06-03T00:00:00.000Z",
        })),
      );
    }

    results.push({
      providerKey: version.providerKey,
      profileVersion: version.profileVersion,
      failures,
    });
  }

  return results;
}

export function formatCatalogProviderProfileFixtureFailures(
  results: readonly CatalogProviderProfileFixtureHarnessResult[],
): string {
  return results
    .flatMap((result) => result.failures)
    .map(
      (failure) =>
        `${failure.providerKey}@${failure.profileVersion} ${failure.flow} ${failure.path}: ${failure.diagnosticText}`,
    )
    .join("\n");
}

async function validateFixtureCase(input: {
  version: CatalogProviderIntegrationProfileVersionRecord;
  fixtureCase: CatalogProviderProfileFixtureCase;
  store: CatalogProviderIntegrationProfileVersionStore;
  repositoryRoot: string;
  observedAt: string;
}): Promise<readonly CatalogProviderProfileFixtureHarnessFailure[]> {
  const failures: CatalogProviderProfileFixtureHarnessFailure[] = [];
  const payloadPath = path.join(
    input.repositoryRoot,
    input.version.fixtures.fixtureRoot,
    input.fixtureCase.payloadFile,
  );
  const payload = JSON.parse(await readFile(payloadPath, "utf8")) as JsonValue;

  failures.push(...secretFailures(input.version, input.fixtureCase, payload));

  const result = await dryRunCatalogProviderProfileVersion({
    store: input.store,
    providerKey: input.fixtureCase.providerKey,
    profileVersion: input.fixtureCase.profileVersion,
    profileKey: input.fixtureCase.profileKey,
    ingestionUnitKey: input.fixtureCase.ingestionUnitKey,
    payload,
    observedAt: input.observedAt,
  });

  if (result.status !== input.fixtureCase.expectedStatus) {
    failures.push(
      caseFailure(
        input.version,
        input.fixtureCase,
        "status",
        `Expected ${input.fixtureCase.expectedStatus} but got ${result.status}.`,
      ),
    );
  }

  failures.push(...diagnosticFailures(input.version, input.fixtureCase, result));
  failures.push(...observationFailures(input.version, input.fixtureCase, result));
  failures.push(...evidencePathFailures(input.version, input.fixtureCase, "hashMaterial", result.hashMaterial));
  failures.push(
    ...evidencePathFailures(input.version, input.fixtureCase, "mergeCandidateEvidence", result.mergeCandidateEvidence),
  );
  failures.push(...duplicatePreventionFailures(input.version, input.fixtureCase, result));
  failures.push(...promotionCommandFailures(input.version, input.fixtureCase, result));

  return failures;
}

function diagnosticFailures(
  version: CatalogProviderIntegrationProfileVersionRecord,
  fixtureCase: CatalogProviderProfileFixtureCase,
  result: CatalogProviderProfileDryRunResult,
): readonly CatalogProviderProfileFixtureHarnessFailure[] {
  const failures: CatalogProviderProfileFixtureHarnessFailure[] = [];
  const expectedPaths = new Set(fixtureCase.expectedDiagnosticPaths ?? []);
  const actualPaths = new Set(result.diagnostics.map((diagnostic) => diagnostic.path));

  for (const path of expectedPaths) {
    if (!actualPaths.has(path)) {
      failures.push(caseFailure(version, fixtureCase, path, "Expected diagnostic path was not reported."));
    }
  }

  const unexpectedDiagnostics = result.diagnostics.filter((diagnostic) => !expectedPaths.has(diagnostic.path));
  for (const diagnostic of unexpectedDiagnostics) {
    failures.push(caseFailure(version, fixtureCase, diagnostic.path, diagnostic.diagnosticText));
  }

  return failures;
}

function observationFailures(
  version: CatalogProviderIntegrationProfileVersionRecord,
  fixtureCase: CatalogProviderProfileFixtureCase,
  result: CatalogProviderProfileDryRunResult,
): readonly CatalogProviderProfileFixtureHarnessFailure[] {
  const expected = fixtureCase.expectedObservation;
  if (!expected) {
    return [];
  }
  if (!result.observation) {
    return [caseFailure(version, fixtureCase, "observation", "Expected an observation but normalization was blocked.")];
  }

  const failures: CatalogProviderProfileFixtureHarnessFailure[] = [];
  if (expected.externalKey && result.observation.externalKey !== expected.externalKey) {
    failures.push(
      caseFailure(version, fixtureCase, "sourceObservation.externalKey", `Expected ${expected.externalKey}.`),
    );
  }
  if (expected.normalizedKind && result.observation.normalized.kind !== expected.normalizedKind) {
    failures.push(caseFailure(version, fixtureCase, "normalized.kind", `Expected ${expected.normalizedKind}.`));
  }

  for (const [fieldPath, expectedValue] of Object.entries(expected.normalizedFields ?? {})) {
    const actual = readPath(result.observation.normalized as JsonObject, fieldPath);
    if (JSON.stringify(actual) !== JSON.stringify(expectedValue)) {
      failures.push(
        caseFailure(
          version,
          fixtureCase,
          `normalized.${fieldPath}`,
          `Expected ${JSON.stringify(expectedValue)} but got ${JSON.stringify(actual)}.`,
        ),
      );
    }
  }

  const catalogReferences = result.observation.normalized.externalCatalogItemReferences ?? [];
  for (const expectedReference of expected.externalCatalogItemReferences ?? []) {
    if (
      !catalogReferences.some(
        (reference) =>
          reference.providerKey === expectedReference.providerKey &&
          reference.externalKey === expectedReference.externalKey,
      )
    ) {
      failures.push(
        caseFailure(
          version,
          fixtureCase,
          "normalized.externalCatalogItemReferences",
          `Missing ${expectedReference.providerKey}:${expectedReference.externalKey}.`,
        ),
      );
    }
  }

  const productReferences = result.observation.normalized.externalProductReferences ?? [];
  for (const expectedReference of expected.externalProductReferences ?? []) {
    const actualReference = productReferences.find(
      (reference) =>
        reference.providerKey === expectedReference.providerKey &&
        reference.externalKey === expectedReference.externalKey,
    );
    if (!actualReference) {
      failures.push(
        caseFailure(
          version,
          fixtureCase,
          "normalized.externalProductReferences",
          `Missing ${expectedReference.providerKey}:${expectedReference.externalKey}.`,
        ),
      );
      continue;
    }
    for (const selectedOption of expectedReference.selectedOptions ?? []) {
      if (
        !(actualReference.selectedOptions ?? []).some(
          (actualOption) =>
            selectedOptionValue(actualOption, "dimensionKey", "dimensionId") === selectedOption.dimensionKey &&
            selectedOptionValue(actualOption, "optionKey", "optionId") === selectedOption.optionKey &&
            selectedOptionValue(actualOption, "providerValue") === selectedOption.providerValue,
        )
      ) {
        failures.push(
          caseFailure(
            version,
            fixtureCase,
            `normalized.externalProductReferences.${expectedReference.externalKey}.selectedOptions`,
            `Missing ${selectedOption.dimensionKey}:${selectedOption.providerValue}.`,
          ),
        );
      }
    }
  }

  return failures;
}

function selectedOptionValue(option: unknown, primaryKey: string, fallbackKey?: string): string | null | undefined {
  if (!isJsonObject(option)) {
    return undefined;
  }

  const value = primaryKey in option ? option[primaryKey] : fallbackKey ? option[fallbackKey] : undefined;
  return typeof value === "string" || value === null ? value : undefined;
}

function evidencePathFailures(
  version: CatalogProviderIntegrationProfileVersionRecord,
  fixtureCase: CatalogProviderProfileFixtureCase,
  evidenceKind: "hashMaterial" | "mergeCandidateEvidence",
  actualEvidence: readonly CatalogProviderProfileDryRunEvidence[],
): readonly CatalogProviderProfileFixtureHarnessFailure[] {
  const expectedPaths =
    evidenceKind === "hashMaterial" ? fixtureCase.expectedHashEvidencePaths : fixtureCase.expectedMergeEvidencePaths;
  if (!expectedPaths) {
    return [];
  }

  const actualPaths = new Set(actualEvidence.map((evidence) => evidence.path));
  return expectedPaths
    .filter((path) => !actualPaths.has(path))
    .map((path) => caseFailure(version, fixtureCase, path, `Missing ${evidenceKind} evidence.`));
}

function promotionCommandFailures(
  version: CatalogProviderIntegrationProfileVersionRecord,
  fixtureCase: CatalogProviderProfileFixtureCase,
  result: CatalogProviderProfileDryRunResult,
): readonly CatalogProviderProfileFixtureHarnessFailure[] {
  const failures: CatalogProviderProfileFixtureHarnessFailure[] = [];
  const actualCommands = result.promotionCommandPlan.commands.map((command) => command.commandName);

  for (const commandName of fixtureCase.expectedPromotionCommands ?? []) {
    if (!actualCommands.includes(commandName)) {
      failures.push(caseFailure(version, fixtureCase, "promotionCommandPlan.commands", `Missing ${commandName}.`));
    }
  }

  for (const commandName of fixtureCase.forbiddenPromotionCommands ?? []) {
    if (actualCommands.includes(commandName)) {
      failures.push(
        caseFailure(version, fixtureCase, "promotionCommandPlan.commands", `Forbidden ${commandName} was planned.`),
      );
    }
  }

  const actualInputPaths = new Set(
    result.promotionCommandPlan.commands.flatMap((command) => command.inputs.map((input) => input.path)),
  );
  for (const inputPath of fixtureCase.expectedPromotionInputPaths ?? []) {
    if (!actualInputPaths.has(inputPath)) {
      failures.push(caseFailure(version, fixtureCase, inputPath, "Missing promotion command input evidence."));
    }
  }

  return failures;
}

function duplicatePreventionFailures(
  version: CatalogProviderIntegrationProfileVersionRecord,
  fixtureCase: CatalogProviderProfileFixtureCase,
  result: CatalogProviderProfileDryRunResult,
): readonly CatalogProviderProfileFixtureHarnessFailure[] {
  const expected = fixtureCase.expectedDuplicatePrevention;
  if (!expected) {
    return [];
  }

  const failures: CatalogProviderProfileFixtureHarnessFailure[] = [];
  if (
    expected.ambiguousCandidatePolicy &&
    result.duplicatePreventionPolicy.ambiguousCandidatePolicy !== expected.ambiguousCandidatePolicy
  ) {
    failures.push(
      caseFailure(
        version,
        fixtureCase,
        "duplicatePrevention.ambiguousCandidatePolicy",
        `Expected ${expected.ambiguousCandidatePolicy}.`,
      ),
    );
  }
  if (expected.replayPolicy && result.duplicatePreventionPolicy.replayPolicy !== expected.replayPolicy) {
    failures.push(
      caseFailure(version, fixtureCase, "duplicatePrevention.replayPolicy", `Expected ${expected.replayPolicy}.`),
    );
  }
  if (
    expected.exactExternalCatalogItemReferencesFirst !== undefined &&
    result.duplicatePreventionPolicy.exactExternalCatalogItemReferencesFirst !==
      expected.exactExternalCatalogItemReferencesFirst
  ) {
    failures.push(
      caseFailure(
        version,
        fixtureCase,
        "duplicatePrevention.exactExternalCatalogItemReferencesFirst",
        `Expected ${expected.exactExternalCatalogItemReferencesFirst}.`,
      ),
    );
  }

  for (const rulePolicy of expected.rulePolicies ?? []) {
    const actual = result.duplicatePreventionRules.find((rule) => rule.ruleKey === rulePolicy.ruleKey);
    if (!actual) {
      failures.push(
        caseFailure(version, fixtureCase, "duplicatePrevention.identityRules", `Missing ${rulePolicy.ruleKey}.`),
      );
      continue;
    }
    if (actual.candidatePolicy !== rulePolicy.candidatePolicy) {
      failures.push(
        caseFailure(
          version,
          fixtureCase,
          `duplicatePrevention.identityRules.${rulePolicy.ruleKey}.candidatePolicy`,
          `Expected ${rulePolicy.candidatePolicy}.`,
        ),
      );
    }
  }

  return failures;
}

function secretFailures(
  version: CatalogProviderIntegrationProfileVersionRecord,
  fixtureCase: CatalogProviderProfileFixtureCase,
  payload: JsonValue,
): readonly CatalogProviderProfileFixtureHarnessFailure[] {
  return scanSensitivePayloadPaths(payload)
    .filter((sensitivePath) => !allowedBoundaryEvidencePath(sensitivePath))
    .map((sensitivePath) =>
      caseFailure(
        version,
        fixtureCase,
        sensitivePath,
        "Fixture payload includes secret, seller, price, or inventory evidence.",
      ),
    );
}

function scanSensitivePayloadPaths(value: JsonValue, path = "payload"): readonly string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => scanSensitivePayloadPaths(entry, `${path}.${index}`));
  }
  if (!isJsonObject(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, entry]) => {
    const entryPath = `${path}.${key}`;
    const matches = /cookie|auth|secret|token|password|seller/i.test(key) || /price|inventory/i.test(key);
    return [matches ? entryPath : null, ...scanSensitivePayloadPaths(entry, entryPath)].filter(
      (candidate): candidate is string => Boolean(candidate),
    );
  });
}

function allowedBoundaryEvidencePath(path: string): boolean {
  return /sourcePayload\.excludedEvidence\.(price|inventory|seller)/.test(path);
}

function profileFailure(
  version: CatalogProviderIntegrationProfileVersionRecord,
  path: string,
  diagnosticText: string,
): CatalogProviderProfileFixtureHarnessFailure {
  return {
    providerKey: version.providerKey,
    profileVersion: version.profileVersion,
    flow: "profile",
    path,
    diagnosticText,
  };
}

function caseFailure(
  version: CatalogProviderIntegrationProfileVersionRecord,
  fixtureCase: CatalogProviderProfileFixtureCase,
  path: string,
  diagnosticText: string,
): CatalogProviderProfileFixtureHarnessFailure {
  return {
    providerKey: version.providerKey,
    profileVersion: version.profileVersion,
    flow: fixtureCase.flow,
    path,
    diagnosticText,
  };
}

function profileStore(
  versions: readonly CatalogProviderIntegrationProfileVersionRecord[],
): CatalogProviderIntegrationProfileVersionStore {
  return {
    seedProfileVersions: async () => versions,
    upsertProfileVersion: async (version) => version,
    listProfileVersions: async (providerKey) =>
      versions.filter(
        (version) => !providerKey || normalizeProviderKey(version.providerKey) === normalizeProviderKey(providerKey),
      ),
    getProfileVersion: async (providerKey, profileVersion, selector) =>
      versions.find(
        (version) =>
          normalizeProviderKey(version.providerKey) === normalizeProviderKey(providerKey) &&
          version.profileVersion === profileVersion &&
          selectorMatchesVersion(selector, version),
      ) ?? null,
    getActiveProfileVersion: async (providerKey, selector) =>
      versions.find(
        (version) =>
          normalizeProviderKey(version.providerKey) === normalizeProviderKey(providerKey) &&
          version.active &&
          selectorMatchesVersion(selector, version),
      ) ?? null,
    activateProfileVersion: async (providerKey, profileVersion) => {
      const version = versions.find(
        (candidate) =>
          normalizeProviderKey(candidate.providerKey) === normalizeProviderKey(providerKey) &&
          candidate.profileVersion === profileVersion,
      );
      if (!version) {
        throw new Error(`Profile version ${providerKey}@${profileVersion} not found.`);
      }
      return { ...version, lifecycle: "active", active: true };
    },
    deprecateProfileVersion: async (providerKey, profileVersion) => {
      const version = versions.find(
        (candidate) =>
          normalizeProviderKey(candidate.providerKey) === normalizeProviderKey(providerKey) &&
          candidate.profileVersion === profileVersion,
      );
      if (!version) {
        throw new Error(`Profile version ${providerKey}@${profileVersion} not found.`);
      }
      return { ...version, lifecycle: "deprecated", active: false };
    },
    rollbackProfileVersion: async (providerKey, profileVersion) => {
      const version = versions.find(
        (candidate) =>
          normalizeProviderKey(candidate.providerKey) === normalizeProviderKey(providerKey) &&
          candidate.profileVersion === profileVersion,
      );
      if (!version) {
        throw new Error(`Profile version ${providerKey}@${profileVersion} not found.`);
      }
      return { ...version, lifecycle: "active", active: true };
    },
    countProfileVersionReferences: async () => 0,
  };
}

function fixtureCaseMatchesVersion(
  fixtureCase: CatalogProviderProfileFixtureCase,
  version: CatalogProviderIntegrationProfileVersionRecord,
): boolean {
  return (
    normalizeProviderKey(fixtureCase.providerKey) === normalizeProviderKey(version.providerKey) &&
    fixtureCase.profileVersion === version.profileVersion &&
    selectorMatchesVersion(fixtureCase, version)
  );
}

function selectorMatchesVersion(
  selector: Readonly<{ profileKey?: string | null; ingestionUnitKey?: string | null }> | null | undefined,
  version: CatalogProviderIntegrationProfileVersionRecord,
): boolean {
  const profileKey = selector?.profileKey?.trim().toLowerCase();
  const ingestionUnitKey = selector?.ingestionUnitKey?.trim().toLowerCase();
  return (
    (!profileKey || version.profileKey.trim().toLowerCase() === profileKey) &&
    (!ingestionUnitKey ||
      (
        version.ingestionUnitIdentity?.unitKey ??
        version.executableMappingContract?.ingestionUnitIdentity?.unitKey ??
        ""
      )
        .trim()
        .toLowerCase() === ingestionUnitKey)
  );
}

function readPath(value: JsonObject, fieldPath: string): JsonValue | undefined {
  if (fieldPath === ".") {
    return value;
  }

  return fieldPath.split(".").reduce<JsonValue | undefined>((current, segment) => {
    if (!isJsonObject(current) && !Array.isArray(current)) {
      return undefined;
    }
    if (Array.isArray(current)) {
      const index = Number(segment);
      return Number.isInteger(index) ? current[index] : undefined;
    }
    return current[segment];
  }, value);
}

function normalizeProviderKey(providerKey: string): string {
  return providerKey.trim().toLowerCase();
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
