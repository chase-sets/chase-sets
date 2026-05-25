import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useLoaderData } from "react-router";
import { createForwardedAuthHeaders } from "@chase-sets/platform-runtime/http";
import { t } from "@chase-sets/localization";
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
  outstandingEventCount: string;
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
  outstandingEventCount: string;
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
    outstandingEventCount: string;
  }>;
  projectionGroups: readonly ProjectionGroupStatus[];
  blockedProjections: readonly BlockedProjectionDetails[];
  workers: readonly Record<string, unknown>[];
  runners: readonly Record<string, unknown>[];
}>;

const routeKey = "adminWeb.app.routes.projectionOperations";

type ProjectionSubscriptionRow = ProjectionSubscriptionStatus &
  Readonly<{
    projectionGroupName: string;
  }>;

export const meta: MetaFunction = () => [{ title: t(`${routeKey}.meta.title`) }];

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
  const subscriptionRows = data.projectionGroups.flatMap((group) =>
    group.subscriptions.map((subscription) => ({
      ...subscription,
      projectionGroupName: group.projectionName,
    })),
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t(`${routeKey}.eyebrow`)}
        title={t(`${routeKey}.title`)}
        description={t(`${routeKey}.description`)}
      />
      <ActionBar>
        <LinkButton href="/catalog/dimensions" tone="secondary">
          {t(`${routeKey}.catalog`)}
        </LinkButton>
        <LinkButton href="/identity/accounts" tone="secondary">
          {t(`${routeKey}.identity`)}
        </LinkButton>
      </ActionBar>

      <StatGrid columns={{ base: 1, md: 5 }}>
        <Stat label={t(`${routeKey}.status`)} value={data.summary.status} />
        <Stat label={t(`${routeKey}.projectionGroups`)} value={data.summary.totalGroups} />
        <Stat label={t(`${routeKey}.caughtUp`)} value={data.summary.caughtUpGroups} />
        <Stat
          label={t(`${routeKey}.outstandingEvents`)}
          value={formatDecimalCount(data.summary.outstandingEventCount)}
        />
        <Stat label={t(`${routeKey}.blockedStreams`)} value={blockedRows.length} />
      </StatGrid>

      <Grid columns={{ base: 1, xl: 2 }} gap={4}>
        <PageSection title={t(`${routeKey}.projectionGroups`)}>
          <DataTable<ProjectionGroupStatus>
            columns={[
              {
                key: "projection",
                header: t(`${routeKey}.projection`),
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
                header: t(`${routeKey}.state`),
                cell: (group) => <Badge tone={stateTone(group.state)}>{group.state}</Badge>,
              },
              {
                key: "lag",
                header: t(`${routeKey}.backlog`),
                cell: (group) => (
                  <Stack gap={1}>
                    <Text weight="semibold">
                      {t(`${routeKey}.outstandingSummary`, {
                        count: formatDecimalCount(group.outstandingEventCount),
                      })}
                    </Text>
                    <Text size="sm" tone="secondary">
                      {t(`${routeKey}.issueSummary`, {
                        blocked: group.blockedStreamCount,
                        poison: group.poisonEventCount,
                      })}
                    </Text>
                  </Stack>
                ),
              },
              {
                key: "revision",
                header: t(`${routeKey}.revision`),
                cell: (group) =>
                  group.revisionStale
                    ? t(`${routeKey}.staleRevision`, {
                        stored: group.storedProjectionRevision ?? t(`${routeKey}.none`),
                        current: group.projectionRevision,
                      })
                    : String(group.projectionRevision),
              },
              {
                key: "actions",
                header: t(`${routeKey}.actions`),
                cell: (group) => (
                  <Inline gap={2}>
                    <form method="post">
                      <input type="hidden" name="intent" value="rebuild-group" readOnly />
                      <input type="hidden" name="contextName" value={group.targetContextName} readOnly />
                      <input type="hidden" name="projectionName" value={group.projectionName} readOnly />
                      <Button type="submit" tone="secondary" size="sm" leadingIcon="refreshCcw">
                        {t(`${routeKey}.rebuild`)}
                      </Button>
                    </form>
                  </Inline>
                ),
              },
            ]}
            rows={[...data.projectionGroups]}
            getRowId={(group) => `${group.targetContextName}:${group.projectionName}`}
            emptyTitle={t(`${routeKey}.noProjectionGroups`)}
            emptyDescription={t(`${routeKey}.noProjectionGroupsDescription`)}
          />
        </PageSection>

        <PageSection title={t(`${routeKey}.workerRunners`)}>
          <DataTable<Record<string, unknown>>
            columns={[
              {
                key: "runner_name",
                header: t(`${routeKey}.runner`),
                cell: (row) => String(row.runner_name ?? row.worker_id ?? ""),
              },
              {
                key: "kind",
                header: t(`${routeKey}.kind`),
                cell: (row) => String(row.runner_kind ?? row.worker_kind ?? ""),
              },
              {
                key: "state",
                header: t(`${routeKey}.state`),
                cell: (row) => (
                  <Badge tone={stateTone(String(row.state ?? "idle"))}>
                    {String(row.state ?? t(`${routeKey}.active`))}
                  </Badge>
                ),
              },
              {
                key: "updated",
                header: t(`${routeKey}.updated`),
                cell: (row) =>
                  formatDate(String(row.updated_at ?? row.heartbeat_at ?? ""), t(`${routeKey}.notRecorded`)),
              },
            ]}
            rows={[...data.runners, ...data.workers]}
            getRowId={(row, index) => String(row.runner_name ?? row.worker_id ?? index)}
            emptyTitle={t(`${routeKey}.noWorkers`)}
            emptyDescription={t(`${routeKey}.noWorkersDescription`)}
          />
        </PageSection>
      </Grid>

      <PageSection title={t(`${routeKey}.subscriptionBacklog`)}>
        <DataTable<ProjectionSubscriptionRow>
          columns={[
            {
              key: "projection",
              header: t(`${routeKey}.projection`),
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{row.projectionGroupName}</Text>
                  <Text size="sm" tone="secondary">
                    {row.checkpointKey}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "source",
              header: t(`${routeKey}.source`),
              cell: (row) => row.sourceContextName,
            },
            {
              key: "state",
              header: t(`${routeKey}.state`),
              cell: (row) => <Badge tone={stateTone(row.state)}>{row.state}</Badge>,
            },
            {
              key: "outstanding",
              header: t(`${routeKey}.outstandingEvents`),
              cell: (row) => formatDecimalCount(row.outstandingEventCount),
            },
            {
              key: "positions",
              header: t(`${routeKey}.positions`),
              cell: (row) =>
                `${formatDecimalCount(row.lastGlobalPosition)} -> ${formatDecimalCount(row.sourceHeadGlobalPosition)}`,
            },
          ]}
          rows={[...subscriptionRows].sort(compareSubscriptionRows)}
          getRowId={(row) => row.checkpointKey}
          emptyTitle={t(`${routeKey}.noSubscriptions`)}
          emptyDescription={t(`${routeKey}.noSubscriptionsDescription`)}
        />
      </PageSection>

      <PageSection title={t(`${routeKey}.blockedStreams`)}>
        <DataTable<BlockedStream>
          columns={[
            { key: "projection", header: t(`${routeKey}.projectionKey`), cell: (row) => row.projectionKey },
            { key: "stream", header: t(`${routeKey}.stream`), cell: (row) => row.streamId },
            { key: "version", header: t(`${routeKey}.firstVersion`), cell: (row) => row.firstBlockedStreamVersion },
            {
              key: "position",
              header: t(`${routeKey}.positions`),
              cell: (row) => `${row.firstBlockedGlobalPosition} -> ${row.lastSeenGlobalPosition}`,
            },
            { key: "deferred", header: t(`${routeKey}.deferred`), cell: (row) => row.deferredEventCount },
            {
              key: "action",
              header: t(`${routeKey}.action`),
              cell: (row) => (
                <form method="post">
                  <input type="hidden" name="intent" value="retry-stream" readOnly />
                  <input type="hidden" name="projectionKey" value={row.projectionKey} readOnly />
                  <input type="hidden" name="streamId" value={row.streamId} readOnly />
                  <Button type="submit" size="sm" leadingIcon="refreshCcw">
                    {t(`${routeKey}.retry`)}
                  </Button>
                </form>
              ),
            },
          ]}
          rows={blockedRows}
          getRowId={(row) => `${row.projectionKey}:${row.streamId}`}
          emptyTitle={t(`${routeKey}.noBlockedStreams`)}
          emptyDescription={t(`${routeKey}.noBlockedStreamsDescription`)}
        />
      </PageSection>

      <Grid columns={{ base: 1, xl: 2 }} gap={4}>
        {data.blockedProjections.map((projection) => (
          <Surface key={projection.projectionKey} elevated>
            <DetailPanel title={projection.projectionKey}>
              <Stack gap={3}>
                <KeyValueList
                  items={[
                    { key: t(`${routeKey}.blockedStreams`), value: projection.blockedStreams.length },
                    { key: t(`${routeKey}.poisonEvents`), value: projection.poisonEvents.length },
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
                          { key: t(`${routeKey}.event`), value: event.eventId },
                          { key: t(`${routeKey}.stream`), value: event.streamId },
                          { key: t(`${routeKey}.position`), value: event.globalPosition },
                          { key: t(`${routeKey}.retries`), value: event.retryCount },
                          {
                            key: t(`${routeKey}.lastSeen`),
                            value: formatDate(event.lastSeenAt, t(`${routeKey}.notRecorded`)),
                          },
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

function compareSubscriptionRows(left: ProjectionSubscriptionRow, right: ProjectionSubscriptionRow) {
  const backlogComparison = BigInt(right.outstandingEventCount) - BigInt(left.outstandingEventCount);
  if (backlogComparison !== 0n) {
    return backlogComparison > 0n ? 1 : -1;
  }

  if (left.projectionGroupName !== right.projectionGroupName) {
    return left.projectionGroupName.localeCompare(right.projectionGroupName);
  }

  return left.sourceContextName.localeCompare(right.sourceContextName);
}

function formatDecimalCount(value: string | number) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
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

function formatDate(value: string, emptyLabel: string) {
  if (!value) {
    return emptyLabel;
  }

  return new Date(value).toLocaleString();
}
