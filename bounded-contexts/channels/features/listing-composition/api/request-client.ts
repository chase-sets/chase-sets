import { readApiErrorMessage } from "@chase-sets/http/responses";
import { createForwardedAuthFetch, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type {
  ChannelCommandResult,
  ChannelPublicationConnectionDetail,
  ChannelPublicationConnectionSummary,
  ChannelPublicationSettings,
} from "../domain/contracts";

export class ChannelsPublicationApiError extends Error {
  public constructor(
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(readApiErrorMessage(body, `Channels API error ${status}`));
  }
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
  // A configuration command at a version that is no longer current answers 409 with its refusal
  // (`stream-version-conflict`), which is the command's result rather than a failure.
  async function command(path: string, init: RequestInit): Promise<ChannelCommandResult> {
    try {
      return await json<ChannelCommandResult>(path, init);
    } catch (error) {
      if (error instanceof ChannelsPublicationApiError && error.status === 409 && isVersionConflict(error.body)) {
        return error.body;
      }
      throw error;
    }
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
      return command(`/${encodeURIComponent(connectionId)}/settings`, {
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
      return command(
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

function isVersionConflict(body: unknown): body is Extract<ChannelCommandResult, { kind: "refused" }> {
  if (typeof body !== "object" || body === null) return false;
  const record = body as Record<string, unknown>;
  return record.kind === "refused" && record.code === "stream-version-conflict";
}
