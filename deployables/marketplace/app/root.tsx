import { t } from "@chase-sets/localization";
import "@chase-sets/design-system/styles.css";
import { useEffect, type ReactNode } from "react";
import type { LoaderFunctionArgs } from "react-router";
import {
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
import { requireMarketplaceProofAccess } from "./proof-access.server";
import { registerMarketplaceServiceWorker } from "./pwa/register-service-worker";
import { ChaseRoot, Container, LinkButton, MarketplaceEmptyState, Page, Stack } from "@chase-sets/design-system";
import { createCheckoutRequestApiClient, readAnonymousCartId } from "@chase-sets/checkout/server";
import { itemDetailRailAnalyticsEventNames } from "@chase-sets/discovery/web";
import { createIdentityRequestApiClient, type CurrentActorDisplay } from "@chase-sets/identity/server";

type MarketplaceRootActor = Awaited<ReturnType<typeof resolveMarketplaceActor>>;

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

    if (actor) {
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

export async function loader({ request }: LoaderFunctionArgs) {
  const proofAccessActor = await requireMarketplaceProofAccess(request);
  const actor = proofAccessActor ?? (await resolveMarketplaceActor(request));

  return {
    actor,
    actorDisplay: await resolveCurrentActorDisplay(request, actor),
    cartCount: await resolveCartCount(request, actor),
    origin: new URL(request.url).origin,
    shouldIndex: shouldIndexMarketplace(),
  };
}

export function Layout({ children }: { children: ReactNode }) {
  const data = useLoaderData<typeof loader>() as Awaited<ReturnType<typeof loader>> | undefined;
  const location = useLocation();
  const origin = data?.origin ?? (typeof window === "undefined" ? "http://localhost" : window.location.origin);
  const shouldIndex = data?.shouldIndex ?? shouldIndexMarketplace();
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
        <ChaseRoot colorMode="system">
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
