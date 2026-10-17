import type { createMemoryRouter } from "react-router";
import type { loader as listLoader } from "../../../routes/marketplace/account-channels";
import type { loader as detailLoader } from "../ui/account-channels-connection-route-adapter";
import type { ChannelConnectionStatus } from "../domain/contracts";

export function channelConnectionStateFixture(status: ChannelConnectionStatus) {
  return {
    connectionId: `connection-${status}`,
    accountId: "account-1",
    providerKey: "fixture-provider",
    environment: "sandbox" as const,
    status,
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

export type ConnectionEvidenceSurface = "list" | "connect" | "setup" | "activate";
export type ConnectionEvidenceState = "loading" | "empty" | "error" | "success";

export function channelConnectionBrowserState(surface: ConnectionEvidenceSurface, state: ConnectionEvidenceState) {
  return {
    surface,
    state,
    connection: channelConnectionStateFixture("pending-setup"),
    locations: [{ storageLocationId: "one", name: "Shelf one" }],
  };
}

// Like the Sell List recovery fixture, this is serialized into an already hydrated
// production router. Only route data/action states are synthetic; route components,
// navigation, forms, design-system providers and built CSS remain the production ones.
// This is visual state evidence, not API, authority, or manual-sync execution proof.
export async function mountChannelConnectionBrowserState(input: ReturnType<typeof channelConnectionBrowserState>) {
  type Router = ReturnType<typeof createMemoryRouter>;
  const host = window as unknown as {
    __reactRouterDataRouter: Router;
    channelConnectionEvidence?: { dispose: () => void };
  };
  const router = host.__reactRouterDataRouter;
  const allRoutes = (routes: Router["routes"]): Router["routes"] =>
    routes.flatMap((route) => [route, ...allRoutes(route.children ?? [])]);
  const routes = allRoutes(router.routes);
  const list = routes.find((route) => route.id === "channels/channels-connections");
  const detail = routes.find((route) => route.id === "channels/channels-connection-detail");
  if (!list || !detail || !router.state.matches.some((match) => match.route.id === detail.id)) {
    throw new Error("Production Channels list and detail routes must be hydrated before state evidence");
  }
  const baseline = router.state.loaderData[detail.id] as Awaited<ReturnType<typeof detailLoader>>;
  if (baseline.kind !== "ready") throw new Error("Production Channels detail must be ready before state evidence");
  const originals = [list, detail].map((route) => ({ route, loader: route.loader, action: route.action }));
  const listPath = "/account/channels";
  const detailPath = `/account/channels/${input.connection.connectionId}`;
  const readyList: Awaited<ReturnType<typeof listLoader>> = {
    kind: "ready",
    page: { items: input.state === "empty" ? [] : [input.connection] },
    statusFilter: "default",
    providers: input.surface === "connect" && input.state === "empty" ? [] : ["tcgplayer"],
  };
  const readyDetail: Awaited<ReturnType<typeof detailLoader>> = {
    ...baseline,
    connection: input.connection,
    canManageDrift: true,
    setupLocations: { kind: "loaded", items: input.state === "empty" ? [] : input.locations },
  };
  let release: (() => void) | undefined;
  const held = () =>
    new Promise<null>((resolve) => {
      release = () => resolve(null);
    });
  list.loader = () =>
    input.surface === "list" && input.state === "error"
      ? { kind: "error", message: "Channels API error 503" }
      : readyList;
  detail.loader = () => readyDetail;
  list.action = () =>
    input.state === "loading"
      ? held()
      : input.state === "error"
        ? { message: "provider-setup-not-registered" }
        : new Response(null, { status: 302, headers: { Location: detailPath } });
  detail.action = () =>
    input.state === "loading"
      ? held()
      : input.state === "error"
        ? { kind: "command-error", message: "binding-not-current" }
        : { kind: "applied", connection: { ...input.connection, status: "active" } };
  host.channelConnectionEvidence = {
    dispose: () => {
      for (const original of originals) {
        original.route.loader = original.loader;
        original.route.action = original.action;
      }
      release?.();
    },
  };
  await router.navigate(input.surface === "list" || input.surface === "connect" ? listPath : detailPath);
  if (input.surface === "list" && input.state === "loading") {
    list.loader = held;
    void router.navigate(`${listPath}?status=active`);
  }
}
