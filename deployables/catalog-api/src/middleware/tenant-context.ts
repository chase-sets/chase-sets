import type { Context, Next } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createActorEventStoreContext,
  hasPermission,
  type ResolvedActor,
} from "@chase-sets/identity/server";

export type TenantContextEnv = {
  Variables: {
    context: EventStoreContext;
    actor: ResolvedActor;
  };
};

export type CatalogActorResolver = (
  request: Request,
) => Promise<ResolvedActor | null>;

function getRequiredPermission(method: string) {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
      return "catalog.view" as const;
    default:
      return "catalog.manage" as const;
  }
}

export function createCatalogAuthMiddleware(resolveActor: CatalogActorResolver) {
  return async function catalogAuthMiddleware(
    c: Context<TenantContextEnv>,
    next: Next,
  ): Promise<Response | void> {
    const actor = await resolveActor(c.req.raw);
    if (!actor) {
      return c.json({ error: "Authentication required." }, 401);
    }

    const requiredPermission = getRequiredPermission(c.req.method);
    if (!hasPermission(actor, requiredPermission)) {
      return c.json({ error: "Forbidden." }, 403);
    }

    c.set("actor", actor);
    c.set("context", createActorEventStoreContext(actor));
    await next();
  };
}
