import type {
  ReadConsistencyExactDependencyMode,
  ReadConsistencyRouteTuning,
} from "@chase-sets/bounded-context-runtime";
import { ENVIRONMENT_DATA_PROFILES } from "@chase-sets/bounded-context-module";

export type PlatformPoolConfig = Readonly<{
  max: number;
  idleTimeoutMillis: number;
  idleInTransactionSessionTimeoutMillis?: number;
  connectionTimeoutMillis: number;
}>;

export type PlatformCatalogAssetStorageConfig =
  | Readonly<{
      kind: "filesystem";
      rootDir: string;
      publicBaseUrl: string;
    }>
  | Readonly<{
      kind: "s3";
      bucket: string;
      region: string;
      publicBaseUrl: string;
      endpoint?: string;
      accessKeyId?: string;
      secretAccessKey?: string;
      forcePathStyle?: boolean;
    }>;

export type PlatformPaymentProcessorConfig =
  | Readonly<{
      kind: "fake";
    }>
  | Readonly<{
      kind: "stripe";
      secretKey: string;
      publishableKey: string;
      webhookSecret: string;
      apiBaseUrl?: string;
    }>;

export type PlatformMoneyMovementConfig =
  | Readonly<{
      kind: "fake";
    }>
  | Readonly<{
      kind: "stripe";
      secretKey: string;
      webhookSecret: string;
      connectAccountsApi: PlatformStripeConnectAccountsApi;
      apiBaseUrl?: string;
    }>;

export type PlatformStripeConnectAccountsApi = "v1" | "v2";

export const DEPLOYMENT_ENVIRONMENTS = [
  "production",
  "staging",
  "preview",
  "test",
  "dev",
  "local",
  "remote-dev",
] as const;

export type DeploymentEnvironment = (typeof DEPLOYMENT_ENVIRONMENTS)[number];

export type PlatformPostageConfig<TIncludeWebhookSecret extends boolean = boolean> =
  | Readonly<{
      kind: "sandbox";
    }>
  | (Readonly<{
      kind: "easypost";
      apiKey: string;
      apiBaseUrl?: string;
      mode: "test" | "production";
    }> &
      (TIncludeWebhookSecret extends true
        ? Readonly<{
            webhookSecret?: string;
          }>
        : Readonly<Record<never, never>>));

export type PlatformMobileMessagingProvider = "noop" | "twilio";

const BOOLEAN_TRUE_VALUES = ["1", "true", "yes", "on"] as const;
const BOOLEAN_FALSE_VALUES = ["0", "false", "no", "off"] as const;

export const TCGPLAYER_AUTOMATION_DOMAIN_KEYS = ["mpSearchApi", "mpApi", "infiniteApi", "mpGateway"] as const;

export type PlatformTcgplayerAutomationDomainKey = (typeof TCGPLAYER_AUTOMATION_DOMAIN_KEYS)[number];

export type PlatformTcgplayerAutomationDomainConfig = Readonly<{
  requestDelayMs: number;
  rateLimitCooldownMs: number;
  maxConcurrentRequests: number;
  adaptiveEnabled: boolean;
  minRequestDelayMs: number;
  maxRequestDelayMs: number;
  learnedMinDelayMs: number;
}>;

export type PlatformTcgplayerAutomationConfig = Readonly<{
  auth: Readonly<{
    tcgAuthCookie: string | null;
    userAgent: string;
  }>;
  domainConfigs: Readonly<Record<PlatformTcgplayerAutomationDomainKey, PlatformTcgplayerAutomationDomainConfig>>;
  adaptiveConfig: Readonly<{
    increaseMultiplier: number;
    floorStepMs: number;
    decreaseAmountMs: number;
    successThreshold: number;
  }>;
  maxRetries: number;
}>;

export type PlatformDatabaseConfig<TContextName extends string> = Readonly<{
  sharedDatabaseUrl: string | null;
  controlDatabaseUrl: string;
  workSignalDatabaseUrl: string | null;
  contextDatabaseUrls: Readonly<Partial<Record<TContextName, string>>>;
  contextWaiterDatabaseUrls: Readonly<Partial<Record<TContextName, string>>>;
}>;

export type PlatformStripeProviderConfig = Readonly<{
  paymentProcessor: PlatformPaymentProcessorConfig;
  moneyMovement: PlatformMoneyMovementConfig;
  secretKey: string | null;
  publishableKey: string | null;
  webhookSecret: string | null;
  connectWebhookSecret: string | null;
  resolvedConnectWebhookSecret: string | undefined;
  connectAccountsApi: PlatformStripeConnectAccountsApi;
  apiBaseUrl: string | undefined;
}>;

export const PLATFORM_DATA_PROFILES = ENVIRONMENT_DATA_PROFILES;

const DEFAULT_TCGPLAYER_AUTOMATION_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG: PlatformTcgplayerAutomationDomainConfig = {
  requestDelayMs: 250,
  rateLimitCooldownMs: 30_000,
  maxConcurrentRequests: 2,
  adaptiveEnabled: true,
  minRequestDelayMs: 250,
  maxRequestDelayMs: 30_000,
  learnedMinDelayMs: 250,
};

export function getOptionalEnv(name: string) {
  const value = process.env[name];

  return value?.trim() ? value.trim() : null;
}

export function getBooleanEnv(name: string, defaultValue: boolean) {
  const value = getOptionalEnv(name);
  if (!value) {
    return defaultValue;
  }

  const normalized = value.toLowerCase();
  if ((BOOLEAN_TRUE_VALUES as readonly string[]).includes(normalized)) {
    return true;
  }
  if ((BOOLEAN_FALSE_VALUES as readonly string[]).includes(normalized)) {
    return false;
  }

  throw new Error(`${name} must be a boolean value: ${[...BOOLEAN_TRUE_VALUES, ...BOOLEAN_FALSE_VALUES].join(", ")}.`);
}

export function resolveEnumEnv<T extends string>(
  name: string,
  value: string | null,
  allowed: readonly T[],
  defaultValue: T,
): T {
  if (!value) {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();
  const resolved = allowed.find((allowedValue) => allowedValue.toLowerCase() === normalized);
  if (resolved) {
    return resolved;
  }

  throw new Error(`${name} must be one of: ${allowed.join(", ")}.`);
}

export function loadDeploymentEnvironment(input?: {
  deploymentEnvironment?: string | null;
  nodeEnv?: string | null;
}): DeploymentEnvironment {
  const deploymentEnvironment = input?.deploymentEnvironment ?? getOptionalEnv("DEPLOYMENT_ENVIRONMENT");
  if (deploymentEnvironment) {
    return resolveEnumEnv("DEPLOYMENT_ENVIRONMENT", deploymentEnvironment, DEPLOYMENT_ENVIRONMENTS, "dev");
  }

  const nodeEnv = input?.nodeEnv ?? process.env.NODE_ENV;
  if (nodeEnv === "production") {
    return "production";
  }
  if (nodeEnv === "test") {
    return "test";
  }

  return "dev";
}

export function getOptionalCsvEnv(name: string): readonly string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function getOptionalJsonEnv<T>(name: string): T | null {
  const value = getOptionalEnv(name);
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${name} must contain valid JSON.`);
  }
}

export function getOptionalPositiveNumberEnv(name: string, defaultValue: number) {
  const parsed = Number(process.env[name] ?? defaultValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function getPositiveNumberEnv(name: string, defaultValue: number) {
  return getOptionalPositiveNumberEnv(name, defaultValue) ?? defaultValue;
}

export function getRequiredPositiveNumberEnv(name: string, defaultValue: number) {
  const value = getOptionalEnv(name);
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed;
  }

  throw new Error(`${name} must be a positive number.`);
}

/**
 * A duration env reader for security-sensitive lifetimes (session/token TTLs):
 * parses a positive millisecond integer and enforces `[minMs, maxMs]` bounds
 * so a fat-fingered env value can never silently zero out or unbound an
 * expiry. Fails closed at boot with a message naming the bounds, rather than
 * clamping -- a clamp would let a misconfigured deploy ship silently.
 */
export function getBoundedDurationEnv(
  name: string,
  defaultValueMs: number,
  bounds: Readonly<{ minMs: number; maxMs: number }>,
): number {
  const raw = getOptionalEnv(name);
  const value = raw === null ? defaultValueMs : Number(raw);

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number of milliseconds.`);
  }
  if (value < bounds.minMs || value > bounds.maxMs) {
    throw new Error(`${name} must be between ${bounds.minMs}ms and ${bounds.maxMs}ms, got ${value}ms.`);
  }

  return value;
}

export function getReadConsistencyExactDependencyModeEnv(name: string): ReadConsistencyExactDependencyMode {
  const value = getOptionalEnv(name) ?? "enabled";
  if (value === "enabled" || value === "target-context") {
    return value;
  }

  throw new Error(`${name} must be enabled or target-context.`);
}

export function loadReadConsistencyRouteTuningEnv(input: {
  envName: string;
  criticalRouteTuning?: readonly ReadConsistencyRouteTuning[];
}): readonly ReadConsistencyRouteTuning[] {
  const value = getOptionalJsonEnv<unknown>(input.envName) ?? [];
  if (!Array.isArray(value)) {
    throw new Error(`${input.envName} must be a JSON array.`);
  }

  const environmentRouteTuning = value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`${input.envName}[${index}] must be an object.`);
    }

    const mountPath = entry.mountPath;
    const routePath = entry.routePath;
    const targetContextName = entry.targetContextName;
    const timeoutMs = entry.timeoutMs;
    const pollIntervalMs = entry.pollIntervalMs;
    const exactDependencyMode = entry.exactDependencyMode;

    if (typeof mountPath !== "string" || !mountPath.trim().startsWith("/")) {
      throw new Error(`${input.envName}[${index}].mountPath must be an absolute path string.`);
    }
    if (typeof routePath !== "string" || !routePath.trim().startsWith("/")) {
      throw new Error(`${input.envName}[${index}].routePath must be an absolute path string.`);
    }
    if (targetContextName !== undefined && (typeof targetContextName !== "string" || !targetContextName.trim())) {
      throw new Error(`${input.envName}[${index}].targetContextName must be a string when set.`);
    }
    if (timeoutMs !== undefined && !isPositiveNumber(timeoutMs)) {
      throw new Error(`${input.envName}[${index}].timeoutMs must be a positive number when set.`);
    }
    if (pollIntervalMs !== undefined && !isPositiveNumber(pollIntervalMs)) {
      throw new Error(`${input.envName}[${index}].pollIntervalMs must be a positive number when set.`);
    }
    if (
      exactDependencyMode !== undefined &&
      exactDependencyMode !== "enabled" &&
      exactDependencyMode !== "target-context"
    ) {
      throw new Error(`${input.envName}[${index}].exactDependencyMode must be enabled or target-context when set.`);
    }

    return {
      mountPath: mountPath.trim(),
      routePath: routePath.trim(),
      ...(typeof targetContextName === "string" ? { targetContextName: targetContextName.trim() } : {}),
      ...(typeof timeoutMs === "number" ? { timeoutMs } : {}),
      ...(typeof pollIntervalMs === "number" ? { pollIntervalMs } : {}),
      ...(typeof exactDependencyMode === "string"
        ? { exactDependencyMode: exactDependencyMode as ReadConsistencyExactDependencyMode }
        : {}),
    };
  });

  return [...(input.criticalRouteTuning ?? []), ...environmentRouteTuning];
}

export function getRequiredNonNegativeNumberEnv(name: string, defaultValue: number) {
  const value = getOptionalEnv(name);
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);
  if (Number.isFinite(parsed) && parsed >= 0) {
    return parsed;
  }

  throw new Error(`${name} must be a non-negative number.`);
}

export function getContextDatabaseEnvName(contextName: string) {
  return `DATABASE_URL_${contextName.replaceAll("-", "_").toUpperCase()}`;
}

export function getContextWaiterDatabaseEnvName(contextName: string) {
  return `${getContextDatabaseEnvName(contextName)}_WAITER`;
}

export function loadPlatformDatabaseConfig<TContextName extends string>(input: {
  contextNames: readonly TContextName[];
  missingControlDatabaseUrlError: string;
  productionLike?: boolean;
  productionMissingExplicitControlDatabaseUrlError?: string;
}): PlatformDatabaseConfig<TContextName> {
  const sharedDatabaseUrl = getOptionalEnv("DATABASE_URL");
  const explicitControlDatabaseUrl = getOptionalEnv("PLATFORM_CONTROL_DATABASE_URL");
  const workSignalDatabaseUrl = getOptionalEnv("PLATFORM_WORK_SIGNAL_DATABASE_URL");
  const controlDatabaseUrl = explicitControlDatabaseUrl ?? sharedDatabaseUrl;
  if (!controlDatabaseUrl) {
    throw new Error(input.missingControlDatabaseUrlError);
  }
  if (input.productionLike && !explicitControlDatabaseUrl && input.productionMissingExplicitControlDatabaseUrlError) {
    throw new Error(input.productionMissingExplicitControlDatabaseUrlError);
  }

  const contextDatabaseUrls = Object.fromEntries(
    input.contextNames.flatMap((contextName) => {
      const databaseUrl = getOptionalEnv(getContextDatabaseEnvName(contextName));

      return databaseUrl ? [[contextName, databaseUrl]] : [];
    }),
  ) as Readonly<Partial<Record<TContextName, string>>>;
  const contextWaiterDatabaseUrls = Object.fromEntries(
    input.contextNames.flatMap((contextName) => {
      const databaseUrl = getOptionalEnv(getContextWaiterDatabaseEnvName(contextName));

      return databaseUrl ? [[contextName, databaseUrl]] : [];
    }),
  ) as Readonly<Partial<Record<TContextName, string>>>;
  const missingContextNames = input.contextNames.filter(
    (contextName) => !sharedDatabaseUrl && !contextDatabaseUrls[contextName],
  );

  if (missingContextNames.length > 0) {
    throw new Error(
      `DATABASE_URL or per-context database URLs are required. Missing: ${missingContextNames
        .map((contextName) => getContextDatabaseEnvName(contextName))
        .join(", ")}.`,
    );
  }

  return {
    sharedDatabaseUrl,
    controlDatabaseUrl,
    workSignalDatabaseUrl,
    contextDatabaseUrls,
    contextWaiterDatabaseUrls,
  };
}

export function loadPoolConfig(): PlatformPoolConfig {
  return {
    max: getPositiveNumberEnv("DATABASE_POOL_MAX", 10),
    idleTimeoutMillis: getPositiveNumberEnv("DATABASE_POOL_IDLE_TIMEOUT_MS", 30_000),
    idleInTransactionSessionTimeoutMillis:
      getOptionalPositiveNumberEnv("DATABASE_POOL_IDLE_IN_TRANSACTION_SESSION_TIMEOUT_MS", Number.NaN) ?? undefined,
    connectionTimeoutMillis: getPositiveNumberEnv("DATABASE_POOL_CONNECTION_TIMEOUT_MS", 5_000),
  };
}

export function loadStorageConfig(input: {
  kindEnvName: string;
  localRootEnvName: string;
  publicBaseUrlEnvName: string;
  s3BucketEnvName: string;
  s3RegionEnvName: string;
  s3EndpointEnvName: string;
  s3AccessKeyIdEnvName: string;
  s3SecretAccessKeyEnvName: string;
  s3ForcePathStyleEnvName: string;
  defaultLocalRoot: string;
  defaultPublicBaseUrl: string;
  productionLike: boolean;
  productionFilesystemError: string;
  invalidKindError: string;
  missingS3ConfigError: string;
  mismatchedS3CredentialsError: string;
}): PlatformCatalogAssetStorageConfig {
  const kind = getOptionalEnv(input.kindEnvName) ?? (input.productionLike ? "s3" : "filesystem");

  if (kind === "filesystem") {
    if (input.productionLike) {
      throw new Error(input.productionFilesystemError);
    }

    return {
      kind: "filesystem",
      rootDir: getOptionalEnv(input.localRootEnvName) ?? input.defaultLocalRoot,
      publicBaseUrl: getOptionalEnv(input.publicBaseUrlEnvName) ?? input.defaultPublicBaseUrl,
    };
  }

  if (kind !== "s3") {
    throw new Error(input.invalidKindError);
  }

  const bucket = getOptionalEnv(input.s3BucketEnvName);
  const region = getOptionalEnv(input.s3RegionEnvName);
  const publicBaseUrl = getOptionalEnv(input.publicBaseUrlEnvName);
  const accessKeyId = getOptionalEnv(input.s3AccessKeyIdEnvName);
  const secretAccessKey = getOptionalEnv(input.s3SecretAccessKeyEnvName);

  if (!bucket || !region || !publicBaseUrl) {
    throw new Error(input.missingS3ConfigError);
  }
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error(input.mismatchedS3CredentialsError);
  }

  return {
    kind: "s3",
    bucket,
    region,
    publicBaseUrl,
    endpoint: getOptionalEnv(input.s3EndpointEnvName) ?? undefined,
    accessKeyId: accessKeyId ?? undefined,
    secretAccessKey: secretAccessKey ?? undefined,
    forcePathStyle: getBooleanEnv(input.s3ForcePathStyleEnvName, false),
  };
}

export function loadCatalogAssetStorageConfig(input: {
  port: number;
  productionLike: boolean;
  defaultPublicBaseUrl: string;
}): PlatformCatalogAssetStorageConfig {
  return loadStorageConfig({
    kindEnvName: "CATALOG_ASSET_STORAGE_KIND",
    localRootEnvName: "CATALOG_ASSET_LOCAL_ROOT",
    publicBaseUrlEnvName: "CATALOG_ASSET_PUBLIC_BASE_URL",
    s3BucketEnvName: "CATALOG_ASSET_S3_BUCKET",
    s3RegionEnvName: "CATALOG_ASSET_S3_REGION",
    s3EndpointEnvName: "CATALOG_ASSET_S3_ENDPOINT",
    s3AccessKeyIdEnvName: "CATALOG_ASSET_S3_ACCESS_KEY_ID",
    s3SecretAccessKeyEnvName: "CATALOG_ASSET_S3_SECRET_ACCESS_KEY",
    s3ForcePathStyleEnvName: "CATALOG_ASSET_S3_FORCE_PATH_STYLE",
    defaultLocalRoot: "artifacts/catalog-assets",
    defaultPublicBaseUrl: input.defaultPublicBaseUrl,
    productionLike: input.productionLike,
    productionFilesystemError: "CATALOG_ASSET_STORAGE_KIND=s3 is required for Catalog asset storage in production.",
    invalidKindError: "CATALOG_ASSET_STORAGE_KIND must be filesystem or s3.",
    missingS3ConfigError:
      "CATALOG_ASSET_S3_BUCKET, CATALOG_ASSET_S3_REGION, and CATALOG_ASSET_PUBLIC_BASE_URL are required when CATALOG_ASSET_STORAGE_KIND=s3.",
    mismatchedS3CredentialsError:
      "CATALOG_ASSET_S3_ACCESS_KEY_ID and CATALOG_ASSET_S3_SECRET_ACCESS_KEY must be configured together.",
  });
}

export function loadStripeProviderConfig(input: {
  productionLike: boolean;
  deploymentEnvironment?: DeploymentEnvironment;
  productionMissingConfigError: string;
}): PlatformStripeProviderConfig {
  const secretKey = getOptionalEnv("STRIPE_SECRET_KEY");
  const publishableKey = getOptionalEnv("STRIPE_PUBLISHABLE_KEY");
  const webhookSecret = getOptionalEnv("STRIPE_WEBHOOK_SECRET");
  const connectWebhookSecret = getOptionalEnv("STRIPE_CONNECT_WEBHOOK_SECRET");
  const apiBaseUrl = getOptionalEnv("STRIPE_API_BASE_URL") ?? undefined;
  const connectAccountsApi = resolveEnumEnv<PlatformStripeConnectAccountsApi>(
    "STRIPE_CONNECT_ACCOUNTS_API",
    getOptionalEnv("STRIPE_CONNECT_ACCOUNTS_API"),
    ["v1", "v2"],
    "v2",
  );
  const deploymentEnvironment = input.deploymentEnvironment ?? loadDeploymentEnvironment();
  const productionDeployment = deploymentEnvironment === "production";

  if (deploymentEnvironment === "staging" && !connectWebhookSecret) {
    throw new Error(
      "STRIPE_CONNECT_WEBHOOK_SECRET is required when DEPLOYMENT_ENVIRONMENT=staging; staging must use a distinct Connect webhook secret.",
    );
  }

  const resolvedConnectWebhookSecret =
    connectWebhookSecret ?? (!input.productionLike ? (webhookSecret ?? undefined) : undefined);

  if (input.productionLike && (!secretKey || !publishableKey || !webhookSecret || !connectWebhookSecret)) {
    throw new Error(input.productionMissingConfigError);
  }
  if (!productionDeployment && (secretKey?.startsWith("sk_live") || publishableKey?.startsWith("pk_live"))) {
    throw new Error("Live Stripe keys are only allowed when DEPLOYMENT_ENVIRONMENT=production.");
  }
  if (
    productionDeployment &&
    ((secretKey && !secretKey.startsWith("sk_live")) || (publishableKey && !publishableKey.startsWith("pk_live")))
  ) {
    throw new Error("STRIPE_SECRET_KEY and STRIPE_PUBLISHABLE_KEY must use live-mode keys in production.");
  }

  return {
    secretKey,
    publishableKey,
    webhookSecret,
    connectWebhookSecret,
    resolvedConnectWebhookSecret,
    connectAccountsApi,
    apiBaseUrl,
    paymentProcessor:
      secretKey && publishableKey && webhookSecret
        ? {
            kind: "stripe",
            secretKey,
            publishableKey,
            webhookSecret,
            apiBaseUrl,
          }
        : { kind: "fake" },
    moneyMovement:
      secretKey && resolvedConnectWebhookSecret
        ? {
            kind: "stripe",
            secretKey,
            webhookSecret: resolvedConnectWebhookSecret,
            connectAccountsApi,
            apiBaseUrl,
          }
        : { kind: "fake" },
  };
}

export function loadPostageConfig<TIncludeWebhookSecret extends boolean>(input: {
  productionLike: boolean;
  productionMissingApiKeyError: string;
  includeWebhookSecret: TIncludeWebhookSecret;
  productionMissingWebhookSecretError?: string;
}): PlatformPostageConfig<TIncludeWebhookSecret> {
  const apiKey = getOptionalEnv("EASYPOST_API_KEY");
  const webhookSecret = input.includeWebhookSecret
    ? (getOptionalEnv("EASYPOST_WEBHOOK_SECRET") ?? undefined)
    : undefined;
  const apiBaseUrl = getOptionalEnv("EASYPOST_API_BASE_URL") ?? undefined;
  const mode = resolveEnumEnv<"test" | "production">(
    "EASYPOST_MODE",
    getOptionalEnv("EASYPOST_MODE"),
    ["test", "production"],
    "test",
  );

  if (input.productionLike && !apiKey) {
    throw new Error(input.productionMissingApiKeyError);
  }
  if (input.productionLike && input.includeWebhookSecret && apiKey && !webhookSecret) {
    throw new Error(input.productionMissingWebhookSecretError);
  }
  if (!apiKey) {
    return { kind: "sandbox" };
  }

  return {
    kind: "easypost",
    apiKey,
    ...(input.includeWebhookSecret ? { webhookSecret } : {}),
    apiBaseUrl,
    mode,
  } as PlatformPostageConfig<TIncludeWebhookSecret>;
}

export function loadTcgplayerAutomationConfig(): PlatformTcgplayerAutomationConfig | null {
  const tcgAuthCookie = getOptionalEnv("TCGPLAYER_AUTOMATION_TCG_AUTH_COOKIE");
  if (!tcgAuthCookie) {
    return null;
  }

  const baseDomainConfig: PlatformTcgplayerAutomationDomainConfig = {
    requestDelayMs: getRequiredNonNegativeNumberEnv(
      "TCGPLAYER_AUTOMATION_REQUEST_DELAY_MS",
      DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG.requestDelayMs,
    ),
    rateLimitCooldownMs: getRequiredPositiveNumberEnv(
      "TCGPLAYER_AUTOMATION_RATE_LIMIT_COOLDOWN_MS",
      DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG.rateLimitCooldownMs,
    ),
    maxConcurrentRequests: getRequiredPositiveNumberEnv(
      "TCGPLAYER_AUTOMATION_MAX_CONCURRENT_REQUESTS",
      DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG.maxConcurrentRequests,
    ),
    adaptiveEnabled: getBooleanEnv(
      "TCGPLAYER_AUTOMATION_ADAPTIVE_ENABLED",
      DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG.adaptiveEnabled,
    ),
    minRequestDelayMs: getRequiredNonNegativeNumberEnv(
      "TCGPLAYER_AUTOMATION_MIN_REQUEST_DELAY_MS",
      DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG.minRequestDelayMs,
    ),
    maxRequestDelayMs: getRequiredPositiveNumberEnv(
      "TCGPLAYER_AUTOMATION_MAX_REQUEST_DELAY_MS",
      DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG.maxRequestDelayMs,
    ),
    learnedMinDelayMs: getRequiredNonNegativeNumberEnv(
      "TCGPLAYER_AUTOMATION_LEARNED_MIN_DELAY_MS",
      DEFAULT_TCGPLAYER_AUTOMATION_DOMAIN_CONFIG.learnedMinDelayMs,
    ),
  };

  return {
    auth: {
      tcgAuthCookie,
      userAgent: getOptionalEnv("TCGPLAYER_AUTOMATION_USER_AGENT") ?? DEFAULT_TCGPLAYER_AUTOMATION_USER_AGENT,
    },
    domainConfigs: mergeTcgplayerAutomationDomainConfigs(
      Object.fromEntries(TCGPLAYER_AUTOMATION_DOMAIN_KEYS.map((domainKey) => [domainKey, baseDomainConfig])) as Record<
        PlatformTcgplayerAutomationDomainKey,
        PlatformTcgplayerAutomationDomainConfig
      >,
      getOptionalJsonEnv<unknown>("TCGPLAYER_AUTOMATION_DOMAIN_CONFIG_JSON"),
    ),
    adaptiveConfig: {
      increaseMultiplier: getRequiredPositiveNumberEnv("TCGPLAYER_AUTOMATION_ADAPTIVE_INCREASE_MULTIPLIER", 2),
      floorStepMs: getRequiredPositiveNumberEnv("TCGPLAYER_AUTOMATION_ADAPTIVE_FLOOR_STEP_MS", 100),
      decreaseAmountMs: getRequiredPositiveNumberEnv("TCGPLAYER_AUTOMATION_ADAPTIVE_DECREASE_AMOUNT_MS", 100),
      successThreshold: getRequiredPositiveNumberEnv("TCGPLAYER_AUTOMATION_ADAPTIVE_SUCCESS_THRESHOLD", 10),
    },
    maxRetries: getRequiredNonNegativeNumberEnv("TCGPLAYER_AUTOMATION_MAX_RETRIES", 3),
  };
}

export function describeTcgplayerAutomationConfigForLogs(config: PlatformTcgplayerAutomationConfig | null) {
  if (!config) {
    return {
      configured: false,
    };
  }

  return {
    configured: true,
    auth: {
      tcgAuthCookie: "[configured]",
      userAgent: config.auth.userAgent ? "[configured]" : "[missing]",
    },
    domainConfigs: Object.fromEntries(
      Object.entries(config.domainConfigs).map(([domainKey, domainConfig]) => [
        domainKey,
        {
          requestDelayMs: domainConfig.requestDelayMs,
          rateLimitCooldownMs: domainConfig.rateLimitCooldownMs,
          maxConcurrentRequests: domainConfig.maxConcurrentRequests,
          adaptiveEnabled: domainConfig.adaptiveEnabled,
          minRequestDelayMs: domainConfig.minRequestDelayMs,
          maxRequestDelayMs: domainConfig.maxRequestDelayMs,
          learnedMinDelayMs: domainConfig.learnedMinDelayMs,
        },
      ]),
    ),
    maxRetries: config.maxRetries,
  };
}

export function resolveMobileMessagingProvider(value: string | null): PlatformMobileMessagingProvider {
  return resolveEnumEnv<PlatformMobileMessagingProvider>(
    "MOBILE_MESSAGING_PROVIDER",
    value,
    ["noop", "twilio"],
    "noop",
  );
}

function mergeTcgplayerAutomationDomainConfigs(
  defaults: Record<PlatformTcgplayerAutomationDomainKey, PlatformTcgplayerAutomationDomainConfig>,
  overrides: unknown,
): Record<PlatformTcgplayerAutomationDomainKey, PlatformTcgplayerAutomationDomainConfig> {
  if (overrides === null) {
    return defaults;
  }
  if (!isRecord(overrides)) {
    throw new Error("TCGPLAYER_AUTOMATION_DOMAIN_CONFIG_JSON must be a JSON object.");
  }

  const domainKeys = new Set(TCGPLAYER_AUTOMATION_DOMAIN_KEYS);
  const merged = { ...defaults };
  for (const [domainKey, value] of Object.entries(overrides)) {
    if (!domainKeys.has(domainKey as PlatformTcgplayerAutomationDomainKey)) {
      throw new Error(`TCGPLAYER_AUTOMATION_DOMAIN_CONFIG_JSON contains unsupported domain '${domainKey}'.`);
    }
    if (!isRecord(value)) {
      throw new Error(`TCGPLAYER_AUTOMATION_DOMAIN_CONFIG_JSON.${domainKey} must be an object.`);
    }

    merged[domainKey as PlatformTcgplayerAutomationDomainKey] = {
      ...merged[domainKey as PlatformTcgplayerAutomationDomainKey],
      ...readTcgplayerAutomationDomainConfigOverride(domainKey, value),
    };
  }

  return merged;
}

function readTcgplayerAutomationDomainConfigOverride(
  domainKey: string,
  value: Readonly<Record<string, unknown>>,
): Partial<PlatformTcgplayerAutomationDomainConfig> {
  const requestDelayMs = readOptionalNumberOverride(value, domainKey, "requestDelayMs", false);
  const rateLimitCooldownMs = readOptionalNumberOverride(value, domainKey, "rateLimitCooldownMs", true);
  const maxConcurrentRequests = readOptionalNumberOverride(value, domainKey, "maxConcurrentRequests", true);
  const adaptiveEnabled = readOptionalBooleanOverride(value, domainKey, "adaptiveEnabled");
  const minRequestDelayMs = readOptionalNumberOverride(value, domainKey, "minRequestDelayMs", false);
  const maxRequestDelayMs = readOptionalNumberOverride(value, domainKey, "maxRequestDelayMs", true);
  const learnedMinDelayMs = readOptionalNumberOverride(value, domainKey, "learnedMinDelayMs", false);

  return {
    ...(requestDelayMs === undefined ? {} : { requestDelayMs }),
    ...(rateLimitCooldownMs === undefined ? {} : { rateLimitCooldownMs }),
    ...(maxConcurrentRequests === undefined ? {} : { maxConcurrentRequests }),
    ...(adaptiveEnabled === undefined ? {} : { adaptiveEnabled }),
    ...(minRequestDelayMs === undefined ? {} : { minRequestDelayMs }),
    ...(maxRequestDelayMs === undefined ? {} : { maxRequestDelayMs }),
    ...(learnedMinDelayMs === undefined ? {} : { learnedMinDelayMs }),
  };
}

function readOptionalNumberOverride(
  source: Readonly<Record<string, unknown>>,
  domainKey: string,
  key: keyof PlatformTcgplayerAutomationDomainConfig,
  positive: boolean,
): number | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value) || (positive ? value <= 0 : value < 0)) {
    throw new Error(
      `TCGPLAYER_AUTOMATION_DOMAIN_CONFIG_JSON.${domainKey}.${key} must be a ${
        positive ? "positive" : "non-negative"
      } number.`,
    );
  }

  return value;
}

function readOptionalBooleanOverride(
  source: Readonly<Record<string, unknown>>,
  domainKey: string,
  key: keyof PlatformTcgplayerAutomationDomainConfig,
): boolean | undefined {
  const value = source[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`TCGPLAYER_AUTOMATION_DOMAIN_CONFIG_JSON.${domainKey}.${key} must be a boolean.`);
  }

  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
