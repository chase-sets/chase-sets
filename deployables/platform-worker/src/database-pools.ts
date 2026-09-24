import { type WorkerHostContextName } from "@chase-sets/platform-runtime/worker";
import { createPgPool } from "@chase-sets/event-core-postgres";
import {
  closeContextPools,
  createContextPools,
  type ContextPoolRegistry,
  type ContextPools,
} from "@chase-sets/platform-runtime/context-pools";
import {
  getContextDatabaseEnvName,
  getPlatformWorkerContextsForRuntimeProfile,
  type PlatformWorkerConfig,
} from "./config";
import { workerContextRegistry } from "./generated/worker-context-registry";

const PLATFORM_IDLE_TRANSACTION_TIMEOUT_MS = 15_000;

export function createPlatformWorkerPools(
  config: PlatformWorkerConfig,
): ContextPools<WorkerHostContextName<typeof workerContextRegistry>> {
  const platformWorkerPoolRegistry = {
    contextNames: getPlatformWorkerContextsForRuntimeProfile(config.runtimeProfile),
    getContextDatabaseEnvName,
    defaultPool: {
      max: 10,
      idleTimeoutMillis: 30_000,
      idleInTransactionSessionTimeoutMillis: PLATFORM_IDLE_TRANSACTION_TIMEOUT_MS,
      connectionTimeoutMillis: 5_000,
    },
  } satisfies ContextPoolRegistry<WorkerHostContextName<typeof workerContextRegistry>, PlatformWorkerConfig>;

  return createContextPools(platformWorkerPoolRegistry, config);
}

export const closePlatformWorkerPools = closeContextPools;

export class WorkerSettlementDirectDatabaseUrlRequiredError extends Error {
  readonly code = "WORKER_SETTLEMENT_DIRECT_DATABASE_URL_REQUIRED";

  constructor() {
    super(
      "WORKER_SETTLEMENT_DIRECT_DATABASE_URL_REQUIRED: BOOTSTRAP_DATABASE_URL_SETTLEMENT must be a direct database URL for schema bootstrap.",
    );
    this.name = "WorkerSettlementDirectDatabaseUrlRequiredError";
  }
}

export function selectSettlementBootstrapDatabaseUrl(
  config: PlatformWorkerConfig,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const directUrl =
    env.BOOTSTRAP_DATABASE_URL_SETTLEMENT?.trim() || config.contextDatabaseUrls.settlement || config.sharedDatabaseUrl;
  const deploymentEnvironment = env.DEPLOYMENT_ENVIRONMENT ?? (env.NODE_ENV === "production" ? "production" : "dev");
  const managedCluster = deploymentEnvironment === "staging" || deploymentEnvironment === "production";
  let parsed: URL;
  try {
    parsed = new URL(directUrl ?? "");
  } catch {
    throw new WorkerSettlementDirectDatabaseUrlRequiredError();
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    parsed.port === "25061" ||
    (managedCluster && parsed.port !== "25060")
  ) {
    throw new WorkerSettlementDirectDatabaseUrlRequiredError();
  }
  return directUrl!;
}

export function createSettlementBootstrapPool(config: PlatformWorkerConfig) {
  return createPgPool(selectSettlementBootstrapDatabaseUrl(config), {
    max: 1,
    connectionTimeoutMillis: 5_000,
  });
}
