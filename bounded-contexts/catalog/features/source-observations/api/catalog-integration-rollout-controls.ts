import type { CatalogProviderProfileLifecycle } from "./provider-integration-mapping-contract";

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
  providerApiEmergencyStop?: readonly string[] | "all" | null;
  providerOptionQueries?: "open" | "disabled" | "cache-only" | null;
  disabledImports?: readonly string[] | "all" | null;
  disabledPromotion?: readonly string[] | "all" | null;
  disabledReapply?: readonly string[] | "all" | null;
  activationMode?: "open" | "disabled" | "test-profiles-only" | null;
  magicProductionSignoffReference?: string | null;
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
const WORKER_PROCESSING_DISABLED_MESSAGE = "Catalog integration worker job processing is disabled.";
const WORKER_LANE_LIMITED_MESSAGE = "Catalog integration worker job processing is lane-limited.";
const WORKER_PROCESSING_OPEN_MESSAGE = "Catalog integration worker job processing is open.";
const MAGIC_PRODUCTION_PROVIDER_KEYS = ["mtgjson", "scryfall", "tcgplayer"] as const;

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
  const controlPlaneMode = parseControlPlaneMode(env.CATALOG_INTEGRATION_CONTROL_PLANE_MODE);
  const disabledImports = parseProviderScope(env.CATALOG_INTEGRATION_IMPORTS_DISABLED);
  const disabledPromotion = parseProviderScope(env.CATALOG_INTEGRATION_PROMOTION_DISABLED);
  const disabledReapply = parseProviderScope(env.CATALOG_INTEGRATION_REAPPLY_DISABLED);
  const activationMode = parseActivationMode(env.CATALOG_INTEGRATION_ACTIVATION_MODE);

  return createCatalogIntegrationRolloutControlPolicy({
    controlPlaneMode: defaultWhenEnvUnset(controlPlaneMode, productionLike ? "dry-run-only" : null),
    disabledProviderAdapters: parseProviderScope(env.CATALOG_INTEGRATION_DISABLED_PROVIDER_ADAPTERS),
    providerApiEmergencyStop: parseProviderScope(env.CATALOG_INTEGRATION_PROVIDER_API_EMERGENCY_STOP),
    providerOptionQueries: parseOptionQueryMode(env.CATALOG_INTEGRATION_PROVIDER_OPTION_QUERIES),
    disabledImports: defaultWhenEnvUnset(disabledImports, productionLike ? MAGIC_PRODUCTION_PROVIDER_KEYS : null),
    disabledPromotion: defaultWhenEnvUnset(disabledPromotion, productionLike ? MAGIC_PRODUCTION_PROVIDER_KEYS : null),
    disabledReapply: defaultWhenEnvUnset(disabledReapply, productionLike ? MAGIC_PRODUCTION_PROVIDER_KEYS : null),
    activationMode: defaultWhenEnvUnset(activationMode, productionLike ? "test-profiles-only" : null),
    ...(productionLike
      ? {
          magicProductionSignoffReference: normalizeMagicProductionSignoffReference(
            env.CATALOG_INTEGRATION_MAGIC_PRODUCTION_SIGNOFF_REFERENCE,
          ),
        }
      : {}),
    workerMode: parseWorkerMode(env.CATALOG_INTEGRATION_WORKER_MODE),
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
    providerScopeControl(
      "provider-api-emergency-stop",
      ["provider-transport", "provider-option-query", "import"],
      config.providerApiEmergencyStop,
      "Provider API emergency stop is active for the configured provider scope.",
    ),
    optionQueryControl(config.providerOptionQueries ?? "open"),
    providerScopeControl(
      "imports-disabled",
      ["import"],
      config.disabledImports,
      "Catalog integration imports are disabled for the configured provider scope.",
    ),
    providerScopeControl(
      "promotion-disabled",
      ["promotion"],
      config.disabledPromotion,
      "Catalog integration promotion is disabled for the configured provider scope.",
    ),
    providerScopeControl(
      "reapply-disabled",
      ["reapply"],
      config.disabledReapply,
      "Catalog integration reapply is disabled for the configured provider scope.",
    ),
    activationControl(config.activationMode ?? "open"),
    magicProductionSignoffControl(config),
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

  const reference = normalizeMagicProductionSignoffReference(config.magicProductionSignoffReference);
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

function parseProviderScope(value: string | undefined): readonly string[] | "all" | null | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "false" || normalized === "open" || normalized === "none") {
    return null;
  }
  if (normalized === "true" || normalized === "all" || normalized === "*") {
    return "all";
  }
  return normalized
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseControlPlaneMode(
  value: string | undefined,
): CatalogIntegrationRolloutControlConfig["controlPlaneMode"] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "open" || normalized === "false" || normalized === "none") {
    return "open";
  }
  return normalized === "read-only" || normalized === "dry-run-only" || normalized === "rollback-ready"
    ? normalized
    : undefined;
}

function parseOptionQueryMode(
  value: string | undefined,
): CatalogIntegrationRolloutControlConfig["providerOptionQueries"] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "open" || normalized === "false" || normalized === "none") {
    return "open";
  }
  return normalized === "disabled" || normalized === "cache-only" ? normalized : null;
}

function parseActivationMode(
  value: string | undefined,
): CatalogIntegrationRolloutControlConfig["activationMode"] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "open" || normalized === "false" || normalized === "none") {
    return "open";
  }
  return normalized === "disabled" || normalized === "test-profiles-only" ? normalized : undefined;
}

function parseWorkerMode(value: string | undefined): CatalogIntegrationRolloutControlConfig["workerMode"] | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "open" || normalized === "false" || normalized === "none") {
    return "open";
  }
  return normalized === "disabled" || normalized === "lane-limited" ? normalized : null;
}

function isProductionLikeCatalogIntegrationEnvironment(env: NodeJS.ProcessEnv): boolean {
  return env.DEPLOYMENT_ENVIRONMENT?.trim().toLowerCase() === "production" || env.NODE_ENV === "production";
}

function normalizeMagicProductionSignoffReference(value: string | null | undefined): string | null {
  const reference = value?.trim();
  if (!reference) {
    return null;
  }

  const normalized = reference.toLowerCase();
  return normalized === "false" || normalized === "none" || normalized === "open" ? null : reference;
}
