import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type { ProviderConnectionsSnapshot } from "./contracts";

export async function loadProviderConnections(request: Request): Promise<ProviderConnectionsSnapshot> {
  const response = await fetch(resolveRequestApiBaseUrl(request, "/api/platform/provider-connections"), {
    headers: createForwardedAuthHeaders(request),
  });
  if (!response.ok) throw new Response(null, { status: response.status });
  return response.json();
}
