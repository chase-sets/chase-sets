import type { RouteContextManifest } from "@chase-sets/platform-runtime/http";
import metadata from "../metadata.json";

export const paymentsRouteManifest = {
  contextName: "payments",
  readAfterWriteRouteInventory: metadata.readAfterWriteRouteInventory,
} satisfies RouteContextManifest;
