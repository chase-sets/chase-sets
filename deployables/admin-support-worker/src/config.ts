import { getWorkerHostContextNames, type WorkerHostContextName } from "@chase-sets/platform-runtime/worker";
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
  port: number;
  workerId: string;
  maxConcurrentRunners: number;
  projectionMaxConcurrentRunners: number;
  jobMaxConcurrentRunners: number;
  pollIntervalMs: number;
  leaseTtlMs: number;
  leaseRenewIntervalMs: number;
}>;

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
    port: Number(process.env.PORT ?? 6193),
    workerId: getOptionalEnv("WORKER_ID") ?? `admin-support-worker-${process.pid}-${Date.now().toString(36)}`,
    maxConcurrentRunners,
    projectionMaxConcurrentRunners: getPositiveNumberEnv(
      "WORKER_PROJECTION_MAX_CONCURRENT_RUNNERS",
      maxConcurrentRunners,
    ),
    jobMaxConcurrentRunners: getPositiveNumberEnv(
      "WORKER_JOB_MAX_CONCURRENT_RUNNERS",
      Math.min(2, maxConcurrentRunners),
    ),
    pollIntervalMs: getPositiveNumberEnv("WORKER_POLL_INTERVAL_MS", 1_000),
    leaseTtlMs: getPositiveNumberEnv("WORKER_LEASE_TTL_MS", 30_000),
    leaseRenewIntervalMs: getPositiveNumberEnv("WORKER_LEASE_RENEW_INTERVAL_MS", 10_000),
  };
}
