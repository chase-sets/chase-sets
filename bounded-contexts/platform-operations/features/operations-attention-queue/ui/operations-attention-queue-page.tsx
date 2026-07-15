import { formatDateTime, t } from "@chase-sets/localization";
import { useEffect, useRef, useState } from "react";
import { subscribeRealtimePatches } from "@chase-sets/platform-runtime/realtime-web";
import { useLiveConnectionStatus } from "@chase-sets/platform-runtime/live-connection-status";
import {
  ActionBar,
  Badge,
  ConnectionStatusIndicator,
  DataTable,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Stat,
  StatGrid,
  Text,
} from "@chase-sets/design-system";
import type {
  OperationsAttentionItem,
  OperationsAttentionQueue,
  OperationsAttentionSeverity,
  OperationsAttentionSourceId,
} from "../read-model/attention-queue";

const routeKey = "platformOperations.operationsAttention";

function severityTone(severity: OperationsAttentionSeverity): "danger" | "warning" | "neutral" {
  if (severity === "critical") {
    return "danger";
  }
  if (severity === "warning") {
    return "warning";
  }
  return "neutral";
}

function severityLabel(severity: OperationsAttentionSeverity): string {
  return t(`${routeKey}.severity.${severity}`);
}

function sourceLabel(source: OperationsAttentionSourceId): string {
  switch (source) {
    case "projection-poison-event":
      return t(`${routeKey}.source.projectionPoisonEvent`);
    case "projection-blocked-stream":
      return t(`${routeKey}.source.projectionBlockedStream`);
    case "wake-stalled-job":
      return t(`${routeKey}.source.wakeStalledJob`);
    case "support-request-deadline":
      return t(`${routeKey}.source.supportRequestDeadline`);
    case "platform-feedback-unreviewed":
      return t(`${routeKey}.source.platformFeedbackUnreviewed`);
    default:
      return source;
  }
}

// Render one item's copy from its stable semantic code + typed params, so the
// read model never carries operator wording the surface owns.
function summaryText(item: OperationsAttentionItem): string {
  const { code, params } = item.summary;
  return t(`${routeKey}.summary.${code}`, params);
}

function dueLabel(value: string | null): string {
  return value ? formatDateTime(value) : t(`${routeKey}.notSet`);
}

// Subscribes to the shared realtime SSE source for the operations attention
// topic and refreshes on patches — the m89 live/stale connection pattern, not
// a bespoke poll. The returned status drives the connection indicator; the route
// supplies `onRefresh` (revalidation) so this surface stays router-agnostic.
function useOperationsAttentionLiveStatus(
  topics: readonly string[],
  onRefresh: (() => void) | undefined,
  staleAfterMs: number | undefined,
) {
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  const [connected, setConnected] = useState(false);
  const subscriptionKey = topics.join("\n");

  useEffect(() => {
    const activeTopics = subscriptionKey.split("\n").filter(Boolean);
    if (activeTopics.length === 0) {
      return;
    }

    const subscription = subscribeRealtimePatches({
      topics: activeTopics,
      onPatch: () => refreshRef.current?.(),
      onSyncRequired: () => refreshRef.current?.(),
      onConnectionStateChange: setConnected,
    });

    return () => subscription.close();
  }, [subscriptionKey]);

  return useLiveConnectionStatus(connected, { staleAfterMs });
}

export function OperationsAttentionQueuePage({
  queue,
  realtimeTopics = [],
  onRefresh,
  connectionStaleAfterMs,
}: {
  queue: OperationsAttentionQueue;
  realtimeTopics?: readonly string[];
  onRefresh?: () => void;
  connectionStaleAfterMs?: number;
}) {
  const connection = useOperationsAttentionLiveStatus(realtimeTopics, onRefresh, connectionStaleAfterMs);
  const unavailableSources = queue.sources.filter((source) => source.status === "unavailable");

  return (
    <Page>
      <PageHeader
        eyebrow={t(`${routeKey}.eyebrow`)}
        title={t(`${routeKey}.title`)}
        description={t(`${routeKey}.description`)}
      />

      {realtimeTopics.length > 0 ? (
        <ActionBar>
          <ConnectionStatusIndicator
            status={connection.status}
            liveLabel={t(`${routeKey}.connectionLive`)}
            connectingLabel={t(`${routeKey}.connectionConnecting`)}
            staleLabel={t(`${routeKey}.connectionStaleSince`, {
              value: connection.staleSince ? formatDateTime(connection.staleSince.toISOString()) : "",
            })}
            staleDescription={t(`${routeKey}.connectionStaleDescription`)}
          />
        </ActionBar>
      ) : null}

      <StatGrid columns={{ base: 2, md: 4 }}>
        <Stat label={t(`${routeKey}.statTotal`)} value={queue.rollup.total} />
        <Stat label={t(`${routeKey}.statCritical`)} value={queue.rollup.bySeverity.critical} />
        <Stat label={t(`${routeKey}.statWarning`)} value={queue.rollup.bySeverity.warning} />
        <Stat label={t(`${routeKey}.statInfo`)} value={queue.rollup.bySeverity.info} />
      </StatGrid>

      {unavailableSources.length > 0 ? (
        <PageSection title={t(`${routeKey}.degradedTitle`)}>
          <Stack gap={2}>
            <Text tone="secondary" size="sm">
              {t(`${routeKey}.degradedDescription`)}
            </Text>
            {unavailableSources.map((source) => (
              <Text key={source.id} tone="danger" size="sm">
                {t(`${routeKey}.sourceUnavailable`, {
                  source: sourceLabel(source.id),
                  reason: source.reason ?? "",
                })}
              </Text>
            ))}
          </Stack>
        </PageSection>
      ) : null}

      <PageSection title={t(`${routeKey}.queueTitle`)}>
        <DataTable<OperationsAttentionItem>
          columns={[
            {
              key: "severity",
              header: t(`${routeKey}.column.severity`),
              cell: (item) => <Badge tone={severityTone(item.severity)}>{severityLabel(item.severity)}</Badge>,
            },
            {
              key: "item",
              header: t(`${routeKey}.column.item`),
              cell: (item) => summaryText(item),
            },
            {
              key: "source",
              header: t(`${routeKey}.column.source`),
              cell: (item) => sourceLabel(item.source),
            },
            {
              key: "waited",
              header: t(`${routeKey}.column.waited`),
              cell: (item) => formatDateTime(item.observedAt),
            },
            {
              key: "due",
              header: t(`${routeKey}.column.due`),
              cell: (item) => dueLabel(item.dueAt),
            },
            {
              key: "action",
              header: t(`${routeKey}.column.action`),
              cell: (item) => (
                <LinkButton href={item.deepLink.href} size="sm">
                  {t(`${routeKey}.open`)}
                </LinkButton>
              ),
            },
          ]}
          rows={[...queue.items]}
          getRowId={(item) => item.id}
          emptyTitle={t(`${routeKey}.emptyTitle`)}
          emptyDescription={t(`${routeKey}.emptyDescription`)}
        />
      </PageSection>
    </Page>
  );
}
