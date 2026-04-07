import { defineAuthHost } from "@chase-sets/auth/server";
import { marketplaceAuthHostConfig } from "../../../bounded-contexts/auth/host-config";

const authPolicy = defineAuthHost(marketplaceAuthHostConfig);

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
