import type { CatalogProviderProfileLifecycle } from "../providers/provider-integration-mapping-contract";
import { CATALOG_INTEGRATION_ONE_PIECE_PRODUCTION_SIGNOFF_REFERENCE_ENV } from "./catalog-integration-data-governance";
import { listCatalogProviderIntegrationProfiles } from "../provider-integration-profiles";

export type CatalogIntegrationRolloutControlId =
  | "control-plane-read-only"
  | "dry-run-only"
  | "provider-adapter-disabled"
  | "provider-option-queries-disabled"
  | "provider-option-queries-cache-only"
  | "imports-disabled"
  | "promotion-disabled"
  | "reapply-disabled"
  | "activation-disabled"
  | "activation-test-profiles-only"
  | "magic-production-signoff-required"
  | "one-piece-production-signoff-required"
  | "rollback-ready-release-mode"
  | "worker-processing-disabled"
  | "worker-lane-limited"
  | "provider-api-emergency-stop";

export type CatalogIntegrationRolloutCapability =
  | "provider-transport"
  | "provider-option-query"
  | "import"
  | "promotion"
  | "reapply"
  | "activation"
  | "worker-job-processing";

export type CatalogIntegrationRolloutControlStatus = "open" | "degraded" | "blocked";

export type CatalogIntegrationRolloutControl = Readonly<{
  controlId: CatalogIntegrationRolloutControlId;
  defaultState: "open";
  status: CatalogIntegrationRolloutControlStatus;
  severity: "info" | "warning" | "error";
  capabilities: readonly CatalogIntegrationRolloutCapability[];
  providerKeys: readonly string[];
  profileKeys: readonly string[];
  unitKeys: readonly string[];
  message: string;
  auditEventName: "rollout-control-evaluated" | "rollout-control-denied";
  metricKey: string;
}>;

export type CatalogIntegrationRolloutControlSnapshot = Readonly<{
  generatedAt: string;
  controls: readonly CatalogIntegrationRolloutControl[];
}>;

export type CatalogIntegrationRolloutDecisionInput = Readonly<{
  capability: CatalogIntegrationRolloutCapability;
  providerKey?: string | null;
  profileKey?: string | null;
  profileVersion?: string | null;
  profileLifecycle?: CatalogProviderProfileLifecycle | string | null;
  unitKey?: string | null;
}>;

export type CatalogIntegrationRolloutDecision = Readonly<{
  allowed: boolean;
  capability: CatalogIntegrationRolloutCapability;
  controls: readonly CatalogIntegrationRolloutControl[];
  diagnosticCode: "catalog-integration-rollout-control-denied" | null;
  message: string | null;
}>;

export type CatalogIntegrationRolloutControlConfig = Readonly<{
  controlPlaneMode?: "open" | "read-only" | "dry-run-only" | "rollback-ready" | null;
  disabledProviderAdapters?: readonly string[] | "all" | null;
  disabledProviderAdapterUnits?: readonly string[] | "all" | null;
  providerApiEmergencyStop?: readonly string[] | "all" | null;
  providerApiEmergencyStopUnits?: readonly string[] | "all" | null;
  providerOptionQueries?: "open" | "disabled" | "cache-only" | null;
  disabledProviderOptionQueryProviders?: readonly string[] | "all" | null;
  disabledProviderOptionQueryUnits?: readonly string[] | "all" | null;
  cacheOnlyProviderOptionQueryProviders?: readonly string[] | "all" | null;
  cacheOnlyProviderOptionQueryUnits?: readonly string[] | "all" | null;
  disabledImports?: readonly string[] | "all" | null;
  disabledImportUnits?: readonly string[] | "all" | null;
  disabledPromotion?: readonly string[] | "all" | null;
  disabledPromotionUnits?: readonly string[] | "all" | null;
  disabledReapply?: readonly string[] | "all" | null;
  disabledReapplyUnits?: readonly string[] | "all" | null;
  activationMode?: "open" | "disabled" | "test-profiles-only" | null;
  magicProductionSignoffReference?: string | null;
  onePieceProductionSignoffReference?: string | null;
  workerMode?: "open" | "disabled" | "lane-limited" | null;
}>;

export type CatalogIntegrationRolloutControlPolicy = Readonly<{
  snapshot: () => CatalogIntegrationRolloutControlSnapshot;
  decide: (input: CatalogIntegrationRolloutDecisionInput) => CatalogIntegrationRolloutDecision;
  assertAllowed: (input: CatalogIntegrationRolloutDecisionInput) => void;
}>;

export class CatalogIntegrationRolloutControlError extends Error {
  readonly code = "catalog_integration_rollout_control_denied";
  readonly decision: CatalogIntegrationRolloutDecision;

  constructor(decision: CatalogIntegrationRolloutDecision) {
    super(decision.message ?? "Catalog integration rollout control denied the operation.");
    this.name = "CatalogIntegrationRolloutControlError";
    this.decision = decision;
  }
}

const CONTROL_PLANE_READ_ONLY_MESSAGE = "Catalog Integration Control Plane read-only mode is active.";
const CONTROL_PLANE_DRY_RUN_ONLY_MESSAGE = "Catalog Integration Control Plane dry-run-only mode is active.";
const ROLLBACK_READY_RELEASE_MODE_MESSAGE = "Catalog Integration Control Plane rollback-ready release mode is active.";
const CONTROL_PLANE_OPEN_MESSAGE = "Catalog Integration Control Plane write workflows are open.";
const PROVIDER_OPTION_QUERIES_DISABLED_MESSAGE = "Provider option queries are disabled.";
const PROVIDER_OPTION_QUERIES_CACHE_ONLY_MESSAGE = "Provider option queries are restricted to cache-only mode.";
const PROVIDER_OPTION_QUERIES_OPEN_MESSAGE = "Provider option queries are open.";
const ACTIVATION_DISABLED_MESSAGE = "Catalog provider profile activation is disabled.";
const ACTIVATION_TEST_PROFILES_ONLY_MESSAGE = "Catalog provider profile activation is restricted to test profiles.";
const ACTIVATION_OPEN_MESSAGE = "Catalog provider profile activation is open.";
const MAGIC_PRODUCTION_SIGNOFF_REQUIRED_MESSAGE =
  "Magic production sync requires recorded provider-data signoff and interface-only staging UAT evidence.";
const ONE_PIECE_PRODUCTION_SIGNOFF_REQUIRED_MESSAGE =
  "One Piece production sync requires recorded provider-data signoff, redacted provider usage evidence, and interface-only staging UAT evidence.";
const WORKER_PROCESSING_DISABLED_MESSAGE = "Catalog integration worker job processing is disabled.";
const WORKER_LANE_LIMITED_MESSAGE = "Catalog integration worker job processing is lane-limited.";
const WORKER_PROCESSING_OPEN_MESSAGE = "Catalog integration worker job processing is open.";
const MAGIC_PRODUCTION_PROVIDER_KEYS = ["mtgjson", "scryfall", "tcgplayer"] as const;
const ONE_PIECE_PRODUCTION_PROVIDER_KEYS = ["scrydex", "tcgplayer"] as const;
const ONE_PIECE_PRODUCTION_UNIT_KEYS = [
  "scrydex:one-piece:single-card:source-observation-import",
  "scrydex:one-piece:sealed-product:source-observation-import",
  "tcgplayer:one-piece:single-card:source-observation-import",
  "tcgplayer:one-piece:sealed-product:source-observation-import",
] as const;

export function createCatalogIntegrationRolloutControlPolicy(
  config: CatalogIntegrationRolloutControlConfig = {},
  generatedAt = new Date().toISOString(),
): CatalogIntegrationRolloutControlPolicy {
  const snapshot = buildCatalogIntegrationRolloutControlSnapshot(config, generatedAt);

  const policy: CatalogIntegrationRolloutControlPolicy = {
    snapshot: () => snapshot,
    decide: (input) => decideCatalogIntegrationRollout(input, snapshot.controls),
    assertAllowed: (input) => {
      const decision = policy.decide(input);
      if (!decision.allowed) {
        throw new CatalogIntegrationRolloutControlError(decision);
      }
    },
  };

  return policy;
}

export function createCatalogIntegrationRolloutControlPolicyFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): CatalogIntegrationRolloutControlPolicy {
  const productionLike = isProductionLikeCatalogIntegrationEnvironment(env);
  const controlPlaneMode = parseControlPlaneMode(
    "CATALOG_INTEGRATION_CONTROL_PLANE_MODE",
    env.CATALOG_INTEGRATION_CONTROL_PLANE_MODE,
  );
  const disabledImports = parseProviderKeyScope(
    "CATALOG_INTEGRATION_IMPORTS_DISABLED",
    env.CATALOG_INTEGRATION_IMPORTS_DISABLED,
  );
  const disabledPromotion = parseProviderKeyScope(
    "CATALOG_INTEGRATION_PROMOTION_DISABLED",
    env.CATALOG_INTEGRATION_PROMOTION_DISABLED,
  );
  const disabledReapply = parseProviderKeyScope(
    "CATALOG_INTEGRATION_REAPPLY_DISABLED",
    env.CATALOG_INTEGRATION_REAPPLY_DISABLED,
  );
  const activationMode = parseActivationMode(
    "CATALOG_INTEGRATION_ACTIVATION_MODE",
    env.CATALOG_INTEGRATION_ACTIVATION_MODE,
  );

  return createCatalogIntegrationRolloutControlPolicy({
    controlPlaneMode: defaultWhenEnvUnset(controlPlaneMode, productionLike ? "dry-run-only" : null),
    disabledProviderAdapters: parseProviderKeyScope(
      "CATALOG_INTEGRATION_DISABLED_PROVIDER_ADAPTERS",
      env.CATALOG_INTEGRATION_DISABLED_PROVIDER_ADAPTERS,
    ),
    disabledProviderAdapterUnits: parseProviderScope(
      "CATALOG_INTEGRATION_DISABLED_PROVIDER_ADAPTER_UNITS",
      env.CATALOG_INTEGRATION_DISABLED_PROVIDER_ADAPTER_UNITS,
    ),
    providerApiEmergencyStop: parseProviderKeyScope(
      "CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP",
      env.CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP,
    ),
    providerApiEmergencyStopUnits: parseProviderScope(
      "CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP_UNITS",
      env.CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP_UNITS,
    ),
    providerOptionQueries: parseOptionQueryMode(
      "CATALOG_INTEGRATION_PROVIDER_OPTION_QUERIES",
      env.CATALOG_INTEGRATION_PROVIDER_OPTION_QUERIES,
    ),
    disabledProviderOptionQueryProviders: parseProviderKeyScope(
      "CATALOG_INTEGRATION_PROVIDER_OPTION_QUERY_PROVIDERS_DISABLED",
      env.CATALOG_INTEGRATION_PROVIDER_OPTION_QUERY_PROVIDERS_DISABLED,
    ),
    disabledProviderOptionQueryUnits: parseProviderScope(
      "CATALOG_INTEGRATION_PROVIDER_OPTION_QUERY_UNITS_DISABLED",
      env.CATALOG_INTEGRATION_PROVIDER_OPTION_QUERY_UNITS_DISABLED,
    ),
    cacheOnlyProviderOptionQueryProviders: parseProviderKeyScope(
      "CATALOG_INTEGRATION_PROVIDER_OPTION_QUERY_PROVIDERS_CACHE_ONLY",
      env.CATALOG_INTEGRATION_PROVIDER_OPTION_QUERY_PROVIDERS_CACHE_ONLY,
    ),
    cacheOnlyProviderOptionQueryUnits: parseProviderScope(
      "CATALOG_INTEGRATION_PROVIDER_OPTION_QUERY_UNITS_CACHE_ONLY",
      env.CATALOG_INTEGRATION_PROVIDER_OPTION_QUERY_UNITS_CACHE_ONLY,
    ),
    disabledImports: defaultWhenEnvUnset(disabledImports, productionLike ? MAGIC_PRODUCTION_PROVIDER_KEYS : null),
    disabledImportUnits: parseProviderScope(
      "CATALOG_INTEGRATION_IMPORT_UNITS_DISABLED",
      env.CATALOG_INTEGRATION_IMPORT_UNITS_DISABLED,
    ),
    disabledPromotion: defaultWhenEnvUnset(disabledPromotion, productionLike ? MAGIC_PRODUCTION_PROVIDER_KEYS : null),
    disabledPromotionUnits: parseProviderScope(
      "CATALOG_INTEGRATION_PROMOTION_UNITS_DISABLED",
      env.CATALOG_INTEGRATION_PROMOTION_UNITS_DISABLED,
    ),
    disabledReapply: defaultWhenEnvUnset(disabledReapply, productionLike ? MAGIC_PRODUCTION_PROVIDER_KEYS : null),
    disabledReapplyUnits: parseProviderScope(
      "CATALOG_INTEGRATION_REAPPLY_UNITS_DISABLED",
      env.CATALOG_INTEGRATION_REAPPLY_UNITS_DISABLED,
    ),
    activationMode: defaultWhenEnvUnset(activationMode, productionLike ? "test-profiles-only" : null),
    ...(productionLike
      ? {
          magicProductionSignoffReference: normalizeProductionSignoffReference(
            env.CATALOG_INTEGRATION_MAGIC_PRODUCTION_SIGNOFF_REFERENCE,
          ),
          onePieceProductionSignoffReference: normalizeProductionSignoffReference(
            env[CATALOG_INTEGRATION_ONE_PIECE_PRODUCTION_SIGNOFF_REFERENCE_ENV],
          ),
        }
      : {}),
    workerMode: parseWorkerMode("CATALOG_INTEGRATION_WORKER_MODE", env.CATALOG_INTEGRATION_WORKER_MODE),
  });
}

function defaultWhenEnvUnset<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value;
}

export function rolloutControlErrorResponse(error: CatalogIntegrationRolloutControlError) {
  const control = error.decision.controls[0];

  return {
    error: {
      code: error.code,
      diagnosticCode: error.decision.diagnosticCode,
      message: error.message,
      capability: error.decision.capability,
      controlId: control?.controlId ?? null,
      auditEventName: control?.auditEventName ?? "rollout-control-denied",
      metricKey: control?.metricKey ?? "catalog.integration.rollout.denied",
      controls: error.decision.controls,
    },
  };
}

function buildCatalogIntegrationRolloutControlSnapshot(
  config: CatalogIntegrationRolloutControlConfig,
  generatedAt: string,
): CatalogIntegrationRolloutControlSnapshot {
  const controls: CatalogIntegrationRolloutControl[] = [
    modeControl(config.controlPlaneMode ?? "open"),
    providerScopeControl(
      "provider-adapter-disabled",
      ["provider-transport", "provider-option-query", "import"],
      config.disabledProviderAdapters,
      "Provider adapter access is disabled for the configured provider scope.",
    ),
    unitScopeControl(
      "provider-adapter-disabled",
      ["provider-transport", "provider-option-query", "import"],
      config.disabledProviderAdapterUnits,
      "Provider adapter access is disabled for the configured ingestion-unit scope.",
    ),
    providerScopeControl(
      "provider-api-emergency-stop",
      ["provider-transport", "provider-option-query", "import"],
      config.providerApiEmergencyStop,
      "Provider API emergency stop is active for the configured provider scope.",
    ),
    unitScopeControl(
      "provider-api-emergency-stop",
      ["provider-transport", "provider-option-query", "import"],
      config.providerApiEmergencyStopUnits,
      "Provider API emergency stop is active for the configured ingestion-unit scope.",
    ),
    optionQueryControl(config.providerOptionQueries ?? "open"),
    providerScopeControl(
      "provider-option-queries-disabled",
      ["provider-option-query"],
      config.disabledProviderOptionQueryProviders,
      "Provider option queries are disabled for the configured provider scope.",
    ),
    unitScopeControl(
      "provider-option-queries-disabled",
      ["provider-option-query"],
      config.disabledProviderOptionQueryUnits,
      "Provider option queries are disabled for the configured ingestion-unit scope.",
    ),
    providerScopeControl(
      "provider-option-queries-cache-only",
      ["provider-option-query"],
      config.cacheOnlyProviderOptionQueryProviders,
      "Provider option queries are restricted to cache-only mode for the configured provider scope.",
    ),
    unitScopeControl(
      "provider-option-queries-cache-only",
      ["provider-option-query"],
      config.cacheOnlyProviderOptionQueryUnits,
      "Provider option queries are restricted to cache-only mode for the configured ingestion-unit scope.",
    ),
    providerScopeControl(
      "imports-disabled",
      ["import"],
      config.disabledImports,
      "Catalog integration imports are disabled for the configured provider scope.",
    ),
    unitScopeControl(
      "imports-disabled",
      ["import"],
      config.disabledImportUnits,
      "Catalog integration imports are disabled for the configured ingestion-unit scope.",
    ),
    providerScopeControl(
      "promotion-disabled",
      ["promotion"],
      config.disabledPromotion,
      "Catalog integration promotion is disabled for the configured provider scope.",
    ),
    unitScopeControl(
      "promotion-disabled",
      ["promotion"],
      config.disabledPromotionUnits,
      "Catalog integration promotion is disabled for the configured ingestion-unit scope.",
    ),
    providerScopeControl(
      "reapply-disabled",
      ["reapply"],
      config.disabledReapply,
      "Catalog integration reapply is disabled for the configured provider scope.",
    ),
    unitScopeControl(
      "reapply-disabled",
      ["reapply"],
      config.disabledReapplyUnits,
      "Catalog integration reapply is disabled for the configured ingestion-unit scope.",
    ),
    activationControl(config.activationMode ?? "open"),
    magicProductionSignoffControl(config),
    onePieceProductionSignoffControl(config),
    workerControl(config.workerMode ?? "open"),
  ].filter((item): item is CatalogIntegrationRolloutControl => Boolean(item));

  return {
    generatedAt,
    controls,
  };
}

function decideCatalogIntegrationRollout(
  input: CatalogIntegrationRolloutDecisionInput,
  controls: readonly CatalogIntegrationRolloutControl[],
): CatalogIntegrationRolloutDecision {
  const blockingControls = controls.filter(
    (control) =>
      control.status === "blocked" &&
      control.capabilities.includes(input.capability) &&
      controlMatchesInput(control, input),
  );

  if (blockingControls.length === 0) {
    return {
      allowed: true,
      capability: input.capability,
      controls: [],
      diagnosticCode: null,
      message: null,
    };
  }

  return {
    allowed: false,
    capability: input.capability,
    controls: blockingControls,
    diagnosticCode: "catalog-integration-rollout-control-denied",
    message: blockingControls[0].message,
  };
}

function controlMatchesInput(
  control: CatalogIntegrationRolloutControl,
  input: CatalogIntegrationRolloutDecisionInput,
): boolean {
  if (
    control.controlId === "activation-test-profiles-only" &&
    input.capability === "activation" &&
    input.profileLifecycle === "test"
  ) {
    return false;
  }

  return (
    scopeMatches(control.providerKeys, input.providerKey) &&
    scopeMatches(control.profileKeys, input.profileKey ?? input.profileVersion) &&
    scopeMatches(control.unitKeys, input.unitKey)
  );
}

function modeControl(mode: NonNullable<CatalogIntegrationRolloutControlConfig["controlPlaneMode"]>) {
  if (mode === "read-only") {
    return control({
      controlId: "control-plane-read-only",
      status: "blocked",
      severity: "error",
      capabilities: ["import", "promotion", "reapply", "activation"],
      message: CONTROL_PLANE_READ_ONLY_MESSAGE,
    });
  }

  if (mode === "dry-run-only") {
    return control({
      controlId: "dry-run-only",
      status: "blocked",
      severity: "error",
      capabilities: ["import", "promotion", "reapply", "activation"],
      message: CONTROL_PLANE_DRY_RUN_ONLY_MESSAGE,
    });
  }

  if (mode === "rollback-ready") {
    return control({
      controlId: "rollback-ready-release-mode",
      status: "degraded",
      severity: "warning",
      capabilities: ["import", "promotion", "reapply", "activation"],
      message: ROLLBACK_READY_RELEASE_MODE_MESSAGE,
    });
  }

  return control({
    controlId: "control-plane-read-only",
    status: "open",
    severity: "info",
    capabilities: ["import", "promotion", "reapply", "activation"],
    message: CONTROL_PLANE_OPEN_MESSAGE,
  });
}

function providerScopeControl(
  controlId: CatalogIntegrationRolloutControlId,
  capabilities: readonly CatalogIntegrationRolloutCapability[],
  providerKeys: readonly string[] | "all" | null | undefined,
  message: string,
) {
  const normalizedProviderKeys = normalizeScope(providerKeys);
  return control({
    controlId,
    status: normalizedProviderKeys.length > 0 ? "blocked" : "open",
    severity: normalizedProviderKeys.length > 0 ? "error" : "info",
    capabilities,
    providerKeys: normalizedProviderKeys,
    message: normalizedProviderKeys.length > 0 ? message : `${message} Default state is open.`,
  });
}

function unitScopeControl(
  controlId: CatalogIntegrationRolloutControlId,
  capabilities: readonly CatalogIntegrationRolloutCapability[],
  unitKeys: readonly string[] | "all" | null | undefined,
  message: string,
) {
  const normalizedUnitKeys = normalizeScope(unitKeys);
  return control({
    controlId,
    status: normalizedUnitKeys.length > 0 ? "blocked" : "open",
    severity: normalizedUnitKeys.length > 0 ? "error" : "info",
    capabilities,
    unitKeys: normalizedUnitKeys,
    message: normalizedUnitKeys.length > 0 ? message : `${message} Default state is open.`,
  });
}

function optionQueryControl(mode: NonNullable<CatalogIntegrationRolloutControlConfig["providerOptionQueries"]>) {
  if (mode === "disabled") {
    return control({
      controlId: "provider-option-queries-disabled",
      status: "blocked",
      severity: "error",
      capabilities: ["provider-option-query"],
      message: PROVIDER_OPTION_QUERIES_DISABLED_MESSAGE,
    });
  }

  if (mode === "cache-only") {
    return control({
      controlId: "provider-option-queries-cache-only",
      status: "blocked",
      severity: "warning",
      capabilities: ["provider-option-query"],
      message: PROVIDER_OPTION_QUERIES_CACHE_ONLY_MESSAGE,
    });
  }

  return control({
    controlId: "provider-option-queries-disabled",
    status: "open",
    severity: "info",
    capabilities: ["provider-option-query"],
    message: PROVIDER_OPTION_QUERIES_OPEN_MESSAGE,
  });
}

function activationControl(mode: NonNullable<CatalogIntegrationRolloutControlConfig["activationMode"]>) {
  if (mode === "disabled") {
    return control({
      controlId: "activation-disabled",
      status: "blocked",
      severity: "error",
      capabilities: ["activation"],
      message: ACTIVATION_DISABLED_MESSAGE,
    });
  }

  if (mode === "test-profiles-only") {
    return control({
      controlId: "activation-test-profiles-only",
      status: "blocked",
      severity: "warning",
      capabilities: ["activation"],
      message: ACTIVATION_TEST_PROFILES_ONLY_MESSAGE,
    });
  }

  return control({
    controlId: "activation-disabled",
    status: "open",
    severity: "info",
    capabilities: ["activation"],
    message: ACTIVATION_OPEN_MESSAGE,
  });
}

function magicProductionSignoffControl(config: CatalogIntegrationRolloutControlConfig) {
  if (!Object.prototype.hasOwnProperty.call(config, "magicProductionSignoffReference")) {
    return null;
  }

  const reference = normalizeProductionSignoffReference(config.magicProductionSignoffReference);
  return control({
    controlId: "magic-production-signoff-required",
    status: reference ? "open" : "blocked",
    severity: reference ? "info" : "error",
    capabilities: ["import", "promotion", "reapply", "activation"],
    providerKeys: MAGIC_PRODUCTION_PROVIDER_KEYS,
    message: reference
      ? `Magic production signoff reference recorded: ${reference}.`
      : MAGIC_PRODUCTION_SIGNOFF_REQUIRED_MESSAGE,
  });
}

function onePieceProductionSignoffControl(config: CatalogIntegrationRolloutControlConfig) {
  if (!Object.prototype.hasOwnProperty.call(config, "onePieceProductionSignoffReference")) {
    return null;
  }

  const reference = normalizeProductionSignoffReference(config.onePieceProductionSignoffReference);
  return control({
    controlId: "one-piece-production-signoff-required",
    status: reference ? "open" : "blocked",
    severity: reference ? "info" : "error",
    capabilities: ["import", "promotion", "reapply", "activation"],
    providerKeys: ONE_PIECE_PRODUCTION_PROVIDER_KEYS,
    unitKeys: ONE_PIECE_PRODUCTION_UNIT_KEYS,
    message: reference
      ? `One Piece production signoff reference recorded: ${reference}.`
      : ONE_PIECE_PRODUCTION_SIGNOFF_REQUIRED_MESSAGE,
  });
}

function workerControl(mode: NonNullable<CatalogIntegrationRolloutControlConfig["workerMode"]>) {
  if (mode === "disabled") {
    return control({
      controlId: "worker-processing-disabled",
      status: "blocked",
      severity: "error",
      capabilities: ["worker-job-processing"],
      message: WORKER_PROCESSING_DISABLED_MESSAGE,
    });
  }

  if (mode === "lane-limited") {
    return control({
      controlId: "worker-lane-limited",
      status: "degraded",
      severity: "warning",
      capabilities: ["worker-job-processing"],
      message: WORKER_LANE_LIMITED_MESSAGE,
    });
  }

  return control({
    controlId: "worker-processing-disabled",
    status: "open",
    severity: "info",
    capabilities: ["worker-job-processing"],
    message: WORKER_PROCESSING_OPEN_MESSAGE,
  });
}

function control(input: {
  controlId: CatalogIntegrationRolloutControlId;
  status: CatalogIntegrationRolloutControlStatus;
  severity: "info" | "warning" | "error";
  capabilities: readonly CatalogIntegrationRolloutCapability[];
  message: string;
  providerKeys?: readonly string[];
  profileKeys?: readonly string[];
  unitKeys?: readonly string[];
  defaultState?: "open";
}): CatalogIntegrationRolloutControl {
  return {
    controlId: input.controlId,
    defaultState: input.defaultState ?? "open",
    status: input.status,
    severity: input.severity,
    capabilities: input.capabilities,
    providerKeys: input.providerKeys ?? [],
    profileKeys: input.profileKeys ?? [],
    unitKeys: input.unitKeys ?? [],
    message: input.message,
    auditEventName: input.status === "blocked" ? "rollout-control-denied" : "rollout-control-evaluated",
    metricKey: `catalog.integration.rollout.${input.controlId.replaceAll("-", "_")}`,
  };
}

function scopeMatches(scope: readonly string[], value: string | null | undefined): boolean {
  if (scope.length === 0 || scope.includes("*")) {
    return true;
  }

  const normalized = value?.trim().toLowerCase();
  return Boolean(normalized && scope.includes(normalized));
}

function normalizeScope(value: readonly string[] | "all" | null | undefined): readonly string[] {
  if (!value) {
    return [];
  }
  if (value === "all") {
    return ["*"];
  }

  return Array.from(new Set(value.map((item) => item.trim().toLowerCase()).filter(Boolean)));
}

const OPEN_MODE_ALIASES = ["open", "false", "none"] as const;
const PROVIDER_SCOPE_OPEN_ALIASES = ["false", "open", "none"] as const;
const PROVIDER_SCOPE_ALL_ALIASES = ["true", "all", "*"] as const;

function parseProviderKeyScope(
  envName: string,
  value: string | undefined,
): readonly string[] | "all" | null | undefined {
  const scope = parseProviderScope(envName, value);
  if (!Array.isArray(scope)) {
    return scope;
  }

  const validProviderKeys = catalogIntegrationProviderKeySet();
  const unknownProviderKey = scope.find((providerKey) => !validProviderKeys.has(providerKey));
  if (unknownProviderKey) {
    throw new Error(
      `${envName} contains unknown provider key '${unknownProviderKey}'. Allowed provider keys: ${[
        ...validProviderKeys,
      ].join(
        ", ",
      )}. Use one of ${formatAllowedValues(PROVIDER_SCOPE_OPEN_ALIASES)} to leave open, or one of ${formatAllowedValues(
        PROVIDER_SCOPE_ALL_ALIASES,
      )} to target every provider.`,
    );
  }

  return scope;
}

function parseProviderScope(envName: string, value: string | undefined): readonly string[] | "all" | null | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (includesValue(PROVIDER_SCOPE_OPEN_ALIASES, normalized)) {
    return null;
  }
  if (includesValue(PROVIDER_SCOPE_ALL_ALIASES, normalized)) {
    return "all";
  }
  const scope = normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (scope.length === 0) {
    throw new Error(
      `${envName} must be a comma-separated scope list, one of ${formatAllowedValues(
        PROVIDER_SCOPE_OPEN_ALIASES,
      )} to leave open, or one of ${formatAllowedValues(PROVIDER_SCOPE_ALL_ALIASES)} to target every provider.`,
    );
  }
  return scope;
}

function parseControlPlaneMode(
  envName: string,
  value: string | undefined,
): CatalogIntegrationRolloutControlConfig["controlPlaneMode"] | undefined {
  return parseRolloutMode(envName, value, ["read-only", "dry-run-only", "rollback-ready"] as const);
}

function parseOptionQueryMode(
  envName: string,
  value: string | undefined,
): CatalogIntegrationRolloutControlConfig["providerOptionQueries"] | undefined {
  return parseRolloutMode(envName, value, ["disabled", "cache-only"] as const);
}

function parseActivationMode(
  envName: string,
  value: string | undefined,
): CatalogIntegrationRolloutControlConfig["activationMode"] | undefined {
  return parseRolloutMode(envName, value, ["disabled", "test-profiles-only"] as const);
}

function parseWorkerMode(
  envName: string,
  value: string | undefined,
): CatalogIntegrationRolloutControlConfig["workerMode"] | undefined {
  return parseRolloutMode(envName, value, ["disabled", "lane-limited"] as const);
}

function parseRolloutMode<TAllowed extends string>(
  envName: string,
  value: string | undefined,
  allowedModes: readonly TAllowed[],
): "open" | TAllowed | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (includesValue(OPEN_MODE_ALIASES, normalized)) {
    return "open";
  }
  if (includesValue(allowedModes, normalized)) {
    return normalized;
  }

  throw new Error(
    `${envName} must be one of ${formatAllowedValues([...OPEN_MODE_ALIASES, ...allowedModes])}. Received '${normalized}'.`,
  );
}

function catalogIntegrationProviderKeySet(): ReadonlySet<string> {
  return new Set(
    [
      ...new Set(listCatalogProviderIntegrationProfiles().map((profile) => profile.providerKey.trim().toLowerCase())),
    ].sort(),
  );
}

function includesValue<TValue extends string>(values: readonly TValue[], value: string): value is TValue {
  return values.includes(value as TValue);
}

function formatAllowedValues(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(", ");
}

function isProductionLikeCatalogIntegrationEnvironment(env: NodeJS.ProcessEnv): boolean {
  const deploymentEnvironment = env.DEPLOYMENT_ENVIRONMENT?.trim().toLowerCase();
  if (deploymentEnvironment) {
    return deploymentEnvironment === "production";
  }

  return env.NODE_ENV?.trim().toLowerCase() === "production";
}

function normalizeProductionSignoffReference(value: string | null | undefined): string | null {
  const reference = value?.trim();
  if (!reference) {
    return null;
  }

  const normalized = reference.toLowerCase();
  return normalized === "false" || normalized === "none" || normalized === "open" ? null : reference;
}
