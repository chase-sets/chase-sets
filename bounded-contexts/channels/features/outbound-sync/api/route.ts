import { Hono, type Context } from "hono";
import type { ChannelsApiEnv } from "../../../api";
import { OutboundSyncError, type OutboundSyncServices } from "../domain/contracts";
import type { ChannelConnectionServices } from "../../connections/domain/contracts";

export function createOutboundOperationRoutes(
  connections: ChannelConnectionServices,
  outboundSync: OutboundSyncServices,
) {
  const app = new Hono<ChannelsApiEnv>();

  app.get("/:connectionId/outbound-operations", async (c) => {
    const actor = c.get("actor");
    const connectionId = c.req.param("connectionId");
    const connection = await connections.getConnection({ accountId: actor.accountId, connectionId });
    if (!connection) return notFound(c);

    try {
      const limitText = c.req.query("limit");
      const limit = limitText === undefined ? undefined : Number(limitText);
      const cursor = c.req.query("cursor");
      const to = c.req.query("to") ?? new Date().toISOString();
      const from = c.req.query("from") ?? new Date(Date.parse(to) - 30 * 24 * 60 * 60 * 1_000).toISOString();
      const [log, summary] = await Promise.all([
        outboundSync.readOutboundOperationLog({
          accountId: actor.accountId,
          connectionId,
          ...(cursor ? { cursor } : {}),
          ...(limit === undefined ? {} : { limit }),
        }),
        outboundSync.readOutboundOperationSummary({
          accountId: actor.accountId,
          connectionId,
          window: { from, to },
        }),
      ]);
      return c.json({ connection, log, summary });
    } catch (error) {
      if (error instanceof OutboundSyncError && error.code === "invalid-input") {
        return c.json({ error: { code: "invalid_request", message: "invalid_request" } }, 400);
      }
      throw error;
    }
  });

  return app;
}

function notFound(c: Context<ChannelsApiEnv>) {
  return c.json({ error: { code: "channel_connection_not_found", message: "channel_connection_not_found" } }, 404);
}
