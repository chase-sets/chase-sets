import type { PortableRouteModule } from "@chase-sets/bounded-context-module";
import type { PortableClientFetch } from "@chase-sets/platform-runtime/portable-client";
import { AccountProfilePage } from "./account-profile-page";
import { loadPortableAccountRoute, mutatePortableAccountRoute } from "./portable-route";

export const identityPortableRoutes = [
  {
    routeId: "account",
    pageComponent: AccountProfilePage,
    load: loadPortableAccountRoute,
    mutate: mutatePortableAccountRoute,
  },
] satisfies readonly PortableRouteModule<PortableClientFetch>[];
