import { formatDateTime, t } from "@chase-sets/localization";
import { subscribeDurableJobStatus } from "@chase-sets/platform-runtime/durable-job-web";
import { useEffect, useState } from "react";
import { RouterForm } from "@chase-sets/design-system/react-router";
import {
  HiddenInput,
  ActionBar,
  AppliedFilterChips,
  Badge,
  Button,
  Cluster,
  DataTable,
  DetailPanel,
  FilterArea,
  Form,
  Inline,
  KeyValueList,
  LinkButton,
  LinkText,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Stat,
  StatGrid,
  Surface,
  Text,
  TextInput,
} from "@chase-sets/design-system";
import type {
  GoogleShoppingFeedRowFilter,
  GoogleShoppingFeedRowList,
  GoogleShoppingFeedRowListItem,
  GoogleShoppingFullSyncJobStatus,
  GoogleShoppingOperationsFilters,
  GoogleShoppingOperationsNotice,
} from "./contracts";

const routeKey = "discovery.googleShoppingOperations";
const routePath = "/growth/google-shopping";
const liveGateIssueHref = "https://github.com/chase-sets/chase-sets/issues/3032";

type Tone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

export function GoogleShoppingOperationsPage({
  data,
  filters,
  notice,
  unavailableMessage,
  actionError,
  actorPermissions = [],
  latestJobIds = [],
  onJobTerminal,
}: Readonly<{
  data: GoogleShoppingFeedRowList;
  filters: GoogleShoppingOperationsFilters;
  notice?: GoogleShoppingOperationsNotice | null;
  unavailableMessage?: string | null;
  actionError?: string | null;
  actorPermissions?: readonly string[];
  latestJobIds?: readonly string[];
  onJobTerminal?: () => void;
}>) {
  const latestJobId = latestJobIds.at(-1) ?? null;
  const [streamedJob, setStreamedJob] = useState<GoogleShoppingFullSyncJobStatus | null>(null);
  const selectedRow = resolveSelectedRow(data.rows, filters.selected);

  useEffect(() => {
    setStreamedJob(null);
    if (!latestJobId) {
      return;
    }

    const subscription = subscribeDurableJobStatus<GoogleShoppingFullSyncJobStatus>({
      url: googleShoppingJobEventsUrl(latestJobId),
      onStatus: setStreamedJob,
      onTerminal: (job) => {
        setStreamedJob(job);
        onJobTerminal?.();
      },
    });

    return () => subscription.close();
  }, [latestJobId, onJobTerminal]);

  return (
    <Page>
      <PageHeader
        eyebrow={t(`${routeKey}.eyebrow`)}
        title={t(`${routeKey}.title`)}
        description={t(`${routeKey}.description`)}
      />

      <ActionBar>
        <RouterForm method="post" spacing="none">
          <HiddenInput type="hidden" name="intent" value="dry-run-full-sync" readOnly />
          <HiddenInput type="hidden" name="batchSize" value={filters.limit} readOnly />
          <Button type="submit" leadingIcon="play">
            {t(`${routeKey}.dryRunFullSync`)}
          </Button>
        </RouterForm>
        <RouterForm method="post" spacing="none">
          <HiddenInput type="hidden" name="intent" value="dry-run-maintenance-sync" readOnly />
          <HiddenInput type="hidden" name="limit" value={filters.limit} readOnly />
          <HiddenInput type="hidden" name="refreshWindowDays" value={filters.refreshWindowDays} readOnly />
          <Button type="submit" tone="secondary" leadingIcon="refreshCcw">
            {t(`${routeKey}.dryRunMaintenance`)}
          </Button>
        </RouterForm>
        <RouterForm method="post" spacing="none">
          <HiddenInput type="hidden" name="intent" value="dry-run-diagnostics-refresh" readOnly />
          <HiddenInput type="hidden" name="batchSize" value={filters.limit} readOnly />
          <Button type="submit" tone="secondary" leadingIcon="refreshCcw">
            {t(`${routeKey}.dryRunDiagnostics`)}
          </Button>
        </RouterForm>
        <Button type="button" tone="secondary" leadingIcon="lock" disabled>
          {t(`${routeKey}.liveFullSyncGated`)}
        </Button>
        <Button type="button" tone="secondary" leadingIcon="lock" disabled>
          {t(`${routeKey}.liveMaintenanceGated`)}
        </Button>
        {hasPermission(actorPermissions, "security.manage") ? (
          <LinkButton href="/platform/projections?contextName=discovery" tone="secondary">
            {t(`${routeKey}.projections`)}
          </LinkButton>
        ) : null}
        <LinkButton
          href="https://github.com/chase-sets/chase-sets/blob/main/docs/runbooks/google-shopping-operations.md"
          tone="secondary"
          target="_blank"
          rel="noreferrer"
          trailingIcon="externalLink"
        >
          {t(`${routeKey}.runbook`)}
        </LinkButton>
      </ActionBar>

      {unavailableMessage ? <Notice tone="warning" message={unavailableMessage} /> : null}
      {notice ? <Notice tone={notice.tone} message={notice.message} /> : null}
      {actionError ? <Notice tone="danger" message={actionError} /> : null}
      {latestJobId ? <GoogleShoppingJobSummary jobId={latestJobId} job={streamedJob} /> : null}

      <Surface elevation="tinted" data-testid="google-shopping-live-gate-surface">
        <Cluster align="center" justify="between">
          <Inline gap={2}>
            <Badge tone="warning">{t(`${routeKey}.liveGateBadge`)}</Badge>
            <Text weight="semibold">{t(`${routeKey}.liveGateMessage`)}</Text>
          </Inline>
          <LinkButton href={liveGateIssueHref} tone="secondary" target="_blank" rel="noreferrer">
            {t(`${routeKey}.liveGateAction`)}
          </LinkButton>
        </Cluster>
      </Surface>

      <Surface elevation="tinted" data-testid="google-shopping-readiness-summary-surface">
        <Stack gap={4}>
          <Cluster align="center" justify="between">
            <Inline gap={2}>
              <Badge tone={summaryTone(data.summary.failedRows + data.summary.disapprovedRows)}>
                {t(`${routeKey}.readiness`, {
                  count: data.summary.failedRows + data.summary.disapprovedRows,
                })}
              </Badge>
              <Badge tone="info">
                {t(`${routeKey}.generatedAt`, {
                  value: formatSyncDateTime(data.generatedAt),
                })}
              </Badge>
            </Inline>
            <Text size="sm" tone="secondary">
              {t(`${routeKey}.refreshCutoff`, {
                value: formatSyncDateTime(data.refreshCutoff),
              })}
            </Text>
          </Cluster>
          <StatGrid columns={{ base: 1, md: 4 }}>
            <Stat label={t(`${routeKey}.totalRows`)} value={formatCount(data.summary.totalRows)} />
            <Stat label={t(`${routeKey}.eligibleRows`)} value={formatCount(data.summary.eligibleRows)} />
            <Stat label={t(`${routeKey}.failedRows`)} value={formatCount(data.summary.failedRows)} />
            <Stat label={t(`${routeKey}.disapprovedRows`)} value={formatCount(data.summary.disapprovedRows)} />
            <Stat label={t(`${routeKey}.excludedRows`)} value={formatCount(data.summary.excludedRows)} />
            <Stat label={t(`${routeKey}.pendingDeleteRows`)} value={formatCount(data.summary.pendingDeleteRows)} />
            <Stat label={t(`${routeKey}.staleRows`)} value={formatCount(data.summary.staleRows)} />
            <Stat
              label={t(`${routeKey}.pendingDiagnosticsRows`)}
              value={formatCount(data.summary.pendingDiagnosticsRows)}
            />
          </StatGrid>
        </Stack>
      </Surface>

      <GoogleShoppingFilters filters={filters} />

      {selectedRow ? <SelectedRowDetail row={selectedRow} /> : null}

      <PageSection title={t(`${routeKey}.feedRows`)} description={t(`${routeKey}.feedRowsDescription`)}>
        <DataTable
          density="compact"
          rows={[...data.rows]}
          getRowId={(row) => row.rowId}
          emptyTitle={t(`${routeKey}.noRows`)}
          emptyDescription={t(`${routeKey}.noRowsDescription`)}
          columns={[
            {
              key: "listing",
              header: t(`${routeKey}.listing`),
              cell: (row) => <ListingCell row={row} actorPermissions={actorPermissions} />,
            },
            {
              key: "eligibility",
              header: t(`${routeKey}.eligibility`),
              cell: (row) => <EligibilityCell row={row} />,
            },
            {
              key: "sync",
              header: t(`${routeKey}.sync`),
              cell: (row) => <SyncCell row={row} />,
            },
            {
              key: "diagnostics",
              header: t(`${routeKey}.diagnostics`),
              cell: (row) => <DiagnosticsCell row={row} />,
            },
            {
              key: "owners",
              header: t(`${routeKey}.owners`),
              cell: (row) => row.remediationOwners.join(", "),
            },
            {
              key: "updated",
              header: t(`${routeKey}.updated`),
              cell: (row) => formatSyncDateTime(row.updatedAt),
            },
            {
              key: "action",
              header: t(`${routeKey}.action`),
              align: "right",
              cell: (row) => (
                <LinkButton href={withSelected(row.rowId)} size="sm" tone="secondary">
                  {t(`${routeKey}.inspect`)}
                </LinkButton>
              ),
            },
          ]}
        />
      </PageSection>
    </Page>
  );
}

function GoogleShoppingJobSummary({
  jobId,
  job,
}: Readonly<{ jobId: string; job: GoogleShoppingFullSyncJobStatus | null }>) {
  const progress = job?.progress;

  return (
    <Surface elevation="elevated" data-testid="google-shopping-latest-job-surface">
      <Stack gap={3}>
        <Cluster align="center" justify="between">
          <Stack gap={1}>
            <Text weight="semibold">{t(`${routeKey}.latestJob`)}</Text>
            <Text size="sm" tone="secondary">
              {job?.progress.message ?? t(`${routeKey}.latestJobWaiting`)}
            </Text>
          </Stack>
          <Badge tone={jobStatusTone(job?.status)}>{job?.status ?? t(`${routeKey}.jobStatus.pending`)}</Badge>
        </Cluster>
        <KeyValueList
          density="compact"
          items={[
            { key: t(`${routeKey}.jobId`), value: breakable(jobId) },
            { key: t(`${routeKey}.jobKind`), value: job?.jobKind ?? t(`${routeKey}.none`) },
            { key: t(`${routeKey}.currentRow`), value: breakable(progress?.currentRowId ?? null) },
            { key: t(`${routeKey}.updated`), value: formatSyncDateTime(job?.updatedAt ?? null) },
          ]}
        />
        <StatGrid columns={{ base: 1, md: 4 }}>
          <Stat
            label={t(`${routeKey}.jobProcessed`)}
            value={t(`${routeKey}.jobProcessedValue`, {
              completed: progress?.completed ?? 0,
              total: progress?.total ?? 0,
            })}
          />
          <Stat label={t(`${routeKey}.jobSubmitted`)} value={formatCount(progress?.submitted ?? 0)} />
          <Stat label={t(`${routeKey}.jobSkipped`)} value={formatCount(progress?.skipped ?? 0)} />
          <Stat label={t(`${routeKey}.jobDeleted`)} value={formatCount(progress?.deleted ?? 0)} />
          <Stat label={t(`${routeKey}.jobFailed`)} value={formatCount(progress?.failed ?? 0)} />
          <Stat label={t(`${routeKey}.jobExcluded`)} value={formatCount(progress?.excluded ?? 0)} />
        </StatGrid>
      </Stack>
    </Surface>
  );
}

function Notice({ tone, message }: GoogleShoppingOperationsNotice) {
  return (
    <Surface elevation="tinted" data-testid="google-shopping-notice-surface">
      <Inline gap={2}>
        <Badge tone={tone}>{tone}</Badge>
        <Text weight="semibold">{message}</Text>
      </Inline>
    </Surface>
  );
}

function GoogleShoppingFilters({ filters }: Readonly<{ filters: GoogleShoppingOperationsFilters }>) {
  const appliedFilters = buildAppliedFilters(filters);

  return (
    <Stack gap={2}>
      <Form method="get" spacing="none">
        <FilterArea
          activeFilterCount={appliedFilters.length}
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
              key="filter"
              label={t(`${routeKey}.filter`)}
              name="filter"
              defaultValue={filters.filter}
              items={filterItems()}
            />,
            <NativeSelect
              key="limit"
              label={t(`${routeKey}.limit`)}
              name="limit"
              defaultValue={String(filters.limit)}
              items={["25", "50", "100", "200"].map((value) => ({ value, label: value }))}
            />,
            <NativeSelect
              key="refreshWindowDays"
              label={t(`${routeKey}.refreshWindowDays`)}
              name="refreshWindowDays"
              defaultValue={String(filters.refreshWindowDays)}
              items={["14", "25", "30", "45"].map((value) => ({ value, label: value }))}
            />,
          ]}
          actions={
            <Inline>
              <Button type="submit" leadingIcon="filter">
                {t(`${routeKey}.applyFilters`)}
              </Button>
              <LinkButton href={routePath} tone="secondary">
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
            <LinkButton href={routePath} size="sm" tone="secondary">
              {t(`${routeKey}.clearFilters`)}
            </LinkButton>
          ) : null
        }
      />
    </Stack>
  );
}

function ListingCell({
  row,
  actorPermissions,
}: Readonly<{ row: GoogleShoppingFeedRowListItem; actorPermissions: readonly string[] }>) {
  return (
    <Stack gap={1}>
      <LinkText href={withSelected(row.rowId)}>{row.listingId}</LinkText>
      <Text size="xs" tone="secondary">
        {row.merchantOfferId}
      </Text>
      <Inline gap={2}>
        <LinkButton href={row.canonicalUrl} size="sm" tone="ghost" target="_blank" rel="noreferrer">
          {t(`${routeKey}.publicListing`)}
        </LinkButton>
        {hasPermission(actorPermissions, "accounts.view") ? (
          <LinkButton href={`/access/accounts/${row.accountId}`} size="sm" tone="ghost">
            {t(`${routeKey}.account`)}
          </LinkButton>
        ) : null}
        {hasPermission(actorPermissions, "catalog.view") ? (
          <LinkButton href={`/catalog/catalog-items/${row.catalogItemId}`} size="sm" tone="ghost">
            {t(`${routeKey}.catalogItem`)}
          </LinkButton>
        ) : null}
      </Inline>
    </Stack>
  );
}

function hasPermission(actorPermissions: readonly string[], permission: string) {
  return actorPermissions.includes(permission);
}

function EligibilityCell({ row }: Readonly<{ row: GoogleShoppingFeedRowListItem }>) {
  const reasons = [...row.exclusionReasons, ...row.imageExclusionReasons];
  return (
    <Stack gap={1}>
      <Inline gap={1}>
        <Badge tone={row.eligibilityStatus === "eligible" ? "success" : "warning"}>{row.eligibilityStatus}</Badge>
        {row.pendingDelete ? <Badge tone="warning">{t(`${routeKey}.pendingDelete`)}</Badge> : null}
        {row.stale ? <Badge tone="info">{t(`${routeKey}.stale`)}</Badge> : null}
      </Inline>
      <Text size="xs" tone="secondary">
        {reasons.length > 0 ? reasons.join(", ") : t(`${routeKey}.noExclusions`)}
      </Text>
    </Stack>
  );
}

function SyncCell({ row }: Readonly<{ row: GoogleShoppingFeedRowListItem }>) {
  return (
    <Stack gap={1}>
      <Badge tone={syncTone(row.syncStatus)}>{row.syncStatus}</Badge>
      <Text size="xs" tone="secondary">
        {row.lastSyncErrorCode ?? row.lastProviderOperation ?? t(`${routeKey}.noProviderOperation`)}
      </Text>
    </Stack>
  );
}

function DiagnosticsCell({ row }: Readonly<{ row: GoogleShoppingFeedRowListItem }>) {
  return (
    <Stack gap={1}>
      <Badge tone={diagnosticTone(row.diagnosticStatus)}>{row.diagnosticStatus ?? t(`${routeKey}.unknown`)}</Badge>
      <Text size="xs" tone="secondary">
        {t(`${routeKey}.issueSummary`, {
          active: row.activeIssueCount,
          unknown: row.unknownIssueCodeCount,
        })}
      </Text>
    </Stack>
  );
}

function SelectedRowDetail({ row }: Readonly<{ row: GoogleShoppingFeedRowListItem }>) {
  return (
    <DetailPanel
      title={t(`${routeKey}.selectedRow`, { listingId: row.listingId })}
      actions={
        <Inline>
          <Button type="button" tone="secondary" size="sm" disabled>
            {t(`${routeKey}.targetedRetryGated`)}
          </Button>
          <LinkButton href={liveGateIssueHref} tone="secondary" size="sm" target="_blank" rel="noreferrer">
            {t(`${routeKey}.liveGateAction`)}
          </LinkButton>
          <LinkButton href={routePath} tone="secondary" size="sm">
            {t(`${routeKey}.closeDetail`)}
          </LinkButton>
        </Inline>
      }
    >
      <Stack gap={4}>
        <KeyValueList
          density="compact"
          items={[
            { key: t(`${routeKey}.rowId`), value: breakable(row.rowId) },
            { key: t(`${routeKey}.listing`), value: breakable(row.listingId) },
            { key: t(`${routeKey}.account`), value: breakable(row.accountId) },
            { key: t(`${routeKey}.product`), value: breakable(row.productId) },
            { key: t(`${routeKey}.catalogItem`), value: breakable(row.catalogItemId) },
            { key: t(`${routeKey}.merchantOfferId`), value: breakable(row.merchantOfferId) },
            { key: t(`${routeKey}.externalSellerId`), value: breakable(row.externalSellerId) },
            { key: t(`${routeKey}.payloadHash`), value: breakable(row.payloadHash) },
            { key: t(`${routeKey}.lastSubmittedPayloadHash`), value: breakable(row.lastSubmittedPayloadHash) },
            { key: t(`${routeKey}.providerOperation`), value: row.lastProviderOperation ?? t(`${routeKey}.none`) },
            { key: t(`${routeKey}.syncErrorCode`), value: row.lastSyncErrorCode ?? t(`${routeKey}.none`) },
            { key: t(`${routeKey}.syncErrorMessage`), value: row.lastSyncErrorMessage ?? t(`${routeKey}.none`) },
            { key: t(`${routeKey}.lastSubmittedAt`), value: formatSyncDateTime(row.lastSubmittedAt) },
            { key: t(`${routeKey}.lastAcceptedAt`), value: formatSyncDateTime(row.lastAcceptedAt) },
            { key: t(`${routeKey}.lastDiagnosticAt`), value: formatSyncDateTime(row.lastDiagnosticAt) },
            { key: t(`${routeKey}.shippingPolicyUrl`), value: breakable(row.shippingPolicyUrl) },
            { key: t(`${routeKey}.returnPolicyUrl`), value: breakable(row.returnPolicyUrl) },
            { key: t(`${routeKey}.returnPolicyLabel`), value: breakable(row.returnPolicyLabel) },
            { key: t(`${routeKey}.owners`), value: row.remediationOwners.join(", ") },
          ]}
        />
        <DataTable
          density="compact"
          rows={[
            {
              signal: t(`${routeKey}.eligibility`),
              status: row.eligibilityStatus,
              reasons: row.exclusionReasons.join(", ") || t(`${routeKey}.none`),
            },
            {
              signal: t(`${routeKey}.imageEligibility`),
              status: row.imageEligibilityStatus,
              reasons: row.imageExclusionReasons.join(", ") || t(`${routeKey}.none`),
            },
            {
              signal: t(`${routeKey}.diagnostics`),
              status: row.diagnosticStatus ?? t(`${routeKey}.unknown`),
              reasons: t(`${routeKey}.issueSummary`, {
                active: row.activeIssueCount,
                unknown: row.unknownIssueCodeCount,
              }),
            },
          ]}
          getRowId={(item) => item.signal}
          columns={[
            { key: "signal", header: t(`${routeKey}.signal`), cell: (item) => item.signal },
            { key: "status", header: t(`${routeKey}.status`), cell: (item) => item.status },
            { key: "reasons", header: t(`${routeKey}.reasons`), cell: (item) => item.reasons },
          ]}
        />
      </Stack>
    </DetailPanel>
  );
}

function filterItems() {
  const filters: readonly GoogleShoppingFeedRowFilter[] = [
    "all",
    "eligible",
    "excluded",
    "failed",
    "disapproved",
    "pending-delete",
    "stale",
    "nearing-refresh",
    "pending-diagnostics",
  ];

  return filters.map((value) => ({ value, label: t(`${routeKey}.filter.${value}`) }));
}

function buildAppliedFilters(filters: GoogleShoppingOperationsFilters) {
  const applied: Array<{ id: string; label: string }> = [];
  if (filters.search) {
    applied.push({ id: "search", label: t(`${routeKey}.searchFilter`, { search: filters.search }) });
  }
  if (filters.filter !== "all") {
    applied.push({
      id: "filter",
      label: t(`${routeKey}.rowFilter`, { filter: t(`${routeKey}.filter.${filters.filter}`) }),
    });
  }
  if (filters.limit !== 100) {
    applied.push({ id: "limit", label: t(`${routeKey}.limitFilter`, { limit: filters.limit }) });
  }
  if (filters.refreshWindowDays !== 25) {
    applied.push({
      id: "refreshWindowDays",
      label: t(`${routeKey}.refreshWindowDaysFilter`, { days: filters.refreshWindowDays }),
    });
  }
  return applied;
}

function resolveSelectedRow(rows: readonly GoogleShoppingFeedRowListItem[], selected: string) {
  return rows.find((row) => row.rowId === selected) ?? rows.find((row) => row.blockingIssueCount > 0) ?? null;
}

function withSelected(rowId: string) {
  const query = new URLSearchParams({ selected: rowId });
  return `${routePath}?${query.toString()}`;
}

function googleShoppingJobEventsUrl(jobId: string) {
  return `/api/marketplace/google-shopping/sync-jobs/${encodeURIComponent(jobId)}/events`;
}

function jobStatusTone(status: GoogleShoppingFullSyncJobStatus["status"] | undefined): Tone {
  return status === "completed"
    ? "success"
    : status === "failed"
      ? "danger"
      : status === "running"
        ? "info"
        : "warning";
}

function summaryTone(count: number): Tone {
  return count > 0 ? "warning" : "success";
}

function syncTone(status: string): Tone {
  return status === "failed" ? "danger" : status === "submitted" ? "success" : "neutral";
}

function diagnosticTone(status: string | null): Tone {
  return status === "disapproved"
    ? "danger"
    : status === "approved"
      ? "success"
      : status === "pending"
        ? "info"
        : "warning";
}

function formatCount(value: number) {
  return value.toLocaleString();
}

function formatSyncDateTime(value: string | null) {
  if (!value) {
    return t(`${routeKey}.none`);
  }

  return formatDateTime(value, { preset: "short" });
}

function breakable(value: string | null) {
  return (
    <Text element="span" wrap="anywhere">
      {value ?? t(`${routeKey}.none`)}
    </Text>
  );
}
