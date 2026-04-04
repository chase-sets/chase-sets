import { redirect } from "react-router";
import {
  hasPermission,
  resolveActorFromAuthApi,
  type ResolvedActor,
} from "@chase-sets/auth-runtime";
import { resolveRequestApiBaseUrl } from "@chase-sets/bounded-context-runtime";
import {
  completeBrowserAuthentication,
  requireAccountSelectionTokenOrRedirect,
  signOutActorViaIdentityApi,
} from "@chase-sets/identity/server";

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
  return resolveActorFromAuthApi({
    authApiBaseUrl: resolveRequestApiBaseUrl(request, "/api/identity"),
    request,
  });
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
  return requireAccountSelectionTokenOrRedirect(request, {
    fallbackPath: "/dimensions",
  });
}

export function completeAuthentication(
  request: Request,
  result: Readonly<{
    requiresAccountSelection?: boolean;
    selectionToken?: string;
    sessionToken?: string;
  }>,
) {
  return completeBrowserAuthentication(request, result, {
    defaultSuccessPath: "/dimensions",
    accountSelectionPath: "/account-select",
  });
}

export async function signOutCatalogAdmin(request: Request) {
  return signOutActorViaIdentityApi(request, { returnTo: "/sign-in" });
}
