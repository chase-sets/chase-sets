import { bootstrapPlatformAdminPassword } from "@chase-sets/auth/server";
import { bootstrapPlatformAdminIdentity } from "@chase-sets/identity/server";
import { syncContextProjectionGroups } from "@chase-sets/bounded-context-runtime";
import { bootstrapPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { seedApiHostIfEmpty } from "@chase-sets/platform-runtime/api";
import { createFilesystemObjectStorage, createS3ObjectStorage } from "@chase-sets/object-storage";
import { createPlatformApiHost } from "./app";
import { loadBootstrapConfig } from "./config";
import { closePlatformApiPools, createPlatformApiPools } from "./database-pools";
import { ensurePreviewPostgresDatabases } from "./preview-postgres";
import { apiContextRegistry } from "./generated/api-context-registry";
import { createProductionTaxQuoteResolverBlocker, shouldBlockProductionTaxQuotes } from "./tax-readiness";
import { createFakeMoneyMovementGateway, createFakePaymentProcessorGateway } from "./test-support/provider-gateways";

// Keep every seed substep budget comfortably inside the deploy-quiesce window (the bootstrap
// job is killed ~780s in). A 30-minute lock budget could never clear before that kill, so it
// only produced silent hangs (exit 124) instead of an actionable error. Bounding the budgets
// here lets schema-bootstrap surface its descriptive lock-timeout error, and the substep
// timeout catches any non-lock stall, both well before the job is force-killed.
const DEPLOYMENT_SCHEMA_BOOTSTRAP_LOCK_WAIT_TIMEOUT_MS = 300_000;
const DEPLOYMENT_SEED_SUBSTEP_TIMEOUT_MS = 600_000;

async function bootstrap() {
  const config = await runBootstrapPhase("load-config", () => loadBootstrapConfig());
  if (config.previewPostgresAdminUrl) {
    await runBootstrapPhase("preview-postgres-databases", () => ensurePreviewPostgresDatabases(config));
  }
  const pools = await runBootstrapPhase("create-database-pools", () => createPlatformApiPools(config));

  try {
    await runBootstrapPhase("platform-control-plane", () => bootstrapPlatformControlPlane(pools.control));
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
          processorGateway: paymentProcessorGateway,
          paymentProcessorPublicConfiguration: paymentProcessorGateway.getPublicConfiguration(),
          moneyMovementGateway: createFakeMoneyMovementGateway(),
          listingPhotoStorage:
            config.listingPhotoStorage.kind === "s3"
              ? createS3ObjectStorage(config.listingPhotoStorage)
              : createFilesystemObjectStorage(config.listingPhotoStorage),
          returnIntakeEvidenceStorage:
            config.listingPhotoStorage.kind === "s3"
              ? createS3ObjectStorage({
                  ...config.listingPhotoStorage,
                  publicBaseUrl: "private://return-intake-evidence",
                })
              : createFilesystemObjectStorage({
                  rootDir: `${config.listingPhotoStorage.rootDir}/private-return-intake`,
                  publicBaseUrl: "private://return-intake-evidence",
                }),
          supportEvidenceAttachmentStorage:
            config.listingPhotoStorage.kind === "s3"
              ? createS3ObjectStorage({
                  ...config.listingPhotoStorage,
                  publicBaseUrl: "private://support-evidence",
                })
              : createFilesystemObjectStorage({
                  rootDir: `${config.listingPhotoStorage.rootDir}-private-support-evidence`,
                  publicBaseUrl: "private://support-evidence",
                }),
          ...(taxQuoteResolver ? { taxQuoteResolver } : {}),
        },
      }),
    );
    await runBootstrapPhase("seed-api-host", () =>
      seedApiHostIfEmpty(apiContextRegistry, "platform-api", runtime, {
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
      const admin = await runBootstrapPhase("platform-admin-identity", () =>
        bootstrapPlatformAdminIdentity(identityServices, {
          email: platformAdmin.email,
          displayName: platformAdmin.displayName,
          accountName: platformAdmin.accountName,
        }),
      );

      await runBootstrapPhase("auth-projection-sync", () => syncContextProjectionGroups(runtime, "auth"));
      await runBootstrapPhase("platform-admin-password", () =>
        bootstrapPlatformAdminPassword(authServices, {
          userId: admin.userId,
          credentialId: admin.credentialId,
          password: platformAdmin.password,
        }),
      );
      console.log("Platform admin bootstrap reconciled.");
    }

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

void bootstrap().catch((error) => {
  console.error("Platform API bootstrap failed.", error);
  process.exit(1);
});
