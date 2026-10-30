import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ChannelsApiEnv } from "../../../api";
import type { EbayAccountDeletionServices } from "./runtime";
import { EbayReceiptError } from "../domain/subject";
import { EBAY_RECEIPT_LOOKUP_PERMISSION, STAGING_EBAY_RECEIPT_LOOKUP_SERVICE_ID } from "@chase-sets/auth-context";
import { ebayReceiptLookupLimits, EbayReceiptResponseTooLarge, serializeEbayReceiptMatches } from "../domain/responses";

export function createEbayReceiptStaffRoutes(services: EbayAccountDeletionServices) {
  const app = new Hono<ChannelsApiEnv>();
  app.use("/staff/ebay-account-deletion/lookup", bodyLimit({ maxSize: 8192 }));
  app.use("/staff/ebay-account-deletion/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const service = c.get("receiptLookupServiceActor");
    if (service) {
      if (
        service.kind !== "service" ||
        service.serviceId !== STAGING_EBAY_RECEIPT_LOOKUP_SERVICE_ID ||
        !service.permissions.includes(EBAY_RECEIPT_LOOKUP_PERMISSION) ||
        c.req.path !== "/api/channels/staff/ebay-account-deletion/lookup" ||
        c.req.method !== "POST"
      )
        return c.json({ error: "receipt_actor_operation_forbidden" }, 403);
      await next();
      return;
    }
    const actor = c.get("actor");
    if (!actor) return c.json({ error: "authentication_required" }, 401);
    if (!actor.permissions.includes("support.manage")) return c.json({ error: "authorization_forbidden" }, 403);
    await next();
  });
  app.post("/staff/ebay-account-deletion/lookup", async (c) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
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
      const result = await Promise.race([
        services.lookup(Reflect.get(value, "userId")),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ebayReceiptLookupLimits.completeBodyDeadlineMs);
        }),
      ]);
      if (result === null) return c.json({ error: "receipt_lookup_deadline_exceeded" }, 408);
      const serialized = serializeEbayReceiptMatches(result);
      return c.body(serialized, 200, { "Content-Type": "application/json" });
    } catch (error) {
      if (error instanceof EbayReceiptResponseTooLarge) return c.json({ error: "receipt_response_too_large" }, 413);
      if (
        error instanceof SyntaxError ||
        (error instanceof Error && error.message === "invalid-ebay-receipt-response") ||
        (error instanceof EbayReceiptError && error.code === "invalid-notice")
      )
        return c.json({ error: "invalid_lookup" }, 400);
      return c.json({ error: "receipt_lookup_unavailable" }, 503);
    } finally {
      clearTimeout(timer);
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
