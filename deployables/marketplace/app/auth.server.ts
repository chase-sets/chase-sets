import { defineAuthHost } from "@chase-sets/auth/server";
import { marketplaceAuthHostConfig } from "@chase-sets/auth/host-config";
import { isTransientAuthResolutionError } from "@chase-sets/platform-runtime/auth";

const authPolicy = defineAuthHost(marketplaceAuthHostConfig);

export const getReturnTo = authPolicy.getReturnTo;

export async function resolveMarketplaceActor(request: Request) {
  try {
    return await authPolicy.resolveActor(request);
  } catch (error) {
    if (isTransientAuthResolutionError(error)) {
      return null;
    }

    throw error;
  }
}

function buildCurrentPath(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function redirectToSignIn(request: Request) {
  return new Response(null, {
    status: 302,
    headers: {
      Location: `/sign-in?returnTo=${encodeURIComponent(buildCurrentPath(request))}`,
    },
  });
}

export async function requireMarketplaceActor(request: Request, permission?: string) {
  try {
    return await authPolicy.requireActor(request, permission);
  } catch (error) {
    if (isTransientAuthResolutionError(error)) {
      throw redirectToSignIn(request);
    }

    throw error;
  }
}

export function requireAccountSelectionToken(request: Request) {
  return authPolicy.requireAccountSelectionToken(request);
}

export function completeAuthentication(
  request: Request,
  result: Parameters<typeof authPolicy.completeAuthentication>[1],
  options: Readonly<{
    defaultSuccessPath: string;
    accountSelectionPath: string;
  }>,
) {
  return authPolicy.completeAuthentication(request, result, options);
}

export async function signOutMarketplaceActor(
  request: Request,
  options: Readonly<{
    returnTo?: string;
  }> = {},
) {
  return authPolicy.signOutActor(request, options);
}
