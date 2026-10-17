import { t } from "@chase-sets/localization";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { navigateAfterWrite } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import { listConnectableChannelProviders } from "../../features/connections/api/providers";
import { createConnectionSetupRequestApiClient } from "../../features/connections/ui/setup-api-client";
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
  const actor = await requireActorFromAuthApi({ request, permission: "channels.view" });
  const providers = actor.permissions.includes("channels.manage") ? await listConnectableChannelProviders() : [];
  const url = new URL(request.url);
  const statusFilter = statusFilterFromUrl(url);
  const cursor = url.searchParams.get("cursor") ?? undefined;
  try {
    const page = await createChannelsConnectionsRequestApiClient(request).listConnections({
      ...(statusFilter === "default" ? {} : { status: statusFilter }),
      ...(cursor ? { cursor } : {}),
    });
    return { kind: "ready" as const, page, statusFilter, providers };
  } catch (error) {
    if (error instanceof ChannelsConnectionsApiError) {
      return { kind: "error" as const, message: error.message };
    }
    throw error;
  }
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "channels.manage" });
  const form = await request.formData();
  try {
    const connection = await createConnectionSetupRequestApiClient(request).connect(
      String(form.get("providerKey") ?? ""),
    );
    return redirect(navigateAfterWrite(connection, `/account/channels/${encodeURIComponent(connection.connectionId)}`));
  } catch (error) {
    return { message: error instanceof Error ? error.message : t("channels.connections.action.failed") };
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
  const actionData = useActionData<typeof action>();
  if (navigation.state === "loading") {
    return <ChannelConnectionListPage state={{ kind: "loading" }} />;
  }
  if (data.kind === "error") {
    return <ChannelConnectionListPage state={{ kind: "error", message: data.message }} />;
  }
  return (
    <ChannelConnectionListPage
      providers={data.providers}
      connecting={navigation.state === "submitting"}
      connectError={actionData?.message}
      state={{
        kind: "ready",
        connections: data.page.items,
        statusFilter: data.statusFilter,
        nextCursor: data.page.nextCursor,
      }}
    />
  );
}
