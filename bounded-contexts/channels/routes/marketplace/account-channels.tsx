import { t } from "@chase-sets/localization";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useLoaderData, useNavigation } from "react-router";
import { ChannelConnectionListPage } from "../../features/connections/ui/connection-pages";
import {
  channelConnectionStatuses,
  type ChannelConnectionStatus,
  ChannelsConnectionsApiError,
  createChannelsConnectionsRequestApiClient,
} from "../../support/request-support/api-client";

function statusFilterFromUrl(url: URL): ChannelConnectionStatus | "default" {
  const status = url.searchParams.get("status");
  return status !== null && (channelConnectionStatuses as readonly string[]).includes(status)
    ? (status as ChannelConnectionStatus)
    : "default";
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "channels.view" });
  const url = new URL(request.url);
  const statusFilter = statusFilterFromUrl(url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  try {
    const page = await createChannelsConnectionsRequestApiClient(request).listConnections({
      ...(statusFilter === "default" ? {} : { status: statusFilter }),
      ...(cursor ? { cursor } : {}),
    });
    return { kind: "ready" as const, page, statusFilter };
  } catch (error) {
    if (error instanceof ChannelsConnectionsApiError) {
      return { kind: "error" as const, message: error.message };
    }
    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("channels.connections.meta.title"),
    description: t("channels.connections.meta.description"),
  });

export default function AccountChannelsRoute() {
  const data = useLoaderData<typeof loader>();
  const navigation = useNavigation();
  if (navigation.state === "loading") {
    return <ChannelConnectionListPage state={{ kind: "loading" }} />;
  }
  if (data.kind === "error") {
    return <ChannelConnectionListPage state={{ kind: "error", message: data.message }} />;
  }
  return (
    <ChannelConnectionListPage
      state={{
        kind: "ready",
        connections: data.page.items,
        statusFilter: data.statusFilter,
        nextCursor: data.page.nextCursor,
      }}
    />
  );
}
