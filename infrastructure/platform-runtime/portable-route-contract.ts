import type {
  BcMarketplaceRouteModule,
  BcRouteModule,
  PortableDataOperations,
  RouteAuthorization,
  RouteAvailability,
  RouteCanonicalLinkIntent,
  RouteDelivery,
  UnsupportedMobileRoute,
} from "@chase-sets/bounded-context-module";

type MarketplaceRouteCandidate = BcRouteModule &
  Readonly<{
    delivery?: RouteDelivery;
    authorization?: RouteAuthorization;
    canonicalLink?: RouteCanonicalLinkIntent;
    availability?: RouteAvailability;
    pageComponentExport?: string;
    portableDataOperations?: PortableDataOperations;
    unsupportedMobile?: UnsupportedMobileRoute;
  }>;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function assertMarketplaceRouteContract(
  contextName: string,
  route: MarketplaceRouteCandidate,
): asserts route is BcMarketplaceRouteModule {
  const routeKey = `${contextName}/${route.routeId}`;

  if (route.sourceContext !== contextName) {
    throw new Error(`Marketplace route '${routeKey}' must name its owning context as sourceContext.`);
  }
  if (route.delivery === "web-resource-only" && route.pageComponentExport !== undefined) {
    throw new Error(`Web resource marketplace route '${routeKey}' cannot declare a page component export.`);
  }
  if (route.delivery !== "web-resource-only" && !isNonEmptyString(route.pageComponentExport)) {
    throw new Error(`Marketplace route '${routeKey}' must identify its page component export.`);
  }
  if (!route.availability || route.availability.web !== true) {
    throw new Error(`Marketplace route '${routeKey}' must remain explicitly available on web.`);
  }
  if (!route.canonicalLink) {
    throw new Error(`Marketplace route '${routeKey}' must declare canonical-link metadata.`);
  }
  if (route.canonicalLink.kind === "not-applicable" && !isNonEmptyString(route.canonicalLink.reason)) {
    throw new Error(`Marketplace route '${routeKey}' must explain why no canonical link applies.`);
  }
  if (!route.authorization) {
    throw new Error(`Marketplace route '${routeKey}' must declare authorization metadata.`);
  }
  if (route.authorization.kind === "authenticated" && !Array.isArray(route.authorization.requiredPermissions)) {
    throw new Error(`Marketplace route '${routeKey}' must declare its required permissions.`);
  }

  if (route.delivery !== "portable" && route.delivery !== "server-only" && route.delivery !== "web-resource-only") {
    throw new Error(`Marketplace route '${routeKey}' must declare a supported delivery class.`);
  }

  if (route.delivery === "portable") {
    if (!route.availability.mobile) {
      throw new Error(`Portable marketplace route '${routeKey}' must be available on mobile.`);
    }
    if (!route.portableDataOperations?.load) {
      throw new Error(`Portable marketplace route '${routeKey}' must declare a portable load operation.`);
    }
    if (route.unsupportedMobile !== undefined) {
      throw new Error(`Portable marketplace route '${routeKey}' cannot carry unsupported-mobile inventory.`);
    }
    return;
  }

  if (route.availability.mobile) {
    throw new Error(`Unsupported marketplace route '${routeKey}' cannot be available on mobile.`);
  }
  const unsupportedMobile = route.unsupportedMobile;
  if (!isNonEmptyString(unsupportedMobile?.owner) || !isNonEmptyString(unsupportedMobile?.followUp)) {
    throw new Error(`Unsupported marketplace route '${routeKey}' must identify an owner and follow-up.`);
  }
  if (!isNonEmptyString(unsupportedMobile.reason)) {
    throw new Error(`Unsupported marketplace route '${routeKey}' must explain its exclusion from mobile.`);
  }
}
