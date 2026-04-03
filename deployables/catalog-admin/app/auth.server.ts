import { redirect } from "react-router";
import { IdentityApiError } from "@chase-sets/identity/web";
import {
  appendAccountSelectionCookie,
  appendIdentitySessionCookie,
  clearAccountSelectionCookie,
  clearIdentitySessionCookie,
  hasPermission,
  readAccountSelectionToken,
  type ResolvedActor,
} from "@chase-sets/identity/server";
import { createIdentityServerApiClient } from "./api.server";

function buildCurrentPath(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function isSafeReturnTo(value: string | null) {
  return Boolean(value && value.startsWith("/") && !value.startsWith("//"));
}

export function getReturnTo(request: Request, fallback: string) {
  const returnTo = new URL(request.url).searchParams.get("returnTo");
  return isSafeReturnTo(returnTo) ? returnTo! : fallback;
}

export async function resolveCatalogAdminActor(request: Request) {
  const api = createIdentityServerApiClient(request);

  try {
    const response = await api.getCurrentActor<{ actor: ResolvedActor }>();
    return response.actor;
  } catch (error) {
    if (error instanceof IdentityApiError && error.status === 401) {
      return null;
    }

    throw error;
  }
}

export async function requireCatalogAdminActor(
  request: Request,
  permission: Parameters<typeof hasPermission>[1] = "catalog.view",
) {
  const actor = await resolveCatalogAdminActor(request);
  if (!actor) {
    throw redirect(
      `/sign-in?returnTo=${encodeURIComponent(buildCurrentPath(request))}`,
    );
  }

  if (!hasPermission(actor, permission)) {
    throw new Response("Forbidden.", { status: 403 });
  }

  return actor;
}

export function requireAccountSelectionToken(request: Request) {
  const selectionToken = readAccountSelectionToken(request);
  if (!selectionToken) {
    throw redirect(
      `/sign-in?returnTo=${encodeURIComponent(getReturnTo(request, "/dimensions"))}`,
    );
  }

  return selectionToken;
}

export function completeAuthentication(
  request: Request,
  result: Readonly<{
    requiresAccountSelection?: boolean;
    selectionToken?: string;
    sessionToken?: string;
  }>,
) {
  const headers = new Headers();
  clearAccountSelectionCookie(headers, request);

  if (result.requiresAccountSelection) {
    if (!result.selectionToken) {
      return { error: "Account selection could not be started." };
    }

    appendAccountSelectionCookie(headers, result.selectionToken, request);
    throw redirect(
      `/account-select?returnTo=${encodeURIComponent(
        getReturnTo(request, "/dimensions"),
      )}`,
      { headers },
    );
  }

  if (!result.sessionToken) {
    return { error: "Authentication did not return a session." };
  }

  appendIdentitySessionCookie(headers, result.sessionToken, request);
  throw redirect(getReturnTo(request, "/dimensions"), { headers });
}

export async function signOutCatalogAdmin(request: Request) {
  const headers = new Headers();
  clearAccountSelectionCookie(headers, request);
  clearIdentitySessionCookie(headers, request);

  try {
    const api = createIdentityServerApiClient(request);
    await api.signOutCurrentSession();
  } catch {
    // Clearing the local cookies is enough to end the browser session.
  }

  return redirect("/sign-in", { headers });
}
