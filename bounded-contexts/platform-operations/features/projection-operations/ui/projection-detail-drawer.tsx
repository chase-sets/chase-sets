import type { ReactNode } from "react";
import {
  Badge,
  Button,
  Cluster,
  DataTable,
  Dialog,
  Form,
  HiddenInput,
  KeyValueList,
  SideSheet,
  Stack,
  Text,
} from "@chase-sets/design-system";
import { formatDateTime, t } from "@chase-sets/localization";
import type {
  BlockedStream,
  PoisonEvent,
  ProjectionGroupStatus,
  ProjectionOperationsSnapshot,
} from "../read-model/contracts";
import { buildBlockedRows, buildProjectionSubscriptionRows } from "../read-model/contracts";

const routeKey = "platformOperations.projectionOperations";

export function ProjectionDetailDrawer({
  data,
  selected,
  canOperate,
  canRebuild,
  onClose,
}: Readonly<{
  data: ProjectionOperationsSnapshot;
  selected: string;
  canOperate: boolean;
  canRebuild: boolean;
  onClose?: () => void;
}>) {
  const detail = resolveSelectedDetail(data, selected, { canOperate, canRebuild });
  if (!detail) return null;

  return (
    <SideSheet
      open
      onOpenChange={(open) => {
        if (!open) onClose?.();
      }}
      title={detail.title}
      description={t(`${routeKey}.drawerDescription`)}
      closeLabel={t(`${routeKey}.closeDetail`)}
      width="lg"
    >
      <Stack gap={4}>
        {detail.actions ? <Cluster>{detail.actions}</Cluster> : null}
        <KeyValueList variant="surface" density="compact" items={[...detail.items]} />
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
    </SideSheet>
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
  if (!selected) return null;

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
      actions: permissions.canRebuild ? (
        <>
          <RebuildGroupDialog group={group} />
          <RebuildContextDialog contextName={group.targetContextName} />
        </>
      ) : undefined,
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

  const poison = findPoisonEvent(data, selected);
  if (poison) {
    const blocked = buildBlockedRows(data).find(
      (entry) => entry.projectionKey === poison.projectionKey && entry.streamId === poison.event.streamId,
    );
    return {
      title: poison.event.eventType,
      actions: permissions.canOperate && blocked ? <RetryStreamForm row={blocked} /> : undefined,
      error: poison.event.errorMessage,
      poisonEvents: [poison.event],
      items: [
        { key: t(`${routeKey}.projectionKey`), value: poison.projectionKey },
        { key: t(`${routeKey}.stream`), value: poison.event.streamId },
        { key: t(`${routeKey}.version`), value: poison.event.streamVersion },
        { key: t(`${routeKey}.position`), value: poison.event.globalPosition },
        { key: t(`${routeKey}.retryCount`), value: poison.event.retryCount },
        { key: t(`${routeKey}.firstSeenAt`), value: formatProjectionDateTime(poison.event.firstSeenAt) },
        { key: t(`${routeKey}.lastSeenAt`), value: formatProjectionDateTime(poison.event.lastSeenAt) },
      ],
    };
  }

  const blocked = buildBlockedRows(data).find((entry) => blockedStreamId(entry) === selected);
  if (blocked) {
    const projection = data.blockedProjections.find((entry) => entry.projectionKey === blocked.projectionKey);
    return {
      title: t(`${routeKey}.blockedStreamDetailTitle`, { projection: blocked.projectionKey, stream: blocked.streamId }),
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

function findPoisonEvent(data: ProjectionOperationsSnapshot, selected: string) {
  if (!selected.startsWith("poison-event:")) return null;
  const eventId = selected.slice("poison-event:".length);
  for (const projection of data.blockedProjections) {
    const event = projection.poisonEvents.find((candidate) => candidate.eventId === eventId);
    if (event) return { projectionKey: projection.projectionKey, event };
  }
  return null;
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
        <Button type="button" tone="secondary" size="sm" leadingIcon="refreshCcw">
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

export function groupId(group: ProjectionGroupStatus) {
  return `${group.targetContextName}:${group.projectionName}`;
}

export function blockedStreamId(row: BlockedStream) {
  return `${row.projectionKey}:${row.streamId}`;
}

export function workerId(row: Record<string, unknown>) {
  return String(row.runner_name ?? row.worker_id ?? "");
}

export function stateTone(state: string) {
  if (["failed", "error", "poison"].includes(state)) return "danger" as const;
  if (["degraded", "blocked", "cancel_requested", "stale", "expired", "behind"].includes(state)) {
    return "warning" as const;
  }
  if (["running", "retrying", "queued"].includes(state)) return "accent" as const;
  if (["caught-up", "succeeded", "active", "ok"].includes(state)) return "success" as const;
  return "neutral" as const;
}

export function formatDecimalCount(value: string | number) {
  const numeric = typeof value === "number" ? value : Number(value || "0");
  return Number.isFinite(numeric) ? numeric.toLocaleString("en-US") : String(value);
}

function formatApplicableLag(value: string | null | undefined) {
  return value == null || value === "" ? t(`${routeKey}.notRecorded`) : formatDecimalCount(value);
}

export function formatProjectionDateTime(value: string) {
  return value ? formatDateTime(value) : t(`${routeKey}.notRecorded`);
}

function isCancellable(state: string) {
  return state === "queued" || state === "running" || state === "cancel_requested";
}
