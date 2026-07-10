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
  | "provider-usage-summary"
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
    key: "provider-usage-summary",
    displayName: "Provider usage and credit summary",
    owner: "provider-adapter",
    retentionPolicy: "retain-redacted-summary",
    rawBodyPolicy: "redacted-preview-only",
    adminVisibility: "catalog-manage-summary",
    exportPolicy: "redacted-summary-only",
    loggingPolicy:
      "Usage logs may include provider key, unit key, request/page/cache counts, credit state, and redacted usage-check diagnostics only.",
    signoffTriggers: ["show-raw-provider-content", "export-provider-content"],
    redactedPathPatterns: [...sharedSensitivePathPatterns, ...providerControlledCommercePatterns],
    allowedEvidence: [
      "provider key",
      "unit key",
      "estimated request count",
      "actual request count",
      "page count",
      "cache hit count",
      "cache miss count",
      "usage check state",
      "credit state",
      "redacted usage diagnostic",
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
    "Confirm provider-specific constraints for TCGdex, TCGplayer, Scrydex/Scryfall-style, MTGJSON, LorcanaJSON, Lorcast, and future providers are documented before live sampling.",
  ];
}

// ---------------------------------------------------------------------------
// One Piece provider authority and Scrydex credit-aware import policy.
// ---------------------------------------------------------------------------

export const CATALOG_INTEGRATION_ONE_PIECE_PRODUCTION_SIGNOFF_REFERENCE_ENV =
  "CATALOG_INTEGRATION_ONE_PIECE_PRODUCTION_SIGNOFF_REFERENCE";

export type CatalogIntegrationOnePieceProviderAuthorityKey =
  | "scrydex-one-piece"
  | "tcgplayer-one-piece"
  | "bandai-one-piece-official"
  | "one-piece-fallback-sources";

export type CatalogIntegrationOnePieceProviderAuthorityPolicy = Readonly<{
  key: CatalogIntegrationOnePieceProviderAuthorityKey;
  providerKey: string;
  displayName: string;
  productionRole: string;
  catalogAuthority: readonly string[];
  notCatalogTruth: readonly string[];
  activationRequirement: string;
}>;

export type CatalogIntegrationOnePieceValidationTarget = "card" | "expansion" | "sealed-product";

export type CatalogIntegrationOnePieceValidationCheck = Readonly<{
  key: string;
  target: CatalogIntegrationOnePieceValidationTarget;
  validationSource: "bandai-one-piece-official";
  comparedProviders: readonly ("scrydex-one-piece" | "tcgplayer-one-piece")[];
  comparedFieldClasses: readonly string[];
  allowedEvidence: readonly string[];
  forbiddenEvidence: readonly string[];
  operatorEvidenceRequirement: string;
  fallbackSourcePolicy: string;
}>;

export const catalogIntegrationOnePieceProviderAuthorityPolicies = [
  onePieceAuthorityPolicy({
    key: "scrydex-one-piece",
    providerKey: "scrydex",
    displayName: "Scrydex One Piece",
    productionRole:
      "Preferred paid One Piece seed provider for cards, variants, expansions, sealed products, approved price-history evidence, and webhook freshness where source authority approves the data class.",
    catalogAuthority: [
      "card and variant identifiers",
      "expansion and set identifiers",
      "sealed product identifiers and packaging labels",
      "image URI evidence when retention policy permits it",
      "provider freshness and usage diagnostics",
    ],
    notCatalogTruth: [
      "seller facts",
      "inventory quantities",
      "listings",
      "orders",
      "raw provider bodies",
      "API keys or team ids",
      "price history except as approved evidence outside Catalog truth",
    ],
    activationRequirement:
      "Requires One Piece provider-data signoff, redacted credential readiness, bulk-first call-budget evidence, and interface-only staging UAT.",
  }),
  onePieceAuthorityPolicy({
    key: "tcgplayer-one-piece",
    providerKey: "tcgplayer",
    displayName: "TCGplayer One Piece",
    productionRole:
      "Marketplace-aligned source for One Piece product ids, group/set identity, SKU mapping, condition/language/printing variants, and price-reference evidence.",
    catalogAuthority: [
      "product id external-reference candidates",
      "SKU external-product-reference candidates after selected options validate",
      "group and set-name matching evidence",
      "condition, language, printing, and sealed-form evidence",
    ],
    notCatalogTruth: [
      "prices as Catalog identity",
      "market prices as Catalog truth",
      "latest sales",
      "seller or account facts",
      "inventory",
      "listings",
      "orders",
      "messages",
      "session material",
    ],
    activationRequirement:
      "Requires existing TCGplayer credential posture, source-authority approval, and a product-line-specific profile unit for One Piece.",
  }),
  onePieceAuthorityPolicy({
    key: "bandai-one-piece-official",
    providerKey: "bandai-official",
    displayName: "Bandai official One Piece Card Game",
    productionRole:
      "Canonical validation reference for card lists and product releases, not an ingestion source unless legal/source-authority approval explicitly changes that role.",
    catalogAuthority: [
      "manual validation reference",
      "source-disagreement evidence after redaction",
      "operator checklist evidence that a Scrydex or TCGplayer record aligns with official release information",
    ],
    notCatalogTruth: [
      "raw official page text",
      "official imagery copies",
      "scraped payload bodies",
      "automated ingestion facts without explicit approval",
    ],
    activationRequirement:
      "May be used for validation checklists before ingestion; automated ingestion requires separate approval and retained-data policy.",
  }),
  onePieceAuthorityPolicy({
    key: "one-piece-fallback-sources",
    providerKey: "comparison-only",
    displayName: "One Piece fallback and community sources",
    productionRole: "Comparison-only or fallback evidence for gaps in Scrydex or TCGplayer after governance approval.",
    catalogAuthority: [
      "source-disagreement diagnostics",
      "coverage-gap analysis",
      "fallback identifiers only when a separate approval names the source and data class",
    ],
    notCatalogTruth: [
      "default production authority",
      "raw community payloads",
      "unapproved images",
      "unreviewed price or gameplay facts",
    ],
    activationRequirement:
      "Requires a named source approval before any fallback source is used for retained fixtures or production observations.",
  }),
] as const satisfies readonly CatalogIntegrationOnePieceProviderAuthorityPolicy[];

export const catalogIntegrationOnePieceValidationChecks = [
  onePieceValidationCheck({
    key: "one-piece-card-release-validation",
    target: "card",
    validationSource: "bandai-one-piece-official",
    comparedProviders: ["scrydex-one-piece", "tcgplayer-one-piece"],
    comparedFieldClasses: [
      "card name",
      "card number",
      "rarity",
      "card type/color/life/power/cost attributes",
      "expansion membership",
    ],
    allowedEvidence: [
      "redacted official reference label",
      "normalized provider fact path",
      "source-disagreement diagnostic",
      "operator checklist result",
    ],
    forbiddenEvidence: ["raw official page text", "official imagery copies", "scraped official payload bodies"],
    operatorEvidenceRequirement:
      "Before production signoff, validate at least one representative card through the Admin interface without retaining Bandai payload bodies or imagery.",
    fallbackSourcePolicy:
      "Fallback or community card sources are comparison-only after named approval and cannot resolve Catalog truth automatically.",
  }),
  onePieceValidationCheck({
    key: "one-piece-expansion-validation",
    target: "expansion",
    validationSource: "bandai-one-piece-official",
    comparedProviders: ["scrydex-one-piece", "tcgplayer-one-piece"],
    comparedFieldClasses: [
      "expansion name",
      "set code",
      "release date",
      "product-line membership",
      "card-count or release-summary evidence",
    ],
    allowedEvidence: [
      "redacted official release reference",
      "normalized expansion reference record",
      "source-disagreement diagnostic",
      "operator checklist result",
    ],
    forbiddenEvidence: ["raw official release text", "official imagery copies", "scraped official payload bodies"],
    operatorEvidenceRequirement:
      "Before production signoff, validate the imported One Piece expansion or set reference from the Admin interface and keep only redacted disagreement evidence.",
    fallbackSourcePolicy:
      "Fallback or community expansion sources are comparison-only after named approval and cannot become the default production authority.",
  }),
  onePieceValidationCheck({
    key: "one-piece-sealed-product-validation",
    target: "sealed-product",
    validationSource: "bandai-one-piece-official",
    comparedProviders: ["scrydex-one-piece", "tcgplayer-one-piece"],
    comparedFieldClasses: [
      "sealed product name",
      "product form",
      "contained expansion or release family",
      "packaging label",
      "marketplace product/SKU bridge evidence",
    ],
    allowedEvidence: [
      "redacted official product reference",
      "normalized sealed-product Source Observation",
      "TCGplayer product/SKU reference candidate",
      "source-disagreement diagnostic",
      "operator checklist result",
    ],
    forbiddenEvidence: ["raw official product text", "official imagery copies", "scraped official payload bodies"],
    operatorEvidenceRequirement:
      "Before production signoff, validate at least one sealed product through the Admin interface and keep TCGplayer commerce facts out of Catalog truth.",
    fallbackSourcePolicy:
      "Fallback or community sealed-product sources are comparison-only after named approval and cannot bypass Scrydex or TCGplayer authority.",
  }),
] as const satisfies readonly CatalogIntegrationOnePieceValidationCheck[];

export type CatalogIntegrationScrydexBulkImportPolicy = Readonly<{
  providerKey: "scrydex";
  productLineKey: "one-piece";
  requestStrategy: "bulk-first";
  pageSizePolicy: string;
  fieldSelectionPolicy: string;
  allowedRequestShapes: readonly string[];
  forbiddenNormalPatterns: readonly string[];
  perRecordFallbackRequirement: string;
  requiredPreflightEvidence: readonly string[];
  requiredPostRunEvidence: readonly string[];
  evidenceDataClass: CatalogIntegrationGovernedDataClassKey;
}>;

export const catalogIntegrationScrydexOnePieceBulkImportPolicy = {
  providerKey: "scrydex",
  productLineKey: "one-piece",
  requestStrategy: "bulk-first",
  pageSizePolicy:
    "Use the highest safe Scrydex-supported page size for the selected import unit unless measured response size, provider behavior, or documented rate/credit guidance requires a smaller page.",
  fieldSelectionPolicy:
    "Use provider field selection to request only fields needed by the selected cards, variants, expansions, sealed products, price-history, or freshness import unit.",
  allowedRequestShapes: ["paginated-list", "paginated-search", "bulk-filtered-search", "usage-check"],
  forbiddenNormalPatterns: [
    "one Scrydex card request per card",
    "one Scrydex variant request per variant",
    "one Scrydex sealed-product request per sealed product",
    "repeat live option queries when a safe fresh or stale cache page exists",
  ],
  perRecordFallbackRequirement:
    "A per-record Scrydex call is allowed only when no bulk/list/search endpoint can supply the required field or relationship; the fallback must be documented, tested, preflighted with call impact, and surfaced to the operator before execution.",
  requiredPreflightEvidence: [
    "credential readiness",
    "team readiness",
    "credit or usage readiness",
    "cache freshness",
    "estimated request count or estimate-unavailable diagnostic",
    "selected unit key and source scope",
  ],
  requiredPostRunEvidence: [
    "actual request count",
    "page count",
    "cache hit count",
    "cache miss count",
    "usage-check result",
    "credit or degraded diagnostic",
    "bulk-first confirmation or per-record fallback reason",
  ],
  evidenceDataClass: "provider-usage-summary",
} as const satisfies CatalogIntegrationScrydexBulkImportPolicy;

function onePieceAuthorityPolicy(
  policy: CatalogIntegrationOnePieceProviderAuthorityPolicy,
): CatalogIntegrationOnePieceProviderAuthorityPolicy {
  return policy;
}

function onePieceValidationCheck(
  check: CatalogIntegrationOnePieceValidationCheck,
): CatalogIntegrationOnePieceValidationCheck {
  return check;
}

// ---------------------------------------------------------------------------
// Lorcana provider authority and Scrydex credit-aware import policy.
// ---------------------------------------------------------------------------

export const CATALOG_INTEGRATION_LORCANA_PRODUCTION_SIGNOFF_REFERENCE_ENV =
  "CATALOG_INTEGRATION_LORCANA_PRODUCTION_SIGNOFF_REFERENCE";

export type CatalogIntegrationLorcanaProviderAuthorityKey =
  | "lorcanajson-lorcana"
  | "lorcast-lorcana"
  | "tcgplayer-lorcana"
  | "scrydex-lorcana"
  | "ravensburger-lorcana-official";

export type CatalogIntegrationLorcanaProviderAuthorityPolicy = Readonly<{
  key: CatalogIntegrationLorcanaProviderAuthorityKey;
  providerKey: string;
  displayName: string;
  productionRole: string;
  catalogAuthority: readonly string[];
  notCatalogTruth: readonly string[];
  activationRequirement: string;
}>;

export type CatalogIntegrationLorcanaValidationTarget = "card" | "set" | "sealed-product" | "official-deck";

export type CatalogIntegrationLorcanaValidationCheck = Readonly<{
  key: string;
  target: CatalogIntegrationLorcanaValidationTarget;
  validationSource: "ravensburger-lorcana-official";
  comparedProviders: readonly ("lorcanajson-lorcana" | "lorcast-lorcana" | "tcgplayer-lorcana" | "scrydex-lorcana")[];
  comparedFieldClasses: readonly string[];
  allowedEvidence: readonly string[];
  forbiddenEvidence: readonly string[];
  operatorEvidenceRequirement: string;
  fallbackSourcePolicy: string;
}>;

export type CatalogIntegrationLorcanaOfficialValidationScope = Readonly<{
  key: string;
  releasePosition: "current-or-most-recent-main-set" | "older-main-set";
  displayName: string;
  setCode: string | null;
  requiredTargets: readonly CatalogIntegrationLorcanaValidationTarget[];
  requiredFactClasses: readonly string[];
  evidenceDataClass: CatalogIntegrationGovernedDataClassKey;
  evidenceRequirement: string;
}>;

export const catalogIntegrationLorcanaProviderAuthorityPolicies = [
  lorcanaAuthorityPolicy({
    key: "lorcanajson-lorcana",
    providerKey: "lorcanajson",
    displayName: "LorcanaJSON",
    productionRole:
      "Preferred free bulk-first Disney Lorcana reference provider for sets, cards, languages, variants, image URI evidence, metadata, and official deck files where source authority approves the data class.",
    catalogAuthority: [
      "set/chapter identifiers",
      "card print identifiers",
      "collector numbers",
      "printed names and versions",
      "rarity, ink, classification, franchise/property, and language facts",
      "image URI evidence when retention policy permits it",
      "bulk metadata, generated-on, checksum, and freshness evidence",
    ],
    notCatalogTruth: [
      "marketplace product ids as canonical Catalog identity",
      "prices",
      "seller or account facts",
      "raw provider bodies",
      "unapproved provider imagery copies",
    ],
    activationRequirement:
      "Requires Lorcana provider-data signoff, fixture-backed mapping coverage, bulk-first runtime proof, and interface-only staging UAT.",
  }),
  lorcanaAuthorityPolicy({
    key: "lorcast-lorcana",
    providerKey: "lorcast",
    displayName: "Lorcast",
    productionRole:
      "Free supplemental Disney Lorcana provider for set/card option queries, image URIs, TCGplayer ids, legalities, and lightweight price evidence where approved.",
    catalogAuthority: [
      "set-scoped card lookup evidence",
      "supplemental image URI evidence",
      "TCGplayer id bridge candidates",
      "legality and lightweight price reference diagnostics when approved",
      "cache and pacing diagnostics",
    ],
    notCatalogTruth: [
      "canonical winner when LorcanaJSON or official validation disagrees",
      "prices as Catalog identity",
      "raw provider bodies",
      "provider imagery copies without retained-data approval",
    ],
    activationRequirement:
      "Requires set-scoped option query proof, cache/pacing evidence, fixture-backed mapping coverage, and interface-only staging UAT.",
  }),
  lorcanaAuthorityPolicy({
    key: "tcgplayer-lorcana",
    providerKey: "tcgplayer",
    displayName: "TCGplayer Lorcana",
    productionRole:
      "Marketplace-aligned source for Disney Lorcana product ids, group/set identity, SKU mapping, condition/language/printing variants, sealed products, and price-reference evidence through the existing Chase Sets automation path.",
    catalogAuthority: [
      "product id external-reference candidates",
      "SKU external-product-reference candidates after selected options validate",
      "group and set-name matching evidence",
      "condition, language, printing, and sealed-form evidence",
      "marketplace product image URI evidence when retention policy permits it",
    ],
    notCatalogTruth: [
      "prices as Catalog identity",
      "market prices as Catalog truth",
      "latest sales",
      "seller or account facts",
      "inventory",
      "listings",
      "orders",
      "messages",
      "session material",
      "TCGCSV as a production provider",
    ],
    activationRequirement:
      "Requires existing TCGplayer credential posture, Lorcana unit/profile approval, redacted automation evidence, and interface-only staging UAT.",
  }),
  lorcanaAuthorityPolicy({
    key: "scrydex-lorcana",
    providerKey: "scrydex",
    displayName: "Scrydex Lorcana",
    productionRole:
      "Paid supplemental Disney Lorcana source where Scrydex coverage is better for cards, sets, variants, sealed products, image evidence, price-reference evidence, and freshness signals.",
    catalogAuthority: [
      "card and variant identifiers",
      "set identifiers",
      "sealed product identifiers and packaging labels",
      "image URI evidence when retention policy permits it",
      "provider freshness, usage, credit, and cache diagnostics",
    ],
    notCatalogTruth: [
      "API keys or team ids",
      "per-game Scrydex credential settings",
      "seller facts",
      "inventory quantities",
      "listings",
      "orders",
      "raw provider bodies",
      "unapproved price history bodies",
    ],
    activationRequirement:
      "Requires shared Scrydex credential readiness, bulk-first call-budget evidence, source-authority approval, and interface-only staging UAT.",
  }),
  lorcanaAuthorityPolicy({
    key: "ravensburger-lorcana-official",
    providerKey: "ravensburger-official",
    displayName: "Disney Lorcana/Ravensburger official",
    productionRole:
      "Canonical validation reference for set names, release dates, product lineup, pack counts, official card-gallery presence, and official app references; not an ingestion source unless legal/source-authority approval explicitly changes that role.",
    catalogAuthority: [
      "manual validation reference",
      "source-disagreement evidence after redaction",
      "operator checklist evidence that imported provider records align with official release information",
    ],
    notCatalogTruth: [
      "raw official page text",
      "official imagery copies",
      "scraped payload bodies",
      "automated ingestion facts without explicit approval",
    ],
    activationRequirement:
      "May be used for validation checklists before ingestion; automated ingestion requires separate approval and retained-data policy.",
  }),
] as const satisfies readonly CatalogIntegrationLorcanaProviderAuthorityPolicy[];

export const catalogIntegrationLorcanaValidationChecks = [
  lorcanaValidationCheck({
    key: "lorcana-card-gallery-validation",
    target: "card",
    validationSource: "ravensburger-lorcana-official",
    comparedProviders: ["lorcanajson-lorcana", "lorcast-lorcana", "scrydex-lorcana", "tcgplayer-lorcana"],
    comparedFieldClasses: [
      "card name",
      "collector number",
      "rarity",
      "ink color",
      "classification and property",
      "set membership",
      "official card-gallery presence",
    ],
    allowedEvidence: [
      "redacted official card-gallery reference label",
      "normalized provider fact path",
      "source-disagreement diagnostic",
      "operator checklist result",
    ],
    forbiddenEvidence: ["raw official card text", "official imagery copies", "scraped official payload bodies"],
    operatorEvidenceRequirement:
      "Before production signoff, validate at least one current-set and one older-set card through the Admin interface without retaining Ravensburger payload bodies or imagery.",
    fallbackSourcePolicy:
      "Fallback or community card sources are comparison-only after named approval and cannot resolve Catalog truth automatically.",
  }),
  lorcanaValidationCheck({
    key: "lorcana-set-release-validation",
    target: "set",
    validationSource: "ravensburger-lorcana-official",
    comparedProviders: ["lorcanajson-lorcana", "lorcast-lorcana", "scrydex-lorcana", "tcgplayer-lorcana"],
    comparedFieldClasses: [
      "set name",
      "set code",
      "release date",
      "prerelease date",
      "printed total",
      "card count",
      "official app reference",
    ],
    allowedEvidence: [
      "redacted official release reference",
      "normalized set reference record",
      "source-disagreement diagnostic",
      "operator checklist result",
    ],
    forbiddenEvidence: ["raw official release text", "official imagery copies", "scraped official payload bodies"],
    operatorEvidenceRequirement:
      "Before production signoff, validate one current Lorcana set and one older set from the Admin interface and keep only redacted disagreement evidence.",
    fallbackSourcePolicy:
      "Fallback or community set sources are comparison-only after named approval and cannot become the default production authority.",
  }),
  lorcanaValidationCheck({
    key: "lorcana-sealed-product-lineup-validation",
    target: "sealed-product",
    validationSource: "ravensburger-lorcana-official",
    comparedProviders: ["tcgplayer-lorcana", "scrydex-lorcana", "lorcanajson-lorcana"],
    comparedFieldClasses: [
      "sealed product name",
      "product form",
      "contained set or release family",
      "pack count",
      "official product lineup membership",
      "marketplace product/SKU bridge evidence",
    ],
    allowedEvidence: [
      "redacted official product reference",
      "normalized sealed-product Source Observation",
      "TCGplayer product/SKU reference candidate",
      "source-disagreement diagnostic",
      "operator checklist result",
    ],
    forbiddenEvidence: ["raw official product text", "official imagery copies", "scraped official payload bodies"],
    operatorEvidenceRequirement:
      "Before production signoff, validate at least one sealed product through the Admin interface and keep TCGplayer commerce facts out of Catalog truth.",
    fallbackSourcePolicy:
      "Fallback or community sealed-product sources are comparison-only after named approval and cannot bypass Scrydex or TCGplayer authority.",
  }),
  lorcanaValidationCheck({
    key: "lorcana-official-deck-validation",
    target: "official-deck",
    validationSource: "ravensburger-lorcana-official",
    comparedProviders: ["lorcanajson-lorcana", "scrydex-lorcana", "tcgplayer-lorcana"],
    comparedFieldClasses: [
      "official deck name",
      "deck release family",
      "included cards or product lineup evidence",
      "sealed product bridge evidence",
    ],
    allowedEvidence: [
      "redacted official deck reference",
      "normalized official deck reference",
      "source-disagreement diagnostic",
      "operator checklist result",
    ],
    forbiddenEvidence: ["raw official deck list text", "official imagery copies", "scraped official payload bodies"],
    operatorEvidenceRequirement:
      "If official decks are enabled for the LorcanaJSON import unit, validate at least one deck through the Admin interface before production signoff.",
    fallbackSourcePolicy:
      "Fallback or community deck lists are comparison-only after named approval and cannot become default Catalog truth.",
  }),
] as const satisfies readonly CatalogIntegrationLorcanaValidationCheck[];

export const catalogIntegrationLorcanaOfficialValidationScopes = [
  {
    key: "lorcana-current-main-set-official-validation",
    releasePosition: "current-or-most-recent-main-set",
    displayName: "Operator-selected current or most recent main Lorcana set",
    setCode: null,
    requiredTargets: ["card", "set", "sealed-product"],
    requiredFactClasses: ["set name", "release date", "card-gallery presence", "official product lineup", "pack count"],
    evidenceDataClass: "audit-evidence",
    evidenceRequirement:
      "Before production signoff, operators must validate one current or most recent main Lorcana set through the Admin interface using redacted official-reference labels only.",
  },
  {
    key: "lorcana-the-first-chapter-official-validation",
    releasePosition: "older-main-set",
    displayName: "The First Chapter",
    setCode: "TFC",
    requiredTargets: ["card", "set", "sealed-product", "official-deck"],
    requiredFactClasses: [
      "set name",
      "release date",
      "printed total",
      "card-gallery presence",
      "starter deck or official deck evidence",
    ],
    evidenceDataClass: "audit-evidence",
    evidenceRequirement:
      "Before production signoff, operators must validate The First Chapter as the older stable Lorcana set through the Admin interface using redacted official-reference labels only.",
  },
] as const satisfies readonly CatalogIntegrationLorcanaOfficialValidationScope[];

export type CatalogIntegrationScrydexLorcanaBulkImportPolicy = Readonly<{
  providerKey: "scrydex";
  productLineKey: "lorcana";
  requestStrategy: "bulk-first";
  pageSizePolicy: string;
  fieldSelectionPolicy: string;
  allowedRequestShapes: readonly string[];
  forbiddenNormalPatterns: readonly string[];
  perRecordFallbackRequirement: string;
  requiredPreflightEvidence: readonly string[];
  requiredPostRunEvidence: readonly string[];
  evidenceDataClass: CatalogIntegrationGovernedDataClassKey;
}>;

export const catalogIntegrationScrydexLorcanaBulkImportPolicy = {
  providerKey: "scrydex",
  productLineKey: "lorcana",
  requestStrategy: "bulk-first",
  pageSizePolicy:
    "Use the highest safe Scrydex-supported page size for the selected Lorcana import unit unless measured response size, provider behavior, or documented rate/credit guidance requires a smaller page.",
  fieldSelectionPolicy:
    "Use provider field selection to request only fields needed by the selected Lorcana cards, variants, sets, sealed products, approved price-reference, or freshness import unit.",
  allowedRequestShapes: ["paginated-list", "paginated-search", "bulk-filtered-search", "usage-check"],
  forbiddenNormalPatterns: [
    "one Scrydex card request per card",
    "one Scrydex variant request per variant",
    "one Scrydex sealed-product request per sealed product",
    "per-game Scrydex credential lookup",
    "repeat live option queries when a safe fresh or stale cache page exists",
  ],
  perRecordFallbackRequirement:
    "A per-record Scrydex Lorcana call is allowed only when no bulk/list/search endpoint can supply the required field or relationship; the fallback must be documented, tested, preflighted with call impact, and surfaced to the operator before execution.",
  requiredPreflightEvidence: [
    "shared credential readiness",
    "team readiness",
    "credit or usage readiness",
    "cache freshness",
    "estimated request count or estimate-unavailable diagnostic",
    "selected unit key and source scope",
  ],
  requiredPostRunEvidence: [
    "actual request count",
    "page count",
    "cache hit count",
    "cache miss count",
    "usage-check result",
    "credit or degraded diagnostic",
    "bulk-first confirmation or per-record fallback reason",
  ],
  evidenceDataClass: "provider-usage-summary",
} as const satisfies CatalogIntegrationScrydexLorcanaBulkImportPolicy;

function lorcanaAuthorityPolicy(
  policy: CatalogIntegrationLorcanaProviderAuthorityPolicy,
): CatalogIntegrationLorcanaProviderAuthorityPolicy {
  return policy;
}

function lorcanaValidationCheck(
  check: CatalogIntegrationLorcanaValidationCheck,
): CatalogIntegrationLorcanaValidationCheck {
  return check;
}

// ---------------------------------------------------------------------------
// Alias source governance
//
// Governs which external sources may supply an official English equivalent for a
// localized card/set/series name, which alias kinds may be auto-accepted versus
// held for review, how governed sources break ties when they disagree on the
// official English name, and how generated translations/romanizations are
// constrained. This is the policy the rest of the alias-equivalence pipeline
// references instead of inventing their own. The alias term and review-state
// strings here match the ADR slice (#1903) verbatim and are not imported from
// its not-yet-merged files.
// ---------------------------------------------------------------------------

/**
 * The semantic governing version of the alias source policy. Auto-accepted and
 * accepted aliases must record this version in their audit evidence so
 * a later policy change can be reconciled against what was true at acceptance.
 */
export const CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION = "alias-source-governance-v1";

/**
 * Approved categories of alias source. A category describes *how* a candidate
 * English equivalent was produced, independent of which concrete provider
 * supplied it. Display ownership lives elsewhere; this file owns trust only.
 */
export type CatalogAliasSourceCategoryKey =
  | "provider-same-id-localized-endpoint"
  | "provider-localized-name"
  | "official-english-source"
  | "curated-operator-mapping"
  | "species-reference"
  | "machine-translation"
  | "romanization";

/**
 * Alias term strings locked by the ADR slice (#1903). Used here only to express
 * which alias kinds each source category may produce.
 */
export type CatalogAliasTypeKey =
  | "official-equivalent"
  | "provider-localized-name"
  | "species-name"
  | "literal-translation"
  | "romanization"
  | "generated-translation"
  | "set-equivalent"
  | "series-equivalent";

/**
 * Acceptance disposition for a candidate alias from a given source category.
 * The disposition is an action so it never collides with a review-state noun:
 * `auto-accept` maps to the `auto-accepted` review state, `require-review` maps to
 * the `pending` review state, and `never-official` also maps to `pending`
 * (evidence-only, never official). Downstream slices gate on the resulting review
 * state, not on this disposition string.
 */
export type CatalogAliasAcceptancePolicy = "auto-accept" | "require-review" | "never-official";

/**
 * Alias review states locked by the ADR slice (#1903). `auto-accepted` and
 * `revoked` are required here; the full set is declared so downstream review
 * tooling can reference one source of truth.
 */
export type CatalogAliasReviewStateKey = "pending" | "accepted" | "auto-accepted" | "rejected" | "revoked";

export type CatalogAliasSourceGovernancePolicy = Readonly<{
  category: CatalogAliasSourceCategoryKey;
  displayName: string;
  /** Whether this category may be promoted to an official English equivalent. */
  canProvideOfficialEnglish: boolean;
  acceptancePolicy: CatalogAliasAcceptancePolicy;
  /** Alias kinds this category is allowed to produce. */
  producibleAliasTypes: readonly CatalogAliasTypeKey[];
  /**
   * Lower number wins when governed official-English sources disagree on the
   * official English name. `null` for categories that can never be official.
   */
  officialEnglishPrecedence: number | null;
  /** Aliases from this category are marked low-confidence, evidence-only. */
  evidenceMarkedLowConfidence: boolean;
  /** Storing official English names from this category needs legal/source approval first. */
  requiresLegalSourceApproval: boolean;
  /** Governed data class that backs this category's evidence retention/redaction. */
  evidenceDataClass: CatalogIntegrationGovernedDataClassKey;
  retentionPolicy: CatalogIntegrationGovernanceRetentionPolicy;
  notes: string;
}>;

export const catalogAliasSourceGovernancePolicies = [
  aliasSourcePolicy({
    category: "official-english-source",
    displayName: "Official English source",
    canProvideOfficialEnglish: true,
    acceptancePolicy: "auto-accept",
    producibleAliasTypes: ["official-equivalent", "set-equivalent", "series-equivalent"],
    officialEnglishPrecedence: 1,
    evidenceMarkedLowConfidence: false,
    requiresLegalSourceApproval: true,
    evidenceDataClass: "audit-evidence",
    retentionPolicy: "retain-audit-summary",
    notes:
      "Pokemon TCG official/card database and equivalent first-party English catalogs. Auto-accept only after legal/source approval for the named source is on record.",
  }),
  aliasSourcePolicy({
    category: "curated-operator-mapping",
    displayName: "Curated operator mapping",
    canProvideOfficialEnglish: true,
    acceptancePolicy: "auto-accept",
    producibleAliasTypes: ["official-equivalent", "set-equivalent", "series-equivalent"],
    officialEnglishPrecedence: 2,
    evidenceMarkedLowConfidence: false,
    requiresLegalSourceApproval: false,
    evidenceDataClass: "audit-evidence",
    retentionPolicy: "retain-audit-summary",
    notes:
      "Operator-maintained dictionary curated against approved sources. Each entry is itself an operator-reviewed decision and carries its own audit trail.",
  }),
  aliasSourcePolicy({
    category: "provider-same-id-localized-endpoint",
    displayName: "Provider same-id localized endpoint",
    canProvideOfficialEnglish: true,
    acceptancePolicy: "require-review",
    producibleAliasTypes: ["official-equivalent", "set-equivalent", "series-equivalent"],
    officialEnglishPrecedence: 3,
    evidenceMarkedLowConfidence: false,
    requiresLegalSourceApproval: true,
    evidenceDataClass: "audit-evidence",
    retentionPolicy: "retain-audit-summary",
    notes:
      "Same provider record id resolved against its English-language endpoint (e.g. TCGdex `en`). Strong evidence but held for review because cross-language id alignment is not guaranteed. The TCGdex `id` language code is Indonesian and is never English evidence.",
  }),
  aliasSourcePolicy({
    category: "provider-localized-name",
    displayName: "Provider localized name",
    canProvideOfficialEnglish: false,
    acceptancePolicy: "require-review",
    producibleAliasTypes: ["provider-localized-name"],
    officialEnglishPrecedence: null,
    evidenceMarkedLowConfidence: false,
    requiresLegalSourceApproval: false,
    evidenceDataClass: "audit-evidence",
    retentionPolicy: "retain-audit-summary",
    notes:
      "A provider's own localized (non-English) name. Useful search and matching evidence but not an official English equivalent on its own.",
  }),
  aliasSourcePolicy({
    category: "species-reference",
    displayName: "Species reference",
    canProvideOfficialEnglish: false,
    acceptancePolicy: "require-review",
    producibleAliasTypes: ["species-name"],
    officialEnglishPrecedence: null,
    evidenceMarkedLowConfidence: false,
    requiresLegalSourceApproval: false,
    evidenceDataClass: "audit-evidence",
    retentionPolicy: "retain-audit-summary",
    notes:
      "English species/creature name from a reference dictionary. Improves recall for many cards but is not the official printed card name and does not apply to Trainer/Energy cards.",
  }),
  aliasSourcePolicy({
    category: "machine-translation",
    displayName: "Machine translation",
    canProvideOfficialEnglish: false,
    acceptancePolicy: "never-official",
    producibleAliasTypes: ["literal-translation", "generated-translation"],
    officialEnglishPrecedence: null,
    evidenceMarkedLowConfidence: true,
    requiresLegalSourceApproval: false,
    evidenceDataClass: "engine-diagnostic",
    retentionPolicy: "retain-redacted-summary",
    notes:
      "Generated translation. Low-confidence, evidence-marked, reviewable, and never displayed as an official equivalent. May aid search recall only.",
  }),
  aliasSourcePolicy({
    category: "romanization",
    displayName: "Romanization",
    canProvideOfficialEnglish: false,
    acceptancePolicy: "never-official",
    producibleAliasTypes: ["romanization"],
    officialEnglishPrecedence: null,
    evidenceMarkedLowConfidence: true,
    requiresLegalSourceApproval: false,
    evidenceDataClass: "engine-diagnostic",
    retentionPolicy: "retain-redacted-summary",
    notes:
      "Transliteration of a localized name into Latin script. Low-confidence, evidence-marked, never an official equivalent.",
  }),
] as const satisfies readonly CatalogAliasSourceGovernancePolicy[];

export const catalogAliasSourceGovernancePoliciesByCategory: Readonly<
  Record<CatalogAliasSourceCategoryKey, CatalogAliasSourceGovernancePolicy>
> = Object.fromEntries(catalogAliasSourceGovernancePolicies.map((entry) => [entry.category, entry])) as Readonly<
  Record<CatalogAliasSourceCategoryKey, CatalogAliasSourceGovernancePolicy>
>;

export function getCatalogAliasSourceGovernancePolicy(
  category: CatalogAliasSourceCategoryKey,
): CatalogAliasSourceGovernancePolicy {
  return catalogAliasSourceGovernancePoliciesByCategory[category];
}

/**
 * The ordered list of source categories that may decide the official English
 * name when governed sources disagree, lowest precedence number first. Consumed
 * by promotion conflict handling.
 */
export function catalogAliasOfficialEnglishPrecedenceOrder(): readonly CatalogAliasSourceCategoryKey[] {
  return catalogAliasSourceGovernancePolicies
    .filter(
      (entry): entry is CatalogAliasSourceGovernancePolicy & { officialEnglishPrecedence: number } =>
        entry.canProvideOfficialEnglish && entry.officialEnglishPrecedence !== null,
    )
    .slice()
    .sort((left, right) => left.officialEnglishPrecedence - right.officialEnglishPrecedence)
    .map((entry) => entry.category);
}

/**
 * Resolve the official-English winner when governed sources disagree. Returns
 * the candidate from the category with the strongest (lowest) precedence. The
 * TCGdex `id` (Indonesian) language code is rejected up front and never counts
 * as English evidence regardless of which category cites it.
 */
export type CatalogAliasOfficialEnglishCandidate = Readonly<{
  category: CatalogAliasSourceCategoryKey;
  englishName: string;
  /** Provider language code the candidate was read from, when applicable. */
  languageCode?: string | null;
}>;

export type CatalogAliasOfficialEnglishResolution = Readonly<{
  winner: CatalogAliasOfficialEnglishCandidate | null;
  rejected: readonly Readonly<{
    candidate: CatalogAliasOfficialEnglishCandidate;
    reason: "non-english-evidence" | "category-cannot-be-official" | "outranked";
  }>[];
}>;

export const TCGDEX_INDONESIAN_LANGUAGE_CODE = "id";

export function resolveCatalogAliasOfficialEnglish(
  candidates: readonly CatalogAliasOfficialEnglishCandidate[],
): CatalogAliasOfficialEnglishResolution {
  const rejected: {
    candidate: CatalogAliasOfficialEnglishCandidate;
    reason: "non-english-evidence" | "category-cannot-be-official" | "outranked";
  }[] = [];

  const eligible = candidates.filter((candidate) => {
    if (isRejectedNonEnglishLanguageCode(candidate.languageCode)) {
      rejected.push({ candidate, reason: "non-english-evidence" });
      return false;
    }

    if (!getCatalogAliasSourceGovernancePolicy(candidate.category).canProvideOfficialEnglish) {
      rejected.push({ candidate, reason: "category-cannot-be-official" });
      return false;
    }

    return true;
  });

  const ranked = eligible
    .slice()
    .sort(
      (left, right) => officialEnglishPrecedenceRank(left.category) - officialEnglishPrecedenceRank(right.category),
    );

  const [winner, ...outranked] = ranked;
  for (const candidate of outranked) {
    rejected.push({ candidate, reason: "outranked" });
  }

  return { winner: winner ?? null, rejected };
}

/**
 * The TCGdex `id` language code is Indonesian, not an English identifier, and is
 * never accepted as English evidence.
 */
export function isRejectedNonEnglishLanguageCode(languageCode: string | null | undefined): boolean {
  if (!languageCode) {
    return false;
  }

  return languageCode.trim().toLowerCase() === TCGDEX_INDONESIAN_LANGUAGE_CODE;
}

/**
 * Decide the acceptance disposition for a candidate alias. Auto-accept is only
 * available when the source category allows it *and*, for categories that store
 * official English names from third parties, legal/source approval is on record.
 */
export type CatalogAliasAcceptanceDecisionInput = Readonly<{
  category: CatalogAliasSourceCategoryKey;
  /** Provider language code the candidate was read from, when applicable. */
  languageCode?: string | null;
  /** Whether the named source has legal/source approval recorded for storing English names. */
  hasLegalSourceApproval?: boolean;
}>;

export type CatalogAliasAcceptanceDecision = Readonly<{
  category: CatalogAliasSourceCategoryKey;
  reviewState: Extract<CatalogAliasReviewStateKey, "auto-accepted" | "pending">;
  /** Whether the resulting alias may be promoted to/displayed as an official equivalent. */
  official: boolean;
  evidenceMarkedLowConfidence: boolean;
  /** Governing policy version recorded in the audit trail for this decision. */
  policyVersion: typeof CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION;
  reasons: readonly string[];
}>;

export function decideCatalogAliasAcceptance(
  input: CatalogAliasAcceptanceDecisionInput,
): CatalogAliasAcceptanceDecision {
  const policy = getCatalogAliasSourceGovernancePolicy(input.category);
  const reasons: string[] = [];

  let reviewState: Extract<CatalogAliasReviewStateKey, "auto-accepted" | "pending"> = "pending";

  if (isRejectedNonEnglishLanguageCode(input.languageCode)) {
    reasons.push(`Language code '${input.languageCode}' is Indonesian and is never English evidence.`);
  } else if (policy.acceptancePolicy === "auto-accept") {
    if (policy.requiresLegalSourceApproval && !input.hasLegalSourceApproval) {
      reasons.push(`${policy.displayName} requires recorded legal/source approval before auto-accept.`);
    } else {
      reviewState = "auto-accepted";
      reasons.push(`${policy.displayName} is auto-accepted under ${CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION}.`);
    }
  } else if (policy.acceptancePolicy === "never-official") {
    reasons.push(`${policy.displayName} is evidence-only and is held for review; it can never become official.`);
  } else {
    reasons.push(`${policy.displayName} is held for pending review.`);
  }

  return {
    category: input.category,
    reviewState,
    official: reviewState === "auto-accepted" && policy.canProvideOfficialEnglish,
    evidenceMarkedLowConfidence: policy.evidenceMarkedLowConfidence,
    policyVersion: CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION,
    reasons,
  };
}

/**
 * Audit fields that must be recorded for every accepted, auto-accepted,
 * or revoked alias decision so a later policy change can be reconciled.
 */
export function catalogAliasAcceptanceAuditRequirements(): readonly string[] {
  return [
    "alias type and source category",
    "review state (auto-accepted, accepted, rejected, or revoked)",
    `governing policy version (${CATALOG_ALIAS_SOURCE_GOVERNANCE_POLICY_VERSION})`,
    "source category precedence rank used for any official-English winner",
    "actor (operator id for accepted/revoked, system for auto-accepted)",
    "redacted source evidence reference and content hash, never the raw provider body",
    "whether the alias is marked official or low-confidence evidence-only",
    "legal/source approval reference when storing an official English name from a third party",
  ];
}

/**
 * Governance/fixture requirements a future translation provider adapter must
 * satisfy before it may produce alias evidence.
 */
export function catalogAliasTranslationProviderRequirements(): readonly string[] {
  return [
    "Generated aliases must be marked low-confidence and evidence-only, never displayed as official equivalents.",
    "Adapter output must carry deterministic fixtures proving alias type, source category, and confidence marking.",
    "Adapter must never emit an `official-equivalent` alias type; only `generated-translation`, `literal-translation`, or `romanization`.",
    "Adapter evidence retention and redaction follow the engine-diagnostic governed data class.",
    "Adapter must declare its source category and pass language-code validation that rejects TCGdex `id` (Indonesian) as English.",
    "Legal/source approval is required before any new official English source is wired in; translation adapters never grant official status.",
  ];
}

function aliasSourcePolicy(input: CatalogAliasSourceGovernancePolicy): CatalogAliasSourceGovernancePolicy {
  return input;
}

function officialEnglishPrecedenceRank(category: CatalogAliasSourceCategoryKey): number {
  const precedence = getCatalogAliasSourceGovernancePolicy(category).officialEnglishPrecedence;
  return precedence ?? Number.POSITIVE_INFINITY;
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
