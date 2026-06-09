import { describe, expect, it } from "vitest";

import {
  checkoutFreshStateFeatureKey,
  checkoutFreshStateKillSwitch,
  checkoutFreshStateRoutes,
  checkoutLegacyRouteDispositions,
  findFreshStateRouteCollisions,
  routeAcceptsUnresolvedFulfillment,
} from "./fresh-state-route-strategy";

describe("fresh-state checkout route strategy", () => {
  it("defines the canonical customer-facing buy and sell route map", () => {
    expect(checkoutFreshStateRoutes.map((route) => [route.routeId, route.routePath])).toEqual([
      ["account-cart", "account/cart"],
      ["buy-checkout-readiness", "checkout/buy/readiness"],
      ["buy-checkout-session", "checkout/buy/session/:sessionId"],
      ["buy-checkout-confirmation", "checkout/buy/session/:sessionId/confirmation"],
      ["account-sell-list", "account/sell-list"],
      ["sell-checkout-readiness", "checkout/sell/readiness"],
      ["sell-checkout-session", "checkout/sell/session/:sessionId"],
      ["sell-checkout-confirmation", "checkout/sell/session/:sessionId/confirmation"],
    ]);
  });

  it("keeps the fresh-state map free of dynamic route collisions", () => {
    expect(findFreshStateRouteCollisions()).toEqual([]);
    expect(checkoutFreshStateRoutes.map((route) => route.routePath)).not.toContain("checkout/:sessionId");
  });

  it("allows unresolved fulfillment only in cart/list and readiness routes", () => {
    expect(routeAcceptsUnresolvedFulfillment("account-cart")).toBe(true);
    expect(routeAcceptsUnresolvedFulfillment("buy-checkout-readiness")).toBe(true);
    expect(routeAcceptsUnresolvedFulfillment("buy-checkout-session")).toBe(false);
    expect(routeAcceptsUnresolvedFulfillment("buy-checkout-confirmation")).toBe(false);

    expect(routeAcceptsUnresolvedFulfillment("account-sell-list")).toBe(true);
    expect(routeAcceptsUnresolvedFulfillment("sell-checkout-readiness")).toBe(true);
    expect(routeAcceptsUnresolvedFulfillment("sell-checkout-session")).toBe(false);
    expect(routeAcceptsUnresolvedFulfillment("sell-checkout-confirmation")).toBe(false);
  });

  it("requires checkout-ready sessions for checkout and confirmation routes", () => {
    const guardedSurfaces = checkoutFreshStateRoutes
      .filter((route) => route.surface.endsWith("checkout") || route.surface.endsWith("confirmation"))
      .map((route) => [route.routeId, route.requiresCheckoutReadySession]);

    expect(guardedSurfaces).toEqual([
      ["buy-checkout-session", true],
      ["buy-checkout-confirmation", true],
      ["sell-checkout-session", true],
      ["sell-checkout-confirmation", true],
    ]);
  });

  it("does not preserve legacy checkout routes as customer-facing compatibility paths", () => {
    expect(checkoutLegacyRouteDispositions).toEqual([
      {
        routeId: "checkout-start",
        routePath: "checkout/start",
        disposition: "remove-before-launch",
        customerFacingCompatibility: false,
        replacementRouteId: "buy-checkout-readiness",
      },
      {
        routeId: "checkout-session",
        routePath: "checkout/:sessionId",
        disposition: "hard-disable-before-launch",
        customerFacingCompatibility: false,
        replacementRouteId: "buy-checkout-session",
      },
      {
        routeId: "checkout-concept",
        routePath: "checkout/concept",
        disposition: "removed",
        customerFacingCompatibility: false,
        replacementRouteId: null,
      },
    ]);
  });

  it("uses release controls as a kill switch without restoring legacy checkout", () => {
    expect(checkoutFreshStateFeatureKey).toBe("checkout.shopify-simple");
    expect(checkoutFreshStateKillSwitch).toEqual({
      featureKey: "checkout.shopify-simple",
      disabledBuyEntryRedirectPath: "/account/cart?checkout=disabled",
      disabledSellEntryRedirectPath: "/account/sell-list?checkout=disabled",
      restoresLegacyCheckout: false,
    });
  });
});
