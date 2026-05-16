import {
  getApiHostContextNames,
  type ApiHostContextName,
} from "@chase-sets/platform-runtime/api";
import {
  PLATFORM_INTERNAL_AUTH_SECRET_ENV,
  resolvePlatformInternalAuthSecret,
} from "@chase-sets/platform-runtime/http";
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
  catalogAssetStorage: AdminSupportCatalogAssetStorageConfig;
  platformAdmin: AdminSupportPlatformAdminConfig | null;
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

export type AdminSupportPlatformAdminConfig = Readonly<{
  email: string;
  password: string;
  displayName: string;
  accountName: string;
}>;

const adminSupportContexts = getApiHostContextNames(
  apiContextRegistry,
  "admin-support-api",
);

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

function isProductionDeployment() {
  const deploymentEnvironment = getOptionalEnv("DEPLOYMENT_ENVIRONMENT");
  if (deploymentEnvironment) {
    return deploymentEnvironment === "production";
  }

  return process.env.NODE_ENV === "production";
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
    throw new Error(
      "PLATFORM_ADMIN_EMAIL and PLATFORM_ADMIN_PASSWORD must be configured together.",
    );
  }

  return {
    email,
    password,
    displayName: getOptionalEnv("PLATFORM_ADMIN_DISPLAY_NAME") ?? "Platform Admin",
    accountName: getOptionalEnv("PLATFORM_ADMIN_ACCOUNT_NAME") ?? "Chase Sets Platform",
  };
}

function loadCatalogAssetStorageConfig(
  port: number,
  productionLike: boolean,
): AdminSupportCatalogAssetStorageConfig {
  const kind = getOptionalEnv("CATALOG_ASSET_STORAGE_KIND") ??
    (productionLike ? "s3" : "filesystem");

  if (kind === "filesystem") {
    if (productionLike) {
      throw new Error(
        "CATALOG_ASSET_STORAGE_KIND=s3 is required for Catalog asset storage in production.",
      );
    }

    return {
      kind: "filesystem",
      rootDir: getOptionalEnv("CATALOG_ASSET_LOCAL_ROOT") ??
        "artifacts/catalog-assets",
      publicBaseUrl: getOptionalEnv("CATALOG_ASSET_PUBLIC_BASE_URL") ??
        `http://localhost:${port}/catalog-assets`,
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
  const sharedDatabaseUrl = getOptionalEnv("DATABASE_URL");
  const controlDatabaseUrl =
    getOptionalEnv("PLATFORM_CONTROL_DATABASE_URL") ?? sharedDatabaseUrl;
  if (!controlDatabaseUrl) {
    throw new Error("PLATFORM_CONTROL_DATABASE_URL or DATABASE_URL is required.");
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
    catalogAssetStorage: loadCatalogAssetStorageConfig(
      port,
      isProductionDeployment(),
    ),
    platformAdmin: loadPlatformAdminConfig(),
  };
}

export { PLATFORM_INTERNAL_AUTH_SECRET_ENV };
