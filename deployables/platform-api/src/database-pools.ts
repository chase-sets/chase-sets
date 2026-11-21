import { type ApiHostContextName } from "@chase-sets/platform-runtime/api";
import {
  closeContextPools,
  createContextPools,
  type ContextPoolRegistry,
  type ContextPools,
} from "@chase-sets/platform-runtime/context-pools";
import { createPgPool, type PgPoolOptions, type PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  getContextDatabaseEnvName,
  getPlatformApiContextsForRuntimeProfile,
  type PlatformApiBaseConfig,
} from "./config";
import { apiContextRegistry } from "./context-registry";

const PLATFORM_IDLE_TRANSACTION_TIMEOUT_MS = 15_000;
// Preserve the existing public-profile lock database across registry/profile/release changes.
export const PLATFORM_SCHEMA_BOOTSTRAP_LOCK_CONTEXT = "auth";
const PLATFORM_API_DEFAULT_POOL = {
  max: 10,
  idleTimeoutMillis: 30_000,
  idleInTransactionSessionTimeoutMillis: PLATFORM_IDLE_TRANSACTION_TIMEOUT_MS,
  connectionTimeoutMillis: 5_000,
};

export function createPlatformApiPools(
  config: PlatformApiBaseConfig,
): ContextPools<ApiHostContextName<typeof apiContextRegistry>> {
  const platformApiPoolRegistry = {
    contextNames: getPlatformApiContextsForRuntimeProfile(config.runtimeProfile),
    getContextDatabaseEnvName,
    defaultPool: PLATFORM_API_DEFAULT_POOL,
    resolveControlDatabaseUrl: ({ config, contextNames, resolveContextDatabaseUrl }) => {
      const firstContextName = contextNames[0];
      if (config.controlDatabaseUrl) {
        return config.controlDatabaseUrl;
      }
      if (config.sharedDatabaseUrl) {
        return config.sharedDatabaseUrl;
      }
      if (!firstContextName) {
        throw new Error("Platform API has no registered contexts to use as a control database fallback.");
      }

      return resolveContextDatabaseUrl(firstContextName);
    },
  } satisfies ContextPoolRegistry<ApiHostContextName<typeof apiContextRegistry>, PlatformApiBaseConfig>;

  return createContextPools(platformApiPoolRegistry, config);
}

/** Each API process holds at most two direct Auth connections for Pending Registration row locks. */
export const PENDING_REGISTRATION_LOCK_POOL_MAX = 2;
const PENDING_REGISTRATION_LOCK_URL_KEY = "BOOTSTRAP_DATABASE_URL_AUTH";

export type PendingRegistrationLockPool =
  | Readonly<{ pool: PgTransactionalPool; refusal: null }>
  | Readonly<{ pool: null; refusal: string }>;

/**
 * The separate pool a Pending Registration magic-link consume holds its row
 * lock on. Managed staging and production use only the direct
 * `BOOTSTRAP_DATABASE_URL_AUTH` (port 25060) under the Auth runtime user and
 * TLS settings; local, CI and preview use the Auth or shared URL. Any other URL
 * leaves the pool absent with a refusal that names no credential, and only
 * Pending Registration consumes are refused.
 */
export function createPendingRegistrationLockPool(
  config: PlatformApiBaseConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PendingRegistrationLockPool {
  const refuse = (reason: string): PendingRegistrationLockPool => ({
    pool: null,
    refusal: `Pending Registration lock pool is absent: ${reason}.`,
  });
  const managedCluster = config.deploymentEnvironment === "staging" || config.deploymentEnvironment === "production";
  const runtimeUrl = config.contextDatabaseUrls.auth ?? config.sharedDatabaseUrl ?? null;
  const lockUrl = managedCluster ? env[PENDING_REGISTRATION_LOCK_URL_KEY]?.trim() || null : runtimeUrl;
  if (!lockUrl) {
    return refuse(
      managedCluster ? `${PENDING_REGISTRATION_LOCK_URL_KEY} is not set` : "no Auth or shared database URL",
    );
  }
  const lock = parseDatabaseUrl(lockUrl);
  if (!lock || (lock.protocol !== "postgres:" && lock.protocol !== "postgresql:")) {
    return refuse("the lock URL is not a postgres:// URL");
  }
  // DigitalOcean's managed transaction pools use port 25061; direct cluster URLs use 25060.
  if (lock.port === "25061") {
    return refuse("the lock URL names a transaction pool");
  }
  if (managedCluster) {
    const runtime = parseDatabaseUrl(runtimeUrl ?? "");
    if (lock.port !== "25060") {
      return refuse(`${PENDING_REGISTRATION_LOCK_URL_KEY} is not a direct port 25060 URL`);
    }
    if (!runtime || lockUrl === runtimeUrl?.trim()) {
      return refuse(`${PENDING_REGISTRATION_LOCK_URL_KEY} is the runtime Auth URL`);
    }
    if (decodeURIComponent(lock.username) !== decodeURIComponent(runtime.username)) {
      return refuse(`${PENDING_REGISTRATION_LOCK_URL_KEY} does not use the Auth runtime user`);
    }
    const tlsSettings = ["sslmode", "sslrootcert", "uselibpqcompat"];
    if (tlsSettings.some((name) => lock.searchParams.get(name) !== runtime.searchParams.get(name))) {
      return refuse(`${PENDING_REGISTRATION_LOCK_URL_KEY} does not use the Auth runtime TLS settings`);
    }
  }

  try {
    return { pool: createPgPool(lockUrl, pendingRegistrationLockPoolOptions(config.pool)), refusal: null };
  } catch {
    return refuse("the lock pool could not be created");
  }
}

function pendingRegistrationLockPoolOptions(overrides: PgPoolOptions | undefined): PgPoolOptions {
  const defined = Object.fromEntries(Object.entries(overrides ?? {}).filter(([, value]) => value !== undefined));
  return { ...PLATFORM_API_DEFAULT_POOL, ...defined, max: PENDING_REGISTRATION_LOCK_POOL_MAX };
}

function parseDatabaseUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

export type PlatformApiRuntimePools = ReturnType<typeof createPlatformApiPools> &
  Readonly<{ pendingRegistrationLocks: PgTransactionalPool | null; pendingRegistrationLockRefusal: string | null }>;

/**
 * The serving process's pools: the context pools plus the separate Pending
 * Registration lock pool. Seed and bootstrap commands use only the context pools.
 */
export function createPlatformApiRuntimePools(
  config: PlatformApiBaseConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PlatformApiRuntimePools {
  const pools = createPlatformApiPools(config);
  const locks = createPendingRegistrationLockPool(config, env);
  return { ...pools, pendingRegistrationLocks: locks.pool, pendingRegistrationLockRefusal: locks.refusal };
}

const closingPools = new WeakMap<object, Promise<void>>();

/** Ends every distinct pool exactly once, however many shutdown or startup-failure paths ask. */
export function closePlatformApiPools(pools: Readonly<Record<string, unknown>>): Promise<void> {
  const closing = closingPools.get(pools) ?? closeContextPools(pools);
  closingPools.set(pools, closing);
  return closing;
}

type StartupFailureSignal = Readonly<{
  once: (event: "uncaughtExceptionMonitor", listener: () => void) => unknown;
  off: (event: "uncaughtExceptionMonitor", listener: () => void) => unknown;
}>;

/**
 * Closes the pools if startup fails before the server is listening, including
 * a rejected top-level await; `started()` hands the pools to graceful shutdown.
 */
export function closePlatformApiPoolsOnStartupFailure(
  pools: Readonly<Record<string, unknown>>,
  signal: StartupFailureSignal = process,
) {
  const close = () => {
    void closePlatformApiPools(pools).catch(() => undefined);
  };
  signal.once("uncaughtExceptionMonitor", close);
  return { started: () => void signal.off("uncaughtExceptionMonitor", close) };
}

export class SeedCommandDirectDatabaseUrlRequiredError extends Error {
  readonly code = "SEED_COMMAND_DIRECT_DATABASE_URL_REQUIRED";

  constructor(key: string) {
    super(`SEED_COMMAND_DIRECT_DATABASE_URL_REQUIRED: ${key} must be a direct database URL for schema bootstrap.`);
    this.name = "SeedCommandDirectDatabaseUrlRequiredError";
  }
}

/** Seed commands bootstrap schemas under a session lock; ordinary API pools are transaction-pooled. */
export function selectSeedCommandDatabaseConfig<T extends PlatformApiBaseConfig>(
  config: T,
  env: Readonly<Record<string, string | undefined>> = process.env,
): T {
  const managed = ["staging", "production", "preview"].includes(config.deploymentEnvironment ?? "");
  const managedCluster = config.deploymentEnvironment === "staging" || config.deploymentEnvironment === "production";
  const contexts = getPlatformApiContextsForRuntimeProfile(config.runtimeProfile);
  const contextDatabaseUrls = { ...config.contextDatabaseUrls };

  for (const contextName of contexts) {
    const key = `BOOTSTRAP_${getContextDatabaseEnvName(contextName)}`;
    // Standalone staging jobs export direct DATABASE_URL_* values; in-pod commands
    // receive pooled runtime URLs and dedicated BOOTSTRAP_* direct URLs.
    const directUrl = env[key]?.trim() || contextDatabaseUrls[contextName] || config.sharedDatabaseUrl;
    assertSessionCompatible(directUrl, key, managedCluster);
    contextDatabaseUrls[contextName] = directUrl;
  }

  const controlKey = "BOOTSTRAP_PLATFORM_CONTROL_DATABASE_URL";
  const controlUrl = env[controlKey]?.trim() || config.controlDatabaseUrl || config.sharedDatabaseUrl;
  assertSessionCompatible(controlUrl, controlKey, managedCluster);

  return {
    ...config,
    sharedDatabaseUrl: managed ? null : config.sharedDatabaseUrl,
    contextDatabaseUrls,
    controlDatabaseUrl: controlUrl,
  };
}

function assertSessionCompatible(
  url: string | null | undefined,
  key: string,
  managedCluster: boolean,
): asserts url is string {
  // DigitalOcean's managed transaction pools use port 25061; direct cluster URLs use 25060.
  let parsed: URL;
  try {
    parsed = new URL(url ?? "");
  } catch {
    throw new SeedCommandDirectDatabaseUrlRequiredError(key);
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.port === "25061" ||
    (managedCluster && parsed.port !== "25060")
  ) {
    throw new SeedCommandDirectDatabaseUrlRequiredError(key);
  }
}

export function createSeedCommandPools(config: PlatformApiBaseConfig) {
  const directConfig = selectSeedCommandDatabaseConfig(config);
  const poolOptions = { ...PLATFORM_API_DEFAULT_POOL, ...directConfig.pool, max: 1 };
  const pools = createPlatformApiPools({
    ...directConfig,
    pool: poolOptions,
  });
  const lockContextName = PLATFORM_SCHEMA_BOOTSTRAP_LOCK_CONTEXT;
  const lockUrl = directConfig.contextDatabaseUrls[lockContextName] ?? directConfig.sharedDatabaseUrl;
  if (!lockUrl) {
    throw new Error(`Missing direct database URL for schema bootstrap lock context '${lockContextName}'.`);
  }
  return { ...pools, schemaBootstrapLockPool: createPgPool(lockUrl, poolOptions) };
}
