import { formatDateTime, t } from "@chase-sets/localization";
import { subscribeDurableJobStatus } from "@chase-sets/platform-runtime/durable-job-web";
import { useLiveConnectionStatus } from "@chase-sets/platform-runtime/live-connection-status";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  HiddenInput,
  Form,
  ActionBar,
  AppliedFilterChips,
  Badge,
  Button,
  Cluster,
  ConnectionStatusIndicator,
  DataTable,
  DetailPanel,
  Dialog,
  FilterArea,
  Grid,
  Inline,
  KeyValueList,
  LinkButton,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Stat,
  StatGrid,
  Surface,
  Tabs,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type {
  AttentionItem,
  BlockedStream,
  PoisonEvent,
  ProjectionGroupStatus,
  ProjectionOperation,
  ProjectionOperationsFilters,
  ProjectionOperationsSnapshot,
  ProjectionSubscriptionRow,
} from "../read-model/contracts";
import {
  activeWorkerCount,
  buildAttentionItems,
  buildBlockedRows,
  buildProjectionSubscriptionRows,
  compareSubscriptionRows,
  staleWorkerCount,
  stateSeverity,
} from "../read-model/contracts";
import type { WakeStatusSnapshot } from "../read-model/wake-status-contracts";
import { buildWakeAttentionItems } from "../read-model/wake-status-contracts";

const routeKey = "platformOperations.projectionOperations";
const projectionWakeGrafanaHref =
  "https://grafana.chasesets.com/d/chase-sets-projection-wake-pipeline/projection-wake-pipeline";
const projectionWakeRunbookHref =
  "https://github.com/chase-sets/chase-sets/blob/main/docs/runbooks/push-wake-operations.md";
const projectionOperationsOperatePermission = "projection-operations.operate";
const projectionOperationsRebuildPermission = "projection-operations.rebuild";

export function ProjectionOperationsPage({
  data,
  filters,
  actorPermissions = [],
  wakeStatus = null,
  onOperationTerminal,
  connectionStaleAfterMs,
}: Readonly<{
  data: ProjectionOperationsSnapshot;
  filters: ProjectionOperationsFilters;
  actorPermissions?: readonly string[];
  wakeStatus?: WakeStatusSnapshot | null;
  onOperationTerminal?: () => void;
  connectionStaleAfterMs?: number;
}>) {
  const [streamedOperations, setStreamedOperations] = useState<Readonly<Record<string, ProjectionOperation>>>({});
  const [operationConnectionState, setOperationConnectionState] = useState<Readonly<Record<string, boolean>>>({});
  const liveData = useMemo(
    () => ({ ...data, operations: mergeProjectionOperations(data.operations, streamedOperations) }),
    [data, streamedOperations],
  );
  const operationIdsToWatch = useMemo(
    () =>
      liveData.operations
        .filter(isLiveProjectionOperation)
        .map((operation) => operation.operationId)
        .sort(),
    [liveData.operations],
  );
  const watchKey = operationIdsToWatch.join("\u0000");

  useEffect(() => {
    const watchedOperationIds = watchKey ? watchKey.split("\u0000") : [];
    // Every operation this render is watching starts "not yet connected" — a
    // fresh subscription set replaces whatever connection state the previous
    // set had, since these are brand new EventSource connections.
    setOperationConnectionState(() =>
      Object.fromEntries(watchedOperationIds.map((operationId) => [operationId, false])),
    );

    const subscriptions = watchedOperationIds.map((operationId) =>
      subscribeDurableJobStatus<ProjectionOperation>({
        url: projectionOperationEventsUrl(operationId),
        isTerminal: isTerminalProjectionOperation,
        onStatus: (operation) => {
          setStreamedOperations((current) => ({ ...current, [operation.operationId]: operation }));
        },
        onTerminal: (operation) => {
          setStreamedOperations((current) => ({ ...current, [operation.operationId]: operation }));
          onOperationTerminal?.();
        },
        onConnectionStateChange: (connected) => {
          setOperationConnectionState((current) =>
            operationId in current ? { ...current, [operationId]: connected } : current,
          );
        },
      }),
    );

    return () => {
      for (const subscription of subscriptions) {
        subscription.close();
      }
    };
  }, [watchKey, onOperationTerminal]);

  const hasWatchedOperations = operationIdsToWatch.length > 0;
  // Any watched operation whose stream has silently dropped is enough to
  // demote the whole indicator — a frozen row hiding behind a "connected"
  // sibling is exactly the failure mode this pattern exists to surface.
  const allOperationStreamsConnected = operationIdsToWatch.every(
    (operationId) => operationConnectionState[operationId] === true,
  );
  const operationsConnection = useLiveConnectionStatus(!hasWatchedOperations || allOperationStreamsConnected, {
    staleAfterMs: connectionStaleAfterMs,
  });

  const blockedRows = buildBlockedRows(liveData);
  const subscriptionRows = buildProjectionSubscriptionRows(liveData);
  const wakeAttentionItems = buildWakeAttentionItems(wakeStatus);
  const attentionItems = [...buildAttentionItems(liveData), ...wakeAttentionItems];
  const activeCount = activeWorkerCount(liveData);
  const staleCount = staleWorkerCount(liveData);
  const filteredOperations = filterRows(liveData.operations, filters, operationSearchText);
  const filteredGroups = filterRows(liveData.projectionGroups, filters, groupSearchText);
  const filteredSubscriptions = filterRows(subscriptionRows, filters, subscriptionSearchText);
  const filteredBlockedRows = filterRows(blockedRows, filters, blockedStreamSearchText);
  const workerRows = [...liveData.runners, ...liveData.workers];
  const filteredWorkers = filterRows(workerRows, filters, workerSearchText);
  const defaultTab = filters.tab || (attentionItems.length > 0 ? "attention" : "overview");
  const canOperate = hasPermission(actorPermissions, projectionOperationsOperatePermission);
  const canRebuild = hasPermission(actorPermissions, projectionOperationsRebuildPermission);
  const selectedDetail = resolveSelectedDetail(liveData, filters.selected, { canOperate, canRebuild });
  const selectedContext = filters.contextName || singleContextName(liveData);

  return (
    <Page>
      <PageHeader
        eyebrow={t(`${routeKey}.eyebrow`)}
        title={t(`${routeKey}.title`)}
        description={t(`${routeKey}.description`)}
      />

      <ActionBar>
        {canOperate ? (
          <Form spacing="none" method="post">
            <HiddenInput type="hidden" name="intent" value="refresh-status" readOnly />
            <Button type="submit" leadingIcon="refreshCcw">
              {t(`${routeKey}.refresh`)}
            </Button>
          </Form>
        ) : null}
        {hasPermission(actorPermissions, "catalog.view") ? (
          <LinkButton href="/catalog/dimensions" tone="secondary">
            {t(`${routeKey}.catalog`)}
          </LinkButton>
        ) : null}
        {hasPermission(actorPermissions, "accounts.view") ? (
          <LinkButton href="/access/accounts" tone="secondary">
            {t(`${routeKey}.identity`)}
          </LinkButton>
        ) : null}
        {selectedContext && canRebuild ? <RebuildContextDialog contextName={selectedContext} /> : null}
      </ActionBar>

      <OperationsSummary
        data={liveData}
        attentionItems={attentionItems}
        activeWorkerCount={activeCount}
        staleWorkerCount={staleCount}
        blockedStreamCount={blockedRows.length}
        connectionStatus={
          hasWatchedOperations ? (
            <ConnectionStatusIndicator
              status={operationsConnection.status}
              liveLabel={t(`${routeKey}.connectionLive`)}
              connectingLabel={t(`${routeKey}.connectionConnecting`)}
              staleLabel={t(`${routeKey}.connectionStaleSince`, {
                value: operationsConnection.staleSince
                  ? formatProjectionDateTime(operationsConnection.staleSince.toISOString())
                  : "",
              })}
              staleDescription={t(`${routeKey}.connectionStaleDescription`)}
            />
          ) : null
        }
      />

      <ProjectionOperationFilters filters={filters} data={liveData} />

      {selectedDetail ? <SelectedDetail detail={selectedDetail} /> : null}

      <Tabs
        defaultValue={defaultTab}
        items={[
          {
            value: "overview",
            label: t(`${routeKey}.overview`),
            content: (
              <OverviewPanel
                data={liveData}
                attentionItems={attentionItems}
                activeWorkerCount={activeCount}
                staleWorkerCount={staleCount}
                blockedStreamCount={blockedRows.length}
              />
            ),
          },
          {
            value: "attention",
            label: t(`${routeKey}.attention`),
            badge: attentionItems.length > 0 ? String(attentionItems.length) : undefined,
            content: <AttentionPanel items={attentionItems} />,
          },
          {
            value: "operations",
            label: t(`${routeKey}.operations`),
            badge: liveData.operations.length > 0 ? String(liveData.operations.length) : undefined,
            content: (
              <OperationsTable rows={filteredOperations} selectedId={filters.selected} canOperate={canOperate} />
            ),
          },
          {
            value: "groups",
            label: t(`${routeKey}.projectionGroups`),
            badge: liveData.projectionGroups.length > 0 ? String(liveData.projectionGroups.length) : undefined,
            content: <ProjectionGroupsTable rows={filteredGroups} selectedId={filters.selected} />,
          },
          {
            value: "subscriptions",
            label: t(`${routeKey}.subscriptions`),
            badge: subscriptionRows.length > 0 ? String(subscriptionRows.length) : undefined,
            content: (
              <SubscriptionsTable
                rows={[...filteredSubscriptions].sort(compareSubscriptionRows)}
                selectedId={filters.selected}
              />
            ),
          },
          {
            value: "blocked",
            label: t(`${routeKey}.blockedStreams`),
            badge: blockedRows.length > 0 ? String(blockedRows.length) : undefined,
            content: (
              <BlockedStreamsTable rows={filteredBlockedRows} selectedId={filters.selected} canOperate={canOperate} />
            ),
          },
          {
            value: "workers",
            label: t(`${routeKey}.workers`),
            badge: workerRows.length > 0 ? String(workerRows.length) : undefined,
            content: <WorkersTable rows={filteredWorkers} selectedId={filters.selected} />,
          },
          {
            value: "wake",
            label: t(`${routeKey}.wake`),
            badge: wakeAttentionItems.length > 0 ? String(wakeAttentionItems.length) : undefined,
            content: <WakePipelinePanel wakeStatus={wakeStatus} />,
          },
          {
            value: "diagnostics",
            label: t(`${routeKey}.diagnostics`),
            content: <DiagnosticsPanel data={liveData} />,
          },
        ]}
      />
    </Page>
  );
}

function hasPermission(actorPermissions: readonly string[], permission: string) {
  return actorPermissions.includes(permission);
}

function projectionOperationEventsUrl(operationId: string) {
  return `/api/platform/projections/operations/${encodeURIComponent(operationId)}/events`;
}

function isLiveProjectionOperation(operation: ProjectionOperation) {
  return operation.state === "queued" || operation.state === "running" || operation.state === "cancel_requested";
}

function isTerminalProjectionOperation(operation: ProjectionOperation) {
  return operation.state === "succeeded" || operation.state === "failed" || operation.state === "cancelled";
}

function mergeProjectionOperations(
  operations: readonly ProjectionOperation[],
  streamedOperations: Readonly<Record<string, ProjectionOperation>>,
): readonly ProjectionOperation[] {
  return operations.map((operation) => {
    const streamed = streamedOperations[operation.operationId];
    if (!streamed) {
      return operation;
    }

    return Date.parse(streamed.updatedAt) >= Date.parse(operation.updatedAt) ? streamed : operation;
  });
}

function OperationsSummary({
  data,
  attentionItems,
  activeWorkerCount,
  staleWorkerCount,
  blockedStreamCount,
  connectionStatus,
}: Readonly<{
  data: ProjectionOperationsSnapshot;
  attentionItems: readonly AttentionItem[];
  activeWorkerCount: number;
  staleWorkerCount: number;
  blockedStreamCount: number;
  connectionStatus?: ReactNode;
}>) {
  const status = resolveConsoleStatus(data, attentionItems, staleWorkerCount);

  return (
    <Surface>
      <Stack gap={4}>
        <Cluster align="center" justify="between">
          <Stack gap={1}>
            <Inline gap={2}>
              <Badge tone={status.tone}>{status.label}</Badge>
              <Badge tone={sourceTone(data.projectionStatusSource)}>
                {t(`${routeKey}.source`, { source: data.projectionStatusSource })}
              </Badge>
              {connectionStatus}
            </Inline>
            <Text tone="secondary">{status.detail}</Text>
          </Stack>
          <Text size="sm" tone="secondary">
            {t(`${routeKey}.lastUpdated`, { value: latestUpdatedAt(data) })}
          </Text>
        </Cluster>

        <StatGrid columns={{ base: 1, md: 4 }}>
          <Stat label={t(`${routeKey}.attention`)} value={attentionItems.length} />
          <Stat label={t(`${routeKey}.sourceLag`)} value={formatDecimalCount(data.summary.outstandingEventCount)} />
          <Stat label={t(`${routeKey}.blockedStreams`)} value={blockedStreamCount} />
          <Stat label={t(`${routeKey}.poisonEvents`)} value={totalPoisonEvents(data)} />
          <Stat
            label={t(`${routeKey}.failedOperations`)}
            value={formatDecimalCount(data.operationSummary?.failedCount ?? "0")}
          />
          <Stat
            label={t(`${routeKey}.queuedOperations`)}
            value={formatDecimalCount(data.operationSummary?.queuedCount ?? "0")}
          />
          <Stat
            label={t(`${routeKey}.runningOperations`)}
            value={formatDecimalCount(data.operationSummary?.runningCount ?? "0")}
          />
          <Stat
            label={t(`${routeKey}.activeWorkers`)}
            value={t(`${routeKey}.activeWorkerSummary`, { active: activeWorkerCount, stale: staleWorkerCount })}
          />
        </StatGrid>
      </Stack>
    </Surface>
  );
}

function ProjectionOperationFilters({
  filters,
  data,
}: Readonly<{ filters: ProjectionOperationsFilters; data: ProjectionOperationsSnapshot }>) {
  const contexts = [...new Set(data.projectionGroups.map((group) => group.targetContextName).filter(Boolean))].sort();
  const projections = [...new Set(data.projectionGroups.map((group) => group.projectionName).filter(Boolean))].sort();
  const activeFilterCount = [filters.search, filters.state, filters.contextName, filters.projectionName].filter(
    Boolean,
  ).length;
  const appliedFilters = buildAppliedFilters(filters);

  return (
    <Stack gap={2}>
      <Form spacing="none" method="get">
        <FilterArea
          activeFilterCount={activeFilterCount}
          overflowTriggerLabel={t(`${routeKey}.moreFilters`)}
          panelTitle={t(`${routeKey}.filters`)}
          filters={[
            <TextInput
              key="search"
              label={t(`${routeKey}.search`)}
              name="search"
              defaultValue={filters.search}
              placeholder={t(`${routeKey}.searchPlaceholder`)}
            />,
            <NativeSelect
              key="state"
              label={t(`${routeKey}.state`)}
              name="state"
              defaultValue={filters.state}
              items={[
                { value: "", label: t(`${routeKey}.allStates`) },
                ...[
                  "failed",
                  "error",
                  "degraded",
                  "cancel_requested",
                  "blocked",
                  "behind",
                  "queued",
                  "running",
                  "caught-up",
                  "succeeded",
                ].map((state) => ({ value: state, label: state })),
              ]}
            />,
            <NativeSelect
              key="context"
              label={t(`${routeKey}.context`)}
              name="contextName"
              defaultValue={filters.contextName}
              items={[
                { value: "", label: t(`${routeKey}.allContexts`) },
                ...contexts.map((value) => ({ value, label: value })),
              ]}
            />,
            <NativeSelect
              key="projection"
              label={t(`${routeKey}.projection`)}
              name="projectionName"
              defaultValue={filters.projectionName}
              items={[
                { value: "", label: t(`${routeKey}.allProjections`) },
                ...projections.map((value) => ({ value, label: value })),
              ]}
            />,
          ]}
          actions={
            <Inline>
              <Button type="submit" leadingIcon="filter">
                {t(`${routeKey}.applyFilters`)}
              </Button>
              <LinkButton href="/platform/projections" tone="secondary">
                {t(`${routeKey}.clearFilters`)}
              </LinkButton>
            </Inline>
          }
        />
      </Form>
      <AppliedFilterChips
        filters={appliedFilters}
        clearAction={
          appliedFilters.length > 0 ? (
            <LinkButton href="/platform/projections" size="sm" tone="secondary">
              {t(`${routeKey}.clearFilters`)}
            </LinkButton>
          ) : null
        }
      />
    </Stack>
  );
}

function OverviewPanel({
  data,
  attentionItems,
  activeWorkerCount,
  staleWorkerCount,
  blockedStreamCount,
}: Readonly<{
  data: ProjectionOperationsSnapshot;
  attentionItems: readonly AttentionItem[];
  activeWorkerCount: number;
  staleWorkerCount: number;
  blockedStreamCount: number;
}>) {
  return (
    <Grid columns={{ base: 1, xl: 2 }} gap={4}>
      <PageSection title={t(`${routeKey}.attention`)}>
        <AttentionPanel items={attentionItems} />
      </PageSection>
      <PageSection title={t(`${routeKey}.systemShape`)}>
        <DataTable
          density="compact"
          rows={[
            {
              id: "groups",
              signal: t(`${routeKey}.projectionGroups`),
              value: data.summary.totalGroups,
              detail: t(`${routeKey}.caughtUpCount`, { count: data.summary.caughtUpGroups }),
            },
            {
              id: "workers",
              signal: t(`${routeKey}.workers`),
              value: activeWorkerCount,
              detail: t(`${routeKey}.staleCount`, { count: staleWorkerCount }),
            },
            {
              id: "blocked",
              signal: t(`${routeKey}.blockedStreams`),
              value: blockedStreamCount,
              detail: t(`${routeKey}.poisonEventCount`, { count: totalPoisonEvents(data) }),
            },
            {
              id: "operations",
              signal: t(`${routeKey}.operations`),
              value: data.operations.length,
              detail: t(`${routeKey}.queuedCount`, {
                count: formatDecimalCount(data.operationSummary?.queuedCount ?? "0"),
              }),
            },
          ]}
          getRowId={(row) => row.id}
          columns={[
            { key: "signal", header: t(`${routeKey}.signal`), cell: (row) => row.signal },
            { key: "value", header: t(`${routeKey}.count`), align: "right", cell: (row) => row.value },
            { key: "detail", header: t(`${routeKey}.meaning`), cell: (row) => row.detail },
          ]}
        />
      </PageSection>
    </Grid>
  );
}

function AttentionPanel({ items }: Readonly<{ items: readonly AttentionItem[] }>) {
  if (items.length === 0) {
    return (
      <Surface tone="subtle">
        <Stack gap={1}>
          <Text weight="semibold">{t(`${routeKey}.noAttention`)}</Text>
          <Text tone="secondary">{t(`${routeKey}.noAttentionDescription`)}</Text>
        </Stack>
      </Surface>
    );
  }

  return (
    <DataTable
      density="compact"
      rows={[...items]}
      getRowId={(item) => item.id}
      columns={[
        {
          key: "label",
          header: t(`${routeKey}.signal`),
          cell: (item) => (
            <Inline gap={2}>
              <Badge tone={item.tone}>{item.count ?? item.tone}</Badge>
              <Text weight="semibold">{item.label}</Text>
            </Inline>
          ),
        },
        { key: "detail", header: t(`${routeKey}.meaning`), cell: (item) => item.detail },
        {
          key: "target",
          header: t(`${routeKey}.target`),
          cell: (item) => (
            <LinkButton href={`/platform/projections?tab=${item.targetTab}`} size="sm" tone="secondary">
              {item.targetTab}
            </LinkButton>
          ),
        },
      ]}
    />
  );
}

function OperationsTable({
  rows,
  selectedId,
  canOperate,
}: Readonly<{ rows: readonly ProjectionOperation[]; selectedId: string; canOperate: boolean }>) {
  return (
    <DataTable
      density="compact"
      rows={[...rows].sort((left, right) => stateSeverity(left.state) - stateSeverity(right.state))}
      getRowId={(operation) => operation.operationId}
      emptyTitle={t(`${routeKey}.noProjectionOperations`)}
      emptyDescription={t(`${routeKey}.noProjectionOperationsDescription`)}
      columns={[
        {
          key: "operation",
          header: t(`${routeKey}.operation`),
          cell: (operation) => (
            <Stack gap={1}>
              <Text weight="semibold">{operation.operationKind}</Text>
              <Text size="sm" tone="secondary">
                {operation.operationId}
              </Text>
            </Stack>
          ),
        },
        {
          key: "state",
          header: t(`${routeKey}.state`),
          cell: (operation) => <Badge tone={stateTone(operation.state)}>{operation.state}</Badge>,
        },
        {
          key: "target",
          header: t(`${routeKey}.target`),
          cell: (operation) =>
            t(`${routeKey}.operationTarget`, {
              context: operation.contextName,
              target: operation.projectionName ?? operation.projectionKey ?? operation.streamId ?? t(`${routeKey}.all`),
            }),
        },
        {
          key: "updated",
          header: t(`${routeKey}.updated`),
          cell: (operation) => formatProjectionDateTime(operation.updatedAt),
        },
        {
          key: "actions",
          header: t(`${routeKey}.actions`),
          cell: (operation) => (
            <Inline gap={2}>
              <LinkButton
                href={selectedHref("operations", operation.operationId)}
                size="sm"
                tone={selectedId === operation.operationId ? "primary" : "secondary"}
              >
                {t(`${routeKey}.details`)}
              </LinkButton>
              {canOperate && isCancellable(operation.state) ? (
                <CancelOperationForm operationId={operation.operationId} />
              ) : null}
            </Inline>
          ),
        },
      ]}
    />
  );
}

function ProjectionGroupsTable({
  rows,
  selectedId,
}: Readonly<{ rows: readonly ProjectionGroupStatus[]; selectedId: string }>) {
  return (
    <DataTable
      density="compact"
      rows={[...rows].sort((left, right) => stateSeverity(left.state) - stateSeverity(right.state))}
      getRowId={(group) => groupId(group)}
      emptyTitle={t(`${routeKey}.noProjectionGroups`)}
      emptyDescription={t(`${routeKey}.noProjectionGroupsDescription`)}
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
          header: t(`${routeKey}.sourceLag`),
          align: "right",
          cell: (group) => formatDecimalCount(group.sourceLagEventCount ?? group.outstandingEventCount),
        },
        {
          key: "issues",
          header: t(`${routeKey}.issues`),
          cell: (group) =>
            t(`${routeKey}.issueSummary`, { blocked: group.blockedStreamCount, poison: group.poisonEventCount }),
        },
        {
          key: "actions",
          header: t(`${routeKey}.actions`),
          cell: (group) => (
            <Inline gap={2}>
              <LinkButton
                href={selectedHref("groups", groupId(group))}
                size="sm"
                tone={selectedId === groupId(group) ? "primary" : "secondary"}
              >
                {t(`${routeKey}.details`)}
              </LinkButton>
            </Inline>
          ),
        },
      ]}
    />
  );
}

function SubscriptionsTable({
  rows,
  selectedId,
}: Readonly<{ rows: readonly ProjectionSubscriptionRow[]; selectedId: string }>) {
  return (
    <DataTable
      density="compact"
      rows={[...rows]}
      getRowId={(row) => row.checkpointKey}
      emptyTitle={t(`${routeKey}.noSubscriptions`)}
      emptyDescription={t(`${routeKey}.noSubscriptionsDescription`)}
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
        { key: "source", header: t(`${routeKey}.sourceContext`), cell: (row) => row.sourceContextName },
        {
          key: "state",
          header: t(`${routeKey}.state`),
          cell: (row) => <Badge tone={stateTone(row.operatorState)}>{row.operatorState}</Badge>,
        },
        {
          key: "lag",
          header: t(`${routeKey}.sourceLag`),
          align: "right",
          cell: (row) => formatDecimalCount(row.sourceLagEventCount ?? row.outstandingEventCount),
        },
        {
          key: "positions",
          header: t(`${routeKey}.positions`),
          cell: (row) =>
            t(`${routeKey}.positionRange`, {
              current: formatDecimalCount(row.lastGlobalPosition),
              next: formatDecimalCount(row.sourceHeadGlobalPosition),
            }),
        },
        {
          key: "actions",
          header: t(`${routeKey}.actions`),
          cell: (row) => (
            <LinkButton
              href={selectedHref("subscriptions", row.checkpointKey)}
              size="sm"
              tone={selectedId === row.checkpointKey ? "primary" : "secondary"}
            >
              {t(`${routeKey}.details`)}
            </LinkButton>
          ),
        },
      ]}
    />
  );
}

function BlockedStreamsTable({
  rows,
  selectedId,
  canOperate,
}: Readonly<{ rows: readonly BlockedStream[]; selectedId: string; canOperate: boolean }>) {
  return (
    <DataTable
      density="compact"
      rows={[...rows]}
      getRowId={(row) => blockedStreamId(row)}
      emptyTitle={t(`${routeKey}.noBlockedStreams`)}
      emptyDescription={t(`${routeKey}.noBlockedStreamsDescription`)}
      columns={[
        { key: "projection", header: t(`${routeKey}.projectionKey`), cell: (row) => row.projectionKey },
        { key: "stream", header: t(`${routeKey}.stream`), cell: (row) => row.streamId },
        {
          key: "state",
          header: t(`${routeKey}.state`),
          cell: (row) => <Badge tone={stateTone(row.state)}>{row.state}</Badge>,
        },
        { key: "deferred", header: t(`${routeKey}.deferred`), align: "right", cell: (row) => row.deferredEventCount },
        {
          key: "actions",
          header: t(`${routeKey}.actions`),
          cell: (row) => (
            <Inline gap={2}>
              <LinkButton
                href={selectedHref("blocked", blockedStreamId(row))}
                size="sm"
                tone={selectedId === blockedStreamId(row) ? "primary" : "secondary"}
              >
                {t(`${routeKey}.details`)}
              </LinkButton>
              {canOperate ? <RetryStreamForm row={row} /> : null}
            </Inline>
          ),
        },
      ]}
    />
  );
}

function WorkersTable({
  rows,
  selectedId,
}: Readonly<{ rows: readonly Record<string, unknown>[]; selectedId: string }>) {
  return (
    <DataTable
      density="compact"
      rows={[...rows].sort(
        (left, right) =>
          stateSeverity(String(left.state ?? left.worker_state ?? "")) -
          stateSeverity(String(right.state ?? right.worker_state ?? "")),
      )}
      getRowId={(row) => workerId(row)}
      emptyTitle={t(`${routeKey}.noWorkers`)}
      emptyDescription={t(`${routeKey}.noWorkersDescription`)}
      columns={[
        {
          key: "runner",
          header: t(`${routeKey}.runner`),
          cell: (row) => String(row.runner_name ?? row.worker_id ?? ""),
        },
        { key: "kind", header: t(`${routeKey}.kind`), cell: (row) => String(row.runner_kind ?? row.worker_kind ?? "") },
        {
          key: "state",
          header: t(`${routeKey}.state`),
          cell: (row) => (
            <Badge tone={stateTone(String(row.state ?? row.worker_state ?? "idle"))}>
              {String(row.state ?? row.worker_state ?? "active")}
            </Badge>
          ),
        },
        {
          key: "updated",
          header: t(`${routeKey}.updated`),
          cell: (row) => formatProjectionDateTime(String(row.updated_at ?? row.heartbeat_at ?? "")),
        },
        {
          key: "actions",
          header: t(`${routeKey}.actions`),
          cell: (row) => (
            <LinkButton
              href={selectedHref("workers", workerId(row))}
              size="sm"
              tone={selectedId === workerId(row) ? "primary" : "secondary"}
            >
              {t(`${routeKey}.details`)}
            </LinkButton>
          ),
        },
      ]}
    />
  );
}

function DiagnosticsPanel({ data }: Readonly<{ data: ProjectionOperationsSnapshot }>) {
  return (
    <Grid columns={{ base: 1, xl: 2 }} gap={4}>
      <DetailPanel title={t(`${routeKey}.snapshotDiagnostics`)}>
        <KeyValueList
          items={[
            { key: t(`${routeKey}.statusSource`), value: data.projectionStatusSource },
            { key: t(`${routeKey}.groups`), value: data.summary.totalGroups },
            { key: t(`${routeKey}.caughtUp`), value: data.summary.caughtUpGroups },
            { key: t(`${routeKey}.behind`), value: data.summary.behindGroups },
            { key: t(`${routeKey}.errorGroups`), value: data.summary.errorGroups },
          ]}
        />
      </DetailPanel>
      <DetailPanel title={t(`${routeKey}.operationDiagnostics`)}>
        <KeyValueList
          items={[
            {
              key: t(`${routeKey}.queuedOperations`),
              value: formatDecimalCount(data.operationSummary?.queuedCount ?? "0"),
            },
            {
              key: t(`${routeKey}.runningOperations`),
              value: formatDecimalCount(data.operationSummary?.runningCount ?? "0"),
            },
            {
              key: t(`${routeKey}.failedOperations`),
              value: formatDecimalCount(data.operationSummary?.failedCount ?? "0"),
            },
            {
              key: t(`${routeKey}.oldestQueuedAt`),
              value: formatProjectionDateTime(data.operationSummary?.oldestQueuedAt ?? ""),
            },
            {
              key: t(`${routeKey}.oldestRunningAt`),
              value: formatProjectionDateTime(data.operationSummary?.oldestRunningAt ?? ""),
            },
          ]}
        />
      </DetailPanel>
    </Grid>
  );
}

function WakePipelinePanel({ wakeStatus }: Readonly<{ wakeStatus: WakeStatusSnapshot | null }>) {
  const wakeAttentionItems = buildWakeAttentionItems(wakeStatus);

  return (
    <Stack gap={4}>
      <Surface tone="subtle">
        <Stack gap={3}>
          <Stack gap={1}>
            <Text weight="semibold">{t(`${routeKey}.wakeObservabilityTitle`)}</Text>
            <Text tone="secondary">{t(`${routeKey}.wakeObservabilityDescription`)}</Text>
          </Stack>
          <ActionBar>
            <LinkButton href={projectionWakeGrafanaHref} tone="secondary" leadingIcon="externalLink">
              {t(`${routeKey}.wakeOpenGrafana`)}
            </LinkButton>
            <LinkButton href={projectionWakeRunbookHref} tone="secondary" leadingIcon="externalLink">
              {t(`${routeKey}.wakeOpenRunbook`)}
            </LinkButton>
          </ActionBar>
        </Stack>
      </Surface>
      {wakeStatus ? (
        <AttentionPanel items={wakeAttentionItems} />
      ) : (
        <Surface tone="subtle">
          <Stack gap={1}>
            <Text weight="semibold">{t(`${routeKey}.wakeUnavailable`)}</Text>
            <Text tone="secondary">{t(`${routeKey}.wakeUnavailableDescription`)}</Text>
          </Stack>
        </Surface>
      )}
    </Stack>
  );
}

function SelectedDetail({ detail }: Readonly<{ detail: SelectedRecord }>) {
  return (
    <PageSection title={t(`${routeKey}.selectedDetail`)}>
      <DetailPanel title={detail.title} actions={detail.actions}>
        <Stack gap={3}>
          <KeyValueList items={[...detail.items]} />
          {detail.error ? <Text tone="secondary">{detail.error}</Text> : null}
          {detail.poisonEvents && detail.poisonEvents.length > 0 ? (
            <DataTable
              density="compact"
              rows={[...detail.poisonEvents]}
              getRowId={(event) => event.eventId}
              columns={[
                { key: "type", header: t(`${routeKey}.eventType`), cell: (event) => event.eventType },
                {
                  key: "state",
                  header: t(`${routeKey}.state`),
                  cell: (event) => <Badge tone={stateTone(event.state)}>{event.state}</Badge>,
                },
                {
                  key: "position",
                  header: t(`${routeKey}.position`),
                  align: "right",
                  cell: (event) => event.globalPosition,
                },
                { key: "error", header: t(`${routeKey}.error`), cell: (event) => event.errorMessage },
              ]}
            />
          ) : null}
        </Stack>
      </DetailPanel>
    </PageSection>
  );
}

function CancelOperationForm({ operationId }: Readonly<{ operationId: string }>) {
  return (
    <Form spacing="none" method="post">
      <HiddenInput type="hidden" name="intent" value="cancel-operation" readOnly />
      <HiddenInput type="hidden" name="operationId" value={operationId} readOnly />
      <Button type="submit" size="sm" tone="secondary">
        {t(`${routeKey}.cancel`)}
      </Button>
    </Form>
  );
}

function RebuildGroupDialog({ group }: Readonly<{ group: ProjectionGroupStatus }>) {
  return (
    <Dialog
      title={t(`${routeKey}.confirmRebuildGroupTitle`)}
      description={t(`${routeKey}.confirmRebuildGroupDescription`, {
        context: group.targetContextName,
        projection: group.projectionName,
      })}
      trigger={
        <Button type="button" tone="secondary" size="sm" leadingIcon="refreshCcw">
          {t(`${routeKey}.rebuild`)}
        </Button>
      }
    >
      <Form spacing="none" method="post">
        <Stack gap={3}>
          <HiddenInput type="hidden" name="intent" value="rebuild-group" readOnly />
          <HiddenInput type="hidden" name="contextName" value={group.targetContextName} readOnly />
          <HiddenInput type="hidden" name="projectionName" value={group.projectionName} readOnly />
          <Text tone="secondary">{t(`${routeKey}.confirmRebuildGroupImpact`)}</Text>
          <Button type="submit" tone="danger" leadingIcon="refreshCcw">
            {t(`${routeKey}.confirmRebuild`)}
          </Button>
        </Stack>
      </Form>
    </Dialog>
  );
}

function RebuildContextDialog({ contextName }: Readonly<{ contextName: string }>) {
  return (
    <Dialog
      title={t(`${routeKey}.confirmRebuildContextTitle`)}
      description={t(`${routeKey}.confirmRebuildContextDescription`, { context: contextName })}
      trigger={
        <Button type="button" tone="secondary" leadingIcon="refreshCcw">
          {t(`${routeKey}.rebuildContext`)}
        </Button>
      }
    >
      <Form spacing="none" method="post">
        <Stack gap={3}>
          <HiddenInput type="hidden" name="intent" value="rebuild-context" readOnly />
          <HiddenInput type="hidden" name="contextName" value={contextName} readOnly />
          <Text tone="secondary">{t(`${routeKey}.confirmRebuildContextImpact`)}</Text>
          <Button type="submit" tone="danger" leadingIcon="refreshCcw">
            {t(`${routeKey}.confirmRebuildContext`)}
          </Button>
        </Stack>
      </Form>
    </Dialog>
  );
}

function RetryStreamForm({ row }: Readonly<{ row: BlockedStream }>) {
  return (
    <Form spacing="none" method="post">
      <HiddenInput type="hidden" name="intent" value="retry-stream" readOnly />
      <HiddenInput type="hidden" name="projectionKey" value={row.projectionKey} readOnly />
      <HiddenInput type="hidden" name="streamId" value={row.streamId} readOnly />
      <Button type="submit" size="sm" leadingIcon="refreshCcw">
        {t(`${routeKey}.retry`)}
      </Button>
    </Form>
  );
}

type SelectedRecord = Readonly<{
  title: string;
  items: readonly { key: string; value: string | number }[];
  actions?: ReactNode;
  error?: string | null;
  poisonEvents?: readonly PoisonEvent[];
}>;

function resolveSelectedDetail(
  data: ProjectionOperationsSnapshot,
  selected: string,
  permissions: Readonly<{ canOperate: boolean; canRebuild: boolean }>,
): SelectedRecord | null {
  if (!selected) {
    return null;
  }

  const operation = data.operations.find((entry) => entry.operationId === selected);
  if (operation) {
    return {
      title: t(`${routeKey}.operationDetailTitle`, { kind: operation.operationKind, state: operation.state }),
      actions:
        permissions.canOperate && isCancellable(operation.state) ? (
          <CancelOperationForm operationId={operation.operationId} />
        ) : undefined,
      error: operation.error ? JSON.stringify(operation.error) : null,
      items: [
        { key: t(`${routeKey}.operationId`), value: operation.operationId },
        { key: t(`${routeKey}.context`), value: operation.contextName },
        {
          key: t(`${routeKey}.target`),
          value: operation.projectionName ?? operation.projectionKey ?? operation.streamId ?? t(`${routeKey}.all`),
        },
        { key: t(`${routeKey}.requestedBy`), value: operation.requestedByUserId ?? t(`${routeKey}.notRecorded`) },
        { key: t(`${routeKey}.claimOwner`), value: operation.claimOwnerId ?? t(`${routeKey}.notRecorded`) },
        { key: t(`${routeKey}.requestedAt`), value: formatProjectionDateTime(operation.requestedAt) },
        { key: t(`${routeKey}.startedAt`), value: formatProjectionDateTime(operation.startedAt ?? "") },
        { key: t(`${routeKey}.completedAt`), value: formatProjectionDateTime(operation.completedAt ?? "") },
      ],
    };
  }

  const group = data.projectionGroups.find((entry) => groupId(entry) === selected);
  if (group) {
    return {
      title: t(`${routeKey}.projectionGroupDetailTitle`, {
        context: group.targetContextName,
        projection: group.projectionName,
      }),
      actions: permissions.canRebuild ? <RebuildGroupDialog group={group} /> : undefined,
      error: group.lastError,
      items: [
        { key: t(`${routeKey}.state`), value: group.state },
        {
          key: t(`${routeKey}.requiredDuringBootstrap`),
          value: group.requiredDuringBootstrap ? t(`${routeKey}.yes`) : t(`${routeKey}.no`),
        },
        { key: t(`${routeKey}.initialized`), value: group.initialized ? t(`${routeKey}.yes`) : t(`${routeKey}.no`) },
        { key: t(`${routeKey}.caughtUp`), value: group.caughtUp ? t(`${routeKey}.yes`) : t(`${routeKey}.no`) },
        {
          key: t(`${routeKey}.sourceContexts`),
          value: group.sourceContextNames.join(", ") || t(`${routeKey}.notRecorded`),
        },
        {
          key: t(`${routeKey}.revision`),
          value: t(`${routeKey}.revisionRange`, {
            current: group.storedProjectionRevision ?? t(`${routeKey}.none`),
            next: group.projectionRevision,
          }),
        },
        {
          key: t(`${routeKey}.sourceLag`),
          value: formatDecimalCount(group.sourceLagEventCount ?? group.outstandingEventCount),
        },
        { key: t(`${routeKey}.applicableLag`), value: formatApplicableLag(group.applicableLagEstimate) },
        { key: t(`${routeKey}.ownedTables`), value: group.ownedTables.join(", ") || t(`${routeKey}.notRecorded`) },
        { key: t(`${routeKey}.updated`), value: formatProjectionDateTime(group.updatedAt) },
      ],
    };
  }

  const subscription = buildProjectionSubscriptionRows(data).find((entry) => entry.checkpointKey === selected);
  if (subscription) {
    return {
      title: subscription.checkpointKey,
      error: subscription.lastError,
      items: [
        { key: t(`${routeKey}.state`), value: subscription.operatorState },
        { key: t(`${routeKey}.sourceContext`), value: subscription.sourceContextName },
        { key: t(`${routeKey}.targetContext`), value: subscription.targetContextName },
        { key: t(`${routeKey}.version`), value: subscription.subscriptionVersion },
        { key: t(`${routeKey}.blockedStreams`), value: subscription.blockedStreamCount },
        { key: t(`${routeKey}.poisonEvents`), value: subscription.poisonEventCount },
        {
          key: t(`${routeKey}.positions`),
          value: t(`${routeKey}.positionRange`, {
            current: subscription.lastGlobalPosition,
            next: subscription.sourceHeadGlobalPosition,
          }),
        },
        {
          key: t(`${routeKey}.sourceLag`),
          value: formatDecimalCount(subscription.sourceLagEventCount ?? subscription.outstandingEventCount),
        },
        { key: t(`${routeKey}.applicableLag`), value: formatApplicableLag(subscription.applicableLagEstimate) },
      ],
    };
  }

  const blocked = buildBlockedRows(data).find((entry) => blockedStreamId(entry) === selected);
  if (blocked) {
    const projection = data.blockedProjections.find((entry) => entry.projectionKey === blocked.projectionKey);
    return {
      title: t(`${routeKey}.blockedStreamDetailTitle`, {
        projection: blocked.projectionKey,
        stream: blocked.streamId,
      }),
      actions: permissions.canOperate ? <RetryStreamForm row={blocked} /> : undefined,
      poisonEvents: projection?.poisonEvents.filter((event) => event.streamId === blocked.streamId) ?? [],
      items: [
        { key: t(`${routeKey}.state`), value: blocked.state },
        { key: t(`${routeKey}.stream`), value: blocked.streamId },
        { key: t(`${routeKey}.firstVersion`), value: blocked.firstBlockedStreamVersion },
        {
          key: t(`${routeKey}.positions`),
          value: t(`${routeKey}.positionRange`, {
            current: blocked.firstBlockedGlobalPosition,
            next: blocked.lastSeenGlobalPosition,
          }),
        },
        { key: t(`${routeKey}.deferred`), value: blocked.deferredEventCount },
      ],
    };
  }

  const worker = [...data.runners, ...data.workers].find((entry) => workerId(entry) === selected);
  if (worker) {
    return {
      title: String(worker.runner_name ?? worker.worker_id ?? selected),
      items: Object.entries(worker)
        .filter(([, value]) => value !== null && value !== undefined)
        .slice(0, 12)
        .map(([key, value]) => ({ key, value: typeof value === "object" ? JSON.stringify(value) : String(value) })),
    };
  }

  return null;
}

function filterRows<T>(rows: readonly T[], filters: ProjectionOperationsFilters, searchText: (row: T) => string) {
  return rows.filter((row) => {
    const haystack = searchText(row).toLowerCase();
    const state = readState(row);
    const contextName = readContextName(row);
    const projectionName = readProjectionName(row);

    return (
      (!filters.search || haystack.includes(filters.search.toLowerCase())) &&
      (!filters.state || state === filters.state) &&
      (!filters.contextName || contextName === filters.contextName) &&
      (!filters.projectionName || projectionName === filters.projectionName)
    );
  });
}

function operationSearchText(operation: ProjectionOperation) {
  return [
    operation.operationId,
    operation.operationKind,
    operation.state,
    operation.contextName,
    operation.projectionName,
    operation.projectionKey,
    operation.streamId,
    operation.requestedByUserId,
    operation.claimOwnerId,
  ]
    .filter(Boolean)
    .join(" ");
}

function groupSearchText(group: ProjectionGroupStatus) {
  return [
    group.targetContextName,
    group.projectionName,
    group.state,
    group.sourceContextNames.join(" "),
    group.ownedTables.join(" "),
  ]
    .filter(Boolean)
    .join(" ");
}

function subscriptionSearchText(row: ProjectionSubscriptionRow) {
  return [row.checkpointKey, row.projectionGroupName, row.sourceContextName, row.targetContextName, row.operatorState]
    .filter(Boolean)
    .join(" ");
}

function blockedStreamSearchText(row: BlockedStream) {
  return [row.projectionKey, row.streamId, row.state].filter(Boolean).join(" ");
}

function workerSearchText(row: Record<string, unknown>) {
  return [row.runner_name, row.worker_id, row.runner_kind, row.worker_kind, row.state, row.worker_state]
    .filter(Boolean)
    .join(" ");
}

function readState(row: unknown) {
  if (typeof row === "object" && row !== null) {
    const record = row as Record<string, unknown>;
    return String(record.operatorState ?? record.state ?? record.worker_state ?? "");
  }
  return "";
}

function readContextName(row: unknown) {
  if (typeof row === "object" && row !== null) {
    const record = row as Record<string, unknown>;
    return String(record.contextName ?? record.targetContextName ?? "");
  }
  return "";
}

function readProjectionName(row: unknown) {
  if (typeof row === "object" && row !== null) {
    const record = row as Record<string, unknown>;
    return String(record.projectionName ?? record.projectionGroupName ?? "");
  }
  return "";
}

function groupId(group: ProjectionGroupStatus) {
  return `${group.targetContextName}:${group.projectionName}`;
}

function blockedStreamId(row: BlockedStream) {
  return `${row.projectionKey}:${row.streamId}`;
}

function workerId(row: Record<string, unknown>) {
  return String(row.runner_name ?? row.worker_id ?? row.updated_at ?? row.heartbeat_at ?? JSON.stringify(row));
}

function selectedHref(tab: string, selected: string) {
  return `/platform/projections?tab=${encodeURIComponent(tab)}&selected=${encodeURIComponent(selected)}`;
}

function buildAppliedFilters(filters: ProjectionOperationsFilters) {
  return [
    filters.search ? { id: "search", label: t(`${routeKey}.filterSearch`, { value: filters.search }) } : null,
    filters.state ? { id: "state", label: t(`${routeKey}.filterState`, { value: filters.state }) } : null,
    filters.contextName
      ? { id: "context", label: t(`${routeKey}.filterContext`, { value: filters.contextName }) }
      : null,
    filters.projectionName
      ? { id: "projection", label: t(`${routeKey}.filterProjection`, { value: filters.projectionName }) }
      : null,
  ].filter((entry): entry is { id: string; label: string } => entry !== null);
}

function singleContextName(data: ProjectionOperationsSnapshot) {
  const contexts = new Set(data.projectionGroups.map((group) => group.targetContextName).filter(Boolean));
  return contexts.size === 1 ? [...contexts][0] : "";
}

function isCancellable(state: string) {
  return state === "queued" || state === "running" || state === "cancel_requested";
}

function resolveConsoleStatus(
  data: ProjectionOperationsSnapshot,
  attentionItems: readonly AttentionItem[],
  staleWorkers: number,
) {
  if (attentionItems.some((item) => item.tone === "danger")) {
    return {
      label: t(`${routeKey}.needsAttention`),
      detail: t(`${routeKey}.needsAttentionDescription`),
      tone: "danger" as const,
    };
  }

  if (attentionItems.length > 0) {
    return {
      label: t(`${routeKey}.review`),
      detail: t(`${routeKey}.reviewDescription`),
      tone: "warning" as const,
    };
  }

  if (data.summary.runningGroups > 0 || Number(data.operationSummary?.runningCount ?? 0) > 0) {
    return {
      label: t(`${routeKey}.running`),
      detail: t(`${routeKey}.runningDescription`),
      tone: "accent" as const,
    };
  }

  if (staleWorkers > 0) {
    return {
      label: t(`${routeKey}.stale`),
      detail: t(`${routeKey}.staleDescription`),
      tone: "warning" as const,
    };
  }

  return {
    label: t(`${routeKey}.healthy`),
    detail: t(`${routeKey}.healthyDescription`),
    tone: "success" as const,
  };
}

function sourceTone(source: string) {
  return source === "worker-snapshot" ? "success" : source === "mixed" ? "warning" : "neutral";
}

function stateTone(state: string) {
  switch (state) {
    case "caught-up":
    case "resolved":
    case "succeeded":
    case "ok":
      return "success" as const;
    case "running":
    case "retrying":
    case "active":
      return "accent" as const;
    case "behind":
    case "stale":
    case "expired":
    case "degraded":
    case "blocked":
    case "queued":
    case "cancel_requested":
      return "warning" as const;
    case "error":
    case "failed":
      return "danger" as const;
    case "cancelled":
      return "neutral" as const;
    default:
      return "neutral" as const;
  }
}

function totalPoisonEvents(data: ProjectionOperationsSnapshot) {
  return data.projectionGroups.reduce((sum, group) => sum + group.poisonEventCount, 0);
}

function latestUpdatedAt(data: ProjectionOperationsSnapshot) {
  const values = [
    ...data.projectionGroups.map((group) => group.updatedAt),
    ...data.operations.map((operation) => operation.updatedAt),
    ...data.workers.map((worker) => String(worker.heartbeat_at ?? "")),
  ].filter(Boolean);

  if (values.length === 0) {
    return t(`${routeKey}.notRecorded`);
  }

  return formatProjectionDateTime(values.sort().at(-1) ?? "");
}

function formatDecimalCount(value: string | number) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatApplicableLag(value: string | null | undefined) {
  return value === null || value === undefined
    ? t(`${routeKey}.applicableLagUnknown`)
    : t(`${routeKey}.applicableLagValue`, { count: formatDecimalCount(value) });
}

function formatProjectionDateTime(value: string) {
  if (!value) {
    return t(`${routeKey}.notRecorded`);
  }

  return formatDateTime(value);
}
