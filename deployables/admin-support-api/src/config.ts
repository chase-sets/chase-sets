import {
  getApiHostContextNames,
  nonProductionDataProfiles,
  productionLikeDataProfiles,
  type ApiHostContextName,
  type EnvironmentDataProfile,
} from "@chase-sets/platform-runtime/api";
import {
  getOptionalJsonEnv,
  getRequiredPositiveNumberEnv,
  loadTcgplayerAutomationConfig,
  type PlatformTcgplayerAutomationConfig,
} from "@chase-sets/platform-runtime/config-schema";
import {
  PLATFORM_INTERNAL_AUTH_SECRET_ENV,
  resolvePlatformInternalAuthSecret,
} from "@chase-sets/platform-runtime/http";
import type {
  ReadConsistencyExactDependencyMode,
  ReadConsistencyRouteTuning,
} from "@chase-sets/bounded-context-runtime";
import { apiContextRegistry } from "./generated/api-context-registry";

export type AdminSupportApiContextName = ApiHostContextName<typeof apiContextRegistry>;

export type AdminSupportApiPoolConfig = Readonly<{
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}>;

export type AdminSupportApiConfig = Readonly<{
  sharedDatabaseUrl: string | null;
  controlDatabaseUrl: string;
  contextDatabaseUrls: Readonly<Partial<Record<AdminSupportApiContextName, string>>>;
  pool: AdminSupportApiPoolConfig;
  port: number;
  internalAuthSecret: string;
  adminRegistrationEnabled: boolean;
  socialLogin: AdminSupportApiSocialLoginConfig;
  adminGoogleWorkspaceSso: AdminSupportApiAdminGoogleWorkspaceSsoConfig | null;
  catalogAssetStorage: AdminSupportCatalogAssetStorageConfig;
  tcgplayerAutomation: AdminSupportTcgplayerAutomationConfig | null;
  platformAdmin: AdminSupportPlatformAdminConfig | null;
  readConsistency: AdminSupportApiReadConsistencyConfig;
  deploymentEnvironment: string;
  dataProfiles: readonly EnvironmentDataProfile[];
}>;

export type AdminSupportApiSocialLoginProviderConfig = Readonly<{
  clientId: string;
  clientSecret: string;
}>;

export type AdminSupportApiSocialLoginConfig = Readonly<{
  google?: AdminSupportApiSocialLoginProviderConfig;
}>;

export type AdminSupportApiAdminGoogleWorkspaceSsoConfig = Readonly<{
  allowedHostedDomains: readonly string[];
}>;

export type AdminSupportCatalogAssetStorageConfig =
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

export type AdminSupportTcgplayerAutomationConfig = PlatformTcgplayerAutomationConfig;

export type AdminSupportPlatformAdminConfig = Readonly<{
  email: string;
  password: string;
  displayName: string;
  accountName: string;
}>;

export type AdminSupportApiReadConsistencyConfig = Readonly<{
  timeoutMs: number;
  pollIntervalMs: number;
  exactDependencyMode: ReadConsistencyExactDependencyMode;
  routeTuning: readonly ReadConsistencyRouteTuning[];
  wakeBeforeWaitEnabled: boolean;
}>;

const adminSupportContexts = getApiHostContextNames(apiContextRegistry, "admin-support-api");

function getOptionalEnv(name: string) {
  const value = process.env[name];
  return value?.trim() ? value.trim() : null;
}

function getOptionalPositiveNumberEnv(name: string, defaultValue: number) {
  const parsed = Number(process.env[name] ?? defaultValue);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getPositiveNumberEnv(name: string, defaultValue: number) {
  return getOptionalPositiveNumberEnv(name, defaultValue) ?? defaultValue;
}

function getBooleanEnv(name: string, defaultValue: boolean) {
  const value = getOptionalEnv(name);
  if (!value) {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

function getOptionalCsvEnv(name: string) {
  const value = getOptionalEnv(name);

  return value
    ? value
        .split(",")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

function getReadConsistencyExactDependencyModeEnv(name: string): ReadConsistencyExactDependencyMode {
  const value = getOptionalEnv(name) ?? "enabled";
  if (value === "enabled" || value === "target-context") {
    return value;
  }

  throw new Error(`${name} must be enabled or target-context.`);
}

function loadReadConsistencyRouteTuning(): readonly ReadConsistencyRouteTuning[] {
  const value = getOptionalJsonEnv<unknown>("READ_CONSISTENCY_ROUTE_TUNING_JSON") ?? [];
  if (!Array.isArray(value)) {
    throw new Error("READ_CONSISTENCY_ROUTE_TUNING_JSON must be a JSON array.");
  }

  return value.map((entry, index) => {
    if (!isRecord(entry)) {
      throw new Error(`READ_CONSISTENCY_ROUTE_TUNING_JSON[${index}] must be an object.`);
    }

    const mountPath = entry.mountPath;
    const routePath = entry.routePath;
    const targetContextName = entry.targetContextName;
    const timeoutMs = entry.timeoutMs;
    const pollIntervalMs = entry.pollIntervalMs;
    const exactDependencyMode = entry.exactDependencyMode;

    if (typeof mountPath !== "string" || !mountPath.trim().startsWith("/")) {
      throw new Error(`READ_CONSISTENCY_ROUTE_TUNING_JSON[${index}].mountPath must be an absolute path string.`);
    }
    if (typeof routePath !== "string" || !routePath.trim().startsWith("/")) {
      throw new Error(`READ_CONSISTENCY_ROUTE_TUNING_JSON[${index}].routePath must be an absolute path string.`);
    }
    if (targetContextName !== undefined && (typeof targetContextName !== "string" || !targetContextName.trim())) {
      throw new Error(`READ_CONSISTENCY_ROUTE_TUNING_JSON[${index}].targetContextName must be a string when set.`);
    }
    if (timeoutMs !== undefined && !isPositiveNumber(timeoutMs)) {
      throw new Error(`READ_CONSISTENCY_ROUTE_TUNING_JSON[${index}].timeoutMs must be a positive number when set.`);
    }
    if (pollIntervalMs !== undefined && !isPositiveNumber(pollIntervalMs)) {
      throw new Error(
        `READ_CONSISTENCY_ROUTE_TUNING_JSON[${index}].pollIntervalMs must be a positive number when set.`,
      );
    }
    if (
      exactDependencyMode !== undefined &&
      exactDependencyMode !== "enabled" &&
      exactDependencyMode !== "target-context"
    ) {
      throw new Error(
        `READ_CONSISTENCY_ROUTE_TUNING_JSON[${index}].exactDependencyMode must be enabled or target-context when set.`,
      );
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
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPositiveNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function getDeploymentEnvironment() {
  const deploymentEnvironment = getOptionalEnv("DEPLOYMENT_ENVIRONMENT");
  if (deploymentEnvironment) {
    return deploymentEnvironment;
  }

  if (process.env.NODE_ENV === "production") {
    return "production";
  }
  if (process.env.NODE_ENV === "test") {
    return "test";
  }

  return "dev";
}

function isProductionDeployment(environmentName: string) {
  return environmentName === "production";
}

function isLongLivedEnvironment(environmentName: string) {
  return environmentName === "production" || environmentName === "staging";
}

function assertDataProfilesAllowed(
  environmentName: string,
  profiles: readonly EnvironmentDataProfile[],
): readonly EnvironmentDataProfile[] {
  if (environmentName === "production" && profiles.includes("representative-commerce-state")) {
    throw new Error("representative-commerce-state is not allowed when DEPLOYMENT_ENVIRONMENT=production.");
  }

  return profiles;
}

function loadDataProfiles(environmentName: string): readonly EnvironmentDataProfile[] {
  const explicitProfiles = getOptionalCsvEnv("PLATFORM_DATA_PROFILES");
  if (explicitProfiles.length > 0) {
    const allowedProfiles = new Set<EnvironmentDataProfile>([
      "critical-bootstrap",
      "catalog-integration-bootstrap",
      "scenario-seed",
      "representative-commerce-state",
    ]);
    for (const profile of explicitProfiles) {
      if (!allowedProfiles.has(profile as EnvironmentDataProfile)) {
        throw new Error(`PLATFORM_DATA_PROFILES contains unsupported data profile '${profile}'.`);
      }
    }

    return assertDataProfilesAllowed(environmentName, explicitProfiles as readonly EnvironmentDataProfile[]);
  }

  if (isLongLivedEnvironment(environmentName)) {
    return assertDataProfilesAllowed(environmentName, productionLikeDataProfiles);
  }

  return assertDataProfilesAllowed(environmentName, nonProductionDataProfiles);
}

export function getContextDatabaseEnvName(contextName: AdminSupportApiContextName) {
  return `DATABASE_URL_${contextName.replaceAll("-", "_").toUpperCase()}`;
}

function loadPlatformAdminConfig(): AdminSupportPlatformAdminConfig | null {
  const email = getOptionalEnv("PLATFORM_ADMIN_EMAIL");
  const password = getOptionalEnv("PLATFORM_ADMIN_PASSWORD");

  if (!email && !password) {
    return null;
  }

  if (!email || !password) {
    throw new Error("PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD must be configured together.");
  }

  return {
    email,
    password,
    displayName: getOptionalEnv("PLATFORM_ADMIN_DISPLAY_NAME") ?? "Platform Admin",
    accountName: getOptionalEnv("PLATFORM_ADMIN_ACCOUNT_NAME") ?? "Chase Sets Platform",
  };
}

function loadCatalogAssetStorageConfig(port: number, productionLike: boolean): AdminSupportCatalogAssetStorageConfig {
  const kind = getOptionalEnv("CATALOG_ASSET_STORAGE_KIND") ?? (productionLike ? "s3" : "filesystem");

  if (kind === "filesystem") {
    if (productionLike) {
      throw new Error("CATALOG_ASSET_STORAGE_KIND=s3 is required for Catalog asset storage in production.");
    }

    return {
      kind: "filesystem",
      rootDir: getOptionalEnv("CATALOG_ASSET_LOCAL_ROOT") ?? "artifacts/catalog-assets",
      publicBaseUrl: getOptionalEnv("CATALOG_ASSET_PUBLIC_BASE_URL") ?? `http://localhost:${port}/catalog-assets`,
    };
  }

  if (kind !== "s3") {
    throw new Error("CATALOG_ASSET_STORAGE_KIND must be filesystem or s3.");
  }

  const bucket = getOptionalEnv("CATALOG_ASSET_S3_BUCKET");
  const region = getOptionalEnv("CATALOG_ASSET_S3_REGION");
  const publicBaseUrl = getOptionalEnv("CATALOG_ASSET_PUBLIC_BASE_URL");
  const accessKeyId = getOptionalEnv("CATALOG_ASSET_S3_ACCESS_KEY_ID");
  const secretAccessKey = getOptionalEnv("CATALOG_ASSET_S3_SECRET_ACCESS_KEY");

  if (!bucket || !region || !publicBaseUrl) {
    throw new Error(
      "CATALOG_ASSET_S3_BUCKET, CATALOG_ASSET_S3_REGION, and CATALOG_ASSET_PUBLIC_BASE_URL are required when CATALOG_ASSET_STORAGE_KIND=s3.",
    );
  }
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error(
      "CATALOG_ASSET_S3_ACCESS_KEY_ID and CATALOG_ASSET_S3_SECRET_ACCESS_KEY must be configured together.",
    );
  }

  return {
    kind: "s3",
    bucket,
    region,
    publicBaseUrl,
    endpoint: getOptionalEnv("CATALOG_ASSET_S3_ENDPOINT") ?? undefined,
    accessKeyId: accessKeyId ?? undefined,
    secretAccessKey: secretAccessKey ?? undefined,
    forcePathStyle: getBooleanEnv("CATALOG_ASSET_S3_FORCE_PATH_STYLE", false),
  };
}

export function loadConfig(): AdminSupportApiConfig {
  const deploymentEnvironment = getDeploymentEnvironment();
  const sharedDatabaseUrl = getOptionalEnv("DATABASE_URL");
  const controlDatabaseUrl = getOptionalEnv("PLATFORM_CONTROL_DATABASE_URL") ?? sharedDatabaseUrl;
  const googleSocialLoginClientId = getOptionalEnv("GOOGLE_SOCIAL_LOGIN_CLIENT_ID");
  const googleSocialLoginClientSecret = getOptionalEnv("GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET");
  const adminGoogleWorkspaceSsoDomains = getOptionalCsvEnv("ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS").map((value) =>
    value.toLowerCase(),
  );
  if (!controlDatabaseUrl) {
    throw new Error("PLATFORM_CONTROL_DATABASE_URL or DATABASE_URL is required.");
  }
  if (Boolean(googleSocialLoginClientId) !== Boolean(googleSocialLoginClientSecret)) {
    throw new Error("GOOGLE_SOCIAL_LOGIN_CLIENT_ID and GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET must be configured together.");
  }
  if (adminGoogleWorkspaceSsoDomains.length > 0 && (!googleSocialLoginClientId || !googleSocialLoginClientSecret)) {
    throw new Error(
      "ADMIN_GOOGLE_WORKSPACE_HOSTED_DOMAINS requires GOOGLE_SOCIAL_LOGIN_CLIENT_ID and GOOGLE_SOCIAL_LOGIN_CLIENT_SECRET.",
    );
  }

  const contextDatabaseUrls = Object.fromEntries(
    adminSupportContexts.flatMap((contextName) => {
      const databaseUrl = getOptionalEnv(getContextDatabaseEnvName(contextName));
      return databaseUrl ? [[contextName, databaseUrl]] : [];
    }),
  ) as Readonly<Partial<Record<AdminSupportApiContextName, string>>>;
  const missingContextNames = adminSupportContexts.filter(
    (contextName) => !sharedDatabaseUrl && !contextDatabaseUrls[contextName],
  );
  if (missingContextNames.length > 0) {
    throw new Error(
      `DATABASE_URL or per-context database URLs are required. Missing: ${missingContextNames
        .map((contextName) => getContextDatabaseEnvName(contextName))
        .join(", ")}.`,
    );
  }

  const port = Number(process.env.PORT ?? 6192);

  return {
    sharedDatabaseUrl,
    controlDatabaseUrl,
    contextDatabaseUrls,
    pool: {
      max: getPositiveNumberEnv("DATABASE_POOL_MAX", 10),
      idleTimeoutMillis: getPositiveNumberEnv("DATABASE_POOL_IDLE_TIMEOUT_MS", 30_000),
      connectionTimeoutMillis: getPositiveNumberEnv("DATABASE_POOL_CONNECTION_TIMEOUT_MS", 5_000),
    },
    port,
    internalAuthSecret: resolvePlatformInternalAuthSecret({
      requireExplicitInProduction: true,
    }),
    adminRegistrationEnabled: getBooleanEnv("ADMIN_REGISTRATION_ENABLED", false),
    socialLogin: {
      ...(googleSocialLoginClientId && googleSocialLoginClientSecret
        ? {
            google: {
              clientId: googleSocialLoginClientId,
              clientSecret: googleSocialLoginClientSecret,
            },
          }
        : {}),
    },
    adminGoogleWorkspaceSso:
      adminGoogleWorkspaceSsoDomains.length > 0
        ? {
            allowedHostedDomains: adminGoogleWorkspaceSsoDomains,
          }
        : null,
    catalogAssetStorage: loadCatalogAssetStorageConfig(port, isProductionDeployment(deploymentEnvironment)),
    tcgplayerAutomation: loadTcgplayerAutomationConfig(),
    platformAdmin: loadPlatformAdminConfig(),
    readConsistency: {
      timeoutMs: getRequiredPositiveNumberEnv("READ_CONSISTENCY_TIMEOUT_MS", 2_500),
      pollIntervalMs: getRequiredPositiveNumberEnv("READ_CONSISTENCY_POLL_INTERVAL_MS", 75),
      exactDependencyMode: getReadConsistencyExactDependencyModeEnv("READ_CONSISTENCY_EXACT_DEPENDENCY_MODE"),
      routeTuning: loadReadConsistencyRouteTuning(),
      wakeBeforeWaitEnabled: getBooleanEnv("READ_CONSISTENCY_WAKE_BEFORE_WAIT_ENABLED", false),
    },
    deploymentEnvironment,
    dataProfiles: loadDataProfiles(deploymentEnvironment),
  };
}

export { PLATFORM_INTERNAL_AUTH_SECRET_ENV };
