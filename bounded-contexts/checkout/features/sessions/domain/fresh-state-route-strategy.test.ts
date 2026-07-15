import { describe, expect, it } from "vitest";

import {
  checkoutFreshStateRoutes,
  checkoutOldRouteDispositions,
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
      ["account-desk-offers", "account/desk/offers"],
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
    expect(routeAcceptsUnresolvedFulfillment("account-desk-offers")).toBe(true);
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

  it("does not preserve old checkout routes as customer-facing fallback paths", () => {
    expect(checkoutOldRouteDispositions).toEqual([
      {
        routeId: "checkout-start",
        routePath: "checkout/start",
        disposition: "remove-before-customer-use",
        customerFacingFallback: false,
        replacementRouteId: "buy-checkout-readiness",
      },
      {
        routeId: "checkout-session",
        routePath: "checkout/:sessionId",
        disposition: "hard-disable-before-customer-use",
        customerFacingFallback: false,
        replacementRouteId: "buy-checkout-session",
      },
      {
        routeId: "checkout-concept",
        routePath: "checkout/concept",
        disposition: "removed",
        customerFacingFallback: false,
        replacementRouteId: null,
      },
    ]);
  });

  it("does not reserve rollout or disablement metadata in the customer route map", () => {
    expect(checkoutFreshStateRoutes.every((route) => !("disabledRedirectPath" in route))).toBe(true);
    expect(JSON.stringify(checkoutFreshStateRoutes)).not.toContain("disabledRedirectPath");
  });
});
