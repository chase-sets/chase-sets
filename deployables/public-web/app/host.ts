import { resolveWebHostRouteConfigRecords } from "@chase-sets/platform-runtime/web-route-config";
import { webContextRegistry } from "./context-registry";

export function resolvePublicRouteConfigRecords() {
  return resolveWebHostRouteConfigRecords(webContextRegistry, "public-web");
}
