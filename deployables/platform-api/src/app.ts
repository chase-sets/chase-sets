import { Hono } from "hono";
import { module as authModule } from "@chase-sets/auth";
import { createCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import {
  discoveryRealtimeManifest,
  discoveryRealtimeTopicPolicyManifest,
} from "@chase-sets/discovery/server";
import { module as identityModule } from "@chase-sets/identity";
import type { InventoryDraftListingCreator } from "@chase-sets/inventory/server";
import {
  marketplaceRealtimeManifest,
  marketplaceRealtimeTopicPolicyManifest,
} from "@chase-sets/marketplace/server";
import { createSettlementBalanceCreditResolver } from "@chase-sets/settlement/server";
import {
  attachApiMountMiddleware,
  attachWriteDrainMiddleware,
  attachWriteConsistencyMiddleware,
  drainContextRuntime,
  mountApiRouters,
} from "@chase-sets/bounded-context-runtime";
import { createHonoObservabilityMiddleware } from "@chase-sets/observability";
import {
  createHealthRoutes,
  type HealthProjectionReplaySummary,
  type ReadinessCheck,
} from "@chase-sets/platform-runtime/health";
import {
  createApiHost,
  resolveApiHostMounts,
  type ApiHostRuntime,
} from "@chase-sets/platform-runtime/api";
import {
  createMcpRoutes,
  type CreateMcpRoutesOptions,
} from "@chase-sets/platform-runtime/mcp";
import {
  createRealtimeStatusSnapshot,
  createRealtimeRoutes,
  composeRealtimeTopicPolicyManifest,
  type RealtimeCursorSigningKeySet,
  type RealtimeObserver,
  type RealtimeResourceLimits,
  type RealtimeRouteTuning,
} from "@chase-sets/platform-runtime/realtime";
import {
  createIdentityAuthMiddleware,
  createPlatformActorMiddleware,
  type PlatformActorResolver,
  type TenantContextEnv,
} from "./middleware/auth-context";
import { errorHandler } from "./middleware/error-handler";
import { apiContextRegistry } from "./generated/api-context-registry";

export type PlatformIdentityServices = Readonly<{
  auth: ReturnType<typeof authModule.createServices>;
  identity: ReturnType<typeof identityModule.createServices>;
}>;

export type BuildPlatformApiOptions = Readonly<{
  getProjectionReplay?: () =>
    | HealthProjectionReplaySummary
    | Promise<HealthProjectionReplaySummary>;
  readinessChecks?: readonly ReadinessCheck[];
  resolveActor?: PlatformActorResolver;
  realtimeObserver?: RealtimeObserver;
  realtimeResourceLimits?: RealtimeResourceLimits;
  realtimeRouteTuning?: RealtimeRouteTuning;
  realtimeCursorSigningSecret?: string;
  realtimeCursorSigningKeys?: RealtimeCursorSigningKeySet;
  realtimeStreamLimiter?: Parameters<
    typeof createRealtimeRoutes
  >[0]["streamLimiter"];
  realtimeWakeSignal?: Parameters<typeof createRealtimeRoutes>[0]["wakeSignal"];
  realtimeActiveConnectionCount?: () => number;
  mcp?: CreateMcpRoutesOptions;
  internalAuthSecret?: string;
}>;

export function createPlatformApiHost(
  options: Parameters<typeof createApiHost>[2],
): ApiHostRuntime {
  let runtime: ApiHostRuntime | null = null;
  const commercialTermsPool = options.pools["commercial-terms"];
  const settlementPool = options.pools.settlement;
  const commercialTermsResolver = commercialTermsPool
    ? createCommercialTermsResolver({ db: commercialTermsPool })
    : undefined;
  const balanceCreditResolver = settlementPool
    ? createSettlementBalanceCreditResolver(settlementPool)
    : undefined;
  const draftListingCreator: InventoryDraftListingCreator = async (
    params,
    context,
  ) => {
    const marketplaceServices = runtime?.services.marketplace as
      | {
          listings?: {
            createBatchDraftListingFromInventorySnapshot?: InventoryDraftListingCreator;
          };
        }
      | undefined;
    const createDraft =
      marketplaceServices?.listings?.createBatchDraftListingFromInventorySnapshot;
    if (!createDraft) {
      throw new Error("Marketplace draft listing service is unavailable.");
    }

    return createDraft(params, context);
  };

  runtime = createApiHost(apiContextRegistry, "platform-api", {
    ...options,
    hostPorts: {
      ...options.hostPorts,
      ...(commercialTermsResolver ? { commercialTermsResolver } : {}),
      ...(balanceCreditResolver ? { balanceCreditResolver } : {}),
      draftListingCreator,
    },
  });
  return runtime;
}

export function buildPlatformApiApp(
  runtime: ApiHostRuntime,
  options: BuildPlatformApiOptions = {},
) {
  const app = new Hono<TenantContextEnv>();
  const apiMounts = resolveApiHostMounts(runtime);
  const realtimeStores = runtime.mountedContexts
    .filter(
      (entry) =>
        entry.contextName === "discovery" ||
        entry.contextName === "marketplace",
    )
    .map((entry) => ({
      ...(entry.contextName === "discovery"
        ? discoveryRealtimeManifest
        : marketplaceRealtimeManifest),
      contextName: entry.contextName,
      db: entry.pool,
    }));
  const realtimeTopicPolicyManifest = composeRealtimeTopicPolicyManifest([
    discoveryRealtimeTopicPolicyManifest,
    marketplaceRealtimeTopicPolicyManifest,
  ]);
  const identityServices = {
    auth: runtime.services.auth as ReturnType<typeof authModule.createServices>,
    identity: runtime.services.identity as ReturnType<
      typeof identityModule.createServices
    >,
  } satisfies PlatformIdentityServices;

  app.onError(errorHandler);
  app.use("*", createHonoObservabilityMiddleware());
  app.route(
    "/health",
    createHealthRoutes({
      getProjectionReplay: options.getProjectionReplay,
      readinessChecks: options.readinessChecks,
    }),
  );
  app.route(
    "/api/health",
    createHealthRoutes({
      getProjectionReplay: options.getProjectionReplay,
      readinessChecks: options.readinessChecks,
    }),
  );
  app.get("/internal/realtime/status", async (c) =>
    c.json(
      await createRealtimeStatusSnapshot({
        stores: realtimeStores,
        activeConnectionCount: options.realtimeActiveConnectionCount?.() ?? 0,
        wakeSignalConfigured: Boolean(options.realtimeWakeSignal),
        routeTuning: options.realtimeRouteTuning,
        resourceLimits: options.realtimeResourceLimits,
      }),
    ),
  );

  const platformActorMiddleware = createPlatformActorMiddleware(
    options.resolveActor ?? (async () => null),
  );
  app.use("/mcp", platformActorMiddleware);
  app.use("/mcp/*", platformActorMiddleware);
  app.route("/mcp", createMcpRoutes(options.mcp));
  app.route(
    "/api/realtime",
    createRealtimeRoutes({
      stores: realtimeStores,
      resolveActor: options.resolveActor ?? (async () => null),
      observer: options.realtimeObserver,
      wakeSignal: options.realtimeWakeSignal,
      streamLimiter: options.realtimeStreamLimiter,
      cursorSigningKeys:
        options.realtimeCursorSigningKeys ??
        options.realtimeCursorSigningSecret,
      topicPolicyManifest: realtimeTopicPolicyManifest,
      ...options.realtimeRouteTuning,
      resourceLimits: options.realtimeResourceLimits ?? {
        maxTopicsPerStream: 16,
        maxActiveStreams: 1_000,
        maxActiveStreamsPerConnectionKey: 6,
      },
    }),
  );

  attachApiMountMiddleware(
    app,
    apiMounts
      .filter(
        (mount) =>
          mount.contextName === "auth" || mount.contextName === "identity",
      )
      .map((mount) => mount.mountPath),
    createIdentityAuthMiddleware(identityServices, {
      internalAuthSecret: options.internalAuthSecret,
    }),
  );

  attachApiMountMiddleware(
    app,
    apiMounts
      .filter(
        (mount) =>
          mount.requiresAuth &&
          mount.contextName !== "auth" &&
          mount.contextName !== "identity",
      )
      .map((mount) => mount.mountPath),
    platformActorMiddleware,
  );

  attachWriteConsistencyMiddleware(app, apiMounts);
  attachWriteDrainMiddleware(app, apiMounts, () =>
    drainContextRuntime(runtime),
  );
  mountApiRouters(app, apiMounts);

  return app;
}
