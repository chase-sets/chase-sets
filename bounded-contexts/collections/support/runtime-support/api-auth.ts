import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { MiddlewareHandler } from "hono";

export type CollectionsActor = Readonly<{
  accountId: string;
  permissions: readonly string[];
}>;

export type CollectionsApiEnv = {
  Variables: {
    actor: CollectionsActor;
    context: EventStoreContext;
  };
};

export const requireCollectionsActor: MiddlewareHandler<CollectionsApiEnv> = async (c, next) => {
  if (!c.get("actor")) {
    return c.json({ error: { code: "authentication_required" } }, 401);
  }
  await next();
};
