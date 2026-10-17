import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ChannelsApiEnv } from "../../../api";
import type { EbayAccountDeletionServices } from "./runtime";
import { EbayReceiptError } from "../domain/subject";

export function createEbayReceiptStaffRoutes(services: EbayAccountDeletionServices) {
  const app = new Hono<ChannelsApiEnv>();
  app.use("/staff/ebay-account-deletion/lookup", bodyLimit({ maxSize: 8192 }));
  app.use("/staff/ebay-account-deletion/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const actor = c.get("actor");
    if (!actor) return c.json({ error: "authentication_required" }, 401);
    if (!actor.permissions.includes("support.manage")) return c.json({ error: "authorization_forbidden" }, 403);
    await next();
  });
  app.post("/staff/ebay-account-deletion/lookup", async (c) => {
    try {
      const bytes = await c.req.arrayBuffer();
      if (bytes.byteLength > 8192) return c.json({ error: "invalid_lookup" }, 400);
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      if (
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 1 ||
        !Object.hasOwn(value, "userId")
      )
        return c.json({ error: "invalid_lookup" }, 400);
      return c.json({ matches: await services.lookup(Reflect.get(value, "userId")) });
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof EbayReceiptError && error.code === "invalid-notice"))
        return c.json({ error: "invalid_lookup" }, 400);
      return c.json({ error: "receipt_lookup_unavailable" }, 503);
    }
  });
  app.get("/staff/ebay-account-deletion/subject-data-count", async (c) => {
    try {
      return c.json(await services.countSubjectData());
    } catch {
      return c.json({ error: "receipt_lookup_unavailable" }, 503);
    }
  });
  return app;
}
