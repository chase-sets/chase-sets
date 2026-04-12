import { defineAuthHost } from "@chase-sets/auth/server";
import {
  catalogAdminAuthHostConfig,
  identityAdminAuthHostConfig,
} from "@chase-sets/auth/host-config";

const catalogAdminPolicy = defineAuthHost(catalogAdminAuthHostConfig);
const identityAdminPolicy = defineAuthHost(identityAdminAuthHostConfig);

export const resolveCatalogAdminActor = catalogAdminPolicy.resolveActor;
export const resolveIdentityAdminActor = identityAdminPolicy.resolveActor;

export async function requireCatalogAdminActor(
  request: Request,
  permission = "catalog.view",
) {
  return catalogAdminPolicy.requireActor(request, permission);
}

export async function requireIdentityAdminActor(request: Request) {
  return identityAdminPolicy.requireActor(request, "security.manage");
}
