import "./observability-prelude";
import { serve } from "@hono/node-server";
import { refreshProjectionReplaySummary } from "@chase-sets/bounded-context-runtime";
import { createGoogleSocialLoginProvider } from "@chase-sets/auth/server";
import {
  bootstrapPlatformControlPlane,
  createPostgresPlatformControlPlane,
} from "@chase-sets/platform-runtime/control-plane";
import {
  configureDefaultDurableJobStreamLimiter,
  createDurableJobStreamLimiterFromRealtime,
} from "@chase-sets/platform-runtime/durable-job-events";
import { createProcessDrainState, startGracefulHttpServer } from "@chase-sets/platform-runtime/process-lifecycle";
import { createPostgresRealtimeStreamLimiter } from "@chase-sets/platform-runtime/realtime";
import { createPostgresWorkSignalStore } from "@chase-sets/platform-runtime/work-signal-store";
import {
  createFilesystemObjectStorage,
  createS3ObjectStorage,
  readFilesystemObject,
  type ObjectStorage,
} from "@chase-sets/object-storage";
import {
  getObservabilityRuntime,
  recordCatalogControlPlaneEvent,
  recordCatalogIntegrationJob,
  recordCatalogIntegrationOptionQuery,
} from "@chase-sets/observability";
import { buildAdminSupportApiApp, createAdminSupportApiHost } from "./app";
import { resolveActorFromRequest } from "./auth-request-context";
import { loadConfig, type AdminSupportCatalogAssetStorageConfig } from "./config";
import { closeAdminSupportApiPools, createAdminSupportApiPools } from "./database-pools";

const observability = getObservabilityRuntime();
const logger = observability.logger;
const config = loadConfig();
const pools = createAdminSupportApiPools(config);
await bootstrapPlatformControlPlane(pools.control);
const controlPlane = createPostgresPlatformControlPlane(pools.control);
configureDefaultDurableJobStreamLimiter(
  createDurableJobStreamLimiterFromRealtime(createPostgresRealtimeStreamLimiter({ pool: pools.control })),
);
const catalogAssetStorage = createCatalogAssetStorage(config.catalogAssetStorage);
const sourceObservationTelemetry = createSourceObservationTelemetry();
const socialLoginProviders = [
  ...(config.socialLogin.google
    ? [
        createGoogleSocialLoginProvider({
          clientId: config.socialLogin.google.clientId,
          clientSecret: config.socialLogin.google.clientSecret,
        }),
      ]
    : []),
];

const runtime = createAdminSupportApiHost({
  pools,
  hostPorts: {
    catalogAssetStorage,
    sourceObservationTelemetry,
    socialLoginProviders,
    adminGoogleWorkspaceSso: config.adminGoogleWorkspaceSso,
  },
});
const drainState = createProcessDrainState();
const workSignalStore = createPostgresWorkSignalStore(pools.control, {
  ...(config.readConsistency.wakeBeforeWaitEnabled ? { readConsistencyGateway: {} } : {}),
});
const app = buildAdminSupportApiApp(runtime, {
  internalAuthSecret: config.internalAuthSecret,
  adminRegistrationEnabled: config.adminRegistrationEnabled,
  controlPlane,
  workSignalStore,
  getProjectionReplay: () => refreshProjectionReplaySummary(runtime),
  readConsistencyAuditLogger: logger,
  readConsistency: {
    ...config.readConsistency,
    workSignalGateway: workSignalStore.readConsistencyGateway,
  },
  readinessChecks: runtime.mountedContexts.map((entry) => ({
    name: `${entry.contextName}.database`,
    check: async () => {
      await entry.pool.query("SELECT 1");
    },
  })),
  isDraining: drainState.isDraining,
  resolveActor: (request) =>
    resolveActorFromRequest(runtime.services.auth as Parameters<typeof resolveActorFromRequest>[0], request),
});
mountLocalCatalogAssetRoute(app, config.catalogAssetStorage);

startGracefulHttpServer({
  name: "admin-support-api",
  port: config.port,
  serve,
  fetch: app.fetch,
  drainState,
  logger,
  onListening: (info) => {
    logger.info("Admin support API listening.", {
      type: "admin-support-api.started",
      port: info.port,
    });
  },
  onShutdown: [async () => closeAdminSupportApiPools(pools), async () => observability.shutdown()],
});

function createCatalogAssetStorage(storageConfig: AdminSupportCatalogAssetStorageConfig): ObjectStorage {
  return storageConfig.kind === "s3"
    ? createS3ObjectStorage(storageConfig)
    : createFilesystemObjectStorage(storageConfig);
}

function createSourceObservationTelemetry() {
  return {
    recordProviderOptionQuery: recordCatalogIntegrationOptionQuery,
    recordIntegrationJob: (event: { jobKind: string; result: string }) =>
      recordCatalogIntegrationJob({ ...event, operation: "integration-job" }),
    recordBulkReviewWorkUnit: (event: { jobKind: string; result: string }) =>
      recordCatalogIntegrationJob({ ...event, operation: "bulk-review-work-unit" }),
    recordControlPlaneEvent: recordCatalogControlPlaneEvent,
  };
}

function mountLocalCatalogAssetRoute(
  app: ReturnType<typeof buildAdminSupportApiApp>,
  storageConfig: AdminSupportCatalogAssetStorageConfig,
) {
  if (storageConfig.kind !== "filesystem") {
    return;
  }

  const routePrefix = "/catalog-assets/";
  app.get("/catalog-assets/*", async (c) => {
    const key = c.req.path.slice(routePrefix.length);
    const object = await readFilesystemObject(storageConfig.rootDir, key);
    if (!object) {
      return c.notFound();
    }

    return new Response(toArrayBuffer(object.body), {
      headers: {
        "cache-control": "public, max-age=31536000, immutable",
        "content-type": object.contentType,
      },
    });
  });
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
