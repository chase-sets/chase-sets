import { formatDate, formatMoney, t } from "@chase-sets/localization";
import {
  Badge,
  DataTable,
  EmptyState,
  Form,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Stat,
  StatGrid,
  Text,
  TimeSeriesChart,
} from "@chase-sets/design-system";
import type {
  GmvReconciliationRun,
  OpsDashboardSeriesResponse,
  OpsDashboardSummaryResponse,
  OpsGranularity,
} from "../api/ops-dashboard-client";

const rangeItems = [
  { value: "7", label: t("platformOperations.opsDashboard.range.last7Days") },
  { value: "30", label: t("platformOperations.opsDashboard.range.last30Days") },
  { value: "90", label: t("platformOperations.opsDashboard.range.last90Days") },
  { value: "365", label: t("platformOperations.opsDashboard.range.last365Days") },
];

const granularityItems: { value: OpsGranularity; label: string }[] = [
  { value: "daily", label: t("platformOperations.opsDashboard.granularity.daily") },
  { value: "weekly", label: t("platformOperations.opsDashboard.granularity.weekly") },
  { value: "monthly", label: t("platformOperations.opsDashboard.granularity.monthly") },
];

// Every amount rendered on this page is USD-denominated: pricing's Trades
// Tape and settlement's ledger both post amounts without a per-row currency
// column in the query surfaces this page consumes, matching this
// marketplace's USD-only launch posture elsewhere in the codebase.
const CURRENCY_CODE = "usd";

function money(amount: string): string {
  return formatMoney(amount, CURRENCY_CODE);
}

function formatDateTime(value: string): string {
  return new Date(value).toLocaleString();
}

function reconciliationStatusTone(status: GmvReconciliationRun["status"]) {
  return status === "drift-alarm" ? "danger" : "success";
}

export function OpsDashboardAdminPage({
  summary,
  series,
  reconciliationRuns,
  filters,
}: {
  summary: OpsDashboardSummaryResponse;
  series: OpsDashboardSeriesResponse;
  reconciliationRuns: readonly GmvReconciliationRun[];
  filters: Readonly<{ rangeDays: string; granularity: OpsGranularity }>;
}) {
  const chartSeries = [
    {
      id: "gmv",
      name: t("platformOperations.opsDashboard.chart.gmv"),
      points: series.series.map((point) => ({
        timestamp: new Date(point.day).getTime(),
        value: Number(point.gmvAmount),
        label: t("platformOperations.opsDashboard.chart.pointLabel", {
          date: formatDate(point.day),
          amount: money(point.gmvAmount),
        }),
      })),
    },
  ];

  return (
    <Page>
      <PageHeader
        eyebrow={t("platformOperations.opsDashboard.eyebrow")}
        title={t("platformOperations.opsDashboard.title")}
        description={t("platformOperations.opsDashboard.description")}
      />

      <PageSection title={t("platformOperations.opsDashboard.range")}>
        <Form spacing="none" method="get">
          <Stack direction={{ base: "column", md: "row" }} gap={2}>
            <NativeSelect
              label={t("platformOperations.opsDashboard.rangeLabel")}
              name="rangeDays"
              defaultValue={filters.rangeDays}
              items={rangeItems}
            />
            <NativeSelect
              label={t("platformOperations.opsDashboard.granularityLabel")}
              name="granularity"
              defaultValue={filters.granularity}
              items={granularityItems}
            />
          </Stack>
        </Form>
      </PageSection>

      <StatGrid columns={{ base: 1, md: 3 }}>
        <Stat label={t("platformOperations.opsDashboard.gmv")} value={money(summary.summary.gmvAmount)} />
        <Stat label={t("platformOperations.opsDashboard.tradeCount")} value={summary.summary.tradeCount} />
        <Stat label={t("platformOperations.opsDashboard.orderCount")} value={summary.summary.orderCount} />
        <Stat label={t("platformOperations.opsDashboard.activeBuyers")} value={summary.summary.activeBuyerCount} />
        <Stat label={t("platformOperations.opsDashboard.activeSellers")} value={summary.summary.activeSellerCount} />
        <Stat
          label={t("platformOperations.opsDashboard.verifiedTradeCount")}
          value={summary.summary.verifiedTradeCount}
        />
      </StatGrid>

      <PageSection title={t("platformOperations.opsDashboard.trend")}>
        <TimeSeriesChart
          series={chartSeries}
          label={t("platformOperations.opsDashboard.trendChartLabel")}
          formatValue={(value) => money(value.toFixed(2))}
        />
      </PageSection>

      <PageSection title={t("platformOperations.opsDashboard.liquidity")}>
        <StatGrid columns={{ base: 1, md: 3 }}>
          <Stat
            label={t("platformOperations.opsDashboard.sellThroughRate")}
            value={
              summary.liquidity.sellThroughRate
                ? `${(Number(summary.liquidity.sellThroughRate) * 100).toFixed(1)}%`
                : t("platformOperations.opsDashboard.notAvailable")
            }
          />
          <Stat
            label={t("platformOperations.opsDashboard.medianSpread")}
            value={
              summary.liquidity.medianSpreadAmount
                ? money(summary.liquidity.medianSpreadAmount)
                : t("platformOperations.opsDashboard.notAvailable")
            }
          />
          <Stat
            label={t("platformOperations.opsDashboard.spreadSampleCount")}
            value={summary.liquidity.spreadSampleCount}
          />
        </StatGrid>
        <Text tone="secondary" size="sm">
          {t("platformOperations.opsDashboard.timeToSaleUnavailable")}
        </Text>
      </PageSection>

      <PageSection title={t("platformOperations.opsDashboard.topCatalogItems")}>
        <DataTable
          columns={[
            {
              key: "title",
              header: t("platformOperations.opsDashboard.catalogItem"),
              cell: (item) => item.title ?? item.catalogItemId,
            },
            { key: "gmv", header: t("platformOperations.opsDashboard.gmv"), cell: (item) => money(item.gmvAmount) },
            { key: "trades", header: t("platformOperations.opsDashboard.tradeCount"), cell: (item) => item.tradeCount },
            { key: "units", header: t("platformOperations.opsDashboard.unitVolume"), cell: (item) => item.unitVolume },
          ]}
          rows={[...summary.topCatalogItems]}
          getRowId={(item) => item.catalogItemId}
          emptyTitle={t("platformOperations.opsDashboard.topCatalogItemsEmptyTitle")}
          emptyDescription={t("platformOperations.opsDashboard.topCatalogItemsEmptyDescription")}
        />
      </PageSection>

      <PageSection title={t("platformOperations.opsDashboard.reconciliation")}>
        <Text tone="secondary" size="sm">
          {t("platformOperations.opsDashboard.reconciliationDescription")}
        </Text>
        {reconciliationRuns.length === 0 ? (
          <EmptyState
            icon="chart"
            title={t("platformOperations.opsDashboard.reconciliationEmptyTitle")}
            description={t("platformOperations.opsDashboard.reconciliationEmptyDescription")}
          />
        ) : (
          <DataTable
            columns={[
              { key: "month", header: t("platformOperations.opsDashboard.month"), cell: (run) => run.yearMonth },
              {
                key: "status",
                header: t("platformOperations.opsDashboard.status"),
                cell: (run) => (
                  <Badge tone={reconciliationStatusTone(run.status)}>
                    {run.status === "drift-alarm"
                      ? t("platformOperations.opsDashboard.statusDriftAlarm")
                      : t("platformOperations.opsDashboard.statusOk")}
                  </Badge>
                ),
              },
              {
                key: "tape",
                header: t("platformOperations.opsDashboard.tapeGmv"),
                cell: (run) => money(run.tapeGmvAmount),
              },
              {
                key: "ledger",
                header: t("platformOperations.opsDashboard.ledgerSaleTotal"),
                cell: (run) => money(run.ledgerSaleAmount),
              },
              {
                key: "delta",
                header: t("platformOperations.opsDashboard.delta"),
                cell: (run) =>
                  run.deltaRatio
                    ? `${money(run.deltaAmount)} (${(Number(run.deltaRatio) * 100).toFixed(1)}%)`
                    : money(run.deltaAmount),
              },
              {
                key: "completedAt",
                header: t("platformOperations.opsDashboard.completedAt"),
                cell: (run) => formatDateTime(run.completedAt),
              },
            ]}
            rows={[...reconciliationRuns]}
            getRowId={(run) => run.reconciliationRunId}
            emptyTitle={t("platformOperations.opsDashboard.reconciliationEmptyTitle")}
            emptyDescription={t("platformOperations.opsDashboard.reconciliationEmptyDescription")}
          />
        )}
      </PageSection>
    </Page>
  );
}
