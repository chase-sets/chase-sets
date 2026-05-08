import "./observability-prelude";
import { serve } from "@hono/node-server";
import { refreshProjectionReplaySummary } from "@chase-sets/bounded-context-runtime";
import { bootstrapPlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import { getObservabilityRuntime } from "@chase-sets/observability";
import { buildAdminSupportApiApp, createAdminSupportApiHost } from "./app";
import { resolveActorFromRequest } from "./auth-request-context";
import { loadConfig } from "./config";
import {
  closeAdminSupportApiPools,
  createAdminSupportApiPools,
} from "./database-pools";

const observability = getObservabilityRuntime();
const logger = observability.logger;
const config = loadConfig();
const pools = createAdminSupportApiPools(config);
await bootstrapPlatformControlPlane(pools.control);

const runtime = createAdminSupportApiHost({ pools });
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
