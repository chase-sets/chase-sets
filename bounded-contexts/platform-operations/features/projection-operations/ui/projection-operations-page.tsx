import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActionBar,
  Badge,
  Button,
  Cluster,
  ConnectionStatusIndicator,
  DataTable,
  Form,
  HiddenInput,
  Inline,
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
import { t } from "@chase-sets/localization";
import { subscribeDurableJobStatus } from "@chase-sets/platform-runtime/durable-job-web";
import { useLiveConnectionStatus } from "@chase-sets/platform-runtime/live-connection-status";
import type {
  AttentionItem,
  ProjectionOperation,
  ProjectionOperationsFilters,
  ProjectionOperationsSnapshot,
  ProjectionRepairQueueItem,
} from "../read-model/contracts";
import {
  activeWorkerCount,
  buildAttentionItems,
  buildBlockedRows,
  buildProjectionRepairQueue,
  staleWorkerCount,
  stateSeverity,
} from "../read-model/contracts";
import type { WakeStatusSnapshot } from "../read-model/wake-status-contracts";
import { buildWakeAttentionItems } from "../read-model/wake-status-contracts";
import {
  ProjectionDetailDrawer,
  formatDecimalCount,
  formatProjectionDateTime,
  stateTone,
} from "./projection-detail-drawer";
import {
  matchesProjectionFilters,
  ProjectionOperationsFiltersForm,
  projectionSelectionHref,
} from "./projection-operations-filters";

const routeKey = "platformOperations.projectionOperations";
const operatePermission = "projection-operations.operate";
const rebuildPermission = "projection-operations.rebuild";

export function ProjectionOperationsPage({
  data,
  filters,
  actorPermissions = [],
  wakeStatus = null,
  onOperationTerminal,
  onSelectedDetailClose,
  connectionStaleAfterMs,
}: Readonly<{
  data: ProjectionOperationsSnapshot;
  filters: ProjectionOperationsFilters;
  actorPermissions?: readonly string[];
  wakeStatus?: WakeStatusSnapshot | null;
  onOperationTerminal?: () => void;
  onSelectedDetailClose?: () => void;
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
    setOperationConnectionState(Object.fromEntries(watchedOperationIds.map((operationId) => [operationId, false])));
    const subscriptions = watchedOperationIds.map((operationId) =>
      subscribeDurableJobStatus<ProjectionOperation>({
        url: `/api/platform/projections/operations/${encodeURIComponent(operationId)}/events`,
        isTerminal: isTerminalProjectionOperation,
        onStatus: (operation) =>
          setStreamedOperations((current) => ({ ...current, [operation.operationId]: operation })),
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
    return () => subscriptions.forEach((subscription) => subscription.close());
  }, [watchKey, onOperationTerminal]);

  const hasWatchedOperations = operationIdsToWatch.length > 0;
  const allOperationStreamsConnected = operationIdsToWatch.every(
    (operationId) => operationConnectionState[operationId] === true,
  );
  const operationsConnection = useLiveConnectionStatus(!hasWatchedOperations || allOperationStreamsConnected, {
    staleAfterMs: connectionStaleAfterMs,
  });
  const summaryItems = [...buildAttentionItems(liveData), ...buildWakeAttentionItems(wakeStatus)];
  const repairItems = buildProjectionRepairQueue(liveData).filter((item) =>
    matchesProjectionFilters(
      {
        search: [item.label, item.detail, item.projectionKey, item.streamId].filter(Boolean).join(" "),
        state: item.state,
        contextName: item.contextName,
        projectionName: item.projectionName,
      },
      filters,
    ),
  );
  const operations = liveData.operations.filter((operation) =>
    matchesProjectionFilters(
      {
        search: operationSearchText(operation),
        state: operation.state,
        contextName: operation.contextName,
        projectionName: operation.projectionName ?? undefined,
      },
      filters,
    ),
  );
  const canOperate = hasPermission(actorPermissions, operatePermission);
  const canRebuild = hasPermission(actorPermissions, rebuildPermission);

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
        <LinkButton href="/platform/projections/reference" tone="secondary" leadingIcon="settings">
          {t(`${routeKey}.reference`)}
        </LinkButton>
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
      </ActionBar>

      <OperationsSummary
        data={liveData}
        attentionItems={summaryItems}
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

      <ProjectionOperationsFiltersForm filters={filters} data={liveData} clearHref="/platform/projections" />

      <PageSection title={t(`${routeKey}.repairQueue`)} description={t(`${routeKey}.repairQueueDescription`)}>
        <ProjectionRepairQueue rows={repairItems} filters={filters} />
      </PageSection>

      <PageSection title={t(`${routeKey}.recentOperations`)} description={t(`${routeKey}.recentOperationsDescription`)}>
        <OperationsTable rows={operations} filters={filters} />
      </PageSection>

      <ProjectionDetailDrawer
        data={liveData}
        selected={filters.selected}
        canOperate={canOperate}
        canRebuild={canRebuild}
        onClose={onSelectedDetailClose}
      />
    </Page>
  );
}

function ProjectionRepairQueue({
  rows,
  filters,
}: Readonly<{ rows: readonly ProjectionRepairQueueItem[]; filters: ProjectionOperationsFilters }>) {
  if (rows.length === 0) {
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
      rows={[...rows]}
      getRowId={(item) => `${item.kind}:${item.targetId}`}
      columns={[
        { key: "state", header: t(`${routeKey}.state`), cell: (item) => <Badge tone={item.tone}>{item.state}</Badge> },
        {
          key: "issue",
          header: t(`${routeKey}.signal`),
          cell: (item) => (
            <Stack gap={1}>
              <Text weight="semibold">{item.label}</Text>
              <Text size="sm" tone="secondary">
                {item.kind}
              </Text>
            </Stack>
          ),
        },
        { key: "target", header: t(`${routeKey}.target`), cell: (item) => item.detail },
        {
          key: "actions",
          header: t(`${routeKey}.actions`),
          cell: (item) => (
            <LinkButton
              href={projectionSelectionHref("/platform/projections", filters, item.targetId)}
              size="sm"
              tone="secondary"
            >
              {t(`${routeKey}.details`)}
            </LinkButton>
          ),
        },
      ]}
    />
  );
}

function OperationsTable({
  rows,
  filters,
}: Readonly<{ rows: readonly ProjectionOperation[]; filters: ProjectionOperationsFilters }>) {
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
            <LinkButton
              href={projectionSelectionHref("/platform/projections", filters, operation.operationId)}
              size="sm"
              tone="secondary"
            >
              {t(`${routeKey}.details`)}
            </LinkButton>
          ),
        },
      ]}
    />
  );
}

function OperationsSummary({
  data,
  attentionItems,
  connectionStatus,
}: Readonly<{
  data: ProjectionOperationsSnapshot;
  attentionItems: readonly AttentionItem[];
  connectionStatus?: ReactNode;
}>) {
  const status = resolveConsoleStatus(data, attentionItems, staleWorkerCount(data));
  return (
    <Surface>
      <Stack gap={4}>
        <Cluster align="center" justify="between">
          <Stack gap={1}>
            <Inline gap={2}>
              <Badge tone={status.tone}>{status.label}</Badge>
              <Badge>{t(`${routeKey}.source`, { source: data.projectionStatusSource })}</Badge>
              {connectionStatus}
            </Inline>
            <Text tone="secondary">{status.detail}</Text>
          </Stack>
        </Cluster>
        {attentionItems.length > 0 ? (
          <Inline gap={2}>
            {attentionItems.map((item) => (
              <Badge key={item.id} tone={item.tone}>
                {item.label}
              </Badge>
            ))}
          </Inline>
        ) : null}
        <StatGrid columns={{ base: 1, md: 4 }}>
          <Stat label={t(`${routeKey}.attention`)} value={attentionItems.length} />
          <Stat label={t(`${routeKey}.sourceLag`)} value={formatDecimalCount(data.summary.outstandingEventCount)} />
          <Stat label={t(`${routeKey}.blockedStreams`)} value={buildBlockedRows(data).length} />
          <Stat
            label={t(`${routeKey}.poisonEvents`)}
            value={data.blockedProjections.reduce((sum, projection) => sum + projection.poisonEvents.length, 0)}
          />
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
            value={t(`${routeKey}.activeWorkerSummary`, {
              active: activeWorkerCount(data),
              stale: staleWorkerCount(data),
            })}
          />
        </StatGrid>
      </Stack>
    </Surface>
  );
}

function resolveConsoleStatus(
  data: ProjectionOperationsSnapshot,
  attentionItems: readonly AttentionItem[],
  staleWorkers: number,
) {
  if (attentionItems.some((item) => item.tone === "danger"))
    return {
      label: t(`${routeKey}.needsAttention`),
      detail: t(`${routeKey}.needsAttentionDescription`),
      tone: "danger" as const,
    };
  if (staleWorkers > 0)
    return { label: t(`${routeKey}.stale`), detail: t(`${routeKey}.staleDescription`), tone: "warning" as const };
  if (data.summary.runningGroups > 0 || Number(data.operationSummary?.runningCount ?? 0) > 0)
    return { label: t(`${routeKey}.running`), detail: t(`${routeKey}.runningDescription`), tone: "accent" as const };
  if (attentionItems.length > 0)
    return { label: t(`${routeKey}.review`), detail: t(`${routeKey}.reviewDescription`), tone: "warning" as const };
  return { label: t(`${routeKey}.healthy`), detail: t(`${routeKey}.healthyDescription`), tone: "success" as const };
}

function mergeProjectionOperations(
  operations: readonly ProjectionOperation[],
  streamed: Readonly<Record<string, ProjectionOperation>>,
) {
  return operations.map((operation) => {
    const update = streamed[operation.operationId];
    return update && Date.parse(update.updatedAt) >= Date.parse(operation.updatedAt) ? update : operation;
  });
}

function isLiveProjectionOperation(operation: ProjectionOperation) {
  return operation.state === "queued" || operation.state === "running" || operation.state === "cancel_requested";
}

function isTerminalProjectionOperation(operation: ProjectionOperation) {
  return operation.state === "succeeded" || operation.state === "failed" || operation.state === "cancelled";
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
  ]
    .filter(Boolean)
    .join(" ");
}

function hasPermission(actorPermissions: readonly string[], permission: string) {
  return actorPermissions.includes(permission);
}
