import { formatDate, formatMoney, t } from "@chase-sets/localization";
import {
  Badge,
  DataTable,
  EmptyState,
  Page,
  PageHeader,
  PageSection,
  Stat,
  StatGrid,
  Text,
} from "@chase-sets/design-system";
import type { OfferEconomicsSummaryResponse } from "../api/offer-economics-client";

// Every amount rendered on this page is USD-denominated, matching the ops
// dashboard's own convention (see ops-dashboard-page.tsx).
const CURRENCY_CODE = "usd";

function money(amount: string): string {
  return formatMoney(amount, CURRENCY_CODE);
}

function percent(ratio: string | null): string {
  return ratio === null ? t("platformOperations.offerEconomics.notAvailable") : `${(Number(ratio) * 100).toFixed(1)}%`;
}

export function OfferEconomicsAdminPage({ snapshot }: { snapshot: OfferEconomicsSummaryResponse["snapshot"] }) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("platformOperations.offerEconomics.eyebrow")}
        title={t("platformOperations.offerEconomics.title")}
        description={t("platformOperations.offerEconomics.description")}
      />

      <PageSection title={t("platformOperations.offerEconomics.window")}>
        <Text tone="secondary" size="sm">
          {t("platformOperations.offerEconomics.windowRange", {
            from: formatDate(snapshot.from),
            to: formatDate(snapshot.to),
          })}
        </Text>
      </PageSection>

      <StatGrid columns={{ base: 1, md: 3 }}>
        <Stat label={t("platformOperations.offerEconomics.listingsCreated")} value={snapshot.listingsCreatedCount} />
        <Stat
          label={t("platformOperations.offerEconomics.lockedSellerAccountCount")}
          value={snapshot.lockedSellerAccountCount}
        />
        <Stat label={t("platformOperations.offerEconomics.lockedGmv")} value={money(snapshot.lockedGmvAmount)} />
        <Stat
          label={t("platformOperations.offerEconomics.lockedGmvShare")}
          value={percent(snapshot.lockedGmvShareRatio)}
        />
        <Stat
          label={t("platformOperations.offerEconomics.foregoneFeeEstimate")}
          value={money(snapshot.foregoneFeeEstimateAmount)}
        />
        <Stat label={t("platformOperations.offerEconomics.platformGmv")} value={money(snapshot.platformGmvAmount)} />
      </StatGrid>

      <PageSection title={t("platformOperations.offerEconomics.standardSchedule")}>
        <Text tone="secondary" size="sm">
          {snapshot.standardScheduleSource.scheduleLabel
            ? t("platformOperations.offerEconomics.standardScheduleDescription", {
                label: snapshot.standardScheduleSource.scheduleLabel,
                percent: (snapshot.standardFeePercentageBps / 100).toFixed(2),
                fixed: money(snapshot.standardFeeFixedAmount),
              })
            : t("platformOperations.offerEconomics.standardScheduleUnavailable")}
        </Text>
      </PageSection>

      <PageSection title={t("platformOperations.offerEconomics.sellThroughTrend")}>
        {snapshot.weeklySellThrough.length === 0 ? (
          <EmptyState
            icon="chart"
            title={t("platformOperations.offerEconomics.sellThroughEmptyTitle")}
            description={t("platformOperations.offerEconomics.sellThroughEmptyDescription")}
          />
        ) : (
          <DataTable
            columns={[
              {
                key: "week",
                header: t("platformOperations.offerEconomics.week"),
                cell: (point) => formatDate(point.weekStart),
              },
              {
                key: "listingsCreated",
                header: t("platformOperations.offerEconomics.listingsCreated"),
                cell: (point) => point.listingsCreatedCount,
              },
              {
                key: "cumulativeListings",
                header: t("platformOperations.offerEconomics.cumulativeListingsCreated"),
                cell: (point) => point.cumulativeListingsCreatedCount,
              },
              {
                key: "cumulativeTrades",
                header: t("platformOperations.offerEconomics.cumulativeTradeCount"),
                cell: (point) => point.cumulativeTradeCount,
              },
              {
                key: "sellThroughRate",
                header: t("platformOperations.offerEconomics.sellThroughRate"),
                cell: (point) => percent(point.sellThroughRate),
              },
            ]}
            rows={[...snapshot.weeklySellThrough]}
            getRowId={(point) => point.weekStart}
            emptyTitle={t("platformOperations.offerEconomics.sellThroughEmptyTitle")}
            emptyDescription={t("platformOperations.offerEconomics.sellThroughEmptyDescription")}
          />
        )}
      </PageSection>

      <PageSection title={t("platformOperations.offerEconomics.protectionReserve")}>
        <Badge tone="neutral">{t("platformOperations.offerEconomics.protectionReservePending")}</Badge>
        <Text tone="secondary" size="sm">
          {snapshot.protectionReserve.reason}
        </Text>
      </PageSection>
    </Page>
  );
}
