import { Hono, type Context, type Next } from "hono";
import { module as authModule } from "@chase-sets/auth";
import { module as identityModule } from "@chase-sets/identity";
import {
  attachApiMountMiddleware,
  attachReadConsistencyMiddleware,
  attachWriteConsistencyMiddleware,
  mountApiRouters,
  type ReadConsistencyAuditRecord,
} from "@chase-sets/bounded-context-runtime";
import { createHonoObservabilityMiddleware, recordProjectionFreshnessAudit } from "@chase-sets/observability";
import {
  createHealthRoutes,
  type HealthProjectionReplaySummary,
  type ReadinessCheck,
} from "@chase-sets/platform-runtime/health";
import { createApiHost, resolveApiHostMounts, type ApiHostRuntime } from "@chase-sets/platform-runtime/api";
import {
  createProjectionOperationsRoutes,
  type ProjectionWakeStatusWorkSignalStore,
} from "@chase-sets/platform-runtime/projection-operations-routes";
import { errorHandler } from "@chase-sets/platform-runtime/error-handler";
import { authenticationRequiredResponse, forbiddenResponse } from "@chase-sets/http/responses";
import { apiContextRegistry } from "./generated/api-context-registry";
import {
  createIdentityAuthMiddleware,
  createPlatformActorMiddleware,
  type PlatformActorResolver,
  type TenantContextEnv,
} from "./middleware/auth-context";
import type { PlatformControlPlane } from "@chase-sets/platform-runtime/control-plane";

export type PlatformIdentityServices = Readonly<{
  auth: ReturnType<typeof authModule.createServices>;
  identity: ReturnType<typeof identityModule.createServices>;
}>;

export type BuildAdminSupportApiOptions = Readonly<{
  getProjectionReplay?: () => HealthProjectionReplaySummary | Promise<HealthProjectionReplaySummary>;
  readinessChecks?: readonly ReadinessCheck[];
  resolveActor?: PlatformActorResolver;
  internalAuthSecret?: string;
  adminRegistrationEnabled?: boolean;
  controlPlane?: PlatformControlPlane;
  workSignalStore?: ProjectionWakeStatusWorkSignalStore;
  isDraining?: () => boolean;
  readConsistencyAuditLogger?: Readonly<{
    info: (message: string, fields?: Readonly<Record<string, unknown>>) => void;
  }>;
}>;

export function createAdminSupportApiHost(options: Parameters<typeof createApiHost>[2]): ApiHostRuntime {
  return createApiHost(apiContextRegistry, "admin-support-api", options);
}

export function buildAdminSupportApiApp(runtime: ApiHostRuntime, options: BuildAdminSupportApiOptions = {}) {
  const app = new Hono<TenantContextEnv>();
  const apiMounts = resolveApiHostMounts(runtime);
  const identityServices = {
    auth: runtime.services.auth as ReturnType<typeof authModule.createServices>,
    identity: runtime.services.identity as ReturnType<typeof identityModule.createServices>,
  } satisfies PlatformIdentityServices;

  app.onError(errorHandler);
  app.use("*", createHonoObservabilityMiddleware());
  const createAdminSupportHealthRoutes = () =>
    createHealthRoutes({
      getProjectionReplay: options.getProjectionReplay,
      readinessChecks: options.readinessChecks,
      isDraining: options.isDraining,
    });
  app.route("/health", createAdminSupportHealthRoutes());
  app.route("/api/health", createAdminSupportHealthRoutes());

  if (!options.adminRegistrationEnabled) {
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

  const platformActorMiddleware = createPlatformActorMiddleware(options.resolveActor ?? (async () => null));
  app.use("/api/platform/projections", platformActorMiddleware);
  app.use("/api/platform/projections/*", platformActorMiddleware);
  app.route(
    "/api/platform/projections",
    createProjectionOperationsRoutes(runtime, {
      controlPlane: options.controlPlane,
      workSignalStore: options.workSignalStore,
    }),
  );

  attachApiMountMiddleware(
    app,
    apiMounts
      .filter((mount) => mount.contextName === "auth" || mount.contextName === "identity")
      .map((mount) => mount.mountPath),
    createIdentityAuthMiddleware(identityServices, {
      internalAuthSecret: options.internalAuthSecret,
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
    recordReadConsistencyAudit: (record: ReadConsistencyAuditRecord) => {
      recordProjectionFreshnessAudit(record);
      options.readConsistencyAuditLogger?.info("Read-after-write freshness evaluated.", record);
    },
  });
  mountApiRouters(app, apiMounts);

  return app;
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
