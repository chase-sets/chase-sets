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
import { resolveIdentityAdminActor } from "./auth.server";

export async function loader({ request }: LoaderFunctionArgs) {
  return {
    actor: await resolveIdentityAdminActor(request),
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
  const { origin } = useLoaderData<typeof loader>();
  const location = useLocation();
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
      : "Unknown error";

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Identity Admin Error</title>
        <Links />
      </head>
      <body>
        <main>
          <h1>Identity Admin Error</h1>
          <p>{message}</p>
        </main>
        <Scripts />
      </body>
    </html>
  );
}
