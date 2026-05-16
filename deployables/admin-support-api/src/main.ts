import "./observability-prelude";
import { serve } from "@hono/node-server";
import { refreshProjectionReplaySummary } from "@chase-sets/bounded-context-runtime";
import { bootstrapPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import {
  createFilesystemObjectStorage,
  createS3ObjectStorage,
  readFilesystemObject,
  type ObjectStorage,
} from "@chase-sets/object-storage";
import { getObservabilityRuntime } from "@chase-sets/observability";
import { buildAdminSupportApiApp, createAdminSupportApiHost } from "./app";
import { resolveActorFromRequest } from "./auth-request-context";
import { loadConfig, type AdminSupportCatalogAssetStorageConfig } from "./config";
import {
  closeAdminSupportApiPools,
  createAdminSupportApiPools,
} from "./database-pools";

const observability = getObservabilityRuntime();
const logger = observability.logger;
const config = loadConfig();
const pools = createAdminSupportApiPools(config);
await bootstrapPlatformControlPlane(pools.control);
const catalogAssetStorage = createCatalogAssetStorage(config.catalogAssetStorage);

const runtime = createAdminSupportApiHost({
  pools,
  hostPorts: {
    catalogAssetStorage,
  },
});
const app = buildAdminSupportApiApp(runtime, {
  internalAuthSecret: config.internalAuthSecret,
  adminRegistrationEnabled: config.adminRegistrationEnabled,
  getProjectionReplay: () => refreshProjectionReplaySummary(runtime),
  readinessChecks: runtime.mountedContexts.map((entry) => ({
    name: `${entry.contextName}.database`,
    check: async () => {
      await entry.pool.query("SELECT 1");
    },
  })),
  resolveActor: (request) =>
    resolveActorFromRequest(
      runtime.services.auth as Parameters<typeof resolveActorFromRequest>[0],
      request,
    ),
});
mountLocalCatalogAssetRoute(app, config.catalogAssetStorage);

serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info("Admin support API listening.", {
    type: "admin-support-api.started",
    port: info.port,
  });
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    void closeAdminSupportApiPools(pools)
      .finally(() => observability.shutdown())
      .finally(() => process.exit(0));
  });
}

function createCatalogAssetStorage(
  storageConfig: AdminSupportCatalogAssetStorageConfig,
): ObjectStorage {
  return storageConfig.kind === "s3"
    ? createS3ObjectStorage(storageConfig)
    : createFilesystemObjectStorage(storageConfig);
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
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}
