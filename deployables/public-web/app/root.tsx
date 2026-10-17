import "@chase-sets/design-system/styles.css";
import type { ReactNode } from "react";
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
import { ChaseRoot, Container, LinkButton, MarketplaceEmptyState, Page, Stack } from "@chase-sets/design-system";
import { buildCanonicalUrl, resolvePublicOrigin, shouldIndexPublicWeb } from "./seo";
import { publicPresenceT as t, waitlistAnalyticsEventNames } from "@chase-sets/public-presence/web";

export const waitlistAnalyticsBridgeScript = `
(() => {
  const endpoint = "/api/public-presence/analytics/waitlist";
  const allowedEvents = new Set(${JSON.stringify(waitlistAnalyticsEventNames)});

  function readBounded(value) {
    if (typeof value !== "string") {
      return null;
    }
    const text = value.trim();
    return text.length > 0 && text.length <= 80 && /^[a-zA-Z0-9_.-]+$/.test(text) ? text : null;
  }

  function readAttribution(value) {
    if (typeof value !== "string") {
      return null;
    }
    const text = value.trim();
    return text.length > 0 && text.length <= 120 && /^[a-zA-Z0-9][a-zA-Z0-9 _%+.-]*$/.test(text) ? text : null;
  }

  function readPath(value) {
    if (typeof value !== "string") {
      return null;
    }
    const text = value.trim();
    return text.length > 0 && text.length <= 160 && text.startsWith("/") && /^[/a-zA-Z0-9_.~%=&?-]+$/.test(text)
      ? text
      : null;
  }

  window.addEventListener("chase-sets:waitlist-analytics", (event) => {
    const detail = event instanceof CustomEvent ? event.detail : null;
    if (!detail || typeof detail.event !== "string" || !allowedEvents.has(detail.event)) {
      return;
    }

    const payload = {
      event: detail.event,
      section: readBounded(detail.section),
      target: readBounded(detail.target),
      field: readBounded(detail.field),
      role: readBounded(detail.role),
      interest: readBounded(detail.interest),
      variant: readBounded(detail.variant),
      status: readBounded(detail.status),
      page_path: readPath(detail.page_path),
      utm_source: readAttribution(detail.utm_source),
      utm_medium: readAttribution(detail.utm_medium),
      utm_campaign: readAttribution(detail.utm_campaign),
      checked: typeof detail.checked === "boolean" ? detail.checked : null,
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

export function loader(_args: LoaderFunctionArgs) {
  return {
    origin: resolvePublicOrigin(),
    shouldIndex: shouldIndexPublicWeb(),
  };
}

export function Layout({ children }: { children: ReactNode }) {
  const data = useLoaderData<typeof loader>() as Awaited<ReturnType<typeof loader>> | undefined;
  const location = useLocation();
  const origin = data?.origin ?? resolvePublicOrigin();
  const shouldIndex = data?.shouldIndex ?? shouldIndexPublicWeb();
  const canonicalUrl = buildCanonicalUrl({
    origin,
    pathname: location.pathname,
    search: location.search,
  });

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0e0c15" />
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
        <script dangerouslySetInnerHTML={{ __html: waitlistAnalyticsBridgeScript }} />
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
      : t("publicPresence.appRoot.unknownError");
  const title = isNotFound ? t("publicPresence.appRoot.pageNotFound") : t("publicPresence.appRoot.publicError");
  const description = isNotFound ? t("publicPresence.appRoot.pageNotFound.description") : message;

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0e0c15" />
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
                    trustCue={t("publicPresence.appRoot.error.trustCue")}
                    recoveryActions={<LinkButton href="/">{t("publicPresence.appRoot.goHome")}</LinkButton>}
                  />
                </Stack>
              </Container>
            </Page>
          </main>
        </ChaseRoot>
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}
