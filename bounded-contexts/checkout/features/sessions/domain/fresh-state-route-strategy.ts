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
  readonly disabledRedirectPath: string;
};

export type CheckoutLegacyRouteDisposition = {
  readonly routeId: string;
  readonly routePath: string;
  readonly disposition: "remove-before-launch" | "hard-disable-before-launch" | "internal-reference-only";
  readonly customerFacingCompatibility: false;
  readonly replacementRouteId: string | null;
};

export const checkoutFreshStateFeatureKey = "checkout.shopify-simple";

export const checkoutFreshStateKillSwitch = {
  featureKey: checkoutFreshStateFeatureKey,
  disabledBuyEntryRedirectPath: "/account/cart?checkout=disabled",
  disabledSellEntryRedirectPath: "/account/sell-list?checkout=disabled",
  restoresLegacyCheckout: false,
} as const;

export const checkoutFreshStateRoutes = [
  {
    routeId: "account-cart",
    routePath: "account/cart",
    mode: "buy",
    surface: "buy-cart",
    customerFacing: true,
    acceptsUnresolvedFulfillment: true,
    requiresCheckoutReadySession: false,
    disabledRedirectPath: "/account/cart?checkout=disabled",
  },
  {
    routeId: "buy-checkout-readiness",
    routePath: "checkout/buy/readiness",
    mode: "buy",
    surface: "buy-readiness",
    customerFacing: true,
    acceptsUnresolvedFulfillment: true,
    requiresCheckoutReadySession: false,
    disabledRedirectPath: "/account/cart?checkout=disabled",
  },
  {
    routeId: "buy-checkout-session",
    routePath: "checkout/buy/session/:sessionId",
    mode: "buy",
    surface: "buy-checkout",
    customerFacing: true,
    acceptsUnresolvedFulfillment: false,
    requiresCheckoutReadySession: true,
    disabledRedirectPath: "/account/cart?checkout=disabled",
  },
  {
    routeId: "buy-checkout-confirmation",
    routePath: "checkout/buy/session/:sessionId/confirmation",
    mode: "buy",
    surface: "buy-confirmation",
    customerFacing: true,
    acceptsUnresolvedFulfillment: false,
    requiresCheckoutReadySession: true,
    disabledRedirectPath: "/account/cart?checkout=disabled",
  },
  {
    routeId: "account-sell-list",
    routePath: "account/sell-list",
    mode: "sell",
    surface: "sell-list",
    customerFacing: true,
    acceptsUnresolvedFulfillment: true,
    requiresCheckoutReadySession: false,
    disabledRedirectPath: "/account/sell-list?checkout=disabled",
  },
  {
    routeId: "sell-checkout-readiness",
    routePath: "checkout/sell/readiness",
    mode: "sell",
    surface: "sell-readiness",
    customerFacing: true,
    acceptsUnresolvedFulfillment: true,
    requiresCheckoutReadySession: false,
    disabledRedirectPath: "/account/sell-list?checkout=disabled",
  },
  {
    routeId: "sell-checkout-session",
    routePath: "checkout/sell/session/:sessionId",
    mode: "sell",
    surface: "sell-checkout",
    customerFacing: true,
    acceptsUnresolvedFulfillment: false,
    requiresCheckoutReadySession: true,
    disabledRedirectPath: "/account/sell-list?checkout=disabled",
  },
  {
    routeId: "sell-checkout-confirmation",
    routePath: "checkout/sell/session/:sessionId/confirmation",
    mode: "sell",
    surface: "sell-confirmation",
    customerFacing: true,
    acceptsUnresolvedFulfillment: false,
    requiresCheckoutReadySession: true,
    disabledRedirectPath: "/account/sell-list?checkout=disabled",
  },
] as const satisfies readonly CheckoutFreshStateRoute[];

export const checkoutLegacyRouteDispositions = [
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
    disposition: "internal-reference-only",
    customerFacingCompatibility: false,
    replacementRouteId: null,
  },
] as const satisfies readonly CheckoutLegacyRouteDisposition[];

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
