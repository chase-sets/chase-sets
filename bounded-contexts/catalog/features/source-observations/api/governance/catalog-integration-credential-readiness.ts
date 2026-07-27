import type { JsonValue } from "@chase-sets/primitives/json";
import type { CatalogIntegrationUnitKey } from "./integration-unit";
import type { ProviderTransportDiagnostic } from "../provider-adapters/provider-adapter";

export type CatalogProviderCredentialRequirement = "not-required" | "required";

export type CatalogProviderCredentialSourceKind =
  | "none"
  | "environment-secret"
  | "managed-secret"
  | "operator-session"
  | "local-fake";

export type CatalogProviderCredentialReadinessState =
  | "not-required"
  | "configured"
  | "missing"
  | "invalid"
  | "expired"
  | "revoked"
  | "unknown";

export type CatalogProviderCredentialReadiness = Readonly<{
  providerKey: string;
  unitKey?: CatalogIntegrationUnitKey;
  requirement: CatalogProviderCredentialRequirement;
  sourceKind: CatalogProviderCredentialSourceKind;
  state: CatalogProviderCredentialReadinessState;
  importBlocking: boolean;
  optionQueryBlocking: boolean;
  diagnosticCode: string | null;
  message: string;
  checkedAt: string | null;
  scope: CatalogProviderCredentialReadinessScope;
  expiresAt?: string | null;
  rotationRequiredAt?: string | null;
  revokedAt?: string | null;
  evidence: CatalogProviderCredentialReadinessEvidence;
}>;

export type CatalogProviderCredentialReadinessScope = Readonly<{
  environmentKey?: string;
  accountKey?: string;
  secretReference?: string;
}>;

export type CatalogProviderCredentialReadinessEvidence = Readonly<Record<string, JsonValue>>;

export type CatalogProviderCredentialReadinessAuditSummary = Readonly<{
  eventName: "provider-credential-readiness-changed";
  providerKey: string;
  unitKey: CatalogIntegrationUnitKey | null;
  state: CatalogProviderCredentialReadinessState;
  importBlocking: boolean;
  optionQueryBlocking: boolean;
  sourceKind: CatalogProviderCredentialSourceKind;
  diagnosticCode: string | null;
  checkedAt: string | null;
  scope: CatalogProviderCredentialReadinessScope;
  evidence: CatalogProviderCredentialReadinessEvidence;
}>;

export const CATALOG_PROVIDER_CREDENTIAL_REDACTED_VALUE = "[redacted-provider-credential]";

const credentialSensitiveKeyPattern = /authorization|bearer|cookie|password|secret|session|tcgauthticket|token/i;
const credentialSensitiveValuePattern =
  /\b(Bearer\s+[a-z0-9._~+/=-]+|TCGAuthTicket=[^;\s]+|authorization:|cookie:|password=|secret=|token=)/i;

const credentialStateDiagnosticCodes = {
  missing: "credential-missing",
  invalid: "credential-invalid",
  expired: "credential-expired",
  revoked: "credential-revoked",
  unknown: "adapter-authentication-failed",
} as const satisfies Partial<Record<CatalogProviderCredentialReadinessState, string>>;

export function createCatalogProviderCredentialReadiness(
  input: Readonly<{
    providerKey: string;
    unitKey?: CatalogIntegrationUnitKey;
    requirement: CatalogProviderCredentialRequirement;
    sourceKind: CatalogProviderCredentialSourceKind;
    state: CatalogProviderCredentialReadinessState;
    message: string;
    checkedAt?: string | null;
    scope?: CatalogProviderCredentialReadinessScope;
    expiresAt?: string | null;
    rotationRequiredAt?: string | null;
    revokedAt?: string | null;
    evidence?: CatalogProviderCredentialReadinessEvidence;
  }>,
): CatalogProviderCredentialReadiness {
  const importBlocking = catalogProviderCredentialReadinessBlocksImport(input.state);

  return {
    providerKey: normalizeProviderKey(input.providerKey),
    ...(input.unitKey ? { unitKey: input.unitKey } : {}),
    requirement: input.requirement,
    sourceKind: input.sourceKind,
    state: input.state,
    importBlocking,
    optionQueryBlocking: importBlocking,
    diagnosticCode: catalogProviderCredentialReadinessDiagnosticCode(input.state),
    message: input.message,
    checkedAt: input.checkedAt ?? null,
    scope: redactCatalogProviderCredentialReadinessScope(input.scope ?? {}),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    ...(input.rotationRequiredAt === undefined ? {} : { rotationRequiredAt: input.rotationRequiredAt }),
    ...(input.revokedAt === undefined ? {} : { revokedAt: input.revokedAt }),
    evidence: redactCatalogProviderCredentialReadinessEvidence(input.evidence ?? {}),
  };
}

export function catalogProviderCredentialReadinessBlocksImport(
  state: CatalogProviderCredentialReadinessState,
): boolean {
  return (
    state === "missing" || state === "invalid" || state === "expired" || state === "revoked" || state === "unknown"
  );
}

export function catalogProviderCredentialReadinessDiagnosticCode(
  state: CatalogProviderCredentialReadinessState,
): string | null {
  return credentialStateDiagnosticCodes[state as keyof typeof credentialStateDiagnosticCodes] ?? null;
}

export function catalogProviderCredentialReadinessToTransportDiagnostic(
  readiness: CatalogProviderCredentialReadiness,
): ProviderTransportDiagnostic | null {
  if (!readiness.diagnosticCode) {
    return null;
  }

  return {
    code: readiness.diagnosticCode,
    severity: readiness.importBlocking ? "error" : "info",
    message: readiness.message,
    ...(readiness.unitKey ? { unitKey: readiness.unitKey } : {}),
  };
}

export function summarizeCatalogProviderCredentialReadinessForAudit(
  readiness: CatalogProviderCredentialReadiness,
): CatalogProviderCredentialReadinessAuditSummary {
  return {
    eventName: "provider-credential-readiness-changed",
    providerKey: readiness.providerKey,
    unitKey: readiness.unitKey ?? null,
    state: readiness.state,
    importBlocking: readiness.importBlocking,
    optionQueryBlocking: readiness.optionQueryBlocking,
    sourceKind: readiness.sourceKind,
    diagnosticCode: readiness.diagnosticCode,
    checkedAt: readiness.checkedAt,
    scope: readiness.scope,
    evidence: readiness.evidence,
  };
}

export function redactCatalogProviderCredentialReadinessScope(
  scope: CatalogProviderCredentialReadinessScope,
): CatalogProviderCredentialReadinessScope {
  return {
    ...(safeString(scope.environmentKey) ? { environmentKey: safeString(scope.environmentKey) } : {}),
    ...(safeString(scope.accountKey) ? { accountKey: safeString(scope.accountKey) } : {}),
    ...(safeString(scope.secretReference) ? { secretReference: safeSecretReference(scope.secretReference) } : {}),
  };
}

export function redactCatalogProviderCredentialReadinessEvidence(
  evidence: CatalogProviderCredentialReadinessEvidence,
): CatalogProviderCredentialReadinessEvidence {
  return redactJsonObject(evidence) as CatalogProviderCredentialReadinessEvidence;
}

function redactJsonObject(value: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      credentialSensitiveKeyPattern.test(key)
        ? CATALOG_PROVIDER_CREDENTIAL_REDACTED_VALUE
        : redactJsonValue(entryValue),
    ]),
  );
}

function redactJsonValue(value: JsonValue): JsonValue {
  if (value === undefined) {
    return null;
  }

  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return credentialSensitiveValuePattern.test(value) ? CATALOG_PROVIDER_CREDENTIAL_REDACTED_VALUE : value;
  }

  if (Array.isArray(value)) {
    return value.map(redactJsonValue);
  }

  return redactJsonObject(value as Readonly<Record<string, JsonValue>>);
}

function safeSecretReference(value: string | undefined): string | undefined {
  const safe = safeString(value);
  if (!safe) {
    return undefined;
  }

  return credentialSensitiveValuePattern.test(safe) ? CATALOG_PROVIDER_CREDENTIAL_REDACTED_VALUE : safe;
}

function safeString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

function normalizeProviderKey(providerKey: string): string {
  return providerKey.trim().toLowerCase();
}
