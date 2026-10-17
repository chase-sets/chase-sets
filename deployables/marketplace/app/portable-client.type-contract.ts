import type { ReactNode } from "react";
import { discoveryPortableRoutes } from "@chase-sets/discovery/web";
import { identityPortableRoutes } from "@chase-sets/identity/web";
import { createPortableClientRouter, type PortableClientFetch } from "@chase-sets/platform-runtime/portable-client";
import { webContextRegistry } from "./generated/web-context-registry";

type ClientRouterRoute = Readonly<{
  id: string;
  path: string;
  component: (...args: never[]) => ReactNode;
}>;

type PageComponentRoute<TModule> = TModule extends { readonly pageComponent: infer TPageComponent }
  ? Readonly<{ pageComponent: TPageComponent }>
  : never;

type Equal<TLeft, TRight> =
  (<TValue>() => TValue extends TLeft ? 1 : 2) extends <TValue>() => TValue extends TRight ? 1 : 2
    ? (<TValue>() => TValue extends TRight ? 1 : 2) extends <TValue>() => TValue extends TLeft ? 1 : 2
      ? true
      : false
    : false;

type Expect<TValue extends true> = TValue;

function requiredContext(contextName: "discovery" | "identity") {
  const entry = webContextRegistry.find((candidate) => candidate.contextName === contextName);
  if (!entry) throw new Error(`Missing ${contextName} web context registry entry.`);
  return entry;
}

function createPortableRouter(fetch: PortableClientFetch) {
  const discovery = requiredContext("discovery");
  const identity = requiredContext("identity");
  return createPortableClientRouter({
    apiOrigin: "https://api.chasesets.test",
    fetch,
    contexts: [
      { contextName: discovery.contextName, manifest: discovery.manifest, portableRoutes: discoveryPortableRoutes },
      { contextName: identity.contextName, manifest: identity.manifest, portableRoutes: identityPortableRoutes },
    ],
  });
}

type PortableModule = (typeof discoveryPortableRoutes)[number] | (typeof identityPortableRoutes)[number];
type ReturnedRoute = ReturnType<typeof createPortableRouter>["routes"][number];

export type PortableClientRouteTypeContract = Expect<
  Equal<PageComponentRoute<ReturnedRoute>, PageComponentRoute<PortableModule>>
>;

export function createClientRouterAdapterRoutes(fetch: PortableClientFetch): readonly ClientRouterRoute[] {
  const router = createPortableRouter(fetch);

  return router.routes.map((route) => ({
    id: route.id,
    path: route.path,
    component: route.pageComponent,
  }));
}
