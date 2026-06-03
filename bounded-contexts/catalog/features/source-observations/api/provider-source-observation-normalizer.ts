import { createHash } from "node:crypto";
import type { JsonValue } from "@chase-sets/primitives/json";
import type { SourceObservationNormalized } from "../domain/domain";
import type {
  CatalogProviderExecutableMappingContract,
  CatalogProviderMappingValueExpression,
  CatalogProviderSourceObservationContract,
} from "./provider-integration-mapping-contract";
import {
  evaluateCatalogProviderMappingExpression,
  type CatalogProviderMappingInterpreterDiagnostic,
  type CatalogProviderMappingInterpreterOptions,
} from "./provider-mapping-interpreter";

export type CatalogProviderSourceObservationMappingContract = CatalogProviderExecutableMappingContract &
  Readonly<{
    sourceObservation: CatalogProviderSourceObservationContract;
  }>;

export type CatalogProviderSourceObservationInput = Readonly<{
  observationId: string;
  providerKey: string;
  externalKey: string;
  sourceUrl: string;
  languageCode: string;
  sourceRecordHash: string;
  sourceUpdatedAt: string | null;
  observedAt: string;
  sourceProfileKey: string;
  sourceProfileVersion: string;
  sourceMappingFingerprint: string;
  normalized: SourceObservationNormalized;
  sourcePayload: JsonValue;
}>;

export type CatalogProviderSourceObservationNormalizationResult = Readonly<{
  observation: CatalogProviderSourceObservationInput | null;
  diagnostics: readonly CatalogProviderMappingInterpreterDiagnostic[];
}>;

export function normalizeCatalogProviderSourceObservation(input: {
  contract: CatalogProviderSourceObservationMappingContract;
  payload: JsonValue;
  observedAt: string;
  interpreterOptions?: CatalogProviderMappingInterpreterOptions;
}): CatalogProviderSourceObservationNormalizationResult {
  const diagnostics: CatalogProviderMappingInterpreterDiagnostic[] = [];
  const evaluate = (path: string, expression: CatalogProviderMappingValueExpression): JsonValue | null | undefined => {
    const result = evaluateCatalogProviderMappingExpression(
      expression,
      input.payload,
      input.interpreterOptions ?? {},
      path,
    );
    diagnostics.push(...result.diagnostics);
    return result.omitted ? undefined : (result.evidence?.value ?? null);
  };

  const observationId = asRequiredString(
    evaluate("sourceObservation.observationId", input.contract.sourceObservation.observationId),
    "sourceObservation.observationId",
    diagnostics,
  );
  const externalKey = asRequiredString(
    evaluate("sourceObservation.externalKey", input.contract.sourceObservation.externalKey),
    "sourceObservation.externalKey",
    diagnostics,
  );
  const sourceUrl = asRequiredString(
    evaluate("sourceObservation.sourceUrl", input.contract.sourceObservation.sourceUrl),
    "sourceObservation.sourceUrl",
    diagnostics,
  );
  const sourceUpdatedAt = asOptionalString(
    evaluate("sourceObservation.sourceUpdatedAt", input.contract.sourceObservation.sourceUpdatedAt),
    "sourceObservation.sourceUpdatedAt",
    diagnostics,
  );
  const sourcePayload = evaluate("sourceObservation.sourcePayload", input.contract.sourceObservation.sourcePayload);
  const languageCode = asRequiredString(
    evaluate("normalizedObservation.languageCode", input.contract.normalizedObservation.languageCode),
    "normalizedObservation.languageCode",
    diagnostics,
  );

  const normalizedFields: Record<string, JsonValue> = {};
  for (const [fieldKey, expression] of Object.entries(input.contract.normalizedObservation.fields)) {
    const value = evaluate(`normalizedObservation.fields.${fieldKey}`, expression);
    if (value !== undefined) {
      normalizedFields[fieldKey] = value;
    }
  }

  const hashMaterial = input.contract.normalizedObservation.hashMaterial
    .map((expression, index) => evaluate(`normalizedObservation.hashMaterial.${index}`, expression))
    .filter((value): value is JsonValue => value !== undefined);

  if (!observationId || !externalKey || !sourceUrl || !languageCode || sourcePayload === undefined) {
    return { observation: null, diagnostics };
  }

  const normalized = {
    kind: input.contract.normalizedObservation.outputKind,
    languageCode,
    ...normalizedFields,
  } as SourceObservationNormalized;

  return {
    observation: {
      observationId,
      providerKey: input.contract.providerKey,
      externalKey,
      sourceUrl,
      languageCode,
      sourceRecordHash: hashJson(hashMaterial.length === 1 ? hashMaterial[0] : hashMaterial),
      sourceUpdatedAt,
      observedAt: input.observedAt,
      sourceProfileKey: input.contract.profileKey,
      sourceProfileVersion: input.contract.profileVersion,
      sourceMappingFingerprint: catalogProviderSourceMappingFingerprint(input.contract),
      normalized,
      sourcePayload,
    },
    diagnostics,
  };
}

export function requireCatalogProviderSourceObservation(input: {
  contract: CatalogProviderSourceObservationMappingContract;
  payload: JsonValue;
  observedAt: string;
  interpreterOptions?: CatalogProviderMappingInterpreterOptions;
}): CatalogProviderSourceObservationInput {
  const result = normalizeCatalogProviderSourceObservation(input);
  if (!result.observation) {
    throw new Error(formatCatalogProviderNormalizationDiagnostics(input.contract.providerKey, result.diagnostics));
  }

  return result.observation;
}

export function formatCatalogProviderNormalizationDiagnostics(
  providerKey: string,
  diagnostics: readonly CatalogProviderMappingInterpreterDiagnostic[],
): string {
  const summary = diagnostics.length > 0 ? diagnostics.map((diagnostic) => diagnostic.path).join(", ") : "unknown";
  return `Catalog provider '${providerKey}' source observation normalization failed at ${summary}.`;
}

function asRequiredString(
  value: JsonValue | null | undefined,
  path: string,
  diagnostics: CatalogProviderMappingInterpreterDiagnostic[],
): string | null {
  if (typeof value === "string" && value.trim().length > 0) {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  diagnostics.push({
    code: "transform-type-mismatch",
    path,
    redaction: "none",
    diagnosticText: "Provider mapping value must resolve to a non-empty string.",
  });
  return null;
}

function asOptionalString(
  value: JsonValue | null | undefined,
  path: string,
  diagnostics: CatalogProviderMappingInterpreterDiagnostic[],
): string | null {
  if (value === undefined || value === null) {
    return null;
  }

  if (typeof value === "string") {
    return value.trim() || null;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  diagnostics.push({
    code: "transform-type-mismatch",
    path,
    redaction: "none",
    diagnosticText: "Provider mapping value must resolve to a string or null.",
  });
  return null;
}

function hashJson(value: JsonValue): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function catalogProviderSourceMappingFingerprint(
  contract: CatalogProviderSourceObservationMappingContract,
): string {
  return hashJson({
    providerKey: contract.providerKey,
    profileKey: contract.profileKey,
    profileVersion: contract.profileVersion,
    sourceObservation: contract.sourceObservation,
    normalizedObservation: contract.normalizedObservation,
    externalReferences: contract.externalReferences,
    duplicatePrevention: contract.duplicatePrevention,
  });
}
