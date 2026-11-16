import { Hono } from "hono";
import type { ChannelsApiEnv } from "../../../api";
import { EbayConnectionError } from "../domain/oauth";
import type { EbayConnectionServices } from "./runtime";
import type { EbaySellerSetupServices } from "./setup-runtime";
import { EbaySetupError } from "../domain/setup-material";
import { ChannelConnectionError } from "../../connections/domain/contracts";

export function createEbayConnectionRoutes(service: EbayConnectionServices, setup?: EbaySellerSetupServices) {
  const app = new Hono<ChannelsApiEnv>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    await next();
  });
  app.get("/consent", (c) => {
    if (!service.enabled) return c.json({ error: { code: "unavailable" } }, 404);
    const query = new URL(c.req.url).searchParams;
    if (
      [...query.keys()].some((key) => key !== "publication") ||
      query.getAll("publication").length > 1 ||
      ![null, "true", "false"].includes(query.get("publication"))
    )
      return c.json({ error: { code: "invalid-request" } }, 400);
    return c.json(service.consent(query.get("publication") === "true"));
  });
  app.post("/start", async (c) => {
    try {
      const value: unknown = await c.req.json();
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).some((key) => !["publication", "connectionId"].includes(key))
      )
        throw new EbayConnectionError("invalid-request");
      const publication = Reflect.get(value, "publication"),
        connectionId = Reflect.get(value, "connectionId");
      if (typeof publication !== "boolean" || !(connectionId === null || typeof connectionId === "string"))
        throw new EbayConnectionError("invalid-request");
      return c.json(await service.start(c.get("actor").accountId, publication, connectionId));
    } catch (error) {
      return safeError(error);
    }
  });
  app.post("/callback", async (c) => {
    try {
      const value: unknown = await c.req.json();
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 2 ||
        typeof Reflect.get(value, "state") !== "string" ||
        typeof Reflect.get(value, "code") !== "string"
      )
        throw new EbayConnectionError("invalid-request");
      return c.json(
        await service.callback(
          c.get("actor").accountId,
          Reflect.get(value, "state"),
          Reflect.get(value, "code"),
          c.get("context"),
        ),
      );
    } catch (error) {
      return safeError(error);
    }
  });
  app.post("/declined", async (c) => {
    try {
      const value: unknown = await c.req.json();
      if (
        !value ||
        typeof value !== "object" ||
        Object.keys(value).length !== 1 ||
        typeof Reflect.get(value, "state") !== "string"
      )
        throw new EbayConnectionError("invalid-request");
      await service.consume(c.get("actor").accountId, Reflect.get(value, "state"));
      return c.json({});
    } catch (error) {
      return safeError(error);
    }
  });
  app.get("/connections/:id", async (c) => {
    try {
      const detail = await service.detail({ accountId: c.get("actor").accountId, connectionId: c.req.param("id") });
      return c.json(detail ? { ...detail, authorizationAvailable: service.enabled } : null);
    } catch (error) {
      return safeError(error);
    }
  });
  app.get("/connections/:id/setup", async (c) => {
    try {
      if (!setup) throw new EbayConnectionError("unavailable");
      return c.json(await setup.load({ accountId: c.get("actor").accountId, connectionId: c.req.param("id") }));
    } catch (error) {
      return safeError(error);
    }
  });
  app.post("/connections/:id/setup", async (c) => {
    try {
      if (!setup) throw new EbayConnectionError("unavailable");
      return c.json(
        await setup.select(
          { accountId: c.get("actor").accountId, connectionId: c.req.param("id") },
          await c.req.json(),
          c.get("context"),
        ),
      );
    } catch (error) {
      return safeError(error);
    }
  });
  return app;
}
function safeError(error: unknown) {
  return Response.json(
    {
      error: {
        code:
          error instanceof EbayConnectionError ||
          error instanceof EbaySetupError ||
          error instanceof ChannelConnectionError
            ? error.code
            : "unavailable",
      },
    },
    { status: 409, headers: { "Cache-Control": "no-store" } },
  );
}
