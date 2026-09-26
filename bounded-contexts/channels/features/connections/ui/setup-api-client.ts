import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import { attachResponseMetadata } from "@chase-sets/http/responses";
import { ChannelsConnectionsApiError } from "../../../support/request-support/api-client";
import type { PublicChannelConnection } from "../domain/contracts";

export function createConnectionSetupRequestApiClient(request: Request) {
  const baseUrl = resolveRequestApiBaseUrl(request, "/api/channels/connections");
  const fetch = createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "channels" });
  async function post(path: string, body: unknown): Promise<PublicChannelConnection> {
    const response = await fetch(`${baseUrl}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const result: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new ChannelsConnectionsApiError(response.status, result);
    return attachResponseMetadata(result, response) as PublicChannelConnection;
  }
  return {
    connect: (providerKey: string) => post("", { providerKey }),
    activate: (connectionId: string, storageLocationIds: readonly string[]) =>
      post(`/${encodeURIComponent(connectionId)}/activate`, { storageLocationIds }),
  };
}
