import {
  ActionBar,
  Badge,
  DataTable,
  DetailPanel,
  Grid,
  KeyValueList,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Surface,
  Text,
} from "@chase-sets/design-system";
import { t } from "@chase-sets/localization";
import type {
  ProjectionGroupStatus,
  ProjectionOperationsFilters,
  ProjectionOperationsSnapshot,
  ProjectionSubscriptionRow,
} from "../read-model/contracts";
import { buildProjectionSubscriptionRows, compareSubscriptionRows, stateSeverity } from "../read-model/contracts";
import type { WakeStatusSnapshot } from "../read-model/wake-status-contracts";
import { buildWakeAttentionItems } from "../read-model/wake-status-contracts";
import {
  formatDecimalCount,
  formatProjectionDateTime,
  groupId,
  ProjectionDetailDrawer,
  stateTone,
  workerId,
} from "./projection-detail-drawer";
import {
  matchesProjectionFilters,
  ProjectionOperationsFiltersForm,
  projectionSelectionHref,
} from "./projection-operations-filters";

const routeKey = "platformOperations.projectionOperations";
const grafanaHref = "https://grafana.chasesets.com/d/chase-sets-projection-wake-pipeline/projection-wake-pipeline";
const runbookHref = "https://github.com/chase-sets/chase-sets/blob/main/docs/runbooks/push-wake-operations.md";

export function ProjectionOperationsReferencePage({
  data,
  filters,
  wakeStatus = null,
  actorPermissions = [],
  onSelectedDetailClose,
}: Readonly<{
  data: ProjectionOperationsSnapshot;
  filters: ProjectionOperationsFilters;
  wakeStatus?: WakeStatusSnapshot | null;
  actorPermissions?: readonly string[];
  onSelectedDetailClose?: () => void;
}>) {
  const groups = data.projectionGroups.filter((group) =>
    matchesProjectionFilters(
      {
        search: [group.targetContextName, group.projectionName, ...group.sourceContextNames, ...group.ownedTables].join(
          " ",
        ),
        state: group.state,
        contextName: group.targetContextName,
        projectionName: group.projectionName,
      },
      filters,
    ),
  );
  const subscriptions = buildProjectionSubscriptionRows(data)
    .filter((row) =>
      matchesProjectionFilters(
        {
          search: [row.checkpointKey, row.projectionGroupName, row.sourceContextName, row.targetContextName].join(" "),
          state: row.operatorState,
          contextName: row.targetContextName,
          projectionName: row.projectionGroupName,
        },
        filters,
      ),
    )
    .sort(compareSubscriptionRows);
  const workers = [...data.runners, ...data.workers].filter((row) =>
    matchesProjectionFilters(
      {
        search: Object.values(row)
          .filter((value) => typeof value !== "object")
          .join(" "),
        state: String(row.state ?? row.worker_state ?? ""),
      },
      filters,
    ),
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t(`${routeKey}.eyebrow`)}
        title={t(`${routeKey}.referenceTitle`)}
        description={t(`${routeKey}.referenceDescription`)}
      />
      <ActionBar>
        <LinkButton href={projectionSelectionHref("/platform/projections", filters)} leadingIcon="chevronLeft">
          {t(`${routeKey}.backToOperations`)}
        </LinkButton>
        <LinkButton href={grafanaHref} tone="secondary" leadingIcon="externalLink">
          {t(`${routeKey}.wakeOpenGrafana`)}
        </LinkButton>
        <LinkButton href={runbookHref} tone="secondary" leadingIcon="externalLink">
          {t(`${routeKey}.wakeOpenRunbook`)}
        </LinkButton>
      </ActionBar>

      <ProjectionOperationsFiltersForm filters={filters} data={data} clearHref="/platform/projections/reference" />

      <PageSection title={t(`${routeKey}.projectionGroups`)}>
        <ProjectionGroupsTable rows={groups} filters={filters} />
      </PageSection>
      <PageSection
        title={t(`${routeKey}.subscriptionMatrix`)}
        description={t(`${routeKey}.subscriptionMatrixDescription`)}
      >
        <SubscriptionsTable rows={subscriptions} filters={filters} />
      </PageSection>
      <PageSection title={t(`${routeKey}.workers`)}>
        <WorkersTable rows={workers} filters={filters} />
      </PageSection>
      <PageSection title={t(`${routeKey}.wakeReference`)}>
        <WakeReferencePanel wakeStatus={wakeStatus} />
      </PageSection>
      <PageSection title={t(`${routeKey}.diagnostics`)}>
        <DiagnosticsPanel data={data} />
      </PageSection>

      <ProjectionDetailDrawer
        data={data}
        selected={filters.selected}
        canOperate={actorPermissions.includes("projection-operations.operate")}
        canRebuild={actorPermissions.includes("projection-operations.rebuild")}
        onClose={onSelectedDetailClose}
      />
    </Page>
  );
}

function ProjectionGroupsTable({
  rows,
  filters,
}: Readonly<{ rows: readonly ProjectionGroupStatus[]; filters: ProjectionOperationsFilters }>) {
  return (
    <DataTable
      density="compact"
      rows={[...rows].sort((left, right) => stateSeverity(left.state) - stateSeverity(right.state))}
      getRowId={groupId}
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
            <LinkButton
              href={projectionSelectionHref("/platform/projections/reference", filters, groupId(group))}
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

function SubscriptionsTable({
  rows,
  filters,
}: Readonly<{ rows: readonly ProjectionSubscriptionRow[]; filters: ProjectionOperationsFilters }>) {
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
              href={projectionSelectionHref("/platform/projections/reference", filters, row.checkpointKey)}
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

function WorkersTable({
  rows,
  filters,
}: Readonly<{ rows: readonly Record<string, unknown>[]; filters: ProjectionOperationsFilters }>) {
  return (
    <DataTable
      density="compact"
      rows={[...rows].sort(
        (left, right) =>
          stateSeverity(String(left.state ?? left.worker_state ?? "")) -
          stateSeverity(String(right.state ?? right.worker_state ?? "")),
      )}
      getRowId={workerId}
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
              href={projectionSelectionHref("/platform/projections/reference", filters, workerId(row))}
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

function WakeReferencePanel({ wakeStatus }: Readonly<{ wakeStatus: WakeStatusSnapshot | null }>) {
  const items = buildWakeAttentionItems(wakeStatus);
  return (
    <Stack gap={3}>
      <Surface tone="subtle">
        <Stack gap={1}>
          <Text weight="semibold">{t(`${routeKey}.wakeObservabilityTitle`)}</Text>
          <Text tone="secondary">{t(`${routeKey}.wakeObservabilityDescription`)}</Text>
        </Stack>
      </Surface>
      {!wakeStatus ? (
        <Surface tone="subtle">
          <Stack gap={1}>
            <Text weight="semibold">{t(`${routeKey}.wakeUnavailable`)}</Text>
            <Text tone="secondary">{t(`${routeKey}.wakeUnavailableDescription`)}</Text>
          </Stack>
        </Surface>
      ) : items.length > 0 ? (
        <DataTable
          density="compact"
          rows={[...items]}
          getRowId={(item) => item.id}
          columns={[
            {
              key: "signal",
              header: t(`${routeKey}.signal`),
              cell: (item) => <Badge tone={item.tone}>{item.label}</Badge>,
            },
            { key: "meaning", header: t(`${routeKey}.meaning`), cell: (item) => item.detail },
          ]}
        />
      ) : (
        <Text tone="secondary">{t(`${routeKey}.noWakeAttention`)}</Text>
      )}
    </Stack>
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
