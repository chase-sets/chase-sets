export type CheckoutFreshStateMode = "buy" | "sell";

export type CheckoutFreshStateSurface =
  | "buy-cart"
  | "buy-readiness"
  | "buy-checkout"
  | "buy-confirmation"
  | "sell-list"
  | "sell-readiness"
  | "sell-checkout"
  | "sell-confirmation";

export type CheckoutFreshStateRoute = {
  readonly routeId: string;
  readonly routePath: string;
  readonly mode: CheckoutFreshStateMode;
  readonly surface: CheckoutFreshStateSurface;
  readonly customerFacing: true;
  readonly acceptsUnresolvedFulfillment: boolean;
  readonly requiresCheckoutReadySession: boolean;
};

export type CheckoutOldRouteDisposition = {
  readonly routeId: string;
  readonly routePath: string;
  readonly disposition: "remove-before-customer-use" | "hard-disable-before-customer-use" | "removed";
  readonly customerFacingFallback: false;
  readonly replacementRouteId: string | null;
};

export const checkoutFreshStateRoutes = [
  {
    routeId: "account-cart",
    routePath: "account/cart",
    mode: "buy",
    surface: "buy-cart",
    customerFacing: true,
    acceptsUnresolvedFulfillment: true,
    requiresCheckoutReadySession: false,
  },
  {
    routeId: "buy-checkout-readiness",
    routePath: "checkout/buy/readiness",
    mode: "buy",
    surface: "buy-readiness",
    customerFacing: true,
    acceptsUnresolvedFulfillment: true,
    requiresCheckoutReadySession: false,
  },
  {
    routeId: "buy-checkout-session",
    routePath: "checkout/buy/session/:sessionId",
    mode: "buy",
    surface: "buy-checkout",
    customerFacing: true,
    acceptsUnresolvedFulfillment: false,
    requiresCheckoutReadySession: true,
  },
  {
    routeId: "buy-checkout-confirmation",
    routePath: "checkout/buy/session/:sessionId/confirmation",
    mode: "buy",
    surface: "buy-confirmation",
    customerFacing: true,
    acceptsUnresolvedFulfillment: false,
    requiresCheckoutReadySession: true,
  },
  {
    routeId: "account-sell-list",
    routePath: "account/sell-list",
    mode: "sell",
    surface: "sell-list",
    customerFacing: true,
    acceptsUnresolvedFulfillment: true,
    requiresCheckoutReadySession: false,
  },
  {
    routeId: "account-desk-offers",
    routePath: "account/desk/offers",
    mode: "sell",
    surface: "sell-list",
    customerFacing: true,
    acceptsUnresolvedFulfillment: true,
    requiresCheckoutReadySession: false,
  },
  {
    routeId: "sell-checkout-readiness",
    routePath: "checkout/sell/readiness",
    mode: "sell",
    surface: "sell-readiness",
    customerFacing: true,
    acceptsUnresolvedFulfillment: true,
    requiresCheckoutReadySession: false,
  },
  {
    routeId: "sell-checkout-session",
    routePath: "checkout/sell/session/:sessionId",
    mode: "sell",
    surface: "sell-checkout",
    customerFacing: true,
    acceptsUnresolvedFulfillment: false,
    requiresCheckoutReadySession: true,
  },
  {
    routeId: "sell-checkout-confirmation",
    routePath: "checkout/sell/session/:sessionId/confirmation",
    mode: "sell",
    surface: "sell-confirmation",
    customerFacing: true,
    acceptsUnresolvedFulfillment: false,
    requiresCheckoutReadySession: true,
  },
] as const satisfies readonly CheckoutFreshStateRoute[];

export const checkoutOldRouteDispositions = [
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
] as const satisfies readonly CheckoutOldRouteDisposition[];

export function findFreshStateRouteCollisions(
  routes: readonly Pick<CheckoutFreshStateRoute, "routeId" | "routePath">[] = checkoutFreshStateRoutes,
) {
  const collisions: Array<{ firstRouteId: string; secondRouteId: string; routePath: string }> = [];
  for (let firstIndex = 0; firstIndex < routes.length; firstIndex += 1) {
    const first = routes[firstIndex];
    if (!first) {
      continue;
    }

    for (let secondIndex = firstIndex + 1; secondIndex < routes.length; secondIndex += 1) {
      const second = routes[secondIndex];
      if (!second) {
        continue;
      }

      if (routesCanMatchSamePath(first.routePath, second.routePath)) {
        collisions.push({
          firstRouteId: first.routeId,
          secondRouteId: second.routeId,
          routePath: `${first.routePath} <-> ${second.routePath}`,
        });
      }
    }
  }

  return collisions;
}

export function routeAcceptsUnresolvedFulfillment(routeId: string) {
  return checkoutFreshStateRoutes.find((route) => route.routeId === routeId)?.acceptsUnresolvedFulfillment ?? false;
}

function routesCanMatchSamePath(firstRoutePath: string, secondRoutePath: string) {
  const firstSegments = firstRoutePath.split("/");
  const secondSegments = secondRoutePath.split("/");
  if (firstSegments.length !== secondSegments.length) {
    return false;
  }

  return firstSegments.every((firstSegment, index) => {
    const secondSegment = secondSegments[index] ?? "";
    return firstSegment === secondSegment || isDynamicSegment(firstSegment) || isDynamicSegment(secondSegment);
  });
}

function isDynamicSegment(segment: string) {
  return segment.startsWith(":");
}
