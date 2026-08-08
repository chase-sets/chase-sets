import { t } from "@chase-sets/localization";
import "@chase-sets/design-system/styles.css";
import { useEffect, type ReactNode } from "react";
import { EmptyState, LinkButton, Page } from "@chase-sets/design-system";
import { buildCanonicalUrl } from "@chase-sets/platform-runtime/seo";
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
import { AdminRootShell } from "./admin-root-shell";
import { redactAdminErrorDetail } from "./error-detail-redaction";
import { registerAdminServiceWorker } from "./pwa/register-service-worker";

export async function loader({ request }: LoaderFunctionArgs) {
  return {
    origin: new URL(request.url).origin,
  };
}

export function Layout({ children }: { children: ReactNode }) {
  const data = useLoaderData<typeof loader>() as Awaited<ReturnType<typeof loader>> | undefined;
  const location = useLocation();
  const origin = data?.origin ?? (typeof window === "undefined" ? "http://localhost" : window.location.origin);
  const canonicalUrl = buildCanonicalUrl({
    origin,
    pathname: location.pathname,
    search: location.search,
  });

  useEffect(() => {
    document.documentElement.dataset.adminWebHydrated = "true";
    registerAdminServiceWorker();
  }, []);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0f766e" />
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
  const location = useLocation();
  const status = isRouteErrorResponse(error) ? error.status : null;
  const responseDetail =
    isRouteErrorResponse(error) && error.data
      ? typeof error.data === "string"
        ? error.data
        : JSON.stringify(error.data)
      : null;
  const rawMessage = isRouteErrorResponse(error)
    ? [error.status, error.statusText || responseDetail].filter(Boolean).join(" ")
    : error instanceof Error
      ? error.message
      : t("adminWeb.app.root.unknown.error");
  // Loaders/actions across every admin section can throw with an arbitrary message. Redact it
  // before it ever reaches the DOM so a stray raw id, token, or cookie never leaks through this
  // shared error surface.
  const message = redactAdminErrorDetail(rawMessage);
  const title = status === 404 ? t("adminWeb.app.root.not.found.title") : t("adminWeb.app.root.admin.error.2");
  const retryHref = `${location.pathname}${location.search}${location.hash}` || "/";

  return (
    <AdminRootShell>
      <Page width="content">
        <EmptyState
          title={title}
          description={t("adminWeb.app.root.admin.error.description")}
          actions={
            <>
              <LinkButton href="/" tone="primary">
                {t("adminWeb.app.root.go.to.admin.home")}
              </LinkButton>
              <LinkButton href={retryHref} tone="secondary">
                {t("adminWeb.app.root.retry")}
              </LinkButton>
            </>
          }
        />
        <details>
          <summary>{t("adminWeb.app.root.technical.detail")}</summary>
          <p>{message}</p>
        </details>
      </Page>
    </AdminRootShell>
  );
}
