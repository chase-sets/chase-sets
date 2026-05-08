import { t } from "@chase-sets/localization";
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
import {
  ChaseRoot,
  Container,
  LinkButton,
  MarketplaceEmptyState,
  Page,
  Stack,
} from "@chase-sets/design-system";
import {
  buildCanonicalUrl,
  resolvePublicOrigin,
  shouldIndexPublicWeb,
} from "./seo";

export function loader(_args: LoaderFunctionArgs) {
  return {
    origin: resolvePublicOrigin(),
    shouldIndex: shouldIndexPublicWeb(),
  };
}

export function Layout({ children }: { children: ReactNode }) {
  const data = useLoaderData<typeof loader>() as
    | Awaited<ReturnType<typeof loader>>
    | undefined;
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
  const title = isNotFound
    ? t("marketplace.app.root.page.not.found")
    : t("marketplace.app.root.marketplace.error");
  const description = isNotFound
    ? t("marketplace.app.root.page.not.found.description")
    : message;

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
                      <LinkButton href="/">
                        {t("marketplace.app.root.go.home")}
                      </LinkButton>
                    }
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
