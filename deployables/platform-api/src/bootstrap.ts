import { pathToFileURL } from "node:url";
import { bootstrapPlatformAdminPassword } from "@chase-sets/auth/server";
import { bootstrapPlatformAdminIdentity } from "@chase-sets/identity/server";
import { syncContextProjectionGroups, withSchemaBootstrapLock } from "@chase-sets/bounded-context-runtime";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
  recordWorkerQuiesce,
} from "@chase-sets/platform-runtime/control-plane";
import {
  createProjectionGroupLeasePort,
  seedApiHostIfEmpty,
  SeedApiHostSubstepTimeoutError,
  type ProjectionGroupLeasePort,
} from "@chase-sets/platform-runtime/api";
import {
  PLATFORM_WORKER_KIND,
  quiescedDeploymentsIncludePlatformWorker,
} from "@chase-sets/platform-runtime/worker-event-capability";
import { createPlatformApiHost } from "./app";
import { createPlatformBootstrapStoragePorts } from "./bootstrap-storage";
import { loadBootstrapConfig } from "./config";
import { closePlatformApiPools, createSeedCommandPools } from "./database-pools";
import { ensurePreviewPostgresDatabases } from "./preview-postgres";
import { apiContextRegistry } from "./context-registry";
import { createProductionTaxQuoteResolverBlocker, shouldBlockProductionTaxQuotes } from "./tax-readiness";
import { createFakeMoneyMovementGateway, createFakePaymentProcessorGateway } from "./test-support/provider-gateways";

// Keep every seed substep budget comfortably inside the deploy-quiesce window (the bootstrap
// job is killed ~780s in). A 30-minute lock budget could never clear before that kill, so it
// only produced silent hangs (exit 124) instead of an actionable error. Bounding the budgets
// here lets schema-bootstrap surface its descriptive lock-timeout error, and the substep
// timeout catches any non-lock stall, both well before the job is force-killed.
const DEPLOYMENT_SCHEMA_BOOTSTRAP_LOCK_WAIT_TIMEOUT_MS = 300_000;
const DEPLOYMENT_SEED_SUBSTEP_TIMEOUT_MS = 600_000;

export async function bootstrap() {
  const config = await runBootstrapPhase("load-config", () => loadBootstrapConfig());
  if (config.previewPostgresAdminUrl) {
    await runBootstrapPhase("preview-postgres-databases", () => ensurePreviewPostgresDatabases(config));
  }
  const pools = await runBootstrapPhase("create-database-pools", () => createSeedCommandPools(config));

  try {
    await runBootstrapPhase("platform-control-plane", () => bootstrapPlatformControlPlane(pools.control));
    const controlPlane = createPostgresPlatformControlPlane(pools.control);
    const projectionGroupLeasePort = createProjectionGroupLeasePort(controlPlane, "platform-api");
    // The deployment quiesce sets this only after it confirmed that no platform worker pod remains, which
    // retires every earlier worker for producers gated on worker event capability.
    if (quiescedDeploymentsIncludePlatformWorker(process.env.CHASE_SETS_QUIESCED_DEPLOYMENTS)) {
      await runBootstrapPhase("platform-worker-quiesce", () =>
        recordWorkerQuiesce(pools.control, PLATFORM_WORKER_KIND),
      );
    }
    const paymentProcessorGateway = createFakePaymentProcessorGateway();
    const taxQuoteResolver = shouldBlockProductionTaxQuotes(
      config.deploymentEnvironment,
      Boolean(config.taxProviderBackedQuotesRequired),
    )
      ? createProductionTaxQuoteResolverBlocker()
      : undefined;
    const runtime = await runBootstrapPhase("create-runtime", () =>
      createPlatformApiHost({
        pools,
        runtimeProfile: config.runtimeProfile,
        hostPorts: {
          capabilityAdministrationAuthority: { kind: "deny-all", diagnostic: "authority_absent" },
          ...createPlatformBootstrapStoragePorts(config),
          processorGateway: paymentProcessorGateway,
          paymentProcessorPublicConfiguration: paymentProcessorGateway.getPublicConfiguration(),
          moneyMovementGateway: createFakeMoneyMovementGateway(),
          ...(taxQuoteResolver ? { taxQuoteResolver } : {}),
        },
      }),
    );
    await withSchemaBootstrapLock(
      pools.schemaBootstrapLockPool,
      {
        lockAcquisitionTimeoutMs: DEPLOYMENT_SCHEMA_BOOTSTRAP_LOCK_WAIT_TIMEOUT_MS,
      },
      async (schemaBootstrapLockAcquisition) => {
        await runBootstrapPhase("seed-api-host", () =>
          seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, {
            schemaBootstrapLockPool: pools.schemaBootstrapLockPool,
            schemaBootstrapLockAcquisition,
            projectionGroupLeasePort,
            enabledDataProfiles: config.dataProfiles ?? [],
            environmentName: config.deploymentEnvironment ?? null,
            runtimeProfile: config.runtimeProfile,
            substepTimeoutMs: DEPLOYMENT_SEED_SUBSTEP_TIMEOUT_MS,
            schemaBootstrap: {
              lockAcquisitionTimeoutMs: DEPLOYMENT_SCHEMA_BOOTSTRAP_LOCK_WAIT_TIMEOUT_MS,
              lockTimeoutRetryBudgetMs: DEPLOYMENT_SCHEMA_BOOTSTRAP_LOCK_WAIT_TIMEOUT_MS,
            },
          }),
        );

        const platformAdmin = config.platformAdmin;
        if (platformAdmin) {
          const identityServices = runtime.services.identity as Parameters<typeof bootstrapPlatformAdminIdentity>[0];
          const authServices = runtime.services.auth as Parameters<typeof bootstrapPlatformAdminPassword>[0];
          const admin = await runBootstrapPhase("platform-admin-identity", async () => {
            // A prior worker-less bootstrap may have committed Identity events without projecting them.
            await syncBootstrapProjectionGroups(runtime, "identity", projectionGroupLeasePort);
            return bootstrapPlatformAdminIdentity(identityServices, {
              email: platformAdmin.email,
              displayName: platformAdmin.displayName,
              accountName: platformAdmin.accountName,
            });
          });

          await runBootstrapPhase("auth-projection-sync", () =>
            syncBootstrapProjectionGroups(runtime, "auth", projectionGroupLeasePort),
          );
          await runBootstrapPhase("platform-admin-password", () =>
            bootstrapPlatformAdminPassword(authServices, {
              userId: admin.userId,
              credentialId: admin.credentialId,
              password: platformAdmin.password,
            }),
          );
          console.log("Platform admin bootstrap reconciled.");
        }
      },
    );

    console.log("Platform API bootstrap complete.");
  } finally {
    await runBootstrapPhase("close-database-pools", () => closePlatformApiPools(pools));
  }
}

async function runBootstrapPhase<T>(phase: string, action: () => T | Promise<T>): Promise<T> {
  const startedAt = Date.now();
  console.log(`[platform-bootstrap] ${phase} started.`);
  try {
    const result = await action();
    console.log(`[platform-bootstrap] ${phase} completed in ${Date.now() - startedAt}ms.`);
    return result;
  } catch (error) {
    console.error(`[platform-bootstrap] ${phase} failed after ${Date.now() - startedAt}ms.`, error);
    throw error;
  }
}

export async function syncBootstrapProjectionGroups(
  runtime: Parameters<typeof syncContextProjectionGroups>[0],
  contextName: string,
  leasePort: ProjectionGroupLeasePort,
  timeoutMs = DEPLOYMENT_SEED_SUBSTEP_TIMEOUT_MS,
): Promise<void> {
  const abort = new AbortController();
  const work = syncContextProjectionGroups(runtime, contextName, {
    context: { signal: abort.signal },
    runWithLease: leasePort.runWithLease,
  });
  const timeoutError = new SeedApiHostSubstepTimeoutError(`projection-sync:${contextName}`, timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          abort.abort();
          reject(timeoutError);
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (abort.signal.aborted) {
      await Promise.allSettled([work]);
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void bootstrap().catch((error) => {
    console.error("Platform API bootstrap failed.", error);
    process.exit(1);
  });
}
