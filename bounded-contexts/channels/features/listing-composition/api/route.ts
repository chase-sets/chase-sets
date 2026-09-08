import { Hono } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ChannelsApiEnv } from "../../../api";
import type { ChannelListingCompositionServices } from "./runtime";

export function channelListingCompositionRoutes(services: ChannelListingCompositionServices) {
  const app = new Hono<ChannelsApiEnv>();

  app.get("/", async (c) => {
    const actor = c.get("actor");
    return c.json({ items: await services.listChannelPublicationConnections({ accountId: actor.accountId }) });
  });

  app.get("/:connectionId", async (c) => {
    const actor = c.get("actor");
    const detail = await services.readChannelPublicationConnection({
      accountId: actor.accountId,
      connectionId: c.req.param("connectionId"),
      cursor: c.req.query("cursor") ?? null,
      limit: parseLimit(c.req.query("limit")),
    });
    return detail ? c.json(detail) : c.json({ error: { code: "not_found", message: "not_found" } }, 404);
  });

  app.put("/:connectionId/settings", async (c) => {
    const body = record(await c.req.json());
    const settings = record(body.settings);
    const result = await services.replaceChannelConnectionPublicationSettings(
      {
        connectionId: c.req.param("connectionId"),
        expectedStreamVersion: integer(body.expectedStreamVersion),
        settings: {
          titlePrefix: string(settings.titlePrefix),
          titleSuffix: string(settings.titleSuffix),
          descriptionFooter: string(settings.descriptionFooter),
          categoryAllowlist: strings(settings.categoryAllowlist),
          excludedListingIds: strings(settings.excludedListingIds),
        },
      },
      c.get("context") as EventStoreContext,
    );
    return c.json(result, result.kind === "refused" && result.code === "stream-version-conflict" ? 409 : 200);
  });

  app.post("/:connectionId/mappings/:dimension/:sourceKey/decision", async (c) => {
    const body = record(await c.req.json());
    const dimension = c.req.param("dimension");
    if (dimension !== "category" && dimension !== "condition" && dimension !== "attribute") {
      return c.json({ error: { code: "invalid_input", message: "invalid_input" } }, 400);
    }
    const decision = body.decision;
    if (decision !== "accept" && decision !== "auto-accept" && decision !== "reject" && decision !== "revoke") {
      return c.json({ error: { code: "invalid_input", message: "invalid_input" } }, 400);
    }
    const result = await services.decideChannelMappingReview(
      {
        connectionId: c.req.param("connectionId"),
        dimension,
        sourceKey: decodeURIComponent(c.req.param("sourceKey")),
        decision,
        targetKey: body.targetKey === null ? null : string(body.targetKey),
        expectedStreamVersion: integer(body.expectedStreamVersion),
      },
      c.get("context") as EventStoreContext,
    );
    return c.json(result, result.kind === "refused" && result.code === "stream-version-conflict" ? 409 : 200);
  });

  return app;
}

function parseLimit(value: string | undefined): number {
  const parsed = Number(value ?? 50);
  return Number.isSafeInteger(parsed) ? parsed : 50;
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_input");
  return value as Record<string, unknown>;
}
function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("invalid_input");
  return value;
}
function strings(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("invalid_input");
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error("invalid_input");
  return Number(value);
}
