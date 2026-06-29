import { defineAuthHost } from "@chase-sets/auth/server";
import { adminAuthHostConfig } from "@chase-sets/auth/host-config";
import type { WebHostSection } from "@chase-sets/platform-runtime/web";
import { resolveAdminWebNavItems } from "./host";

const adminPolicy = defineAuthHost(adminAuthHostConfig);

export const resolveAdminActor = adminPolicy.resolveActor;

export async function requireCatalogAdminActor(request: Request, permission = "catalog.view") {
  return adminPolicy.requireActor(request, permission);
}

export async function requireAccessAdminActor(request: Request) {
  return requireAdminSectionActor(request, "access", "accounts.view");
}

export async function requireSignedInAdminActor(request: Request) {
  const actor = await adminPolicy.resolveActor(request);
  return actor ?? adminPolicy.requireActor(request, "");
}

export async function requireAdminSectionActor(request: Request, section: WebHostSection, fallbackPermission: string) {
  const actor = await adminPolicy.resolveActor(request);

  if (!actor) {
    return adminPolicy.requireActor(request, fallbackPermission);
  }

  if (resolveAdminWebNavItems(actor, { section }).length === 0) {
    throw new Response("Forbidden.", { status: 403 });
  }

  return actor;
}
