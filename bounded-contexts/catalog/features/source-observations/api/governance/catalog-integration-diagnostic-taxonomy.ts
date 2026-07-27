export type CatalogIntegrationDiagnosticSource =
  | "adapter"
  | "profile-section"
  | "fixture"
  | "engine"
  | "job"
  | "read-model"
  | "credential-readiness"
  | "projection-lag"
  | "admin-route"
  | "alias-equivalence"
  | "provider-comparison";

export type CatalogIntegrationDiagnosticSeverity = "info" | "warning" | "error" | "blocked";

export type CatalogIntegrationDiagnosticBlockingBehavior =
  | "activation-blocking"
  | "import-blocking"
  | "promotion-blocking"
  | "rollback-blocking"
  | "retirement-blocking"
  | "read-model-blocking"
  | "advisory"
  | "retryable";

export type CatalogIntegrationDiagnosticOperatorVisibility = "summary" | "detail" | "support" | "metric-only";

export type CatalogIntegrationDiagnosticEvidencePolicy =
  | "no-evidence"
  | "safe-catalog-evidence"
  | "redacted-provider-evidence"
  | "credential-redacted"
  | "projection-metadata-only";

export type CatalogIntegrationDiagnosticTaxonomyEntry = Readonly<{
  code: string;
  source: CatalogIntegrationDiagnosticSource;
  severity: CatalogIntegrationDiagnosticSeverity;
  blockingBehavior: CatalogIntegrationDiagnosticBlockingBehavior;
  operatorVisibility: CatalogIntegrationDiagnosticOperatorVisibility;
  metricKey: string;
  remediation: string;
  evidencePolicy: CatalogIntegrationDiagnosticEvidencePolicy;
  groupingKeys: readonly CatalogIntegrationDiagnosticGroupingKey[];
}>;

export type CatalogIntegrationDiagnosticGroupingKey =
  | "providerKey"
  | "profileVersion"
  | "sectionKey"
  | "path"
  | "unitKey"
  | "fixtureFlow"
  | "jobKind"
  | "jobId"
  | "readModelKey"
  | "projectionName"
  | "aliasTargetKind"
  | "aliasType"
  | "aliasLanguageCode"
  | "comparisonSourceKey"
  | "externalId"
  | "fieldClass"
  | "decisionPath";

export type CatalogIntegrationDiagnosticInstance = Readonly<{
  code: CatalogIntegrationDiagnosticCode;
  path: string;
  diagnosticText: string;
  source?: CatalogIntegrationDiagnosticSource;
  severity?: CatalogIntegrationDiagnosticSeverity;
  providerKey?: string;
  profileVersion?: string;
  sectionKey?: string;
  unitKey?: string;
  remediation?: string;
  comparisonSourceKey?: string;
  externalId?: string;
  fieldClass?: string;
  decisionPath?: string;
}>;

export const catalogIntegrationDiagnosticTaxonomy = [
  entry("reference-fixtures-ready", "adapter", "info", "advisory", "summary", "Fixtures are ready.", "no-evidence"),
  entry("fixture-backed-provider", "adapter", "info", "advisory", "summary", "Fixture-backed provider is healthy."),
  entry("adapter-unavailable", "adapter", "error", "retryable", "summary", "Check provider reachability and retry."),
  entry(
    "adapter-authentication-failed",
    "credential-readiness",
    "blocked",
    "import-blocking",
    "summary",
    "Rotate or reconfigure provider credentials before importing.",
    "credential-redacted",
  ),
  entry("adapter-rate-limited", "adapter", "warning", "retryable", "summary", "Wait for the retry window."),
  entry("adapter-contract-drift", "adapter", "error", "import-blocking", "support", "Update the adapter contract."),

  entry(
    "provider-key-mismatch",
    "profile-section",
    "error",
    "activation-blocking",
    "detail",
    "Align the provider key across the version record, profile payload, and engine input.",
  ),
  entry("missing-profile-version", "profile-section", "error", "activation-blocking", "detail", "Set a version."),
  entry(
    "missing-profile-fixture-flow",
    "profile-section",
    "error",
    "activation-blocking",
    "detail",
    "Add fixture coverage for every required flow.",
  ),
  entry(
    "missing-retirement-plan",
    "profile-section",
    "error",
    "activation-blocking",
    "detail",
    "Add a retirement plan for transitional profiles.",
  ),
  entry(
    "missing-executable-mapping-contract",
    "profile-section",
    "error",
    "activation-blocking",
    "detail",
    "Attach an executable mapping contract.",
  ),
  entry(
    "mapping-contract-mismatch",
    "profile-section",
    "error",
    "activation-blocking",
    "detail",
    "Match the mapping contract identity to the profile version.",
  ),
  entry(
    "mapping-contract-diagnostic",
    "profile-section",
    "error",
    "activation-blocking",
    "detail",
    "Resolve the nested mapping contract diagnostic.",
  ),
  entry(
    "ingestion-unit-provider-mismatch",
    "profile-section",
    "error",
    "activation-blocking",
    "detail",
    "Align ingestion-unit provider identity with the profile version.",
  ),
  entry(
    "raw-graded-unit-split",
    "profile-section",
    "error",
    "activation-blocking",
    "detail",
    "Model raw and graded cards inside one single-card ingestion unit.",
  ),
  entry(
    "fixture-live-provider-calls",
    "fixture",
    "error",
    "activation-blocking",
    "summary",
    "Replace live provider calls with fixture-backed validation.",
  ),
  entry(
    "fixture-missing-flow",
    "fixture",
    "error",
    "activation-blocking",
    "detail",
    "Add the missing required fixture flow.",
  ),
  entry(
    "activation-mutable-lifecycle",
    "profile-section",
    "error",
    "activation-blocking",
    "summary",
    "Move the profile version to draft or test before activation.",
  ),
  entry(
    "activation-executable-mapping-contract",
    "profile-section",
    "error",
    "activation-blocking",
    "summary",
    "Attach an executable mapping contract before activation.",
  ),
  entry(
    "activation-import-eligibility",
    "profile-section",
    "error",
    "activation-blocking",
    "summary",
    "Add source-observation-import capability before activation.",
  ),
  entry(
    "activation-fixture-live-calls",
    "fixture",
    "error",
    "activation-blocking",
    "summary",
    "Remove live provider calls from fixture validation.",
  ),
  entry(
    "activation-fixture-covered-flow",
    "fixture",
    "error",
    "activation-blocking",
    "detail",
    "Add fixture coverage for the named flow.",
  ),
  entry(
    "activation-profile-validation",
    "profile-section",
    "error",
    "activation-blocking",
    "detail",
    "Resolve profile validation diagnostics before activation.",
  ),
  entry(
    "activation-migration-evidence",
    "profile-section",
    "error",
    "activation-blocking",
    "summary",
    "Record migration evidence for mapping fingerprint changes.",
  ),
  entry(
    "deprecation-lifecycle",
    "profile-section",
    "error",
    "rollback-blocking",
    "summary",
    "Deprecate only active profiles.",
  ),
  entry(
    "retirement-active-profile",
    "profile-section",
    "error",
    "retirement-blocking",
    "summary",
    "Deactivate the profile before retirement.",
  ),
  entry(
    "retirement-source-observation-references",
    "profile-section",
    "error",
    "retirement-blocking",
    "summary",
    "Clear or migrate Source Observation references before retirement.",
  ),
  entry("retirement-lifecycle", "profile-section", "warning", "advisory", "detail", "No action is needed."),

  entry(
    "missing-fixture-flow",
    "fixture",
    "error",
    "activation-blocking",
    "detail",
    "Add the missing mapping fixture flow.",
  ),
  entry(
    "live-provider-calls-in-fixtures",
    "fixture",
    "error",
    "activation-blocking",
    "summary",
    "Replace live calls with recorded fixtures.",
  ),
  entry(
    "unsafe-owner-for-catalog-use",
    "engine",
    "blocked",
    "activation-blocking",
    "summary",
    "Move price, inventory, operations, or excluded evidence out of Catalog truth uses.",
    "redacted-provider-evidence",
  ),
  entry(
    "secret-used-as-catalog-fact",
    "credential-readiness",
    "blocked",
    "activation-blocking",
    "summary",
    "Remove secret evidence from Catalog facts, hashes, logs, and UI text.",
    "credential-redacted",
  ),

  entry("missing-required-path", "engine", "error", "promotion-blocking", "detail", "Map a present provider path."),
  entry("null-not-allowed", "engine", "error", "promotion-blocking", "detail", "Allow nulls or map a non-null field."),
  entry("expected-array", "engine", "error", "promotion-blocking", "detail", "Map an array provider field."),
  entry("empty-array", "engine", "warning", "advisory", "detail", "Confirm whether empty provider arrays are valid."),
  entry(
    "unregistered-named-selector",
    "engine",
    "error",
    "promotion-blocking",
    "detail",
    "Register the named selector for this interpreter run.",
  ),
  entry(
    "unregistered-named-transform",
    "engine",
    "error",
    "promotion-blocking",
    "detail",
    "Register the named transform for this interpreter run.",
  ),
  entry(
    "transform-type-mismatch",
    "engine",
    "error",
    "promotion-blocking",
    "detail",
    "Fix selector or transform type.",
  ),
  entry("coerce-failed", "engine", "error", "promotion-blocking", "detail", "Map a value that can be coerced safely."),
  entry("lookup-miss", "engine", "warning", "advisory", "detail", "Add mapping aliases or review evidence."),

  entry(
    "missing-provider-value",
    "engine",
    "error",
    "promotion-blocking",
    "detail",
    "Map the required provider selected-option value.",
  ),
  entry(
    "missing-schema-dimension",
    "engine",
    "error",
    "promotion-blocking",
    "detail",
    "Add or map the required Product schema dimension.",
  ),
  entry(
    "inactive-schema-dimension",
    "engine",
    "error",
    "promotion-blocking",
    "detail",
    "Reactivate or remap the schema dimension.",
  ),
  entry(
    "unknown-provider-option",
    "engine",
    "warning",
    "advisory",
    "detail",
    "Add an option alias or review evidence.",
  ),
  entry(
    "inactive-schema-option",
    "engine",
    "error",
    "promotion-blocking",
    "detail",
    "Reactivate or remap the selected option.",
  ),
  entry(
    "missing-reference-value",
    "engine",
    "warning",
    "advisory",
    "detail",
    "Map a provider reference value or keep the row as review evidence.",
  ),
  entry(
    "missing-selected-options",
    "engine",
    "warning",
    "advisory",
    "detail",
    "Resolve selected options before writing Product references.",
  ),
  entry(
    "repeated-ambiguous-reference",
    "engine",
    "warning",
    "advisory",
    "detail",
    "Drop repeated provider references or route them to review.",
  ),
  entry(
    "wrong-target-level",
    "engine",
    "error",
    "promotion-blocking",
    "detail",
    "Use the correct Catalog Item or Product reference target.",
  ),

  entry(
    "integration-unit-mismatch",
    "engine",
    "error",
    "import-blocking",
    "summary",
    "Align payload unit identity with the requested ingestion unit.",
  ),
  entry(
    "normalized-observation-identity-mismatch",
    "engine",
    "error",
    "promotion-blocking",
    "summary",
    "Align normalized observation identity with payload provenance.",
  ),
  entry(
    "no-provider-payloads",
    "adapter",
    "warning",
    "retryable",
    "summary",
    "Retry after provider payloads are available.",
  ),

  entry(
    "missing-promotion-capability",
    "engine",
    "error",
    "promotion-blocking",
    "summary",
    "Add catalog-item-promotion capability to the profile.",
  ),
  entry(
    "unsupported-profile-mapping-kind",
    "engine",
    "error",
    "promotion-blocking",
    "summary",
    "Use a supported profile mapping kind for promotion.",
  ),
  entry(
    "unsupported-observation-kind",
    "engine",
    "error",
    "promotion-blocking",
    "summary",
    "Use a supported normalized observation kind for promotion.",
  ),
  entry(
    "ambiguous-duplicate-candidates",
    "engine",
    "blocked",
    "promotion-blocking",
    "summary",
    "Resolve duplicate candidates before promotion.",
  ),
  entry(
    "missing-catalog-item-target",
    "engine",
    "blocked",
    "promotion-blocking",
    "summary",
    "Choose or create the Catalog Item target.",
  ),
  entry(
    "runtime-preflight-failed",
    "engine",
    "blocked",
    "promotion-blocking",
    "summary",
    "Resolve runtime preflight failures before promotion.",
  ),

  entry(
    "external-key-change",
    "engine",
    "warning",
    "advisory",
    "detail",
    "Record migration evidence before changing external key semantics.",
  ),
  entry(
    "source-hash-change",
    "engine",
    "warning",
    "advisory",
    "detail",
    "Record migration evidence before changing source hash material.",
  ),
  entry(
    "selected-option-change",
    "engine",
    "warning",
    "advisory",
    "detail",
    "Record migration evidence before changing selected-option mapping.",
  ),
  entry(
    "reference-target-level-change",
    "engine",
    "warning",
    "advisory",
    "detail",
    "Record migration evidence before changing reference target levels.",
  ),
  entry(
    "promotion-plan-change",
    "engine",
    "warning",
    "advisory",
    "detail",
    "Record migration evidence before changing promotion commands.",
  ),
  entry(
    "missing-migration-evidence",
    "profile-section",
    "error",
    "activation-blocking",
    "summary",
    "Record migration evidence for the mapping change.",
  ),
  entry("import-eligibility", "engine", "error", "import-blocking", "summary", "Resolve import eligibility blockers."),

  entry(
    "one-piece-provider-disagreement",
    "provider-comparison",
    "warning",
    "advisory",
    "detail",
    "Review the redacted One Piece provider comparison before promotion.",
    "redacted-provider-evidence",
  ),
  entry(
    "one-piece-fallback-source-unapproved",
    "provider-comparison",
    "blocked",
    "promotion-blocking",
    "summary",
    "Record named source approval before using fallback evidence.",
    "redacted-provider-evidence",
  ),

  entry(
    "fixture-harness-failure",
    "fixture",
    "error",
    "activation-blocking",
    "summary",
    "Fix fixture harness failures before activation.",
  ),
  entry(
    "fixture-secret-evidence",
    "fixture",
    "blocked",
    "activation-blocking",
    "summary",
    "Remove secret, seller, price, inventory, or operations evidence from fixtures.",
    "credential-redacted",
  ),
  entry("fixture-status-mismatch", "fixture", "error", "activation-blocking", "detail", "Update fixture expectation."),
  entry(
    "fixture-expected-diagnostic-missing",
    "fixture",
    "error",
    "activation-blocking",
    "detail",
    "Update mapping or fixture expected diagnostic paths.",
  ),
  entry(
    "fixture-unexpected-diagnostic",
    "fixture",
    "error",
    "activation-blocking",
    "detail",
    "Fix unexpected fixture diagnostics.",
  ),
  entry(
    "fixture-observation-missing",
    "fixture",
    "error",
    "activation-blocking",
    "detail",
    "Fix normalization so the fixture produces an observation.",
  ),
  entry(
    "fixture-evidence-missing",
    "fixture",
    "error",
    "activation-blocking",
    "detail",
    "Fix mapping evidence output for the fixture.",
  ),
  entry(
    "fixture-command-missing",
    "fixture",
    "error",
    "activation-blocking",
    "detail",
    "Fix promotion command output for the fixture.",
  ),

  entry("job-not-found", "job", "error", "read-model-blocking", "summary", "Refresh the job list."),
  entry("job-stale-checkpoint", "job", "warning", "retryable", "summary", "Resume from the latest checkpoint."),
  entry(
    "job-work-unit-failed",
    "job",
    "error",
    "import-blocking",
    "detail",
    "Review failed work units and retry safely.",
  ),
  entry(
    "source-projection-stale",
    "projection-lag",
    "warning",
    "retryable",
    "summary",
    "Wait for projection catch-up.",
  ),
  entry(
    "audit-projection-unavailable",
    "projection-lag",
    "error",
    "read-model-blocking",
    "summary",
    "Rebuild or restart the audit evidence projection.",
    "projection-metadata-only",
  ),
  entry(
    "read-model-unavailable",
    "read-model",
    "error",
    "read-model-blocking",
    "summary",
    "Show unavailable state and retry after source recovery.",
    "projection-metadata-only",
  ),
  entry(
    "read-model-partial",
    "read-model",
    "warning",
    "advisory",
    "summary",
    "Render partial results with source attribution.",
    "projection-metadata-only",
  ),
  entry(
    "diagnostic-rate-threshold-exceeded",
    "read-model",
    "warning",
    "advisory",
    "metric-only",
    "Investigate sustained diagnostic rate increases by code and provider.",
    "projection-metadata-only",
  ),
  entry(
    "credential-missing",
    "credential-readiness",
    "blocked",
    "import-blocking",
    "summary",
    "Configure provider credentials.",
    "credential-redacted",
  ),
  entry(
    "credential-expired",
    "credential-readiness",
    "blocked",
    "import-blocking",
    "summary",
    "Rotate expired provider credentials.",
    "credential-redacted",
  ),
  entry(
    "credential-invalid",
    "credential-readiness",
    "blocked",
    "import-blocking",
    "summary",
    "Validate and reconfigure provider credentials.",
    "credential-redacted",
  ),
  entry(
    "credential-revoked",
    "credential-readiness",
    "blocked",
    "import-blocking",
    "summary",
    "Replace revoked provider credentials.",
    "credential-redacted",
  ),
  entry("invalid_json_body", "admin-route", "error", "advisory", "detail", "Send a valid JSON object request body."),
  entry(
    "invalid_profile_section_command",
    "admin-route",
    "error",
    "advisory",
    "detail",
    "Send a valid typed profile section command.",
  ),
  entry(
    "profile_activation_blocked",
    "admin-route",
    "blocked",
    "activation-blocking",
    "summary",
    "Resolve nested activation diagnostics.",
  ),

  // -------------------------------------------------------------------------
  // Catalog Alias equivalence diagnostics
  //
  // The end-to-end alias pipeline (TCGdex Japanese import -> Source Observation
  // -> alias candidate -> review -> promotion -> published resolved fact ->
  // Discovery search -> English display) has its own failure modes that the
  // generic provider/engine diagnostics do not name. These cover the seven
  // failures the milestone e2e proof exercises, with operator-safe remediation.
  // -------------------------------------------------------------------------
  entry(
    "alias-provider-endpoint-missing",
    "alias-equivalence",
    "warning",
    "advisory",
    "detail",
    "The provider English mirror endpoint did not exist for this id; keep the native alias and review for an English equivalent later.",
    "redacted-provider-evidence",
  ),
  entry(
    "alias-coverage-incomplete",
    "alias-equivalence",
    "warning",
    "advisory",
    "summary",
    "Some cards in scope still lack an accepted English alias; finish review before relying on English search and display for them.",
  ),
  entry(
    "alias-pending-candidates-block-high-confidence-search",
    "alias-equivalence",
    "warning",
    "advisory",
    "summary",
    "Pending alias candidates are not published; accept them in alias review so English search reaches the card with high-confidence weight.",
  ),
  entry(
    "alias-resolved-projection-lag",
    "projection-lag",
    "warning",
    "retryable",
    "summary",
    "Resolved-alias recompute or the Discovery alias projection is behind; wait for catch-up or drain the recompute work before checking search.",
    "projection-metadata-only",
  ),
  entry(
    "alias-stale-resolved-hash",
    "alias-equivalence",
    "warning",
    "retryable",
    "support",
    "The published resolved-alias hash no longer matches the publishable aliases; run alias backfill to rebuild the resolved fact.",
    "projection-metadata-only",
  ),
  entry(
    "alias-search-rollout-disabled",
    "alias-equivalence",
    "info",
    "advisory",
    "summary",
    "Alias contribution to Discovery search is disabled by the DISCOVERY_ALIAS_SEARCH kill-switch; re-enable it and rebuild the search index to restore alias recall.",
  ),
  entry(
    "alias-native-script-tokenization-gap",
    "alias-equivalence",
    "warning",
    "advisory",
    "support",
    "A native CJK alias produced no search bigrams, so native substring search will miss it; check the alias text and Discovery normalization.",
  ),
] as const satisfies readonly CatalogIntegrationDiagnosticTaxonomyEntry[];

export type CatalogIntegrationDiagnosticCode = (typeof catalogIntegrationDiagnosticTaxonomy)[number]["code"];

export const catalogIntegrationDiagnosticCodes = catalogIntegrationDiagnosticTaxonomy.map((entry) => entry.code);

export const catalogIntegrationDiagnosticTaxonomyByCode: Readonly<
  Record<CatalogIntegrationDiagnosticCode, CatalogIntegrationDiagnosticTaxonomyEntry>
> = Object.fromEntries(catalogIntegrationDiagnosticTaxonomy.map((entry) => [entry.code, entry])) as Readonly<
  Record<CatalogIntegrationDiagnosticCode, CatalogIntegrationDiagnosticTaxonomyEntry>
>;

export function getCatalogIntegrationDiagnosticDefinition(
  code: CatalogIntegrationDiagnosticCode,
): CatalogIntegrationDiagnosticTaxonomyEntry {
  return catalogIntegrationDiagnosticTaxonomyByCode[code];
}

export function toCatalogIntegrationDiagnostic(
  input: CatalogIntegrationDiagnosticInstance,
): CatalogIntegrationDiagnosticInstance {
  const definition = getCatalogIntegrationDiagnosticDefinition(input.code);
  return {
    ...input,
    source: input.source ?? definition.source,
    severity: input.severity ?? definition.severity,
    remediation: input.remediation ?? definition.remediation,
  };
}

export function assertCatalogIntegrationDiagnosticTaxonomyCoverage(
  requiredCodes: readonly string[],
): asserts requiredCodes is readonly CatalogIntegrationDiagnosticCode[] {
  const missingCodes = requiredCodes.filter((code) => !(code in catalogIntegrationDiagnosticTaxonomyByCode));
  if (missingCodes.length > 0) {
    throw new Error(`Missing Catalog integration diagnostic taxonomy entries for: ${missingCodes.join(", ")}`);
  }
}

function entry<const TCode extends string>(
  code: TCode,
  source: CatalogIntegrationDiagnosticSource,
  severity: CatalogIntegrationDiagnosticSeverity,
  blockingBehavior: CatalogIntegrationDiagnosticBlockingBehavior,
  operatorVisibility: CatalogIntegrationDiagnosticOperatorVisibility,
  remediation: string,
  evidencePolicy: CatalogIntegrationDiagnosticEvidencePolicy = "safe-catalog-evidence",
): CatalogIntegrationDiagnosticTaxonomyEntry & Readonly<{ code: TCode }> {
  return {
    code,
    source,
    severity,
    blockingBehavior,
    operatorVisibility,
    metricKey: `catalog.integration.diagnostic.${code.replace(/-/g, "_")}`,
    remediation,
    evidencePolicy,
    groupingKeys: groupingKeysFor(source),
  };
}

function groupingKeysFor(
  source: CatalogIntegrationDiagnosticSource,
): readonly CatalogIntegrationDiagnosticGroupingKey[] {
  switch (source) {
    case "adapter":
    case "credential-readiness":
      return ["providerKey", "unitKey"];
    case "profile-section":
      return ["providerKey", "profileVersion", "sectionKey", "path"];
    case "fixture":
      return ["providerKey", "profileVersion", "fixtureFlow", "path"];
    case "engine":
      return ["providerKey", "profileVersion", "unitKey", "path"];
    case "job":
      return ["jobKind", "jobId", "unitKey"];
    case "read-model":
      return ["readModelKey", "unitKey"];
    case "projection-lag":
      return ["projectionName", "unitKey"];
    case "admin-route":
      return ["providerKey", "profileVersion", "path"];
    case "alias-equivalence":
      return ["providerKey", "aliasTargetKind", "aliasType", "aliasLanguageCode"];
    case "provider-comparison":
      return ["providerKey", "unitKey", "comparisonSourceKey", "externalId", "fieldClass", "decisionPath"];
  }
}
