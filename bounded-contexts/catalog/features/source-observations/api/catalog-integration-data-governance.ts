import type { JsonValue } from "@chase-sets/primitives/json";

export type CatalogIntegrationGovernedDataClassKey =
  | "raw-provider-payload"
  | "sampled-provider-payload"
  | "fixture-payload"
  | "dry-run-input-payload"
  | "dry-run-output-evidence"
  | "engine-diagnostic"
  | "provider-transport-diagnostic"
  | "provider-credential-readiness"
  | "audit-evidence"
  | "job-progress-summary";

export type CatalogIntegrationGovernanceRetentionPolicy =
  | "request-only"
  | "resettable-pre-launch"
  | "retain-redacted-summary"
  | "retain-audit-summary";

export type CatalogIntegrationGovernanceRawBodyPolicy = "forbidden" | "signoff-required" | "redacted-preview-only";

export type CatalogIntegrationGovernanceAdminVisibility =
  | "catalog-manage-summary"
  | "catalog-support-redacted-detail"
  | "security-legal-reviewed-only"
  | "metric-only";

export type CatalogIntegrationGovernanceExportPolicy =
  | "no-export"
  | "redacted-summary-only"
  | "reviewed-evidence-package-only";

export type CatalogIntegrationProviderDataSignoffTrigger =
  | "store-raw-body"
  | "retain-real-provider-sample"
  | "retain-fixture-body"
  | "retain-dry-run-body"
  | "show-raw-provider-content"
  | "export-provider-content"
  | "include-provider-imagery";

export type CatalogIntegrationGovernancePolicy = Readonly<{
  key: CatalogIntegrationGovernedDataClassKey;
  displayName: string;
  owner: "catalog-source-observations" | "provider-adapter";
  retentionPolicy: CatalogIntegrationGovernanceRetentionPolicy;
  rawBodyPolicy: CatalogIntegrationGovernanceRawBodyPolicy;
  adminVisibility: CatalogIntegrationGovernanceAdminVisibility;
  exportPolicy: CatalogIntegrationGovernanceExportPolicy;
  loggingPolicy: string;
  signoffTriggers: readonly CatalogIntegrationProviderDataSignoffTrigger[];
  redactedPathPatterns: readonly string[];
  allowedEvidence: readonly string[];
}>;

export type CatalogIntegrationProviderDataUse = Readonly<{
  dataClass: CatalogIntegrationGovernedDataClassKey;
  providerKey: string;
  storesRawBody?: boolean;
  retainsRealProviderSample?: boolean;
  retainsFixtureBody?: boolean;
  retainsDryRunBody?: boolean;
  showsRawProviderContent?: boolean;
  exportsProviderContent?: boolean;
  includesProviderImagery?: boolean;
  hasPolicyLegalSignoff?: boolean;
  retainedDataExceptionIssue?: number | null;
}>;

export type CatalogIntegrationProviderDataSignoffFinding = Readonly<{
  code:
    | "provider-data-signoff-required"
    | "retained-data-exception-required"
    | "raw-body-storage-forbidden"
    | "raw-admin-display-forbidden"
    | "provider-content-export-forbidden";
  dataClass: CatalogIntegrationGovernedDataClassKey;
  providerKey: string;
  message: string;
}>;

const sharedSensitivePathPatterns = [
  "authorization",
  "cookie",
  "token",
  "secret",
  "password",
  "sellerId",
  "sellerKey",
  "sellerName",
  "sellerEmail",
  "email",
  "phone",
] as const;

const providerControlledCommercePatterns = ["price", "marketPrice", "inventory", "quantity", "listing"] as const;

export const catalogIntegrationDataGovernancePolicies = [
  policy({
    key: "raw-provider-payload",
    displayName: "Raw provider payload",
    owner: "provider-adapter",
    retentionPolicy: "request-only",
    rawBodyPolicy: "forbidden",
    adminVisibility: "security-legal-reviewed-only",
    exportPolicy: "no-export",
    loggingPolicy:
      "Never log raw provider request or response bodies; log provider key, unit key, scope, status, retry, and redacted diagnostics only.",
    signoffTriggers: ["store-raw-body", "show-raw-provider-content", "export-provider-content"],
    redactedPathPatterns: [...sharedSensitivePathPatterns, ...providerControlledCommercePatterns],
    allowedEvidence: ["provider key", "unit key", "source URL", "content hash", "redacted diagnostic preview"],
  }),
  policy({
    key: "sampled-provider-payload",
    displayName: "Sampled provider payload",
    owner: "catalog-source-observations",
    retentionPolicy: "resettable-pre-launch",
    rawBodyPolicy: "signoff-required",
    adminVisibility: "security-legal-reviewed-only",
    exportPolicy: "reviewed-evidence-package-only",
    loggingPolicy: "Do not log sampled payload bodies; record sample id, provider key, fixture flow, and hash.",
    signoffTriggers: ["retain-real-provider-sample", "store-raw-body", "export-provider-content"],
    redactedPathPatterns: [...sharedSensitivePathPatterns, ...providerControlledCommercePatterns],
    allowedEvidence: ["sample id", "provider key", "fixture flow", "hash", "redacted summary"],
  }),
  policy({
    key: "fixture-payload",
    displayName: "Fixture payload",
    owner: "catalog-source-observations",
    retentionPolicy: "resettable-pre-launch",
    rawBodyPolicy: "signoff-required",
    adminVisibility: "catalog-support-redacted-detail",
    exportPolicy: "reviewed-evidence-package-only",
    loggingPolicy: "Fixture logs may name fixture flow and validation status but must not print payload bodies.",
    signoffTriggers: ["retain-fixture-body", "include-provider-imagery", "export-provider-content"],
    redactedPathPatterns: [...sharedSensitivePathPatterns, ...providerControlledCommercePatterns],
    allowedEvidence: ["fixture flow", "expected diagnostics", "hash evidence paths", "redacted sample payload"],
  }),
  policy({
    key: "dry-run-input-payload",
    displayName: "Dry-run input payload",
    owner: "catalog-source-observations",
    retentionPolicy: "request-only",
    rawBodyPolicy: "signoff-required",
    adminVisibility: "catalog-support-redacted-detail",
    exportPolicy: "redacted-summary-only",
    loggingPolicy: "Dry-run request logs may include unit key and profile version, never input payload bodies.",
    signoffTriggers: ["retain-dry-run-body", "store-raw-body"],
    redactedPathPatterns: [...sharedSensitivePathPatterns, ...providerControlledCommercePatterns],
    allowedEvidence: ["unit key", "profile version", "redacted input summary", "hash"],
  }),
  policy({
    key: "dry-run-output-evidence",
    displayName: "Dry-run output evidence",
    owner: "catalog-source-observations",
    retentionPolicy: "retain-redacted-summary",
    rawBodyPolicy: "redacted-preview-only",
    adminVisibility: "catalog-manage-summary",
    exportPolicy: "redacted-summary-only",
    loggingPolicy: "Dry-run output logs may include diagnostic codes and counts, not evidence values.",
    signoffTriggers: ["show-raw-provider-content", "include-provider-imagery"],
    redactedPathPatterns: [...sharedSensitivePathPatterns, ...providerControlledCommercePatterns],
    allowedEvidence: ["normalized facts", "diagnostic code", "path", "owner", "uses", "redaction label"],
  }),
  policy({
    key: "engine-diagnostic",
    displayName: "Catalog Integration Engine diagnostic",
    owner: "catalog-source-observations",
    retentionPolicy: "retain-redacted-summary",
    rawBodyPolicy: "redacted-preview-only",
    adminVisibility: "catalog-manage-summary",
    exportPolicy: "redacted-summary-only",
    loggingPolicy: "Logs may include diagnostic code, severity, path, provider key, unit key, and remediation.",
    signoffTriggers: ["show-raw-provider-content"],
    redactedPathPatterns: [...sharedSensitivePathPatterns],
    allowedEvidence: ["diagnostic code", "severity", "path", "blocking behavior", "remediation"],
  }),
  policy({
    key: "provider-transport-diagnostic",
    displayName: "Provider transport diagnostic",
    owner: "provider-adapter",
    retentionPolicy: "retain-redacted-summary",
    rawBodyPolicy: "redacted-preview-only",
    adminVisibility: "catalog-support-redacted-detail",
    exportPolicy: "redacted-summary-only",
    loggingPolicy: "Transport diagnostic logs must redact credentials, cookies, seller/account facts, and raw bodies.",
    signoffTriggers: ["show-raw-provider-content", "export-provider-content"],
    redactedPathPatterns: [...sharedSensitivePathPatterns, ...providerControlledCommercePatterns],
    allowedEvidence: ["provider key", "domain key", "HTTP status", "retry count", "redacted provider message"],
  }),
  policy({
    key: "provider-credential-readiness",
    displayName: "Provider credential readiness",
    owner: "provider-adapter",
    retentionPolicy: "retain-redacted-summary",
    rawBodyPolicy: "redacted-preview-only",
    adminVisibility: "catalog-support-redacted-detail",
    exportPolicy: "redacted-summary-only",
    loggingPolicy:
      "Credential readiness logs may include provider key, unit key, state, source kind, and redacted secret reference labels only.",
    signoffTriggers: ["show-raw-provider-content", "export-provider-content"],
    redactedPathPatterns: [...sharedSensitivePathPatterns, ...providerControlledCommercePatterns],
    allowedEvidence: [
      "provider key",
      "unit key",
      "credential state",
      "credential requirement",
      "credential source kind",
      "redacted secret reference",
    ],
  }),
  policy({
    key: "audit-evidence",
    displayName: "Audit evidence",
    owner: "catalog-source-observations",
    retentionPolicy: "retain-audit-summary",
    rawBodyPolicy: "redacted-preview-only",
    adminVisibility: "catalog-support-redacted-detail",
    exportPolicy: "reviewed-evidence-package-only",
    loggingPolicy: "Audit logs must store event metadata and redacted summaries, not raw provider payloads or secrets.",
    signoffTriggers: ["show-raw-provider-content", "export-provider-content", "include-provider-imagery"],
    redactedPathPatterns: [...sharedSensitivePathPatterns, ...providerControlledCommercePatterns],
    allowedEvidence: ["event name", "actor", "timestamp", "profile version", "job id", "observation id"],
  }),
  policy({
    key: "job-progress-summary",
    displayName: "Job progress and result summary",
    owner: "catalog-source-observations",
    retentionPolicy: "retain-redacted-summary",
    rawBodyPolicy: "redacted-preview-only",
    adminVisibility: "catalog-manage-summary",
    exportPolicy: "redacted-summary-only",
    loggingPolicy: "Job logs may include scope, counts, checkpoint state, and redacted failure reasons only.",
    signoffTriggers: ["show-raw-provider-content"],
    redactedPathPatterns: [...sharedSensitivePathPatterns],
    allowedEvidence: ["job id", "unit key", "scope", "counts", "status", "redacted failure reason"],
  }),
] as const satisfies readonly CatalogIntegrationGovernancePolicy[];

export const catalogIntegrationDataGovernancePoliciesByKey: Readonly<
  Record<CatalogIntegrationGovernedDataClassKey, CatalogIntegrationGovernancePolicy>
> = Object.fromEntries(catalogIntegrationDataGovernancePolicies.map((entry) => [entry.key, entry])) as Readonly<
  Record<CatalogIntegrationGovernedDataClassKey, CatalogIntegrationGovernancePolicy>
>;

export function getCatalogIntegrationDataGovernancePolicy(
  key: CatalogIntegrationGovernedDataClassKey,
): CatalogIntegrationGovernancePolicy {
  return catalogIntegrationDataGovernancePoliciesByKey[key];
}

export function evaluateCatalogIntegrationProviderDataUse(
  input: CatalogIntegrationProviderDataUse,
): readonly CatalogIntegrationProviderDataSignoffFinding[] {
  const policy = getCatalogIntegrationDataGovernancePolicy(input.dataClass);
  const triggers = triggersFromUse(input);
  const findings: CatalogIntegrationProviderDataSignoffFinding[] = [];

  if (input.storesRawBody && policy.rawBodyPolicy === "forbidden") {
    findings.push(finding("raw-body-storage-forbidden", input, `${policy.displayName} cannot store raw bodies.`));
  }

  if (input.showsRawProviderContent && policy.rawBodyPolicy !== "signoff-required") {
    findings.push(
      finding("raw-admin-display-forbidden", input, `${policy.displayName} must be redacted before admin display.`),
    );
  }

  if (input.exportsProviderContent && policy.exportPolicy !== "reviewed-evidence-package-only") {
    findings.push(
      finding("provider-content-export-forbidden", input, `${policy.displayName} cannot export provider content.`),
    );
  }

  const matchingSignoffTriggers = triggers.filter((trigger) => policy.signoffTriggers.includes(trigger));
  if (matchingSignoffTriggers.length > 0 && !input.hasPolicyLegalSignoff) {
    findings.push(
      finding(
        "provider-data-signoff-required",
        input,
        `${policy.displayName} requires policy/legal signoff for ${matchingSignoffTriggers.join(", ")}.`,
      ),
    );
  }

  if (
    (input.retainsRealProviderSample || input.retainsFixtureBody || input.retainsDryRunBody) &&
    !input.retainedDataExceptionIssue
  ) {
    findings.push(
      finding(
        "retained-data-exception-required",
        input,
        `${policy.displayName} retained body/sample use must name a retained-data exception issue.`,
      ),
    );
  }

  return findings;
}

export function redactCatalogIntegrationProviderData(value: JsonValue): JsonValue {
  return redactValue(value, []);
}

export function catalogIntegrationProviderDataSignoffChecklist(): readonly string[] {
  return [
    "Name each governed data class and provider key affected by the release.",
    "Confirm raw provider payload bodies are not stored, logged, shown, or exported unless policy/legal signoff and a retained-data exception allow it.",
    "Confirm sampled payload, fixture body, and dry-run body retention has policy/legal signoff, owner, reason, removal criteria, and deletion/rotation plan.",
    "Confirm Admin UI surfaces show normalized facts, hashes, references, diagnostic codes, or redacted previews instead of raw provider bodies.",
    "Confirm logs, metrics, traces, screenshots, CI artifacts, and launch evidence exclude provider secrets, account/seller data, and raw provider bodies.",
    "Confirm provider-specific constraints for TCGdex, TCGplayer, Scrydex/Scryfall-style, MTGJSON, and future providers are documented before live sampling.",
  ];
}

function policy(input: CatalogIntegrationGovernancePolicy): CatalogIntegrationGovernancePolicy {
  return input;
}

function triggersFromUse(
  input: CatalogIntegrationProviderDataUse,
): readonly CatalogIntegrationProviderDataSignoffTrigger[] {
  return [
    ...(input.storesRawBody ? (["store-raw-body"] as const) : []),
    ...(input.retainsRealProviderSample ? (["retain-real-provider-sample"] as const) : []),
    ...(input.retainsFixtureBody ? (["retain-fixture-body"] as const) : []),
    ...(input.retainsDryRunBody ? (["retain-dry-run-body"] as const) : []),
    ...(input.showsRawProviderContent ? (["show-raw-provider-content"] as const) : []),
    ...(input.exportsProviderContent ? (["export-provider-content"] as const) : []),
    ...(input.includesProviderImagery ? (["include-provider-imagery"] as const) : []),
  ];
}

function finding(
  code: CatalogIntegrationProviderDataSignoffFinding["code"],
  input: CatalogIntegrationProviderDataUse,
  message: string,
): CatalogIntegrationProviderDataSignoffFinding {
  return {
    code,
    dataClass: input.dataClass,
    providerKey: input.providerKey,
    message,
  };
}

function redactValue(value: JsonValue, path: readonly string[]): JsonValue {
  if (Array.isArray(value)) {
    return value.map((entry, index) => redactValue(entry, [...path, String(index)]));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => {
        const nextPath = [...path, key];
        if (shouldRedactPath(nextPath)) {
          return [key, "<redacted>"];
        }

        return [key, redactValue(entry as JsonValue, nextPath)];
      }),
    ) as JsonValue;
  }

  return value;
}

function shouldRedactPath(path: readonly string[]): boolean {
  const normalized = path.join(".").toLowerCase();
  return [...sharedSensitivePathPatterns, ...providerControlledCommercePatterns].some((pattern) =>
    normalized.includes(pattern.toLowerCase()),
  );
}
