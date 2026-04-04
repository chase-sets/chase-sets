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

export async function resolveMarketplaceActor(request: Request) {
  return resolveActorFromAuthContext({ request });
}

export async function requireMarketplaceActor(
  request: Request,
  permission?: Parameters<typeof hasPermission>[1],
) {
  const actor = await resolveMarketplaceActor(request);
  if (!actor) {
    throw redirect(
      `/sign-in?returnTo=${encodeURIComponent(buildCurrentPath(request))}`,
    );
  }

  if (permission && !hasPermission(actor, permission)) {
    throw new Response("Forbidden.", { status: 403 });
  }

  return actor;
}

export function requireAccountSelectionToken(request: Request) {
  return requireAccountSelectionTokenOrRedirect(request, {
    fallbackPath: "/account",
  });
}

export function completeAuthentication(
  request: Request,
  result: Readonly<{
    requiresAccountSelection?: boolean;
    selectionToken?: string;
    sessionToken?: string;
  }>,
  options: Readonly<{
    defaultSuccessPath: string;
    accountSelectionPath: string;
  }>,
) {
  return completeBrowserAuthentication(request, result, options);
}

export async function signOutMarketplaceActor(
  request: Request,
  options: Readonly<{
    returnTo?: string;
  }> = {},
) {
  return signOutActorViaAuthApi(request, {
    returnTo: options.returnTo ?? "/search",
  });
}
