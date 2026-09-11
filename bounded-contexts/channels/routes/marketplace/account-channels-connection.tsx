import { t } from "@chase-sets/localization";
import { OperationalStatusBanner, PageSection, Stack } from "@chase-sets/design-system";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  createForwardedAuthHeaders,
  defineFormAction,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import {
  ChannelConnectionDetailPage,
  type ChannelConnectionAllowedAction,
} from "../../features/connections/ui/connection-pages";
import {
  ChannelsConnectionsApiError,
  createChannelsConnectionsRequestApiClient,
} from "../../support/request-support/api-client";
import type { PublicChannelConnection } from "../../features/connections/domain/contracts";
import type { ManualSyncPanel } from "../../features/manual-sync/domain/contracts";
import { ManualSyncPanelView } from "../../features/manual-sync/ui/manual-sync-panel";
import type { OutboundOperationLogPage, OutboundOperationSummary } from "../../features/outbound-sync/domain/contracts";
import {
  readOutboundOperationLogPosition,
  resolveOutboundOperationLogNavigation,
  type OutboundOperationLogNavigation,
} from "../../features/outbound-sync/ui/operation-log-navigation";
import { OutboundOperationLogPanel } from "../../features/outbound-sync/ui/operation-log-panel";

type LoadedData = Readonly<{
  kind: "ready";
  connection: PublicChannelConnection;
  manualSync: AuxiliaryRead<ManualSyncPanel>;
  operationLog:
    | Readonly<{
        kind: "loaded";
        log: OutboundOperationLogPage;
        summary: OutboundOperationSummary;
        navigation: OutboundOperationLogNavigation;
      }>
    | Readonly<{ kind: "read-error" }>;
}>;

type RouteData = LoadedData | Readonly<{ kind: "not-found" }>;
type AuxiliaryRead<T> = Readonly<{ kind: "loaded"; data: T }> | Readonly<{ kind: "read-error" }>;

function required(value: string | undefined): string {
  if (!value) throw new Response("Not found", { status: 404 });
  return value;
}

export async function loader({ request, params }: LoaderFunctionArgs): Promise<RouteData> {
  await requireActorFromAuthApi({ request, permission: "channels.view" });
  const connectionId = required(params.connectionId);
  const connectionApi = createChannelsConnectionsRequestApiClient(request);
  let connection: Awaited<ReturnType<typeof connectionApi.getConnection>>;
  try {
    connection = await connectionApi.getConnection(connectionId);
  } catch (error) {
    if (error instanceof ChannelsConnectionsApiError && error.status === 404) {
      return { kind: "not-found" };
    }
    throw error;
  }

  const position = readOutboundOperationLogPosition(new URL(request.url).searchParams);
  const apiBaseUrl = resolveRequestApiBaseUrl(request, "/api/channels", { requireInternalApiOrigin: true });
  const query = new URLSearchParams({ limit: "50" });
  if (position.cursor !== null) query.set("cursor", position.cursor);
  const headers = createForwardedAuthHeaders(request, undefined, { readTargetContextName: "channels" });
  const [operationResult, manualSync] = await Promise.all([
    readAuxiliary<Readonly<{ log: OutboundOperationLogPage; summary: OutboundOperationSummary }>>(
      fetch(`${apiBaseUrl}/connections/${encodeURIComponent(connectionId)}/outbound-operations?${query}`, {
        credentials: "include",
        headers,
      }),
    ),
    readAuxiliary<ManualSyncPanel>(
      fetch(`${apiBaseUrl}/connections/${encodeURIComponent(connectionId)}/manual-sync`, {
        credentials: "include",
        headers,
      }),
    ),
  ]);
  // The connection read above is the authority for account isolation and not-found.
  // Auxiliary surfaces may be unavailable without hiding the canonical connection page.

  let operationLog: LoadedData["operationLog"] = { kind: "read-error" };
  if (operationResult.kind === "loaded") {
    const body = operationResult.data;
    operationLog = {
      kind: "loaded",
      log: body.log,
      summary: body.summary,
      navigation: resolveOutboundOperationLogNavigation(position, body.log.nextCursor ?? null),
    };
  }
  return { kind: "ready", connection, manualSync, operationLog };
}

async function readAuxiliary<T>(response: Promise<Response>): Promise<AuxiliaryRead<T>> {
  try {
    const resolved = await response;
    if (!resolved.ok) return { kind: "read-error" };
    return { kind: "loaded", data: (await resolved.json()) as T };
  } catch {
    return { kind: "read-error" };
  }
}

const connectionAction = defineFormAction({
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

export async function action(args: ActionFunctionArgs) {
  const form = await args.request.clone().formData();
  const intent = String(form.get("intent") ?? "");
  if (["pause", "resume", "disconnect"].includes(intent)) return connectionAction(args);

  await requireActorFromAuthApi({ request: args.request, permission: "channels.manage" });
  const connectionId = required(args.params.connectionId);
  const apiBaseUrl = resolveRequestApiBaseUrl(args.request, "/api/channels", { requireInternalApiOrigin: true });
  const base = `${apiBaseUrl}/connections/${encodeURIComponent(connectionId)}/manual-sync`;
  const runId = encodeURIComponent(String(form.get("runId") ?? ""));
  const revision = encodeURIComponent(String(form.get("expectedRevision") ?? ""));
  const jsonHeaders = createForwardedAuthHeaders(args.request, { "content-type": "application/json" });
  const emptyHeaders = createForwardedAuthHeaders(args.request);
  let response: Response;
  if (intent === "compose") response = await fetch(`${base}/compose`, { method: "POST", headers: emptyHeaders });
  else if (intent === "retry-clamp")
    response = await fetch(`${base}/runs/${runId}/retry-clamp?expectedRevision=${revision}`, {
      method: "POST",
      headers: emptyHeaders,
    });
  else if (intent === "release" || intent === "validation-cancelled")
    response = await fetch(`${base}/runs/${runId}/${intent}?expectedRevision=${revision}`, {
      method: "POST",
      headers: emptyHeaders,
    });
  else if (intent === "upload-attempt")
    response = await fetch(`${base}/runs/${runId}/upload-attempt`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        expectedRevision: Number(form.get("expectedRevision")),
        uploadAttemptedAt: new Date().toISOString(),
        fileName: String(form.get("fileName") ?? ""),
      }),
    });
  else if (intent === "ingest") {
    const upload = new FormData();
    const file = form.get("export");
    if (typeof file !== "string" && file) upload.set("export", file);
    response = await fetch(`${base}/ingest?surface=${encodeURIComponent(String(form.get("surface") ?? ""))}`, {
      method: "POST",
      headers: createForwardedAuthHeaders(args.request, { "x-channel-export-captured-at": new Date().toISOString() }),
      body: upload,
    });
  } else if (intent === "verify")
    response = await fetch(`${base}/runs/${runId}/verify`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        expectedRevision: Number(form.get("expectedRevision")),
        verificationSnapshotId: String(form.get("verificationSnapshotId") ?? ""),
        importSummary: {
          fileName: String(form.get("fileName") ?? ""),
          dateImportedText: String(form.get("dateImportedText") ?? ""),
          numberOfProducts: Number(form.get("numberOfProducts")),
          recordedAt: new Date().toISOString(),
        },
      }),
    });
  else return { error: t("channels.manualSync.action.invalid") };
  if (!response.ok) return { error: t("channels.manualSync.action.failed.description") };
  return redirect(new URL(args.request.url).pathname);
}

export async function downloadAction({ request, params }: ActionFunctionArgs): Promise<Response> {
  await requireActorFromAuthApi({ request, permission: "channels.manage" });
  const connectionId = encodeURIComponent(required(params.connectionId));
  const form = await request.formData();
  const runId = encodeURIComponent(String(form.get("runId") ?? ""));
  const revision = encodeURIComponent(String(form.get("expectedRevision") ?? ""));
  const apiBaseUrl = resolveRequestApiBaseUrl(request, "/api/channels", { requireInternalApiOrigin: true });
  return fetch(
    `${apiBaseUrl}/connections/${connectionId}/manual-sync/runs/${runId}/download?expectedRevision=${revision}`,
    {
      method: "POST",
      headers: createForwardedAuthHeaders(request),
    },
  );
}

export function readActionError(value: unknown): string | null {
  return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
    ? value.error
    : null;
}

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
  const actionError = readActionError(actionData);
  return (
    <ChannelConnectionDetailPage state={{ kind: "ready", connection }} pendingIntent={pendingIntent}>
      <PageSection title={t("channels.manualSync.title")}>
        <Stack gap={4}>
          {actionError ? (
            <OperationalStatusBanner
              tone="danger"
              title={t("channels.manualSync.action.failed")}
              description={actionError}
            />
          ) : null}
          {data.manualSync.kind === "loaded" ? <ManualSyncPanelView panel={data.manualSync.data} /> : null}
          {data.manualSync.kind === "read-error" ? (
            <OperationalStatusBanner
              tone="danger"
              title={t("channels.manualSync.error.title")}
              description={t("channels.manualSync.error.description")}
            />
          ) : null}
          {data.operationLog.kind === "loaded" ? (
            <OutboundOperationLogPanel
              state={{
                kind: "loaded",
                log: data.operationLog.log,
                summary: data.operationLog.summary,
                navigation: data.operationLog.navigation,
              }}
            />
          ) : (
            <OutboundOperationLogPanel state={{ kind: "read-error" }} />
          )}
        </Stack>
      </PageSection>
    </ChannelConnectionDetailPage>
  );
}
