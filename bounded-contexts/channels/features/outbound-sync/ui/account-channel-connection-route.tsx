import { t } from "@chase-sets/localization";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { createForwardedAuthHeaders, resolveRequestApiBaseUrl } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useNavigate } from "react-router";
import type { PublicChannelConnection } from "../../connections/domain/contracts";
import type { OutboundOperationLogPage, OutboundOperationSummary } from "../domain/contracts";
import { OutboundOperationLogPanel } from "./operation-log-panel";

type LoadedData = Readonly<{
  kind: "loaded";
  connection: PublicChannelConnection;
  log: OutboundOperationLogPage;
  summary: OutboundOperationSummary;
  page: number;
  nextCursor: string | null;
}>;

type RouteData = LoadedData | Readonly<{ kind: "read-error"; page: number; nextCursor: null }>;

export async function loader({ request, params }: LoaderFunctionArgs): Promise<RouteData> {
  await requireActorFromAuthApi({ request, permission: "channels.view" });
  const connectionId = String(params.connectionId ?? "");
  const requestUrl = new URL(request.url);
  const cursor = requestUrl.searchParams.get("cursor");
  const page = positivePage(requestUrl.searchParams.get("page"));
  const apiBaseUrl = resolveRequestApiBaseUrl(request, "/api/channels", { requireInternalApiOrigin: true });
  const query = new URLSearchParams({ limit: "50" });
  if (cursor) query.set("cursor", cursor);

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
    return { kind: "read-error", page, nextCursor: null };
  }
  if (response.status === 404) {
    throw new Response(t("channels.outboundSync.connection.notFound"), { status: 404 });
  }
  if (!response.ok) return { kind: "read-error", page, nextCursor: null };
  const body = (await response.json()) as Omit<LoadedData, "kind" | "page" | "nextCursor">;
  return {
    kind: "loaded",
    connection: body.connection,
    log: body.log,
    summary: body.summary,
    page,
    nextCursor: body.log.nextCursor ?? null,
  };
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("channels.outboundSync.connection.title"),
    description: t("channels.outboundSync.operationLog.description"),
  });

export default function AccountChannelConnectionRoute() {
  const data = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  return (
    <OutboundOperationLogPanel
      state={data.kind === "loaded" ? { kind: "loaded", log: data.log, summary: data.summary } : { kind: "read-error" }}
      page={data.page}
      onPageChange={(nextPage) => {
        if (nextPage > data.page && data.nextCursor) {
          navigate(`?page=${nextPage}&cursor=${encodeURIComponent(data.nextCursor)}`);
        } else if (nextPage < data.page) {
          navigate("?page=1");
        }
      }}
    />
  );
}

function positivePage(value: string | null): number {
  const page = Number(value ?? 1);
  return Number.isSafeInteger(page) && page >= 1 ? page : 1;
}
