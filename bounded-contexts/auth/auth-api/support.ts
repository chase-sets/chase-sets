import { hasPermission as hasActorPermission } from "@chase-sets/auth-runtime";
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
    throw new Error("Missing auth request context.");
  }

  return context;
}

export function getRequiredActor(c: AuthApiContext) {
  const actor = c.var.actor;
  if (!actor) {
    throw new Error("Missing auth actor.");
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
      return c.json({ error: "Authentication required." }, 401);
    }

    if (!hasActorPermission(actor, permission)) {
      return c.json({ error: "Forbidden." }, 403);
    }

    await next();
  };
}

export function createOwnedUserDisplayName(email: string) {
  return email.split("@")[0];
}
