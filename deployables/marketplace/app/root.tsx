import { t } from "@chase-sets/localization";
import "@chase-sets/design-system/styles.css";
import { useEffect, type ReactNode } from "react";
import type { LoaderFunctionArgs } from "react-router";
import {
  data as routeData,
  isRouteErrorResponse,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLoaderData,
  useLocation,
  useRouteError,
} from "react-router";
import { buildCanonicalUrl, shouldIndexMarketplace } from "./seo";
import { resolveMarketplaceActor } from "./auth.server";
import { registerMarketplaceServiceWorker } from "./pwa/register-service-worker";
import {
  ChaseRoot,
  Container,
  LinkButton,
  MarketplaceEmptyState,
  Page,
  Stack,
  type ColorMode,
} from "@chase-sets/design-system";
import { createCheckoutRequestApiClient, readAnonymousCartId } from "@chase-sets/checkout/server";
import { itemDetailRailAnalyticsEventNames } from "@chase-sets/discovery/web";
import {
  createIdentityRequestApiClient,
  createUserPreferencesColorModeCookieSeedHeaders,
  readUserPreferencesColorModeCookie,
  resolveIdentityShellViewer,
  type CurrentActorDisplay,
  type IdentityShellViewer,
} from "@chase-sets/identity/server";

type MarketplaceRootActor = Awaited<ReturnType<typeof resolveMarketplaceActor>>;
type MarketplaceRootTheme = Readonly<{
  colorMode: ColorMode;
  cookieSeedColorMode: ColorMode | null;
  viewer: IdentityShellViewer | null;
}>;
type MarketplaceRootLoaderData = Readonly<{
  actor: MarketplaceRootActor;
  actorDisplay: CurrentActorDisplay | null;
  cartCount: number;
  colorMode: ColorMode;
  origin: string;
  shouldIndex: boolean;
  viewer: IdentityShellViewer | null;
}>;

export const itemDetailRailAnalyticsBridgeScript = `
(() => {
  const endpoint = "/analytics/item-detail-rail";
  const allowedEvents = new Set(${JSON.stringify(itemDetailRailAnalyticsEventNames)});

  function readBounded(value) {
    if (typeof value !== "string") {
      return null;
    }
    const text = value.trim();
    return text.length > 0 && text.length <= 80 && /^[a-zA-Z0-9_.-]+$/.test(text) ? text : null;
  }

  window.addEventListener("chase-sets:item-detail-rail-analytics", (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (!detail || typeof detail.event !== "string" || !allowedEvents.has(detail.event)) {
      return;
    }

    const payload = {
      event: detail.event,
      intent: readBounded(detail.intent),
      workflow: readBounded(detail.workflow),
      selection: readBounded(detail.selection),
      topic: readBounded(detail.topic),
      outcome: readBounded(detail.outcome),
      gate: readBounded(detail.gate),
      viewer: readBounded(detail.viewer),
      surface: readBounded(detail.surface),
    };
    const body = JSON.stringify(payload);

    if (navigator.sendBeacon) {
      navigator.sendBeacon(endpoint, new Blob([body], { type: "application/json" }));
      return;
    }

    fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      credentials: "same-origin",
      keepalive: true,
    }).catch(() => undefined);
  });
})();
`.trim();

async function resolveCartCount(request: Request, actor: MarketplaceRootActor) {
  try {
    const checkoutApi = createCheckoutRequestApiClient(request);

    if (actor && actor.roleKey !== "guest-buyer" && !actor.permissions.includes("guest-checkout.manage")) {
      const cart = await checkoutApi.getCart();
      return cart.count;
    }

    const anonymousCartId = readAnonymousCartId(request);
    if (!anonymousCartId) {
      return 0;
    }

    const cart = await checkoutApi.getGuestCart(anonymousCartId);
    return cart.count;
  } catch {
    return 0;
  }
}

async function resolveCurrentActorDisplay(request: Request, actor: MarketplaceRootActor) {
  if (!actor || actor.roleKey === "guest-buyer") {
    return null;
  }

  try {
    const identityApi = createIdentityRequestApiClient(request);
    return await identityApi.getCurrentActorDisplay<CurrentActorDisplay>();
  } catch {
    return null;
  }
}

async function resolveMarketplaceRootTheme(
  request: Request,
  actor: MarketplaceRootActor,
): Promise<MarketplaceRootTheme> {
  if (!actor || actor.roleKey === "guest-buyer") {
    return { colorMode: "system", cookieSeedColorMode: null, viewer: null };
  }

  const cookieColorMode = readUserPreferencesColorModeCookie(request);

  try {
    const viewer = await resolveIdentityShellViewer(createIdentityRequestApiClient(request), actor);
    const colorMode = viewer.preferences?.colorMode ?? cookieColorMode ?? "system";

    return {
      colorMode,
      cookieSeedColorMode: viewer.preferences?.colorMode ?? null,
      viewer,
    };
  } catch {
    return {
      colorMode: cookieColorMode ?? "system",
      cookieSeedColorMode: null,
      viewer: cookieColorMode
        ? {
            actor,
            preferences: { colorMode: cookieColorMode, reducedMotion: "user" },
          }
        : null,
    };
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const { registerMarketplacePostWriteConsistencyRecorder } = await import("./observability.server");
  registerMarketplacePostWriteConsistencyRecorder();

  const actor = await resolveMarketplaceActor(request);
  const [actorDisplay, cartCount, rootTheme] = await Promise.all([
    resolveCurrentActorDisplay(request, actor),
    resolveCartCount(request, actor),
    resolveMarketplaceRootTheme(request, actor),
  ]);

  const payload = {
    actor,
    actorDisplay,
    cartCount,
    colorMode: rootTheme.colorMode,
    origin: new URL(request.url).origin,
    shouldIndex: shouldIndexMarketplace(),
    viewer: rootTheme.viewer,
  };
  const cookieHeaders = createUserPreferencesColorModeCookieSeedHeaders(request, rootTheme.cookieSeedColorMode);

  return cookieHeaders ? routeData(payload, { headers: cookieHeaders }) : payload;
}

export function Layout({ children }: { children: ReactNode }) {
  const data = useLoaderData<typeof loader>() as MarketplaceRootLoaderData | undefined;
  const location = useLocation();
  const origin = data?.origin ?? (typeof window === "undefined" ? "http://localhost" : window.location.origin);
  // Loader data is unavailable while React Router renders some client-side
  // error/revalidation states. Never fall back to the server environment here:
  // `process` does not exist in the browser, and indexing should fail closed
  // when the server-owned crawl posture is unavailable.
  const shouldIndex = data?.shouldIndex ?? false;
  const canonicalUrl = buildCanonicalUrl({
    origin,
    pathname: location.pathname,
    search: location.search,
  });

  useEffect(() => {
    registerMarketplaceServiceWorker();
  }, []);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        {!shouldIndex ? <meta name="robots" content="noindex,nofollow" /> : null}
        <link rel="canonical" href={canonicalUrl} />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="alternate icon" href="/favicon.ico" sizes="any" />
        <Links />
      </head>
      <body>
        {children}
        <script dangerouslySetInnerHTML={{ __html: itemDetailRailAnalyticsBridgeScript }} />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const isRouteError = isRouteErrorResponse(error);
  const isNotFound = isRouteError && error.status === 404;
  const message = isRouteError
    ? error.statusText
    : error instanceof Error
      ? error.message
      : t("marketplace.app.root.unknown.error");
  const title = isNotFound ? t("marketplace.app.root.page.not.found") : t("marketplace.app.root.marketplace.error");
  const description = isNotFound ? t("marketplace.app.root.page.not.found.description") : message;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <Meta />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="alternate icon" href="/favicon.ico" sizes="any" />
        <Links />
      </head>
      <body>
        <ChaseRoot>
          <main>
            <Page width="narrow">
              <Container width="content">
                <Stack gap={4}>
                  <MarketplaceEmptyState
                    title={title}
                    description={description}
                    trustCue={t("marketplace.app.root.error.trust.cue")}
                    recoveryActions={
                      <>
                        <LinkButton href="/search">{t("marketplace.app.root.browse.marketplace")}</LinkButton>
                        <LinkButton href="/" tone="secondary">
                          {t("marketplace.app.root.go.home")}
                        </LinkButton>
                      </>
                    }
                  />
                </Stack>
              </Container>
            </Page>
          </main>
        </ChaseRoot>
        <script dangerouslySetInnerHTML={{ __html: itemDetailRailAnalyticsBridgeScript }} />
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
