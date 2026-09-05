import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ChannelsServices } from "./features/connections/domain/contracts";
import { channelConnectionRoutes } from "./features/connections/api/route";

export type ChannelsActor = Readonly<{
  accountId: string;
  permissions: readonly string[];
}>;

export type ChannelsApiEnv = {
  Variables: {
    actor: ChannelsActor;
    context: EventStoreContext;
  };
};

export function buildChannelsApi(services: ChannelsServices) {
  const app = new Hono<ChannelsApiEnv>();

  app.use("*", async (c, next) => {
    const actor = c.get("actor");
    if (!actor) return c.json({ error: { code: "authentication_required", message: "authentication_required" } }, 401);
    const permission = c.req.method === "GET" || c.req.method === "HEAD" ? "channels.view" : "channels.manage";
    if (!actor.permissions.includes(permission)) {
      return c.json({ error: { code: "authorization_forbidden", message: "authorization_forbidden" } }, 403);
    }
    await next();
  });

  app.route("/connections", channelConnectionRoutes(services.connections));
  return app;
}
