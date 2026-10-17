import {
  PROVIDER_CREDENTIAL_REDACTED_VALUE,
  redactProviderCredentialReadinessEvidence,
  redactProviderCredentialReadinessScope,
  type ProviderCredentialReadiness,
  type ProviderCredentialReadinessEvidence,
  type ProviderCredentialReadinessScope,
  type ProviderCredentialReadinessState,
  type ProviderCredentialRequirement,
  type ProviderCredentialSourceKind,
} from "@chase-sets/provider-credentials";
import type { CatalogIntegrationUnitKey } from "./integration-unit";
import type { ProviderTransportDiagnostic } from "../provider-adapters/provider-adapter";

export type CatalogProviderCredentialRequirement = ProviderCredentialRequirement;

export type CatalogProviderCredentialSourceKind = ProviderCredentialSourceKind;

export type CatalogProviderCredentialReadinessState = ProviderCredentialReadinessState;

export type CatalogProviderCredentialReadiness = ProviderCredentialReadiness<string, CatalogIntegrationUnitKey>;

export type CatalogProviderCredentialReadinessScope = ProviderCredentialReadinessScope;

export type CatalogProviderCredentialReadinessEvidence = ProviderCredentialReadinessEvidence;

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

export const CATALOG_PROVIDER_CREDENTIAL_REDACTED_VALUE = PROVIDER_CREDENTIAL_REDACTED_VALUE;

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
    diagnosticCode?: string | null;
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
    diagnosticCode:
      input.diagnosticCode === undefined
        ? catalogProviderCredentialReadinessDiagnosticCode(input.state)
        : input.diagnosticCode,
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
  return redactProviderCredentialReadinessScope(scope);
}

export function redactCatalogProviderCredentialReadinessEvidence(
  evidence: CatalogProviderCredentialReadinessEvidence,
): CatalogProviderCredentialReadinessEvidence {
  return redactProviderCredentialReadinessEvidence(evidence);
}

function normalizeProviderKey(providerKey: string): string {
  return providerKey.trim().toLowerCase();
}
