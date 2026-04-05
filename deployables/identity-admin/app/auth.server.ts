import { createAuthHostPolicy } from "@chase-sets/auth/server";

const authPolicy = createAuthHostPolicy({
  signInPath: "/sign-in",
  fallbackPath: "/accounts",
  defaultSuccessPath: "/accounts",
  accountSelectionPath: "/account-select",
  requiredPermission: "security.manage",
  signedOutReturnTo: "/sign-in",
});

export const getReturnTo = authPolicy.getReturnTo;
export const resolveIdentityAdminActor = authPolicy.resolveActor;

export async function requireIdentityAdminActor(request: Request) {
  return authPolicy.requireActor(request, "security.manage");
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

export async function signOutIdentityAdmin(request: Request) {
  return authPolicy.signOutActor(request);
}
