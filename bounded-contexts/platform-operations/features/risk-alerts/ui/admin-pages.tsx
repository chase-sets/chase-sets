import { formatDateTime, t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  DataTable,
  DetailPanel,
  FilterBar,
  Form,
  Grid,
  KeyValueList,
  LinkButton,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Stat,
  StatGrid,
  Text,
  Textarea,
} from "@chase-sets/design-system";
import type { RiskAlertQueueDetail, RiskAlertQueueItem, RiskAlertQueueMetrics } from "../api/contracts";

type ListResponse<T> = Readonly<{ items: readonly T[]; total: number; count: number }>;

const statusItems = [
  { value: "all", label: t("platformOperations.riskAlerts.allStatuses") },
  { value: "needs-review", label: t("platformOperations.riskAlerts.status.needsReview") },
  {
    value: "manual-payout-review-requested",
    label: t("platformOperations.riskAlerts.status.manualPayoutReviewRequested"),
  },
  { value: "acknowledged", label: t("platformOperations.riskAlerts.status.acknowledged") },
];

const kindItems = [
  { value: "all", label: t("platformOperations.riskAlerts.allKinds") },
  { value: "chargeback-velocity", label: t("platformOperations.riskAlerts.kind.chargebackVelocity") },
  { value: "new-seller-listing-velocity", label: t("platformOperations.riskAlerts.kind.listingVelocity") },
  { value: "review-velocity", label: t("platformOperations.riskAlerts.kind.reviewVelocity") },
  { value: "young-buyer-spend-velocity", label: t("platformOperations.riskAlerts.kind.buyerSpendVelocity") },
];

function formatAlertDateTime(value: string | null) {
  return value ? formatDateTime(value) : t("platformOperations.riskAlerts.notSet");
}

function statusLabel(status: string) {
  return statusItems.find((item) => item.value === status)?.label ?? status;
}

function kindLabel(kind: string) {
  return kindItems.find((item) => item.value === kind)?.label ?? kind;
}

function statusTone(status: string) {
  return status === "needs-review" ? "warning" : "neutral";
}

function evidenceSummary(item: RiskAlertQueueItem) {
  return Object.entries(item.evidence)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join(", ");
}

function jsonEntries(value: Record<string, unknown>) {
  return Object.entries(value).map(([key, entry]) => ({ key, value: String(entry) }));
}

export function RiskAlertAdminListPage({
  queue,
  metrics,
  filters,
}: {
  queue: ListResponse<RiskAlertQueueItem>;
  metrics: RiskAlertQueueMetrics;
  filters: Readonly<{ status: string; alertKind: string }>;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("platformOperations.riskAlerts.eyebrow")}
        title={t("platformOperations.riskAlerts.title")}
        description={t("platformOperations.riskAlerts.description")}
      />
      <StatGrid columns={{ base: 1, md: 3 }}>
        <Stat label={t("platformOperations.riskAlerts.total")} value={metrics.total_count} />
        <Stat label={t("platformOperations.riskAlerts.needsReview")} value={metrics.needs_review_count} />
        <Stat
          label={t("platformOperations.riskAlerts.manualPayoutReviewCandidates")}
          value={metrics.manual_payout_review_candidate_count}
        />
      </StatGrid>
      <PageSection title={t("platformOperations.riskAlerts.filters")}>
        <Form spacing="none" method="get">
          <FilterBar sticky={false}>
            <NativeSelect
              label={t("platformOperations.riskAlerts.status")}
              name="status"
              defaultValue={filters.status}
              items={statusItems}
            />
            <NativeSelect
              label={t("platformOperations.riskAlerts.alertKind")}
              name="alertKind"
              defaultValue={filters.alertKind}
              items={kindItems}
            />
          </FilterBar>
          <Button type="submit" leadingIcon="filter">
            {t("platformOperations.riskAlerts.applyFilters")}
          </Button>
        </Form>
      </PageSection>
      <PageSection title={t("platformOperations.riskAlerts.queue")}>
        <DataTable<RiskAlertQueueItem>
          columns={[
            {
              key: "status",
              header: t("platformOperations.riskAlerts.status"),
              cell: (item) => <Badge tone={statusTone(item.status)}>{statusLabel(item.status)}</Badge>,
            },
            {
              key: "kind",
              header: t("platformOperations.riskAlerts.alertKind"),
              cell: (item) => kindLabel(item.alert_kind),
            },
            { key: "account", header: t("platformOperations.riskAlerts.account"), cell: (item) => item.account_id },
            {
              key: "candidate",
              header: t("platformOperations.riskAlerts.manualPayoutReviewCandidate"),
              cell: (item) =>
                item.manual_payout_review_candidate
                  ? t("platformOperations.riskAlerts.yes")
                  : t("platformOperations.riskAlerts.no"),
            },
            { key: "evidence", header: t("platformOperations.riskAlerts.evidence"), cell: evidenceSummary },
            {
              key: "last",
              header: t("platformOperations.riskAlerts.lastTriggered"),
              cell: (item) => formatAlertDateTime(item.last_triggered_at),
            },
            {
              key: "action",
              header: t("platformOperations.riskAlerts.action"),
              cell: (item) => (
                <LinkButton href={`/support/risk-alerts/${item.alert_id}`} size="sm">
                  {t("platformOperations.riskAlerts.open")}
                </LinkButton>
              ),
            },
          ]}
          rows={[...queue.items]}
          getRowId={(item) => item.alert_id}
          emptyTitle={t("platformOperations.riskAlerts.emptyTitle")}
          emptyDescription={t("platformOperations.riskAlerts.emptyDescription")}
        />
        <Text tone="secondary" size="sm">
          {t("platformOperations.riskAlerts.countSummary", { count: queue.count, total: queue.total })}
        </Text>
      </PageSection>
    </Page>
  );
}

export function RiskAlertAdminDetailPage({ item }: { item: RiskAlertQueueDetail }) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("platformOperations.riskAlerts.eyebrow")}
        title={t("platformOperations.riskAlerts.detailTitle", { alertKind: kindLabel(item.alert_kind) })}
        description={t("platformOperations.riskAlerts.detailDescription")}
      />
      <Stack gap={3}>
        <LinkButton href="/support/risk-alerts" tone="secondary">
          {t("platformOperations.riskAlerts.back")}
        </LinkButton>
      </Stack>
      <Grid columns={{ base: 1, xl: 2 }} gap={4}>
        <DetailPanel title={t("platformOperations.riskAlerts.queueItem")}>
          <KeyValueList
            items={[
              { key: t("platformOperations.riskAlerts.status"), value: statusLabel(item.status) },
              { key: t("platformOperations.riskAlerts.alertKind"), value: kindLabel(item.alert_kind) },
              { key: t("platformOperations.riskAlerts.account"), value: item.account_id },
              { key: t("platformOperations.riskAlerts.severity"), value: item.severity },
              {
                key: t("platformOperations.riskAlerts.manualPayoutReviewCandidate"),
                value: item.manual_payout_review_candidate
                  ? t("platformOperations.riskAlerts.yes")
                  : t("platformOperations.riskAlerts.no"),
              },
              {
                key: t("platformOperations.riskAlerts.firstTriggered"),
                value: formatAlertDateTime(item.first_triggered_at),
              },
              {
                key: t("platformOperations.riskAlerts.lastTriggered"),
                value: formatAlertDateTime(item.last_triggered_at),
              },
            ]}
          />
          <Form spacing="md" method="post">
            <Textarea name="note" label={t("platformOperations.riskAlerts.actionNote")} rows={3} maxLength={1000} />
            <Stack direction={{ base: "column", md: "row" }} gap={2}>
              {item.manual_payout_review_candidate ? (
                <Button
                  type="submit"
                  name="action"
                  value="request-manual-payout-review"
                  tone="danger"
                  leadingIcon="shield"
                >
                  {t("platformOperations.riskAlerts.action.requestManualPayoutReview")}
                </Button>
              ) : null}
              <Button type="submit" name="action" value="acknowledge" tone="secondary" leadingIcon="check">
                {t("platformOperations.riskAlerts.action.acknowledge")}
              </Button>
            </Stack>
          </Form>
          {item.last_action ? (
            <Text size="sm" tone="secondary">
              {t("platformOperations.riskAlerts.lastAction", {
                action: item.last_action,
                timestamp: formatAlertDateTime(item.last_action_at),
              })}
            </Text>
          ) : null}
        </DetailPanel>
        <DetailPanel title={t("platformOperations.riskAlerts.evidence")}>
          <KeyValueList items={jsonEntries(item.evidence)} />
        </DetailPanel>
        <DetailPanel title={t("platformOperations.riskAlerts.threshold")}>
          <KeyValueList items={jsonEntries(item.threshold)} />
        </DetailPanel>
      </Grid>
    </Page>
  );
}
