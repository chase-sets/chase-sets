import { Hono } from "hono";
import { module as authModule } from "@chase-sets/auth";
import { createCommercialTermsResolver } from "@chase-sets/commercial-terms/server";
import { discoveryRealtimeRegistration } from "@chase-sets/discovery/server";
import { module as identityModule } from "@chase-sets/identity";
import { marketplaceRealtimeRegistration } from "@chase-sets/marketplace/server";
import { createSettlementBalanceCreditResolver } from "@chase-sets/settlement/server";
import {
  attachApiMountMiddleware,
  attachWriteDrainMiddleware,
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
  createRealtimeRoutes,
  type RealtimeObserver,
  type RealtimeResourceLimits,
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
  drain?: () => Promise<void>;
  getProjectionReplay?: () =>
    | HealthProjectionReplaySummary
    | Promise<HealthProjectionReplaySummary>;
  readinessChecks?: readonly ReadinessCheck[];
  resolveActor?: PlatformActorResolver;
  realtimeObserver?: RealtimeObserver;
  realtimeResourceLimits?: RealtimeResourceLimits;
  mcp?: CreateMcpRoutesOptions;
}>;

export function createPlatformApiHost(
  options: Parameters<typeof createApiHost>[2],
): ApiHostRuntime {
  const commercialTermsPool = options.pools["commercial-terms"];
  const settlementPool = options.pools.settlement;
  const commercialTermsResolver = commercialTermsPool
    ? createCommercialTermsResolver({ db: commercialTermsPool })
    : undefined;
  const balanceCreditResolver = settlementPool
    ? createSettlementBalanceCreditResolver(settlementPool)
    : undefined;

  return createApiHost(apiContextRegistry, "platform-api", {
    ...options,
    hostPorts: {
      ...options.hostPorts,
      ...(commercialTermsResolver ? { commercialTermsResolver } : {}),
      ...(balanceCreditResolver ? { balanceCreditResolver } : {}),
    },
  });
}

export function buildPlatformApiApp(
  runtime: ApiHostRuntime,
  options: BuildPlatformApiOptions = {},
) {
  const app = new Hono<TenantContextEnv>();
  const apiMounts = resolveApiHostMounts(runtime);
  const identityServices = {
    auth: runtime.services.auth as ReturnType<typeof authModule.createServices>,
    identity: runtime.services.identity as ReturnType<typeof identityModule.createServices>,
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

  const platformActorMiddleware = createPlatformActorMiddleware(
    options.resolveActor ?? (async () => null),
  );
  app.use("/mcp", platformActorMiddleware);
  app.use("/mcp/*", platformActorMiddleware);
  app.route("/mcp", createMcpRoutes(options.mcp));
  app.route(
    "/api/realtime",
    createRealtimeRoutes({
      stores: runtime.mountedContexts
        .filter((entry) =>
          entry.contextName === "discovery" || entry.contextName === "marketplace"
        )
        .map((entry) => ({
          ...(entry.contextName === "discovery"
            ? discoveryRealtimeRegistration
            : marketplaceRealtimeRegistration),
          contextName: entry.contextName,
          db: entry.pool,
        })),
      resolveActor: options.resolveActor ?? (async () => null),
      observer: options.realtimeObserver,
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
      .filter((mount) => mount.contextName === "auth" || mount.contextName === "identity")
      .map((mount) => mount.mountPath),
    createIdentityAuthMiddleware(identityServices),
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

  attachWriteDrainMiddleware(
    app,
    apiMounts,
    options.drain ?? (() => Promise.resolve()),
  );
  mountApiRouters(app, apiMounts);

  return app;
}
