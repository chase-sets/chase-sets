import { redirect } from "react-router";
import {
  hasPermission,
  completeBrowserAuthentication,
  requireAccountSelectionTokenOrRedirect,
  resolveActorFromAuthContext,
  signOutActorViaAuthApi,
} from "@chase-sets/auth/server";

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
  return resolveActorFromAuthContext({ request });
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
  return signOutActorViaAuthApi(request, { returnTo: "/sign-in" });
}
