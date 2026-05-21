import { defineAuthHost } from "@chase-sets/auth/server";
import { catalogAdminAuthHostConfig, identityAdminAuthHostConfig } from "@chase-sets/auth/host-config";

const catalogAdminPolicy = defineAuthHost(catalogAdminAuthHostConfig);
const identityAdminPolicy = defineAuthHost(identityAdminAuthHostConfig);

export const resolveCatalogAdminActor = catalogAdminPolicy.resolveActor;
export const resolveIdentityAdminActor = identityAdminPolicy.resolveActor;

export async function requireCatalogAdminActor(request: Request, permission = "catalog.view") {
  return catalogAdminPolicy.requireActor(request, permission);
}

export async function requireIdentityAdminActor(request: Request) {
  return identityAdminPolicy.requireActor(request, "security.manage");
}

export async function requireExperienceAdminActor(
  request: Request,
  permission: string | readonly string[] = "platform-feedback.view",
) {
  if (typeof permission === "string") {
    return identityAdminPolicy.requireActor(request, permission);
  }

  const actor = await identityAdminPolicy.resolveActor(request);
  if (!actor) {
    return identityAdminPolicy.requireActor(request, permission[0]);
  }

  if (!permission.some((entry) => actor.permissions.includes(entry))) {
    throw new Response("Forbidden.", { status: 403 });
  }

  return actor;
}
