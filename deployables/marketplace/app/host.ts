import { resolveWebHostNavItems } from "@chase-sets/platform-runtime/web";
import { resolveWebHostRouteConfigRecords } from "@chase-sets/platform-runtime/web-route-config";
import { webContextRegistry } from "./generated/web-context-registry";

export function resolveMarketplaceRouteConfigRecords() {
  return resolveWebHostRouteConfigRecords(webContextRegistry, "marketplace-web");
}

export function resolveMarketplaceNavItems(
  slot: "top-nav" | "bottom-nav",
  actor?: Readonly<{ permissions?: readonly string[] }> | null,
) {
  return resolveWebHostNavItems(webContextRegistry, "marketplace-web", slot, actor);
}
