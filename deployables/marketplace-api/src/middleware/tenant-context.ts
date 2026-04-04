import type { Context, Next } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import {
  createActorEventStoreContext,
  type ResolvedActor,
} from "@chase-sets/auth-runtime";

export type TenantContextEnv = {
  Variables: {
    actor: ResolvedActor | null;
    context: EventStoreContext | null;
  };
};

export type MarketplaceActorResolver = (
  request: Request,
) => Promise<ResolvedActor | null>;

export function createMarketplaceAuthMiddleware(
  resolveActor: MarketplaceActorResolver,
) {
  return async function marketplaceAuthMiddleware(
    c: Context<TenantContextEnv>,
    next: Next,
  ): Promise<void> {
    const actor = await resolveActor(c.req.raw);

    c.set("actor", actor);
    c.set("context", actor ? createActorEventStoreContext(actor) : null);

    await next();
  };
}
