import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import type { LoaderFunctionArgs } from "react-router";
import type { OutboundOperationLogPage, OutboundOperationSummary } from "../domain/contracts";
import {
  readOutboundOperationLogPosition,
  resolveOutboundOperationLogNavigation,
  type OutboundOperationLogNavigation,
} from "./operation-log-navigation";

export type OutboundOperationLogLoaderData =
  | Readonly<{
      kind: "loaded";
      log: OutboundOperationLogPage;
      summary: OutboundOperationSummary;
      navigation: OutboundOperationLogNavigation;
    }>
  | Readonly<{ kind: "read-error" }>
  | Readonly<{ kind: "not-found" }>;

export async function loadOutboundOperationLog({
  request,
  params,
}: Pick<LoaderFunctionArgs, "request" | "params">): Promise<OutboundOperationLogLoaderData> {
  const connectionId = String(params.connectionId ?? "");
  const position = readOutboundOperationLogPosition(new URL(request.url).searchParams);
  const apiBaseUrl = resolveRequestApiBaseUrl(request, "/api/channels", { requireInternalApiOrigin: true });
  const query = new URLSearchParams({ limit: "50" });
  if (position.cursor !== null) query.set("cursor", position.cursor);

  try {
    const response = await fetch(
      `${apiBaseUrl}/connections/${encodeURIComponent(connectionId)}/outbound-operations?${query}`,
      {
        credentials: "include",
        headers: createForwardedAuthHeaders(request, undefined, { readTargetContextName: "channels" }),
      },
    );
    if (response.status === 404) return { kind: "not-found" };
    if (!response.ok) return { kind: "read-error" };
    const body = (await response.json()) as Readonly<{
      log: OutboundOperationLogPage;
      summary: OutboundOperationSummary;
    }>;
    return {
      kind: "loaded",
      log: body.log,
      summary: body.summary,
      navigation: resolveOutboundOperationLogNavigation(position, body.log.nextCursor ?? null),
    };
  } catch {
    return { kind: "read-error" };
  }
}
