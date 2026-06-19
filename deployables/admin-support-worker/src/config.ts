import { getWorkerHostContextNames, type WorkerHostContextName } from "@chase-sets/platform-runtime/worker";
import {
  loadTcgplayerAutomationConfig,
  type PlatformTcgplayerAutomationConfig,
} from "@chase-sets/platform-runtime/config-schema";
import { workerContextRegistry } from "./generated/worker-context-registry";

export type AdminSupportWorkerContextName = WorkerHostContextName<typeof workerContextRegistry>;

export type AdminSupportWorkerPoolConfig = Readonly<{
  max: number;
  idleTimeoutMillis: number;
  connectionTimeoutMillis: number;
}>;

export type AdminSupportWorkerConfig = Readonly<{
  sharedDatabaseUrl: string | null;
  controlDatabaseUrl: string;
  contextDatabaseUrls: Readonly<Partial<Record<AdminSupportWorkerContextName, string>>>;
  pool: AdminSupportWorkerPoolConfig;
  catalogAssetStorage: AdminSupportWorkerCatalogAssetStorageConfig;
  port: number;
  workerId: string;
  maxConcurrentRunners: number;
  projectionMaxConcurrentRunners: number;
  jobMaxConcurrentRunners: number;
  pollIntervalMs: number;
  leaseTtlMs: number;
  leaseRenewIntervalMs: number;
  tcgplayerAutomation: AdminSupportWorkerTcgplayerAutomationConfig | null;
}>;

export type AdminSupportWorkerCatalogAssetStorageConfig =
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

export type AdminSupportWorkerTcgplayerAutomationConfig = PlatformTcgplayerAutomationConfig;

const adminSupportContexts = getWorkerHostContextNames(workerContextRegistry, "admin-support-worker");

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

export function getContextDatabaseEnvName(contextName: AdminSupportWorkerContextName) {
  return `DATABASE_URL_${contextName.replaceAll("-", "_").toUpperCase()}`;
}

export function loadConfig(): AdminSupportWorkerConfig {
  const sharedDatabaseUrl = getOptionalEnv("DATABASE_URL");
  const controlDatabaseUrl = getOptionalEnv("PLATFORM_CONTROL_DATABASE_URL") ?? sharedDatabaseUrl;
  if (!controlDatabaseUrl) {
    throw new Error("PLATFORM_CONTROL_DATABASE_URL or DATABASE_URL is required.");
  }

  const contextDatabaseUrls = Object.fromEntries(
    adminSupportContexts.flatMap((contextName) => {
      const databaseUrl = getOptionalEnv(getContextDatabaseEnvName(contextName));
      return databaseUrl ? [[contextName, databaseUrl]] : [];
    }),
  ) as Readonly<Partial<Record<AdminSupportWorkerContextName, string>>>;
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

  const port = Number(process.env.PORT ?? 6193);
  const productionLike = process.env.NODE_ENV === "production";
  const maxConcurrentRunners = getPositiveNumberEnv("WORKER_MAX_CONCURRENT_RUNNERS", 4);

  return {
    sharedDatabaseUrl,
    controlDatabaseUrl,
    contextDatabaseUrls,
    pool: {
      max: getPositiveNumberEnv("DATABASE_POOL_MAX", 10),
      idleTimeoutMillis: getPositiveNumberEnv("DATABASE_POOL_IDLE_TIMEOUT_MS", 30_000),
      connectionTimeoutMillis: getPositiveNumberEnv("DATABASE_POOL_CONNECTION_TIMEOUT_MS", 5_000),
    },
    catalogAssetStorage: loadCatalogAssetStorageConfig(port, productionLike),
    port,
    workerId: getOptionalEnv("WORKER_ID") ?? `admin-support-worker-${process.pid}-${Date.now().toString(36)}`,
    maxConcurrentRunners,
    projectionMaxConcurrentRunners: getPositiveNumberEnv(
      "WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS",
      Math.min(2, maxConcurrentRunners),
    ),
    jobMaxConcurrentRunners: getPositiveNumberEnv("WORKER_JOB_MAX_CONCURRENT_RUNNERS", 1),
    pollIntervalMs: getPositiveNumberEnv("WORKER_POLL_INTERVAL_MS", 1_000),
    leaseTtlMs: getPositiveNumberEnv("WORKER_LEASE_TTL_MS", 30_000),
    leaseRenewIntervalMs: getPositiveNumberEnv("WORKER_LEASE_RENEW_INTERVAL_MS", 10_000),
    tcgplayerAutomation: loadTcgplayerAutomationConfig(),
  };
}

function loadCatalogAssetStorageConfig(
  port: number,
  productionLike: boolean,
): AdminSupportWorkerCatalogAssetStorageConfig {
  const kind = getOptionalEnv("CATALOG_ASSET_STORAGE_KIND") ?? (productionLike ? "s3" : "filesystem");

  if (kind === "filesystem") {
    if (productionLike) {
      throw new Error("CATALOG_ASSET_STORAGE_KIND=s3 is required for Catalog asset storage in production.");
    }

    return {
      kind: "filesystem",
      rootDir: getOptionalEnv("CATALOG_ASSET_LOCAL_ROOT") ?? "artifacts/catalog-assets",
      publicBaseUrl:
        getOptionalEnv("CATALOG_ASSET_PUBLIC_BASE_URL") ??
        `${(getOptionalEnv("ADMIN_SUPPORT_API_URL") ?? `http://localhost:${port}`).replace(/\/$/, "")}/catalog-assets`,
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
