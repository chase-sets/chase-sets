import { Hono, type Handler } from "hono";
import type { ChannelsApiEnv } from "../../../api";
import { ChannelDriftError, type ChannelReconciliationServices } from "../domain/contracts";

export function createChannelDriftRoutes(services: ChannelReconciliationServices) {
  const app = new Hono<ChannelsApiEnv>();
  app.get("/:connectionId/drift", async (c) => {
    try {
      const query = c.req.queries();
      if (Object.keys(query).some((key) => key !== "cursor") || (query.cursor && query.cursor.length !== 1))
        throw new ChannelDriftError("invalid-command");
      const result = await services.readChannelDriftDetail({
        accountId: c.get("actor").accountId,
        connectionId: c.req.param("connectionId"),
        ...(query.cursor ? { cursor: query.cursor[0] } : {}),
      });
      return c.json(result, result.kind === "not-found" ? 404 : result.kind === "unavailable" ? 503 : 200);
    } catch (error) {
      return routeError(error);
    }
  });
  const decide =
    (kind: "accept" | "repush"): Handler<ChannelsApiEnv> =>
    async (c) => {
      try {
        if (c.get("actor").accountId !== String(c.get("context")?.audit.forAccountId))
          return c.json({ error: { code: "authorization_forbidden" } }, 403);
        const body: unknown = await c.req.json();
        if (typeof body !== "object" || body === null || Array.isArray(body))
          throw new ChannelDriftError("invalid-command");
        const record = body as Record<string, unknown>;
        const keys =
          kind === "accept"
            ? ["expectedDecisionRevision", "expectedMaterialFingerprint", "observedFingerprint", "operationId"]
            : ["expectedDecisionRevision", "operationId"];
        if (
          Object.keys(record).sort().join(",") !== keys.join(",") ||
          typeof record.operationId !== "string" ||
          record.operationId.length < 1 ||
          record.operationId.length > 512 ||
          typeof record.expectedDecisionRevision !== "number" ||
          !Number.isSafeInteger(record.expectedDecisionRevision) ||
          record.expectedDecisionRevision < 0
        )
          throw new ChannelDriftError("invalid-command");
        const connectionId = c.req.param("connectionId");
        const channelListingId = c.req.param("channelListingId");
        if (!connectionId || !channelListingId) throw new ChannelDriftError("invalid-command");
        const input = {
          connectionId,
          channelListingId,
          operationId: record.operationId,
          expectedDecisionRevision: record.expectedDecisionRevision,
        };
        if (kind === "repush") return c.json(await services.repushChannelListing(input, c.get("context")));
        if (typeof record.observedFingerprint !== "string" || typeof record.expectedMaterialFingerprint !== "string")
          throw new ChannelDriftError("invalid-command");
        return c.json(
          await services.acceptChannelDrift(
            {
              ...input,
              observedFingerprint: record.observedFingerprint,
              expectedMaterialFingerprint: record.expectedMaterialFingerprint,
            },
            c.get("context"),
          ),
        );
      } catch (error) {
        return routeError(error);
      }
    };
  app.post("/:connectionId/drift/:channelListingId/accept", decide("accept"));
  app.post("/:connectionId/drift/:channelListingId/repush", decide("repush"));
  return app;
}

function routeError(error: unknown): Response {
  const code =
    error instanceof ChannelDriftError ? error.code : error instanceof SyntaxError ? "invalid-command" : "unavailable";
  const status = code === "not-found" ? 404 : code === "invalid-command" ? 400 : code === "unavailable" ? 503 : 409;
  return Response.json({ error: { code } }, { status });
}
