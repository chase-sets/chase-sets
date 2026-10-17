import { t } from "@chase-sets/localization";
import "@chase-sets/design-system/styles.css";
import { useEffect, useRef, type ReactNode } from "react";
import { EmptyState, LinkButton, Page, Text } from "@chase-sets/design-system";
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
  useMatches,
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
  const matches = useMatches();
  const observedAtRef = useRef<{ error: unknown; value: string } | null>(null);
  if (observedAtRef.current?.error !== error) {
    observedAtRef.current = { error, value: new Date().toISOString() };
  }
  const observedAt = observedAtRef.current!.value;
  const status = isRouteErrorResponse(error) ? error.status : null;
  const rawMessage = isRouteErrorResponse(error)
    ? [error.status, error.statusText].filter(Boolean).join(" ")
    : error instanceof Error
      ? error.message
      : t("adminWeb.app.root.unknown.error");
  // Loaders/actions across every admin section can throw with an arbitrary message. Redact it
  // before it ever reaches the DOM so a stray raw id, token, or cookie never leaks through this
  // shared error surface.
  const message = redactAdminErrorDetail(rawMessage);
  const diagnostic = {
    // Route ids come from static router configuration, never URL parameters or payloads. This is
    // the deepest matched route, not necessarily the route whose loader or element threw.
    route: matches.at(-1)?.id ?? "unmatched",
    observedAt,
    category: isRouteErrorResponse(error)
      ? "route-response"
      : error instanceof TypeError
        ? "runtime-type-error"
        : error instanceof ReferenceError
          ? "runtime-reference-error"
          : error instanceof SyntaxError
            ? "runtime-syntax-error"
            : error instanceof RangeError
              ? "runtime-range-error"
              : error instanceof Error
                ? "runtime-error"
                : "unknown-error",
    status,
  };
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
          <Text suppressHydrationWarning wrap="anywhere">
            {JSON.stringify(diagnostic)}
          </Text>
        </details>
      </Page>
    </AdminRootShell>
  );
}
