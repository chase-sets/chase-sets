import { t } from "@chase-sets/localization";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { defineFormAction } from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { LoaderFunctionArgs, MetaFunction } from "react-router";
import { useActionData, useLoaderData, useNavigation } from "react-router";
import { OutboundOperationLogPanel } from "../../features/outbound-sync/ui/operation-log-panel";
import { loadOutboundOperationLog } from "../../features/outbound-sync/ui/operation-log-loader";
import {
  ChannelConnectionDetailPage,
  type ChannelConnectionAllowedAction,
} from "../../features/connections/ui/connection-pages";
import {
  ChannelsConnectionsApiError,
  createChannelsConnectionsRequestApiClient,
} from "../../support/request-support/api-client";

function required(value: string | undefined): string {
  if (!value) throw new Response("Not found", { status: 404 });
  return value;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "channels.view" });
  const connectionId = required(params.connectionId);
  try {
    const connection = await createChannelsConnectionsRequestApiClient(request).getConnection(connectionId);
    const outbound = await loadOutboundOperationLog({ request, params });
    if (outbound.kind === "not-found") return { kind: "not-found" as const };
    return { kind: "ready" as const, connection, outbound };
  } catch (error) {
    if (error instanceof ChannelsConnectionsApiError && error.status === 404) {
      return { kind: "not-found" as const };
    }
    throw error;
  }
}

export const action = defineFormAction({
  authorization: { permission: "channels.manage" },
  intents: {
    pause: async ({ request, params }) => ({
      kind: "applied" as const,
      connection: await createChannelsConnectionsRequestApiClient(request).pauseConnection(
        required(params.connectionId),
      ),
    }),
    resume: async ({ request, params }) => ({
      kind: "applied" as const,
      connection: await createChannelsConnectionsRequestApiClient(request).resumeConnection(
        required(params.connectionId),
      ),
    }),
    disconnect: async ({ request, params }) => ({
      kind: "applied" as const,
      connection: await createChannelsConnectionsRequestApiClient(request).disconnectConnection(
        required(params.connectionId),
      ),
    }),
  },
  onUnknownIntent: () => ({ kind: "command-error" as const, message: t("channels.connections.action.unknown") }),
  onError: (error) => ({
    kind: "command-error" as const,
    message: error instanceof Error ? error.message : t("channels.connections.action.failed"),
  }),
});

export const meta: MetaFunction = () => buildOpenGraphMeta({ title: t("channels.connections.connection.meta.title") });

export default function AccountChannelsConnectionRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const pendingIntent =
    navigation.state === "submitting"
      ? ((navigation.formData?.get("intent") as ChannelConnectionAllowedAction | null) ?? null)
      : null;

  if (data.kind === "not-found") {
    return <ChannelConnectionDetailPage state={{ kind: "not-found" }} />;
  }
  if (actionData?.kind === "command-error") {
    return (
      <ChannelConnectionDetailPage
        state={{
          kind: "command-error",
          message: actionData.message ?? t("channels.connections.action.failed"),
          connection: data.connection,
        }}
      />
    );
  }
  const connection = actionData?.kind === "applied" ? actionData.connection : data.connection;
  return (
    <ChannelConnectionDetailPage state={{ kind: "ready", connection }} pendingIntent={pendingIntent}>
      <OutboundOperationLogPanel
        state={
          data.outbound.kind === "loaded"
            ? {
                kind: "loaded",
                log: data.outbound.log,
                summary: data.outbound.summary,
                navigation: data.outbound.navigation,
              }
            : { kind: "read-error" }
        }
      />
    </ChannelConnectionDetailPage>
  );
}
