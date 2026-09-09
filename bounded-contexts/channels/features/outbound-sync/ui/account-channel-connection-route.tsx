import { t } from "@chase-sets/localization";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData } from "react-router";
import type { PublicChannelConnection } from "../../connections/domain/contracts";
import type { OutboundOperationLogPage, OutboundOperationSummary } from "../domain/contracts";
import {
  readOutboundOperationLogPosition,
  resolveOutboundOperationLogNavigation,
  type OutboundOperationLogNavigation,
} from "./operation-log-navigation";
import { OutboundOperationLogPanel } from "./operation-log-panel";

type LoadedData = Readonly<{
  kind: "loaded";
  connection: PublicChannelConnection;
  log: OutboundOperationLogPage;
  summary: OutboundOperationSummary;
  navigation: OutboundOperationLogNavigation;
}>;

type RouteData = LoadedData | Readonly<{ kind: "read-error" }>;

export async function loader({ request, params }: LoaderFunctionArgs): Promise<RouteData> {
  await requireActorFromAuthApi({ request, permission: "channels.view" });
  const connectionId = String(params.connectionId ?? "");
  const position = readOutboundOperationLogPosition(new URL(request.url).searchParams);
  const apiBaseUrl = resolveRequestApiBaseUrl(request, "/api/channels", { requireInternalApiOrigin: true });
  const query = new URLSearchParams({ limit: "50" });
  if (position.cursor !== null) query.set("cursor", position.cursor);

  let response: Response;
  try {
    response = await fetch(
      `${apiBaseUrl}/connections/${encodeURIComponent(connectionId)}/outbound-operations?${query}`,
      {
        credentials: "include",
        headers: createForwardedAuthHeaders(request, undefined, { readTargetContextName: "channels" }),
      },
    );
  } catch {
    return { kind: "read-error" };
  }
  if (response.status === 404) {
    throw new Response(t("channels.outboundSync.connection.notFound"), { status: 404 });
  }
  if (!response.ok) return { kind: "read-error" };
  const body = (await response.json()) as Omit<LoadedData, "kind" | "navigation">;
  return {
    kind: "loaded",
    connection: body.connection,
    log: body.log,
    summary: body.summary,
    navigation: resolveOutboundOperationLogNavigation(position, body.log.nextCursor ?? null),
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("channels.outboundSync.connection.title"),
    description: t("channels.outboundSync.operationLog.description"),
  });

export default function AccountChannelConnectionRoute() {
  const data = useLoaderData<typeof loader>();
  return (
    <OutboundOperationLogPanel
      state={
        data.kind === "loaded"
          ? { kind: "loaded", log: data.log, summary: data.summary, navigation: data.navigation }
          : { kind: "read-error" }
      }
    />
  );
}
