import type {
  BcPortableRouteModule,
  PortableContextRegistryEntry,
  PortableRouteInput,
  PortableRouteModule,
  PortableRouteMutationInput,
} from "@chase-sets/bounded-context-module";
import { assertMarketplaceRouteContract } from "./portable-route-contract";

export type PortableClientFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

type PortableClientRouterOptions = Readonly<{
  apiOrigin: string;
  fetch: PortableClientFetch;
  contexts: readonly PortableContextRegistryEntry<PortableClientFetch>[];
}>;

function resolveAbsoluteApiOrigin(apiOrigin: string): string {
  const origin = new URL(apiOrigin);
  if (origin.protocol !== "https:" && origin.protocol !== "http:") {
    throw new Error("Portable client apiOrigin must use HTTP or HTTPS.");
  }
  if (origin.pathname !== "/" || origin.search || origin.hash || origin.username || origin.password) {
    throw new Error("Portable client apiOrigin must be an absolute origin without path, credentials, query, or hash.");
  }
  return origin.origin;
}

function findPortableModule(
  route: BcPortableRouteModule,
  modules: readonly PortableRouteModule<PortableClientFetch>[],
): PortableRouteModule<PortableClientFetch> {
  const matches = modules.filter((module) => module.routeId === route.routeId);
  if (matches.length !== 1) {
    throw new Error(
      `Portable marketplace route '${route.sourceContext}/${route.routeId}' requires exactly one portable module; found ${matches.length}.`,
    );
  }
  const module = matches[0];
  if (!module) {
    throw new Error(`Portable marketplace route '${route.sourceContext}/${route.routeId}' is missing its module.`);
  }
  if (typeof module.load !== "function") {
    throw new Error(
      `Portable marketplace route '${route.sourceContext}/${route.routeId}' is missing its load operation.`,
    );
  }
  if (module.pageComponent === undefined || module.pageComponent === null) {
    throw new Error(
      `Portable marketplace route '${route.sourceContext}/${route.routeId}' is missing its page component.`,
    );
  }
  if (route.portableDataOperations.mutation !== Boolean(module.mutate)) {
    throw new Error(
      `Portable marketplace route '${route.sourceContext}/${route.routeId}' mutation metadata does not match its module.`,
    );
  }
  return module;
}

export function createPortableClientRouter(options: PortableClientRouterOptions) {
  if (typeof options.fetch !== "function") {
    throw new Error("Portable client router requires an injected fetch implementation.");
  }
  const apiOrigin = resolveAbsoluteApiOrigin(options.apiOrigin);
  const routes = options.contexts.flatMap((entry) => {
    const contributions = entry.manifest.deployableContributions ?? [];
    const marketplaceRoutes = contributions
      .filter((contribution) => contribution.deployable === "marketplace-web")
      .flatMap((contribution) => contribution.routes);

    const classifiedRoutes = marketplaceRoutes.map((route) => {
      assertMarketplaceRouteContract(entry.contextName, route);
      return route;
    });

    const portableRoutes = classifiedRoutes.filter(
      (route): route is BcPortableRouteModule => route.delivery === "portable",
    );
    const portableIds = new Set(portableRoutes.map((route) => route.routeId));
    const unexpectedModules = entry.portableRoutes.filter((module) => !portableIds.has(module.routeId));
    if (unexpectedModules.length > 0) {
      throw new Error(
        `Context '${entry.contextName}' registered portable modules for unsupported routes: ${unexpectedModules
          .map((module) => module.routeId)
          .join(", ")}.`,
      );
    }

    return portableRoutes.map((route) => {
      const module = findPortableModule(route, entry.portableRoutes);
      const mutate = module.mutate;
      return {
        id: `${entry.contextName}/${route.routeId}`,
        path: route.routePath,
        authorization: route.authorization,
        canonicalLink: route.canonicalLink,
        pageComponent: module.pageComponent,
        load: (input: PortableRouteInput) => module.load(input, { apiOrigin, fetch: options.fetch }),
        ...(mutate
          ? {
              mutate: (input: PortableRouteMutationInput) => mutate(input, { apiOrigin, fetch: options.fetch }),
            }
          : {}),
      };
    });
  });

  const ids = routes.map((route) => route.id);
  const paths = routes.map((route) => route.path);
  if (new Set(ids).size !== ids.length || new Set(paths).size !== paths.length) {
    throw new Error("Portable marketplace routes must have unique IDs and paths.");
  }

  return Object.freeze({ routes: Object.freeze(routes) });
}
