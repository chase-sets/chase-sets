import { defineAuthHost } from "@chase-sets/auth/server";
import { accessAdminAuthHostConfig, catalogAdminAuthHostConfig } from "@chase-sets/auth/host-config";
import type { WebHostSection } from "@chase-sets/platform-runtime/web";
import { resolveAdminWebNavItems } from "./host";

const catalogAdminPolicy = defineAuthHost(catalogAdminAuthHostConfig);
const accessAdminPolicy = defineAuthHost(accessAdminAuthHostConfig);

export const resolveCatalogAdminActor = catalogAdminPolicy.resolveActor;
export const resolveAccessAdminActor = accessAdminPolicy.resolveActor;

export async function requireCatalogAdminActor(request: Request, permission = "catalog.view") {
  return catalogAdminPolicy.requireActor(request, permission);
}

export async function requireAccessAdminActor(request: Request) {
  return requireAdminSectionActor(request, "access", "accounts.view");
}

export async function requireSignedInAdminActor(request: Request) {
  const actor = await accessAdminPolicy.resolveActor(request);
  return actor ?? accessAdminPolicy.requireActor(request, "");
}

export async function requireAdminSectionActor(request: Request, section: WebHostSection, fallbackPermission: string) {
  const actor = await accessAdminPolicy.resolveActor(request);

  if (!actor) {
    return accessAdminPolicy.requireActor(request, fallbackPermission);
  }

  if (resolveAdminWebNavItems(actor, { section }).length === 0) {
    throw new Response("Forbidden.", { status: 403 });
  }

  return actor;
}
