import { Hono, type Context, type MiddlewareHandler } from "hono";
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
  const noStore: MiddlewareHandler<AuthenticatedApiEnv> = async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  };
  for (const path of [
    "/account/seller-shipping-setup",
    "/guest/seller-shipping-setup",
    "/operations/seller-shipping-support",
  ])
    app.use(path, noStore);
  app.onError((error, c) => {
    const code = error instanceof SellerShippingError ? error.code : "source-unavailable";
    const status =
      code === "forbidden"
        ? 403
        : code === "authority-unavailable" || code === "source-unavailable"
          ? 503
          : code === "invalid-input"
            ? 400
            : 409;
    return c.json({ error: { code } }, status);
  });

  function owner(c: Context<AuthenticatedApiEnv>, mode: "account" | "guest"): SellerCheckoutReadinessOwner {
    if (c.req.query() && Object.keys(c.req.query()).length > 0) throw new SellerShippingError("invalid-input");
    if (mode === "account") {
      const actor = c.get("actor");
      if (!actor || actor.roleKey === "guest-buyer" || actor.sessionId.startsWith("guest:"))
        throw new SellerShippingError("forbidden");
      return parseShippingOwner({ kind: "account", accountId: actor.accountId });
    }
    return parseShippingOwner({
      kind: "anonymous",
      anonymousSellListId: c.req.header("x-checkout-anonymous-sell-list-id"),
    });
  }
  function save(mode: "account" | "guest") {
    return async (c: Context<AuthenticatedApiEnv>) => {
      const key = owner(c, mode);
      let input: unknown;
      try {
        input = await c.req.json();
      } catch {
        throw new SellerShippingError("invalid-input");
      }
      const context = mode === "guest" ? anonymousContext : c.get("context");
      if (!context) throw new SellerShippingError("forbidden");
      return c.json(await services.saveSetup(key, input, context));
    };
  }
  app.get("/account/seller-shipping-setup", async (c) => c.json(await services.readSetup(owner(c, "account"))));
  app.get("/guest/seller-shipping-setup", async (c) => c.json(await services.readSetup(owner(c, "guest"))));
  app.put("/account/seller-shipping-setup", save("account"));
  app.put("/guest/seller-shipping-setup", save("guest"));

  app.post("/operations/seller-shipping-support", async (c) => {
    const context = c.get("context");
    if (!context || !c.get("actor")) throw new SellerShippingError("forbidden");
    let input: unknown;
    try {
      input = await c.req.json();
    } catch {
      throw new SellerShippingError("invalid-input");
    }
    return c.json(await services.changeSupport(c.get("actor"), input, context));
  });
  return app;
}
