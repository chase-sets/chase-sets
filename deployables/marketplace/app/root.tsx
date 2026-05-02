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
import { buildCanonicalUrl } from "./seo";
import { resolveMarketplaceActor } from "./auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  return {
    actor: await resolveMarketplaceActor(request),
    origin: new URL(request.url).origin,
  };
}

export function Layout({ children }: { children: ReactNode }) {
  const data = useLoaderData<typeof loader>() as
    | Awaited<ReturnType<typeof loader>>
    | undefined;
  const location = useLocation();
  const origin =
    data?.origin ??
    (typeof window === "undefined" ? "http://localhost" : window.location.origin);
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
        <link rel="canonical" href={canonicalUrl} />
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
  const message = isRouteErrorResponse(error)
    ? error.statusText
    : error instanceof Error
      ? error.message
      : t("marketplace.app.root.unknown.error");

  return (
    <main>
      <h1>{t("marketplace.app.root.marketplace.error")}</h1>
      <p>{message}</p>
    </main>
  );
}
