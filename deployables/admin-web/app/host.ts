import { resolveWebHostNavItems } from "@chase-sets/platform-runtime/web";
import { resolveWebHostRouteConfigRecords } from "@chase-sets/platform-runtime/web-route-config";
import { webContextRegistry } from "./generated/web-context-registry";

export function resolveAdminWebRouteConfigRecords() {
  return resolveWebHostRouteConfigRecords(webContextRegistry, "admin-web");
}

export function resolveAdminWebNavItems(
  actor: Readonly<{ permissions?: readonly string[] }> | null | undefined,
  options: Readonly<{ section: "catalog" | "identity" | "experience" | "operations" }>,
) {
  return resolveWebHostNavItems(webContextRegistry, "admin-web", "primary-nav", actor, options);
}
