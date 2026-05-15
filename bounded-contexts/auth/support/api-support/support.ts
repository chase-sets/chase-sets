import { t } from "@chase-sets/localization";
import { hasPermission as hasActorPermission } from "@chase-sets/platform-runtime/auth";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import { createIdentityAuthRequestClient } from "@chase-sets/identity/server";
import type { Context, Hono, MiddlewareHandler } from "hono";

export type AuthApiEnv = {
  Variables: {
    context: EventStoreContext;
    actor: import("@chase-sets/auth-context").ResolvedActor | null;
  };
};

export type AuthApiApp = Hono<AuthApiEnv>;
export type AuthApiContext = Context<AuthApiEnv>;

export function getBootstrapContext(c: AuthApiContext) {
  return c.var.context;
}

export function getRequiredContext(c: AuthApiContext) {
  const context = c.var.context;
  if (!context) {
    throw new Error(t("auth.support.apiSupport.support.missing.auth.request.context"));
  }

  return context;
}

export function getRequiredActor(c: AuthApiContext) {
  const actor = c.var.actor;
  if (!actor) {
    throw new Error(t("auth.support.apiSupport.support.missing.auth.actor"));
  }

  return actor;
}

export function createIdentityMutations(c: AuthApiContext) {
  return createIdentityAuthRequestClient(c.req.raw);
}

export function createPermissionGuard(
  permission: string,
): MiddlewareHandler<AuthApiEnv> {
  return async (c, next) => {
    const actor = c.var.actor;
    if (!actor) {
      return c.json({ error: t("auth.support.apiSupport.support.authentication.required") }, 401);
    }

    if (!hasActorPermission(actor, permission)) {
      return c.json({ error: t("auth.support.apiSupport.support.forbidden") }, 403);
    }

    await next();
  };
}

export function createOwnedUserDisplayName(contactValue: string) {
  return contactValue.includes("@")
    ? contactValue.split("@")[0]
    : contactValue;
}
