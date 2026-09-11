import { readApiErrorMessage } from "@chase-sets/http/responses";
import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type {
  ChannelCommandResult,
  ChannelPublicationConnectionDetail,
  ChannelPublicationConnectionSummary,
  ChannelPublicationSettings,
} from "../../features/listing-composition/domain/contracts";
import {
  channelConnectionStatuses,
  type ChannelConnectionPage,
  type ChannelConnectionStatus,
  type PublicChannelConnection,
} from "../../features/connections/domain/contracts";

export {
  channelConnectionStatuses,
  type ChannelConnectionPage,
  type ChannelConnectionStatus,
  type PublicChannelConnection,
};

export class ChannelsPublicationApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(readApiErrorMessage(body, `Channels API error ${status}`));
  }
}

export class ChannelsConnectionsApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(readApiErrorMessage(body, `Channels API error ${status}`));
  }
}

export function createChannelsConnectionsRequestApiClient(request: Request) {
  const baseUrl = resolveRequestApiBaseUrl(request, "/api/channels/connections");
  const fetch = createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "channels" });
  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new ChannelsConnectionsApiError(response.status, body);
    return body as T;
  }
  return {
    listConnections(
      query: Readonly<{ cursor?: string; status?: ChannelConnectionStatus; limit?: number }> = {},
    ): Promise<ChannelConnectionPage> {
      const params = new URLSearchParams();
      if (query.cursor) params.set("cursor", query.cursor);
      if (query.status) params.set("status", query.status);
      if (query.limit) params.set("limit", String(query.limit));
      const search = params.toString();
      return json(search ? `?${search}` : "");
    },
    getConnection(connectionId: string): Promise<PublicChannelConnection> {
      return json(`/${encodeURIComponent(connectionId)}`);
    },
    pauseConnection(connectionId: string): Promise<PublicChannelConnection> {
      return json(`/${encodeURIComponent(connectionId)}/pause`, { method: "POST" });
    },
    resumeConnection(connectionId: string): Promise<PublicChannelConnection> {
      return json(`/${encodeURIComponent(connectionId)}/resume`, { method: "POST" });
    },
    disconnectConnection(connectionId: string): Promise<PublicChannelConnection> {
      return json(`/${encodeURIComponent(connectionId)}/disconnect`, { method: "POST" });
    },
  };
}

export function createChannelsPublicationRequestApiClient(request: Request) {
  const baseUrl = resolveRequestApiBaseUrl(request, "/api/channels/publication");
  const fetch = createForwardedAuthFetch(request, globalThis.fetch, { readTargetContextName: "channels" });
  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    });
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) throw new ChannelsPublicationApiError(response.status, body);
    return body as T;
  }
  return {
    async listConnections(): Promise<readonly ChannelPublicationConnectionSummary[]> {
      const result = await json<{ items: readonly ChannelPublicationConnectionSummary[] }>("");
      return result.items;
    },
    getConnection(connectionId: string, cursor?: string | null): Promise<ChannelPublicationConnectionDetail> {
      const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : "";
      return json(`/${encodeURIComponent(connectionId)}${query}`);
    },
    replaceSettings(
      connectionId: string,
      settings: ChannelPublicationSettings,
      expectedStreamVersion: number,
    ): Promise<ChannelCommandResult> {
      return json(`/${encodeURIComponent(connectionId)}/settings`, {
        method: "PUT",
        body: JSON.stringify({ settings, expectedStreamVersion }),
      });
    },
    decideMapping(
      input: Readonly<{
        connectionId: string;
        dimension: string;
        sourceKey: string;
        decision: string;
        targetKey: string | null;
        expectedStreamVersion: number;
      }>,
    ): Promise<ChannelCommandResult> {
      return json(
        `/${encodeURIComponent(input.connectionId)}/mappings/${encodeURIComponent(input.dimension)}/${encodeURIComponent(input.sourceKey)}/decision`,
        {
          method: "POST",
          body: JSON.stringify({
            decision: input.decision,
            targetKey: input.targetKey,
            expectedStreamVersion: input.expectedStreamVersion,
          }),
        },
      );
    },
  };
}
