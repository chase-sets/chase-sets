import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ChannelsServices } from "./support/runtime-support/services";
import { channelConnectionRoutes } from "./features/connections/api/route";
import { createOutboundOperationRoutes } from "./features/outbound-sync/api/route";
import { channelListingCompositionRoutes } from "./features/listing-composition/api/route";

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
  app.route("/connections", createOutboundOperationRoutes(services.connections, services.outboundSync));
  app.route("/publication", channelListingCompositionRoutes(services.listingComposition));
  return app;
}
