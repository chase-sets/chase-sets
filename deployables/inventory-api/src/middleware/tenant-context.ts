import type { Context, Next } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createActorEventStoreContext,
  hasPermission,
  type ResolvedActor,
} from "@chase-sets/auth-runtime";

export type TenantContextEnv = {
  Variables: {
    context: EventStoreContext;
    actor: ResolvedActor;
  };
};

export type InventoryActorResolver = (
  request: Request,
) => Promise<ResolvedActor | null>;

function getRequiredPermission(method: string) {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
      return "inventory.view" as const;
    default:
      return "inventory.manage" as const;
  }
}

export function createInventoryAuthMiddleware(resolveActor: InventoryActorResolver) {
  return async function inventoryAuthMiddleware(
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
