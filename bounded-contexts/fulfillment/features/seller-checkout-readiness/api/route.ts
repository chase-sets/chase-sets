import { Hono, type Context } from "hono";
import type { AuthenticatedApiEnv } from "@chase-sets/auth-context";
import type { EventStoreContext } from "@chase-sets/event-core/storage";
import type { AccountId, TenantId, UserId } from "@chase-sets/primitives/typed-ids";
import type { SellerCheckoutReadinessOwner } from "../domain/contract";
import { parseShippingOwner, SellerShippingError } from "../domain/shipping-setup";
import type { SellerShippingSetupServices } from "./runtime";

const anonymousContext: EventStoreContext = {
  tenantId: "tnt_fulfillment" as TenantId,
  audit: { performedByUserId: "usr_fulfillment_system" as UserId, forAccountId: "acc_fulfillment_system" as AccountId },
};

export function createSellerShippingSetupRoutes(services: SellerShippingSetupServices) {
  const app = new Hono<AuthenticatedApiEnv>();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.onError((error, c) => {
    const code = error instanceof SellerShippingError ? error.code : "source-unavailable";
    const status = code === "forbidden" ? 403 : code === "authority-unavailable" || code === "source-unavailable" ? 503 : code === "invalid-input" ? 400 : 409;
    return c.json({ error: { code } }, status);
  });

  for (const mode of ["account", "guest"] as const) {
    function owner(c: Context<AuthenticatedApiEnv>): SellerCheckoutReadinessOwner {
      if (c.req.query() && Object.keys(c.req.query()).length > 0) throw new SellerShippingError("invalid-input");
      if (mode === "account") {
        const actor = c.get("actor");
        if (!actor || actor.roleKey === "guest-buyer" || actor.sessionId.startsWith("guest:")) throw new SellerShippingError("forbidden");
        return parseShippingOwner({ kind: "account", accountId: actor.accountId });
      }
      return parseShippingOwner({ kind: "anonymous", anonymousSellListId: c.req.header("x-checkout-anonymous-sell-list-id") });
    }
    app.get(`/${mode}/seller-shipping-setup`, async (c) => c.json(await services.readSetup(owner(c))));
    app.put(`/${mode}/seller-shipping-setup`, async (c) => {
      const key = owner(c);
      let input: unknown;
      try { input = await c.req.json(); } catch { throw new SellerShippingError("invalid-input"); }
      const context = mode === "guest" ? anonymousContext : c.get("context");
      if (!context) throw new SellerShippingError("forbidden");
      return c.json(await services.saveSetup(key, input, context));
    });
  }

  app.post("/operations/seller-shipping-support", async (c) => {
    const context = c.get("context");
    if (!context || !c.get("actor")) throw new SellerShippingError("forbidden");
    let input: unknown;
    try { input = await c.req.json(); } catch { throw new SellerShippingError("invalid-input"); }
    return c.json(await services.changeSupport(c.get("actor"), input, context));
  });
  return app;
}
