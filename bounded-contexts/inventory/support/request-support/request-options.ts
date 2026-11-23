import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type { InventoryApiClientOptions } from "./client";

export type InventoryRequestClientOptions = Pick<
  InventoryApiClientOptions,
  "requestTimeoutMs" | "recoverTransportErrorsAsGatewayTimeout" | "mutationAttemptId"
>;

export function inventoryRequestOptions(
  request: Request,
  options: InventoryRequestClientOptions = {},
): InventoryApiClientOptions {
  return {
    baseUrl: resolveRequestApiBaseUrl(request, "/api/inventory"),
    fetch: createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "inventory" }),
    ...options,
  };
}
