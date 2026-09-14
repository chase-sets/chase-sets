import { Hono } from "hono";
import type { ChannelsApiEnv } from "../../../api";
import { ChannelHealthError } from "../../connection-health/domain/contracts";
import { closed } from "../../connection-health/domain/codecs";
import { ChannelAttentionError, type ConnectionAttentionServices } from "../domain/contracts";
import { decodeChannelAttentionResolve } from "../domain/codecs";

export function createConnectionAttentionRoutes(services: ConnectionAttentionServices) {
  const app = new Hono<ChannelsApiEnv>();
  app.get("/:connectionId/attention", async (c) => {
    try {
      const rows = await services.listOpenAttention({
        accountId: c.get("actor").accountId,
        connectionId: c.req.param("connectionId"),
      });
      return c.json(rows[0]);
    } catch (error) {
      return routeError(error);
    }
  });
  app.post("/:connectionId/attention/resolve", async (c) => {
    try {
      const body = closed(await c.req.json(), ["reasonCode", "generation", "resolutionReason"]);
      const input = decodeChannelAttentionResolve({
        ...body,
        connection: { accountId: c.get("actor").accountId, connectionId: c.req.param("connectionId") },
      });
      const result = await services.resolveAttention(input, c.get("context"));
      return c.json(result, result.outcome === "stale" ? 409 : 200);
    } catch (error) {
      return routeError(error);
    }
  });
  return app;
}
function routeError(error: unknown): Response {
  if (error instanceof ChannelAttentionError || error instanceof ChannelHealthError)
    return Response.json(
      { error: { code: error.code } },
      { status: error.code === "connection-not-found" ? 404 : 400 },
    );
  if (error instanceof SyntaxError)
    return Response.json({ error: { code: "invalid-attention-contract" } }, { status: 400 });
  throw error;
}
