import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { createForwardedAuthHeaders } from "@chase-sets/platform-runtime/http";
import {
  ActionBar,
  Badge,
  Button,
  DataTable,
  DetailPanel,
  Grid,
  Inline,
  KeyValueList,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Stat,
  StatGrid,
  Surface,
  Text,
} from "@chase-sets/design-system";
import { requireIdentityAdminActor } from "../auth.server";

type ProjectionState = "idle" | "running" | "caught-up" | "degraded" | "error";

type ProjectionGroupStatus = Readonly<{
  projectionName: string;
  projectionRevision: number;
  storedProjectionRevision: number | null;
  revisionStale: boolean;
  targetContextName: string;
  sourceContextNames: readonly string[];
  ownedTables: readonly string[];
  requiredDuringBootstrap: boolean;
  initialized: boolean;
  caughtUp: boolean;
  state: ProjectionState;
  lastError: string | null;
  blockedStreamCount: number;
  poisonEventCount: number;
  updatedAt: string;
  subscriptions: readonly ProjectionSubscriptionStatus[];
}>;

type ProjectionSubscriptionStatus = Readonly<{
  checkpointKey: string;
  subscriptionName: string;
  projectionName: string;
  sourceContextName: string;
  targetContextName: string;
  subscriptionVersion: number;
  lastGlobalPosition: string;
  sourceHeadGlobalPosition: string;
  state: ProjectionState;
  lastError: string | null;
  blockedStreamCount: number;
  poisonEventCount: number;
}>;

type BlockedProjectionDetails = Readonly<{
  projectionKey: string;
  blockedStreams: readonly BlockedStream[];
  poisonEvents: readonly PoisonEvent[];
}>;

type BlockedStream = Readonly<{
  projectionKey: string;
  streamId: string;
  firstBlockedGlobalPosition: string;
  firstBlockedStreamVersion: number;
  lastSeenGlobalPosition: string;
  deferredEventCount: number;
  state: string;
}>;

type PoisonEvent = Readonly<{
  eventId: string;
  eventType: string;
  streamId: string;
  streamVersion: number;
  globalPosition: string;
  errorMessage: string;
  retryCount: number;
  firstSeenAt: string;
  lastSeenAt: string;
  state: string;
}>;

type ProjectionOperationsSnapshot = Readonly<{
  summary: Readonly<{
    status: "ok" | "degraded";
    totalGroups: number;
    caughtUpGroups: number;
    behindGroups: number;
    staleGroups: number;
    runningGroups: number;
    errorGroups: number;
  }>;
  projectionGroups: readonly ProjectionGroupStatus[];
  blockedProjections: readonly BlockedProjectionDetails[];
  workers: readonly Record<string, unknown>[];
  runners: readonly Record<string, unknown>[];
}>;

export const meta: MetaFunction = () => [{ title: "Projection Operations | Chase Sets Admin" }];

export async function loader({ request }: LoaderFunctionArgs) {
  await requireIdentityAdminActor(request);
  const response = await fetch(resolveApiUrl(request), {
    headers: createForwardedAuthHeaders(request),
  });

  if (!response.ok) {
    throw new Response(await response.text(), { status: response.status });
  }

  return (await response.json()) as ProjectionOperationsSnapshot;
}

export async function action({ request }: ActionFunctionArgs) {
  await requireIdentityAdminActor(request);
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");

  if (intent === "retry-stream") {
    await postProjectionOperation(request, [
      String(formData.get("projectionKey") ?? ""),
      "blocked-streams",
      String(formData.get("streamId") ?? ""),
      "retry",
    ]);
  } else if (intent === "rebuild-group") {
    await postProjectionOperation(
      request,
      ["groups", String(formData.get("contextName") ?? ""), String(formData.get("projectionName") ?? ""), "rebuild"],
      { confirm: "rebuild" },
    );
  } else if (intent === "rebuild-context") {
    await postProjectionOperation(request, ["groups", String(formData.get("contextName") ?? ""), "rebuild"], {
      confirm: "rebuild-all",
    });
  }

  return redirect("/operations/projections");
}

export default function ProjectionOperationsRoute() {
  const data = useLoaderData<typeof loader>();
  const blockedRows = data.blockedProjections.flatMap((projection) =>
    projection.blockedStreams.map((stream) => ({ ...stream, projectionKey: projection.projectionKey })),
  );

  return (
    <Page>
      <PageHeader
        eyebrow="Operations"
        title="Projection Operations"
        description="Monitor projection catch-up, inspect poisoned streams, and run targeted repair."
      />
      <ActionBar>
        <LinkButton href="/catalog/dimensions" tone="secondary">
          Catalog
        </LinkButton>
        <LinkButton href="/identity/accounts" tone="secondary">
          Identity
        </LinkButton>
      </ActionBar>

      <StatGrid columns={{ base: 1, md: 4 }}>
        <Stat label="Status" value={data.summary.status} />
        <Stat label="Projection Groups" value={data.summary.totalGroups} />
        <Stat label="Caught Up" value={data.summary.caughtUpGroups} />
        <Stat label="Blocked Streams" value={blockedRows.length} />
      </StatGrid>

      <Grid columns={{ base: 1, xl: 2 }} gap={4}>
        <PageSection title="Projection Groups">
          <DataTable<ProjectionGroupStatus>
            columns={[
              {
                key: "projection",
                header: "Projection",
                cell: (group) => (
                  <Stack gap={1}>
                    <Text weight="semibold">{group.projectionName}</Text>
                    <Text size="sm" tone="secondary">
                      {group.targetContextName}
                    </Text>
                  </Stack>
                ),
              },
              {
                key: "state",
                header: "State",
                cell: (group) => <Badge tone={stateTone(group.state)}>{group.state}</Badge>,
              },
              {
                key: "lag",
                header: "Issues",
                cell: (group) => `${group.blockedStreamCount} blocked / ${group.poisonEventCount} poison`,
              },
              {
                key: "revision",
                header: "Revision",
                cell: (group) =>
                  group.revisionStale
                    ? `stale ${group.storedProjectionRevision ?? "none"} -> ${group.projectionRevision}`
                    : String(group.projectionRevision),
              },
              {
                key: "actions",
                header: "Actions",
                cell: (group) => (
                  <Inline gap={2}>
                    <form method="post">
                      <input type="hidden" name="intent" value="rebuild-group" readOnly />
                      <input type="hidden" name="contextName" value={group.targetContextName} readOnly />
                      <input type="hidden" name="projectionName" value={group.projectionName} readOnly />
                      <Button type="submit" tone="secondary" size="sm" leadingIcon="refreshCcw">
                        Rebuild
                      </Button>
                    </form>
                  </Inline>
                ),
              },
            ]}
            rows={[...data.projectionGroups]}
            getRowId={(group) => `${group.targetContextName}:${group.projectionName}`}
            emptyTitle="No projection groups"
            emptyDescription="This runtime has no projection groups mounted."
          />
        </PageSection>

        <PageSection title="Worker Runners">
          <DataTable<Record<string, unknown>>
            columns={[
              { key: "runner_name", header: "Runner", cell: (row) => String(row.runner_name ?? row.worker_id ?? "") },
              { key: "kind", header: "Kind", cell: (row) => String(row.runner_kind ?? row.worker_kind ?? "") },
              {
                key: "state",
                header: "State",
                cell: (row) => (
                  <Badge tone={stateTone(String(row.state ?? "idle"))}>{String(row.state ?? "active")}</Badge>
                ),
              },
              {
                key: "updated",
                header: "Updated",
                cell: (row) => formatDate(String(row.updated_at ?? row.heartbeat_at ?? "")),
              },
            ]}
            rows={[...data.runners, ...data.workers]}
            getRowId={(row, index) => String(row.runner_name ?? row.worker_id ?? index)}
            emptyTitle="No workers"
            emptyDescription="No worker heartbeat or runner status has been recorded."
          />
        </PageSection>
      </Grid>

      <PageSection title="Blocked Streams">
        <DataTable<BlockedStream>
          columns={[
            { key: "projection", header: "Projection Key", cell: (row) => row.projectionKey },
            { key: "stream", header: "Stream", cell: (row) => row.streamId },
            { key: "version", header: "First Version", cell: (row) => row.firstBlockedStreamVersion },
            {
              key: "position",
              header: "Positions",
              cell: (row) => `${row.firstBlockedGlobalPosition} -> ${row.lastSeenGlobalPosition}`,
            },
            { key: "deferred", header: "Deferred", cell: (row) => row.deferredEventCount },
            {
              key: "action",
              header: "Action",
              cell: (row) => (
                <form method="post">
                  <input type="hidden" name="intent" value="retry-stream" readOnly />
                  <input type="hidden" name="projectionKey" value={row.projectionKey} readOnly />
                  <input type="hidden" name="streamId" value={row.streamId} readOnly />
                  <Button type="submit" size="sm" leadingIcon="refreshCcw">
                    Retry
                  </Button>
                </form>
              ),
            },
          ]}
          rows={blockedRows}
          getRowId={(row) => `${row.projectionKey}:${row.streamId}`}
          emptyTitle="No blocked streams"
          emptyDescription="No stream-isolated projection errors are currently active."
        />
      </PageSection>

      <Grid columns={{ base: 1, xl: 2 }} gap={4}>
        {data.blockedProjections.map((projection) => (
          <Surface key={projection.projectionKey} elevated>
            <DetailPanel title={projection.projectionKey}>
              <Stack gap={3}>
                <KeyValueList
                  items={[
                    { key: "Blocked streams", value: projection.blockedStreams.length },
                    { key: "Poison events", value: projection.poisonEvents.length },
                  ]}
                />
                {projection.poisonEvents.map((event) => (
                  <Surface key={`${event.eventId}:${event.retryCount}`} tone="subtle">
                    <Stack gap={2}>
                      <Inline gap={2}>
                        <Badge tone={stateTone(event.state)}>{event.state}</Badge>
                        <Text weight="semibold">{event.eventType}</Text>
                      </Inline>
                      <Text size="sm">{event.errorMessage}</Text>
                      <KeyValueList
                        items={[
                          { key: "Event", value: event.eventId },
                          { key: "Stream", value: event.streamId },
                          { key: "Position", value: event.globalPosition },
                          { key: "Retries", value: event.retryCount },
                          { key: "Last seen", value: formatDate(event.lastSeenAt) },
                        ]}
                      />
                    </Stack>
                  </Surface>
                ))}
              </Stack>
            </DetailPanel>
          </Surface>
        ))}
      </Grid>
    </Page>
  );
}

function stateTone(state: string) {
  switch (state) {
    case "caught-up":
    case "resolved":
    case "ok":
      return "success" as const;
    case "running":
    case "retrying":
      return "accent" as const;
    case "degraded":
    case "blocked":
      return "warning" as const;
    case "error":
      return "danger" as const;
    default:
      return "neutral" as const;
  }
}

function resolveApiUrl(request: Request) {
  return new URL("/api/platform/projections", request.url);
}

async function postProjectionOperation(
  request: Request,
  segments: readonly string[],
  body: Record<string, unknown> = {},
) {
  const url = resolveApiUrl(request);
  for (const segment of segments) {
    url.pathname = `${url.pathname.replace(/\/$/, "")}/${encodeURIComponent(segment)}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers: createForwardedAuthHeaders(request, {
      "content-type": "application/json",
    }),
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Response(await response.text(), { status: response.status });
  }
}

function formatDate(value: string) {
  if (!value) {
    return "Not recorded";
  }

  return new Date(value).toLocaleString();
}
