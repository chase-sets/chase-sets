import type { Context, Next } from "hono";
import { authenticationRequiredResponse, forbiddenResponse } from "@chase-sets/http/responses";
import type { ResolvedActor } from "@chase-sets/platform-runtime/auth";

type CatalogPermissionEnv = { Variables: { actor: ResolvedActor | null } };

export async function catalogApiPermissionMiddleware(
  c: Context<CatalogPermissionEnv>,
  next: Next,
): Promise<Response | void> {
  const actor = c.get("actor");
  if (!actor) {
    return c.json(authenticationRequiredResponse(), 401);
  }

  const method = c.req.method.toUpperCase();
  const requiredPermission =
    method === "GET" || method === "HEAD" || method === "OPTIONS" ? "catalog.view" : "catalog.manage";
  if (!actor.permissions.includes(requiredPermission)) {
    return c.json(forbiddenResponse(), 403);
  }

  await next();
}
