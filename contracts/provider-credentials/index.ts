import type { JsonValue } from "@chase-sets/primitives/json";

export type ProviderCredentialRequirement = "not-required" | "required";

export type ProviderCredentialSourceKind =
  | "none"
  | "environment-secret"
  | "managed-secret"
  | "operator-session"
  | "local-fake";

export type ProviderCredentialReadinessState =
  | "not-required"
  | "configured"
  | "missing"
  | "invalid"
  | "expired"
  | "revoked"
  | "unknown";

export type ProviderCredentialReadiness<
  ProviderKey extends string = string,
  UnitKey extends string = string,
> = Readonly<{
  providerKey: ProviderKey;
  unitKey?: UnitKey;
  requirement: ProviderCredentialRequirement;
  sourceKind: ProviderCredentialSourceKind;
  state: ProviderCredentialReadinessState;
  importBlocking: boolean;
  optionQueryBlocking: boolean;
  diagnosticCode: string | null;
  message: string;
  checkedAt: string | null;
  scope: ProviderCredentialReadinessScope;
  expiresAt?: string | null;
  rotationRequiredAt?: string | null;
  revokedAt?: string | null;
  evidence: ProviderCredentialReadinessEvidence;
}>;

export type ProviderCredentialReadinessScope = Readonly<{
  environmentKey?: string;
  accountKey?: string;
  secretReference?: string;
}>;

export type ProviderCredentialReadinessEvidence = Readonly<Record<string, JsonValue>>;

export const PROVIDER_CREDENTIAL_REDACTED_VALUE = "[redacted-provider-credential]";

const credentialSensitiveKeyPattern = /authorization|bearer|cookie|password|secret|session|tcgauthticket|token/i;
const credentialSensitiveValuePattern =
  /\b(Bearer\s+[a-z0-9._~+/=-]+|TCGAuthTicket=[^;\s]+|authorization:|cookie:|password=|secret=|token=)/i;

export function redactProviderCredentialReadinessScope(
  scope: ProviderCredentialReadinessScope,
): ProviderCredentialReadinessScope {
  return {
    ...(safeString(scope.environmentKey) ? { environmentKey: safeString(scope.environmentKey) } : {}),
    ...(safeString(scope.accountKey) ? { accountKey: safeString(scope.accountKey) } : {}),
    ...(safeString(scope.secretReference) ? { secretReference: safeSecretReference(scope.secretReference) } : {}),
  };
}

export function redactProviderCredentialReadinessEvidence(
  evidence: ProviderCredentialReadinessEvidence,
): ProviderCredentialReadinessEvidence {
  return redactJsonObject(evidence);
}

function redactJsonObject(value: Readonly<Record<string, JsonValue>>): Readonly<Record<string, JsonValue>> {
  return Object.fromEntries(
    Object.entries(value).map(([key, entryValue]) => [
      key,
      credentialSensitiveKeyPattern.test(key) ? PROVIDER_CREDENTIAL_REDACTED_VALUE : redactJsonValue(entryValue),
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
    return credentialSensitiveValuePattern.test(value) ? PROVIDER_CREDENTIAL_REDACTED_VALUE : value;
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

  return credentialSensitiveValuePattern.test(safe) ? PROVIDER_CREDENTIAL_REDACTED_VALUE : safe;
}

function safeString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}
