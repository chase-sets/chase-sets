import { createAuthHostPolicy } from "@chase-sets/auth/server";

const authPolicy = createAuthHostPolicy({
  signInPath: "/sign-in",
  fallbackPath: "/account",
  defaultSuccessPath: "/account",
  accountSelectionPath: "/account/select",
  signedOutReturnTo: "/search",
});

export const getReturnTo = authPolicy.getReturnTo;
export const resolveMarketplaceActor = authPolicy.resolveActor;

export async function requireMarketplaceActor(
  request: Request,
  permission?: string,
) {
  return authPolicy.requireActor(request, permission);
}

export function requireAccountSelectionToken(request: Request) {
  return authPolicy.requireAccountSelectionToken(request);
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
