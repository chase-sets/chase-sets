import type { PortableRouteModule } from "@chase-sets/bounded-context-module";
import type { PortableClientFetch } from "@chase-sets/platform-runtime/portable-client";
import { SearchPage } from "./search-page";
import { loadPortableSearchRoute } from "./portable-route";

export const discoveryPortableRoutes = [
  {
    routeId: "category",
    pageComponent: SearchPage,
    load: loadPortableSearchRoute,
  },
  {
    routeId: "search",
    pageComponent: SearchPage,
    load: loadPortableSearchRoute,
  },
] as const satisfies readonly PortableRouteModule<PortableClientFetch>[];
