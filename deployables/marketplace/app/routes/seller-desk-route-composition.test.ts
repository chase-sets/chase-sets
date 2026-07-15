import { describe, expect, it } from "vitest";
import { resolveMarketplaceRouteConfigRecords } from "../host";

describe("Seller Desk route composition", () => {
  it("mounts representative entity and module routes from their owning contexts", () => {
    const routes = resolveMarketplaceRouteConfigRecords();
    const byId = new Map(routes.map((route) => [route.routeId, route]));

    expect(byId.get("account-desk")).toMatchObject({
      routePath: "account/desk",
      sourceContext: "marketplace",
    });
    expect(byId.get("seller-desk-inventory-item")).toMatchObject({
      routePath: "account/desk/inventory/:itemId",
      sourceContext: "inventory",
    });
    expect(byId.get("seller-desk-listing")).toMatchObject({
      routePath: "account/desk/listings/:listingId",
      sourceContext: "marketplace",
    });
    expect(byId.get("seller-desk-shipments")).toMatchObject({
      routePath: "account/desk/shipments",
      sourceContext: "fulfillment",
    });
    expect(byId.get("seller-desk-money")).toMatchObject({
      routePath: "account/desk/money",
      sourceContext: "settlement",
    });
    expect(byId.get("account-desk-offers")).toMatchObject({
      routePath: "account/desk/offers",
      sourceContext: "checkout",
    });
  });
});
