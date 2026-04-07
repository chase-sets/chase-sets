import { defineAuthHost } from "@chase-sets/auth/server";
import { identityAdminAuthHostConfig } from "../../../bounded-contexts/auth/host-config";

const authPolicy = defineAuthHost(identityAdminAuthHostConfig);

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
  result: Parameters<typeof authPolicy.completeAuthentication>[1],
) {
  return authPolicy.completeAuthentication(request, result);
}

export async function signOutIdentityAdmin(request: Request) {
  return authPolicy.signOutActor(request);
}
