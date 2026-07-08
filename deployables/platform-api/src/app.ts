import { Hono, type Context, type Next } from "hono";
import { module as authModule } from "@chase-sets/auth";
import {
  createUcpOAuthMetadataRoutes,
  createUcpOAuthRoutes,
  UCP_OAUTH_SUPPORTED_SCOPES,
} from "@chase-sets/auth/server";
import { createCheckoutUcpHandlers } from "@chase-sets/checkout/server";
import { createCommercialTermsResolver, type CommercialTermsAccountSource } from "@chase-sets/commercial-terms/server";
import {
  createDiscoveryUcpHandlers,
  discoveryRealtimeManifest,
  discoveryRealtimeTopicPolicyManifest,
} from "@chase-sets/discovery/server";
import { catalogRealtimeManifest, catalogRealtimeTopicPolicyManifest } from "@chase-sets/catalog/server";
import { module as identityModule } from "@chase-sets/identity";
import type { InventoryDraftListingCreator } from "@chase-sets/inventory/server";
import { createOrderingUcpHandlers } from "@chase-sets/ordering/server";
import { createPaymentsUcpHandoff, type UcpAp2MandateVerifier } from "@chase-sets/payments/server";
import { marketplaceRealtimeManifest, marketplaceRealtimeTopicPolicyManifest } from "@chase-sets/marketplace/server";
import { createSettlementBalanceCreditResolver } from "@chase-sets/settlement/server";
import {
  attachApiMountMiddleware,
  attachReadConsistencyMiddleware,
  attachWriteConsistencyMiddleware,
  mountApiRouters,
  type ReadConsistencyAuditRecord,
  type ReadConsistencyMiddlewareOptions,
} from "@chase-sets/bounded-context-runtime";
import { createHonoObservabilityMiddleware, recordProjectionFreshnessAudit } from "@chase-sets/observability";
import type { PgTransactionalPool } from "@chase-sets/event-core-postgres";
import {
  createHealthRoutes,
  type HealthProjectionReplaySummary,
  type ReadinessCheck,
} from "@chase-sets/platform-runtime/health";
import { createApiHost, resolveApiHostMounts, type ApiHostRuntime } from "@chase-sets/platform-runtime/api";
import type { PlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";
import {
  buildMcpHandlersFromModules,
  createMcpOAuthProtectedResourceMetadataRoutes,
  createMcpRoutes,
  type CreateMcpRoutesOptions,
} from "@chase-sets/platform-runtime/mcp";
import {
  createProjectionOperationsRoutes,
  type ProjectionWakeStatusWorkSignalStore,
} from "@chase-sets/platform-runtime/projection-operations-routes";
import {
  createUcpMcpRoutes,
  createUcpProfileRoutes,
  createUcpRestRoutes,
  addUcpAp2MerchantAuthorization,
  type CreateUcpRoutesOptions,
} from "@chase-sets/platform-runtime/ucp";
import type { AgentGrantSpendPolicy } from "@chase-sets/platform-runtime/agent-guardrails";
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
  type AnonymousRouteDeclaration,
  type PlatformActorResolver,
  type TenantContextEnv,
} from "./middleware/auth-context";
import type { PlatformApiRuntimeProfile } from "@chase-sets/platform-runtime/runtime-profiles";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import { authenticationRequiredResponse, forbiddenResponse } from "@chase-sets/http/responses";
import { apiContextRegistry } from "./generated/api-context-registry";

export type PlatformIdentityServices = Readonly<{
  auth: ReturnType<typeof authModule.createServices>;
  identity: ReturnType<typeof identityModule.createServices>;
}>;

export type BuildPlatformApiOptions = Readonly<{
  runtimeProfile?: PlatformApiRuntimeProfile;
  getProjectionReplay?: () => HealthProjectionReplaySummary | Promise<HealthProjectionReplaySummary>;
  readinessChecks?: readonly ReadinessCheck[];
  resolveActor?: PlatformActorResolver;
  realtimeObserver?: RealtimeObserver;
  realtimeResourceLimits?: RealtimeResourceLimits;
  realtimeRouteTuning?: RealtimeRouteTuning;
  realtimeCursorSigningSecret?: string;
  realtimeCursorSigningKeys?: RealtimeCursorSigningKeySet;
  realtimeStreamLimiter?: Parameters<typeof createRealtimeRoutes>[0]["streamLimiter"];
  realtimeWakeSignal?: Parameters<typeof createRealtimeRoutes>[0]["wakeSignal"];
  realtimeActiveConnectionCount?: () => number;
  isDraining?: () => boolean;
  mcp?: CreateMcpRoutesOptions;
  ucp?: CreateUcpRoutesOptions;
  agentGrantSpendPolicy?: AgentGrantSpendPolicy;
  ucpAp2MandateVerifier?: UcpAp2MandateVerifier;
  internalAuthSecret?: string;
  adminRegistrationEnabled?: boolean;
  controlPlane?: PlatformControlPlane;
  workSignalStore?: ProjectionWakeStatusWorkSignalStore;
  readConsistencyAuditLogger?: Readonly<{
    info: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  }>;
  readConsistency?: Pick<
    ReadConsistencyMiddlewareOptions,
    "timeoutMs" | "pollIntervalMs" | "exactDependencyMode" | "routeTuning" | "workSignalGateway"
  >;
}>;

export function createPlatformApiHost(
  options: Parameters<typeof createApiHost>[2] &
    Readonly<{
      runtimeProfile?: PlatformApiRuntimeProfile;
    }>,
): ApiHostRuntime {
  let runtime: ApiHostRuntime | null = null;
  const runtimeProfile = options.runtimeProfile ?? "public";
  const commercialTermsPool = getPlatformApiPool(options.pools["commercial-terms"]);
  const settlementPool = getPlatformApiPool(options.pools.settlement);
  const commercialTermsResolver = commercialTermsPool
    ? createCommercialTermsResolver({
        db: commercialTermsPool,
        accountSource: createIdentityCommercialTermsAccountSource(
          () => runtime?.services.identity as ReturnType<typeof identityModule.createServices> | undefined,
        ),
      })
    : undefined;
  const balanceCreditResolver = settlementPool ? createSettlementBalanceCreditResolver(settlementPool) : undefined;
  const draftListingCreator: InventoryDraftListingCreator = async (params, context) => {
    const marketplaceServices = runtime?.services.marketplace as
      | {
          listings?: {
            createBatchDraftListingFromInventorySnapshot?: InventoryDraftListingCreator;
          };
        }
      | undefined;
    const createDraft = marketplaceServices?.listings?.createBatchDraftListingFromInventorySnapshot;
    if (!createDraft) {
      throw new Error("Marketplace draft listing service is unavailable.");
    }

    return createDraft(params, context);
  };

  runtime = createApiHost(apiContextRegistry, "platform-api", {
    ...options,
    runtimeProfile,
    hostPorts: {
      ...options.hostPorts,
      ...(commercialTermsResolver ? { commercialTermsResolver } : {}),
      ...(balanceCreditResolver ? { balanceCreditResolver } : {}),
      draftListingCreator,
    },
  });
  return runtime;
}

function getPlatformApiPool(value: unknown): PgTransactionalPool | undefined {
  return value && typeof value === "object" && "query" in value ? (value as PgTransactionalPool) : undefined;
}

function createIdentityCommercialTermsAccountSource(
  getIdentityServices: () => ReturnType<typeof identityModule.createServices> | undefined,
): CommercialTermsAccountSource {
  return {
    getAccount: async (accountId) => {
      const account = await getIdentityServices()?.accounts.getAccountState(accountId);
      if (!account?.id || !account.accountType) {
        return null;
      }

      return {
        account_id: String(account.id),
        account_type: account.accountType,
        status: account.status,
      };
    },
  };
}

export function buildPlatformApiApp(runtime: ApiHostRuntime, options: BuildPlatformApiOptions = {}) {
  const app = new Hono<TenantContextEnv>();
  const runtimeProfile = options.runtimeProfile ?? "public";
  const marketplacePlatformRoutesEnabled = runtimeProfile !== "landing";
  const apiMounts = resolveApiHostMounts(runtime);
  const realtimeStores = runtime.mountedContexts
    .filter(
      (entry) =>
        entry.contextName === "catalog" || entry.contextName === "discovery" || entry.contextName === "marketplace",
    )
    .map((entry) => ({
      ...(entry.contextName === "catalog"
        ? catalogRealtimeManifest
        : entry.contextName === "discovery"
          ? discoveryRealtimeManifest
          : marketplaceRealtimeManifest),
      contextName: entry.contextName,
      db: entry.pool,
    }));
  const realtimeTopicPolicyManifest = composeRealtimeTopicPolicyManifest([
    catalogRealtimeTopicPolicyManifest,
    discoveryRealtimeTopicPolicyManifest,
    marketplaceRealtimeTopicPolicyManifest,
  ]);
  const identityServices = {
    auth: runtime.services.auth as ReturnType<typeof authModule.createServices>,
    identity: runtime.services.identity as ReturnType<typeof identityModule.createServices>,
  } satisfies PlatformIdentityServices;
  const discoveryServices = runtime.services.discovery as
    | { items?: Parameters<typeof createDiscoveryUcpHandlers>[0] }
    | undefined;
  const discoveryUcpHandlers = discoveryServices?.items
    ? createDiscoveryUcpHandlers(discoveryServices.items)
    : undefined;
  const checkoutServices = runtime.services.checkout as Parameters<typeof createCheckoutUcpHandlers>[0] | undefined;
  const paymentsServices = runtime.services.payments as
    | { publicConfig?: Parameters<typeof createPaymentsUcpHandoff>[0] }
    | undefined;
  const paymentHandoff = isPaymentProcessorPublicConfig(paymentsServices?.publicConfig)
    ? createPaymentsUcpHandoff(paymentsServices.publicConfig, {
        ap2Verifier: options.ucpAp2MandateVerifier,
      })
    : undefined;
  const checkoutUcpHandlers = checkoutServices?.sessions
    ? createCheckoutUcpHandlers(checkoutServices, {
        paymentHandoff,
        agentGrantSpendPolicy: options.agentGrantSpendPolicy,
        signCheckout: options.ucp?.businessSigningKeys
          ? (checkout) => addUcpAp2MerchantAuthorization(checkout, options.ucp?.businessSigningKeys)
          : undefined,
      })
    : undefined;
  const orderingServices = runtime.services.ordering as Parameters<typeof createOrderingUcpHandlers>[0] | undefined;
  const orderingUcpHandlers = orderingServices?.orders ? createOrderingUcpHandlers(orderingServices) : undefined;
  const moduleMcpHandlers = buildMcpHandlersFromModules(runtime.mountedModules);
  const mcpOptions = {
    ...options.mcp,
    agentGrantRateLimiter: options.mcp?.agentGrantRateLimiter ?? options.ucp?.agentGrantRateLimiter,
    toolHandlers: {
      ...moduleMcpHandlers.toolHandlers,
      ...options.mcp?.toolHandlers,
    },
    resourceHandlers: {
      ...moduleMcpHandlers.resourceHandlers,
      ...options.mcp?.resourceHandlers,
    },
  };
  const ucpOptions =
    discoveryUcpHandlers || checkoutUcpHandlers || orderingUcpHandlers
      ? {
          ...options.ucp,
          restHandlers: {
            ...discoveryUcpHandlers?.restHandlers,
            ...checkoutUcpHandlers?.restHandlers,
            ...orderingUcpHandlers?.restHandlers,
            ...options.ucp?.restHandlers,
          },
          mcpToolHandlers: {
            ...discoveryUcpHandlers?.mcpToolHandlers,
            ...checkoutUcpHandlers?.mcpToolHandlers,
            ...orderingUcpHandlers?.mcpToolHandlers,
            ...options.ucp?.mcpToolHandlers,
          },
        }
      : options.ucp;
  const resolveActor = options.resolveActor ?? (async () => null);
  const anonymousRoutes = resolveAuthIdentityAnonymousRoutes(runtime);

  app.onError(errorHandler);
  app.use("*", createHonoObservabilityMiddleware());
  app.route(
    "/health",
    createHealthRoutes({
      getProjectionReplay: options.getProjectionReplay,
      readinessChecks: options.readinessChecks,
      isDraining: options.isDraining,
    }),
  );
  app.route(
    "/api/health",
    createHealthRoutes({
      getProjectionReplay: options.getProjectionReplay,
      readinessChecks: options.readinessChecks,
      isDraining: options.isDraining,
    }),
  );
  if (marketplacePlatformRoutesEnabled) {
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
  }

  const platformActorMiddleware = createPlatformActorMiddleware(resolveActor);
  app.use("/api/platform/projections", platformActorMiddleware);
  app.use("/api/platform/projections/*", platformActorMiddleware);
  app.route(
    "/api/platform/projections",
    createProjectionOperationsRoutes(runtime, {
      controlPlane: options.controlPlane,
      workSignalStore: options.workSignalStore,
    }),
  );
  if (marketplacePlatformRoutesEnabled) {
    app.use("/mcp", platformActorMiddleware);
    app.use("/mcp/*", platformActorMiddleware);
    app.route("/mcp", createMcpRoutes(mcpOptions));
    app.route("/.well-known", createUcpProfileRoutes(options.ucp));
    app.route("/.well-known", createUcpOAuthMetadataRoutes());
    app.route(
      "/.well-known",
      createMcpOAuthProtectedResourceMetadataRoutes({ scopesSupported: UCP_OAUTH_SUPPORTED_SCOPES }),
    );
    app.use("/ucp/oauth/*", platformActorMiddleware);
    app.route(
      "/ucp/oauth",
      createUcpOAuthRoutes({
        auth: identityServices.auth,
        linkedPlatformAuthorizations: identityServices.identity.linkedPlatformAuthorizations,
        resolveActor,
      }),
    );
    app.use("/ucp/v1/*", platformActorMiddleware);
    app.use("/ucp/mcp", platformActorMiddleware);
    app.use("/ucp/mcp/*", platformActorMiddleware);
    app.route("/ucp/v1", createUcpRestRoutes(ucpOptions));
    app.route("/ucp/mcp", createUcpMcpRoutes(ucpOptions));
    app.route(
      "/api/realtime",
      createRealtimeRoutes({
        stores: realtimeStores,
        resolveActor,
        observer: options.realtimeObserver,
        wakeSignal: options.realtimeWakeSignal,
        streamLimiter: options.realtimeStreamLimiter,
        cursorSigningKeys: options.realtimeCursorSigningKeys ?? options.realtimeCursorSigningSecret,
        topicPolicyManifest: realtimeTopicPolicyManifest,
        isDraining: options.isDraining,
        ...options.realtimeRouteTuning,
        resourceLimits: options.realtimeResourceLimits ?? {
          maxTopicsPerStream: 16,
          maxActiveStreams: 1_000,
          maxActiveStreamsPerConnectionKey: 6,
        },
      }),
    );
  }

  if (runtimeProfile === "landing" && !options.adminRegistrationEnabled) {
    app.post("/api/auth/register", (c) =>
      c.json(
        {
          error: {
            code: "registration_disabled",
            message: "Admin registration is disabled.",
          },
        },
        403,
      ),
    );
  }

  attachApiMountMiddleware(
    app,
    apiMounts
      .filter((mount) => mount.contextName === "auth" || mount.contextName === "identity")
      .map((mount) => mount.mountPath),
    createIdentityAuthMiddleware(identityServices, {
      internalAuthSecret: options.internalAuthSecret,
      anonymousRoutes,
      resolveActor,
    }),
  );

  attachApiMountMiddleware(
    app,
    apiMounts
      .filter((mount) => mount.requiresAuth && mount.contextName !== "auth" && mount.contextName !== "identity")
      .map((mount) => mount.mountPath),
    platformActorMiddleware,
  );
  attachApiMountMiddleware(
    app,
    apiMounts.filter((mount) => mount.contextName === "catalog" && mount.requiresAuth).map((mount) => mount.mountPath),
    catalogApiPermissionMiddleware,
  );

  attachWriteConsistencyMiddleware(app, apiMounts);
  attachReadConsistencyMiddleware(app, apiMounts, runtime.projectionGroups, {
    timeoutMs: options.readConsistency?.timeoutMs,
    pollIntervalMs: options.readConsistency?.pollIntervalMs,
    exactDependencyMode: options.readConsistency?.exactDependencyMode,
    routeTuning: options.readConsistency?.routeTuning,
    workSignalGateway: options.readConsistency?.workSignalGateway,
    recordReadConsistencyAudit: (record: ReadConsistencyAuditRecord) => {
      recordProjectionFreshnessAudit(record);
      options.readConsistencyAuditLogger?.info("Read-after-write freshness evaluated.", record);
    },
  });
  mountApiRouters(app, apiMounts);

  return app;
}

function resolveAuthIdentityAnonymousRoutes(runtime: ApiHostRuntime): readonly AnonymousRouteDeclaration[] {
  return runtime.mountedContexts
    .filter((entry) => entry.contextName === "auth" || entry.contextName === "identity")
    .flatMap((entry) => {
      const module = entry.module as Readonly<{ anonymousRoutes?: readonly AnonymousRouteDeclaration[] }>;
      return module.anonymousRoutes ?? [];
    });
}

async function catalogApiPermissionMiddleware(c: Context<TenantContextEnv>, next: Next): Promise<Response | void> {
  const actor = c.get("actor");
  if (!actor) {
    return c.json(authenticationRequiredResponse(), 401);
  }

  const method = c.req.method.toUpperCase();
  const requiredPermission =
    method === "GET" || method === "HEAD" || method === "OPTIONS" ? "catalog.view" : "catalog.manage";
  if (!actor.permissions.includes(requiredPermission)) {
    return c.json(forbiddenResponse(), 403);
  }

  await next();
}

function isPaymentProcessorPublicConfig(value: unknown): value is Parameters<typeof createPaymentsUcpHandoff>[0] {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { processorName?: unknown }).processorName === "string" &&
    (value as { confirmationExperience?: unknown }).confirmationExperience === "processor-managed-form"
  );
}
