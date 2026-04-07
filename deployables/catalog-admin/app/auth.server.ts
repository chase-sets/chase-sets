import { defineAuthHost } from "@chase-sets/auth/server";
import { catalogAdminAuthHostConfig } from "../../../bounded-contexts/auth/host-config";

const authPolicy = defineAuthHost(catalogAdminAuthHostConfig);

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
  result: Parameters<typeof authPolicy.completeAuthentication>[1],
) {
  return authPolicy.completeAuthentication(request, result);
}

export async function signOutCatalogAdmin(request: Request) {
  return authPolicy.signOutActor(request);
}
