import { resolveWebHostRouteConfigRecords } from "@chase-sets/platform-runtime/web-route-config";
import { webContextRegistry } from "./generated/web-context-registry";

export function resolvePublicRouteConfigRecords() {
  return resolveWebHostRouteConfigRecords(webContextRegistry, "public-web");
}
