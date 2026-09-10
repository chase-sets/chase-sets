import { Hono, type Context } from "hono";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { ChannelsApiEnv } from "../../../api";
import { assertChannelMappingDecisionCommandPayload, assertChannelPublicationSettingsPayload } from "../domain/codecs";
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
    let input: ReturnType<typeof parseSettingsRequest>;
    try {
      input = parseSettingsRequest(await c.req.json());
    } catch {
      return invalidInput(c);
    }
    const actor = c.get("actor");
    const connectionId = c.req.param("connectionId");
    const owned = await services.readChannelPublicationConnection({
      accountId: actor.accountId,
      connectionId,
      limit: 1,
    });
    if (!owned) return missing(c);
    const result = await services.replaceChannelConnectionPublicationSettings(
      {
        accountId: actor.accountId,
        connectionId,
        ...input,
      },
      c.get("context") as EventStoreContext,
    );
    if (result.kind === "refused" && result.code === "unknown-link") return missing(c);
    return c.json(result, result.kind === "refused" && result.code === "stream-version-conflict" ? 409 : 200);
  });

  app.post("/:connectionId/mappings/:dimension/:sourceKey/decision", async (c) => {
    const dimension = c.req.param("dimension");
    if (dimension !== "category" && dimension !== "condition" && dimension !== "attribute") {
      return invalidInput(c);
    }
    let input: ReturnType<typeof parseMappingDecisionRequest>;
    let sourceKey: string;
    try {
      sourceKey = decodeURIComponent(c.req.param("sourceKey"));
      input = parseMappingDecisionRequest(await c.req.json(), dimension, sourceKey);
    } catch {
      return invalidInput(c);
    }
    const actor = c.get("actor");
    const connectionId = c.req.param("connectionId");
    const owned = await services.readChannelPublicationConnection({
      accountId: actor.accountId,
      connectionId,
      limit: 1,
    });
    if (!owned) return missing(c);
    const result = await services.decideChannelMappingReview(
      {
        accountId: actor.accountId,
        connectionId,
        dimension,
        sourceKey,
        ...input,
      },
      c.get("context") as EventStoreContext,
    );
    if (result.kind === "refused" && result.code === "unknown-link") return missing(c);
    return c.json(result, result.kind === "refused" && result.code === "stream-version-conflict" ? 409 : 200);
  });

  return app;
}

function parseLimit(value: string | undefined): number {
  const parsed = Number(value ?? 50);
  return Number.isSafeInteger(parsed) ? parsed : 50;
}
function parseSettingsRequest(value: unknown) {
  const body = record(value, ["expectedStreamVersion", "settings"]);
  const settings = record(body.settings, [
    "titlePrefix",
    "titleSuffix",
    "descriptionFooter",
    "categoryAllowlist",
    "excludedListingIds",
  ]);
  const parsed = {
    expectedStreamVersion: integer(body.expectedStreamVersion),
    settings: {
      titlePrefix: string(settings.titlePrefix),
      titleSuffix: string(settings.titleSuffix),
      descriptionFooter: string(settings.descriptionFooter),
      categoryAllowlist: strings(settings.categoryAllowlist),
      excludedListingIds: strings(settings.excludedListingIds),
    },
  };
  assertChannelPublicationSettingsPayload(parsed.settings);
  return parsed;
}
function parseMappingDecisionRequest(
  value: unknown,
  dimension: "category" | "condition" | "attribute",
  sourceKey: string,
) {
  const body = record(value, ["decision", "targetKey", "expectedStreamVersion"]);
  const decision = body.decision;
  if (decision !== "accept" && decision !== "auto-accept" && decision !== "reject" && decision !== "revoke") {
    throw new Error("invalid_input");
  }
  const parsed = {
    decision,
    targetKey: body.targetKey === null ? null : string(body.targetKey),
    expectedStreamVersion: integer(body.expectedStreamVersion),
  } as const;
  assertChannelMappingDecisionCommandPayload({
    dimension,
    sourceKey,
    decision: parsed.decision,
    targetKey: parsed.targetKey,
  });
  return parsed;
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid_input");
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => !keys.includes(key)) || keys.some((key) => !(key in result))) {
    throw new Error("invalid_input");
  }
  return result;
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
function invalidInput(c: Context<ChannelsApiEnv>) {
  return c.json({ error: { code: "invalid_input", message: "invalid_input" } }, 400);
}
function missing(c: Context<ChannelsApiEnv>) {
  return c.json({ error: { code: "not_found", message: "not_found" } }, 404);
}
