import { t } from "@chase-sets/localization";
import { readConnectionSetupLocations } from "../../../support/request-support/setup-locations";
import { OperationalStatusBanner, Stack } from "@chase-sets/design-system";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import {
  createForwardedAuthHeaders,
  defineFormAction,
  resolveRequestApiBaseUrl,
} from "@chase-sets/platform-runtime/http";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ActionFunctionArgs, ClientActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useNavigation } from "react-router";
import {
  ChannelConnectionDetailPage,
  ChannelConnectionListPage,
  ChannelConnectionSetupSection,
  type ConnectionSetupLocations,
  type ChannelConnectionAllowedAction,
} from "./connection-pages";
import { createConnectionSetupRequestApiClient } from "./setup-api-client";
import { createChannelsConnectionsRequestApiClient } from "../../../support/request-support/api-client";
import type { PublicChannelConnection } from "../domain/contracts";
import type { ManualSyncPanel } from "../../manual-sync/domain/contracts";
import { ManualSyncPanelView } from "../../manual-sync/ui/manual-sync-panel";
import type { OutboundOperationLogPage, OutboundOperationSummary } from "../../outbound-sync/domain/contracts";
import {
  readOutboundOperationLogPosition,
  resolveOutboundOperationLogNavigation,
  type OutboundOperationLogNavigation,
} from "../../outbound-sync/ui/operation-log-navigation";
import { OutboundOperationLogPanel } from "../../outbound-sync/ui/operation-log-panel";
import { ChannelConnectionHealthPanel } from "../../connection-attention/ui/health-panel";
import type { ChannelConnectionAttention } from "../../connection-attention/domain/contracts";
import type { ChannelDriftDecision, ChannelDriftDetail } from "../../reconciliation/domain/contracts";
import { ChannelDriftPanel, type DriftActionResult, type DriftSubmission } from "../../reconciliation/ui/drift-panel";

type AuxiliaryRead<T> = Readonly<{ kind: "loaded"; data: T }> | Readonly<{ kind: "read-error" }>;
type LoadedData = Readonly<{
  kind: "ready";
  connection: PublicChannelConnection;
  setupLocations: ConnectionSetupLocations;
  drift: ChannelDriftDetail;
  canManageDrift: boolean;
  loadIdentity: string;
  manualSync: AuxiliaryRead<ManualSyncPanel>;
  attention: AuxiliaryRead<ChannelConnectionAttention>;
  operationLog:
    | Readonly<{
        kind: "loaded";
        log: OutboundOperationLogPage;
        summary: OutboundOperationSummary;
        navigation: OutboundOperationLogNavigation;
      }>
    | Readonly<{ kind: "read-error" }>;
}>;
type RouteData = LoadedData | Readonly<{ kind: "not-found" }> | Readonly<{ kind: "loading" }>;
type ConnectionActionData =
  | Readonly<{ kind: "applied"; connection: PublicChannelConnection }>
  | Readonly<{ kind: "command-error"; message: string }>;
type ManualSyncActionError = Readonly<{ error: string }>;
type AttentionActionError = Readonly<{ kind: "attention-error"; error: string }>;

function required(value: string | undefined): string {
  if (!value) throw new Response("Not found", { status: 404 });
  return value;
}

export async function loader({ request, params }: LoaderFunctionArgs): Promise<RouteData> {
  const actor = await requireActorFromAuthApi({ request, permission: "channels.view" });
  const connectionId = required(params.connectionId);
  const connectionApi = createChannelsConnectionsRequestApiClient(request);
  const connection = await connectionApi.getConnection(connectionId);
  const position = readOutboundOperationLogPosition(new URL(request.url).searchParams);
  let setupLocations: ConnectionSetupLocations = { kind: "loaded", items: [] };
  if (connection.status === "pending-setup" && actor.permissions.includes("channels.manage")) {
    try {
      setupLocations = {
        kind: "loaded",
        items: await readConnectionSetupLocations(request),
      };
    } catch {
      setupLocations = { kind: "read-error" };
    }
  }
  const apiBaseUrl = resolveRequestApiBaseUrl(request, "/api/channels", { requireInternalApiOrigin: true });
  const query = new URLSearchParams({ limit: "50" });
  if (position.cursor !== null) query.set("cursor", position.cursor);
  const headers = createForwardedAuthHeaders(request, undefined, { readTargetContextName: "channels" });
  const driftCursor = new URL(request.url).searchParams.get("driftCursor");
  const [operationResult, manualSync, attention, drift] = await Promise.all([
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
    readAuxiliary<ChannelConnectionAttention>(
      fetch(`${apiBaseUrl}/connections/${encodeURIComponent(connectionId)}/attention`, {
        credentials: "include",
        headers,
      }),
    ),
    readAuxiliary<ChannelDriftDetail>(
      fetch(
        `${apiBaseUrl}/connections/${encodeURIComponent(connectionId)}/drift${driftCursor ? `?${new URLSearchParams({ cursor: driftCursor })}` : ""}`,
        { credentials: "include", headers },
      ),
    ),
  ]);
  let operationLog: LoadedData["operationLog"] = { kind: "read-error" };
  if (operationResult.kind === "loaded")
    operationLog = {
      kind: "loaded",
      log: operationResult.data.log,
      summary: operationResult.data.summary,
      navigation: resolveOutboundOperationLogNavigation(position, operationResult.data.log.nextCursor ?? null),
    };
  return {
    kind: "ready",
    connection,
    setupLocations,
    manualSync,
    attention,
    operationLog,
    drift: drift.kind === "loaded" ? drift.data : { kind: "unavailable" },
    canManageDrift: actor.permissions.includes("channels.manage"),
    loadIdentity: crypto.randomUUID(),
  };
}

async function readAuxiliary<T>(response: Promise<Response>): Promise<AuxiliaryRead<T>> {
  try {
    const resolved = await response;
    return resolved.ok ? { kind: "loaded", data: (await resolved.json()) as T } : { kind: "read-error" };
  } catch {
    return { kind: "read-error" };
  }
}

const connectionAction = defineFormAction({
  authorization: { permission: "channels.manage" },
  intents: {
    activate: async ({ request, params, formData }) => ({
      kind: "applied" as const,
      connection: await createConnectionSetupRequestApiClient(request).activate(
        required(params.connectionId),
        formData.getAll("storageLocationIds").map(String),
      ),
    }),
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

function driftSubmission(form: FormData, connectionId: string): DriftSubmission | null {
  const intent = String(form.get("intent") ?? "");
  if (intent !== "accept-drift" && intent !== "repush-drift") return null;
  const input = {
    connectionId,
    channelListingId: String(form.get("channelListingId") ?? ""),
    operationId: String(form.get("operationId") ?? ""),
    expectedDecisionRevision: Number(form.get("expectedDecisionRevision")),
  };
  return intent === "accept-drift"
    ? {
        intent,
        input: {
          ...input,
          observedFingerprint: String(form.get("observedFingerprint") ?? ""),
          expectedMaterialFingerprint: String(form.get("expectedMaterialFingerprint") ?? ""),
        },
      }
    : { intent, input };
}

export async function clientAction(args: ClientActionFunctionArgs) {
  const submission = driftSubmission(await args.request.clone().formData(), required(args.params.connectionId));
  try {
    return await args.serverAction<typeof action>();
  } catch (error) {
    if (error instanceof Response || !submission) throw error;
    return { kind: "drift-result", submission, outcome: "uncertain" } satisfies DriftActionResult;
  }
}

export async function action(
  args: ActionFunctionArgs,
): Promise<ConnectionActionData | ManualSyncActionError | AttentionActionError | DriftActionResult | Response> {
  const form = await args.request.clone().formData();
  const intent = String(form.get("intent") ?? "");
  if (["activate", "pause", "resume", "disconnect"].includes(intent)) return connectionAction(args);
  await requireActorFromAuthApi({ request: args.request, permission: "channels.manage" });
  const connectionId = required(args.params.connectionId);
  const apiBaseUrl = resolveRequestApiBaseUrl(args.request, "/api/channels", { requireInternalApiOrigin: true });
  const base = `${apiBaseUrl}/connections/${encodeURIComponent(connectionId)}/manual-sync`;
  const runId = encodeURIComponent(String(form.get("runId") ?? ""));
  const revision = encodeURIComponent(String(form.get("expectedRevision") ?? ""));
  const jsonHeaders = createForwardedAuthHeaders(args.request, { "content-type": "application/json" });
  if (intent === "accept-drift" || intent === "repush-drift") {
    const submission = driftSubmission(form, connectionId)!;
    const { connectionId: _connectionId, channelListingId: _channelListingId, ...body } = submission.input;
    try {
      const response = await fetch(
        `${apiBaseUrl}/connections/${encodeURIComponent(connectionId)}/drift/${encodeURIComponent(submission.input.channelListingId)}/${intent === "accept-drift" ? "accept" : "repush"}`,
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify(body),
        },
      );
      return {
        kind: "drift-result",
        submission,
        outcome: response.ok
          ? "committed"
          : response.status === 409
            ? "conflict"
            : response.status >= 500
              ? "uncertain"
              : "refused",
        ...(response.ok ? { decision: (await response.json()) as ChannelDriftDecision } : {}),
      };
    } catch {
      return { kind: "drift-result", submission, outcome: "uncertain" };
    }
  }
  if (intent === "resolve-attention") {
    const resolved = await fetch(`${apiBaseUrl}/connections/${encodeURIComponent(connectionId)}/attention/resolve`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({
        reasonCode: String(form.get("reasonCode") ?? ""),
        generation: Number(form.get("generation")),
        resolutionReason: String(form.get("resolutionReason") ?? ""),
      }),
    });
    return resolved.ok
      ? redirect(new URL(args.request.url).pathname)
      : { kind: "attention-error", error: t("channels.attention.failed") };
  }
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
  return response.ok
    ? redirect(new URL(args.request.url).pathname)
    : { error: t("channels.manualSync.action.failed.description") };
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
    { method: "POST", headers: createForwardedAuthHeaders(request) },
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
  if (data.kind === "not-found") return <ChannelConnectionDetailPage state={{ kind: "not-found" }} />;
  if (data.kind === "loading") return <ChannelConnectionListPage state={{ kind: "loading" }} />;
  const connection = isAppliedConnectionAction(actionData) ? actionData.connection : data.connection;
  const actionError = readActionError(actionData);
  return (
    <ChannelConnectionDetailPage
      state={
        isConnectionActionError(actionData)
          ? { kind: "command-error", connection, message: actionData.message }
          : { kind: "ready", connection }
      }
      pendingIntent={pendingIntent}
    >
      {connection.status === "pending-setup" && data.canManageDrift ? (
        <ChannelConnectionSetupSection
          key={connection.connectionId}
          locations={data.setupLocations}
          pending={navigation.state !== "idle"}
        />
      ) : null}
      <Stack gap={4}>
        <ChannelDriftPanel
          key={connection.connectionId}
          connectionId={connection.connectionId}
          detail={data.drift}
          canManage={data.canManageDrift}
          loadIdentity={data.loadIdentity}
          loading={navigation.state !== "idle"}
        />
        <ChannelConnectionHealthPanel
          state={navigation.state === "loading" ? { kind: "loading" } : data.attention}
          pending={navigation.state === "submitting"}
        />
        {actionError ? (
          <OperationalStatusBanner
            tone="danger"
            title={
              actionData && "kind" in actionData && actionData.kind === "attention-error"
                ? t("channels.attention.action.failed")
                : t("channels.manualSync.action.failed")
            }
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
    </ChannelConnectionDetailPage>
  );
}
function isConnectionActionError(value: unknown): value is Readonly<{ kind: "command-error"; message: string }> {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "command-error" &&
    "message" in value &&
    typeof value.message === "string"
  );
}
function isAppliedConnectionAction(
  value: unknown,
): value is Readonly<{ kind: "applied"; connection: PublicChannelConnection }> {
  return (
    typeof value === "object" && value !== null && "kind" in value && value.kind === "applied" && "connection" in value
  );
}
