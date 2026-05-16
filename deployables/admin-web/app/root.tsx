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
import { registerAdminServiceWorker } from "./pwa/register-service-worker";

export async function loader({ request }: LoaderFunctionArgs) {
  return {
    origin: new URL(request.url).origin,
  };
}

export function buildCanonicalUrl({
  origin,
  pathname,
  search = "",
}: {
  origin: string;
  pathname: string;
  search?: string;
}) {
  return new URL(`${pathname}${search}`, origin).toString();
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

  useEffect(() => {
    registerAdminServiceWorker();
  }, []);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#1f6f68" />
        <Meta />
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
  const message = isRouteErrorResponse(error)
    ? error.statusText
    : error instanceof Error
      ? error.message
      : t("adminWeb.app.root.unknown.error");

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#1f6f68" />
        <title>{t("adminWeb.app.root.admin.error")}</title>
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <link rel="alternate icon" href="/favicon.ico" sizes="any" />
        <Links />
      </head>
      <body>
        <main>
          <h1>{t("adminWeb.app.root.admin.error.2")}</h1>
          <p>{message}</p>
        </main>
        <Scripts />
      </body>
    </html>
  );
}
