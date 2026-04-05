import { createAuthHostPolicy } from "@chase-sets/auth/server";

const authPolicy = createAuthHostPolicy({
  signInPath: "/sign-in",
  fallbackPath: "/dimensions",
  defaultSuccessPath: "/dimensions",
  accountSelectionPath: "/account-select",
  requiredPermission: "catalog.view",
  signedOutReturnTo: "/sign-in",
});

export const getReturnTo = authPolicy.getReturnTo;
export const resolveCatalogAdminActor = authPolicy.resolveActor;

export async function requireCatalogAdminActor(
  request: Request,
  permission = "catalog.view",
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
) {
  return authPolicy.completeAuthentication(request, result);
}

export async function signOutCatalogAdmin(request: Request) {
  return authPolicy.signOutActor(request);
}
