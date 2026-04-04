import { redirect } from "react-router";
import { resolveRequestApiBaseUrl } from "@chase-sets/bounded-context-runtime";
import { IdentityApiError } from "@chase-sets/identity/web";
import {
  completeBrowserAuthentication,
  hasPermission,
  requireAccountSelectionTokenOrRedirect,
  resolveActorFromIdentityApi,
  signOutActorViaIdentityApi,
  type ResolvedActor,
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

export async function resolveIdentityAdminActor(request: Request) {
  try {
    return await resolveActorFromIdentityApi({
      identityApiBaseUrl: resolveRequestApiBaseUrl(request, "/api/identity"),
      request,
    });
  } catch (error) {
    if (error instanceof IdentityApiError && error.status === 401) {
      return null;
    }

    throw error;
  }
}

export async function requireIdentityAdminActor(request: Request) {
  const actor = await resolveIdentityAdminActor(request);
  if (!actor) {
    throw redirect(
      `/sign-in?returnTo=${encodeURIComponent(buildCurrentPath(request))}`,
    );
  }

  if (!hasPermission(actor, "security.manage")) {
    throw new Response("Forbidden.", { status: 403 });
  }

  return actor;
}

export function requireAccountSelectionToken(request: Request) {
  return requireAccountSelectionTokenOrRedirect(request, {
    fallbackPath: "/accounts",
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
    defaultSuccessPath: "/accounts",
    accountSelectionPath: "/account-select",
  });
}

export async function signOutIdentityAdmin(request: Request) {
  return signOutActorViaIdentityApi(request, { returnTo: "/sign-in" });
}
