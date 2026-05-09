import { t } from "@chase-sets/localization";
import {
  Badge,
  Card,
  DataTable,
  Inline,
  LinkButton,
  MarketplaceDashboardPanel,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { AccountRecommendationListItem } from "../read-model/queries";

function money(amount: number | null, currency = "USD") {
  if (amount === null) {
    return t("pricing.features.recommendations.ui.recommendationListPage.not.set");
  }

  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
  }).format(amount);
}

function title(row: AccountRecommendationListItem) {
  return row.catalog_item_title ?? row.catalog_catalog_item_id;
}

export function PricingRecommendationListPage({
  recommendations,
}: {
  recommendations: readonly AccountRecommendationListItem[];
}) {
  const stockOnHand = recommendations.reduce(
    (sum, row) => sum + row.stock_on_hand_quantity,
    0,
  );
  const activeOffers = recommendations.reduce(
    (sum, row) => sum + row.active_offer_count,
    0,
  );
  const activeListings = recommendations.reduce(
    (sum, row) => sum + row.active_listing_count,
    0,
  );

  return (
    <Page>
      <PageHeader
        eyebrow={t("pricing.features.recommendations.ui.recommendationListPage.seller")}
        title={t("pricing.features.recommendations.ui.recommendationListPage.repricing")}
        description={t("pricing.features.recommendations.ui.recommendationListPage.review.market.signals.and.copy")}
        actions={
          <Inline>
            <LinkButton href="/account/listings" tone="secondary">
              {t("pricing.features.recommendations.ui.recommendationListPage.listings")}</LinkButton>
            <LinkButton href="/account/inventory/imports" tone="ghost">
              {t("pricing.features.recommendations.ui.recommendationListPage.import")}</LinkButton>
          </Inline>
        }
      />

      <MarketplaceDashboardPanel
        title={t("pricing.features.recommendations.ui.recommendationListPage.market.signals")}
        description={t("pricing.features.recommendations.ui.recommendationListPage.pricing.is.advisory")}
        metrics={[
          {
            label: t("pricing.features.recommendations.ui.recommendationListPage.recommendations"),
            value: recommendations.length,
            detail: t("pricing.features.recommendations.ui.recommendationListPage.items.with.feed.data"),
          },
          {
            label: t("pricing.features.recommendations.ui.recommendationListPage.seller.stock"),
            value: stockOnHand,
            detail: t("pricing.features.recommendations.ui.recommendationListPage.units.on.hand"),
          },
          {
            label: t("pricing.features.recommendations.ui.recommendationListPage.active.listings"),
            value: activeListings,
            detail: t("pricing.features.recommendations.ui.recommendationListPage.market.competition"),
          },
          {
            label: t("pricing.features.recommendations.ui.recommendationListPage.active.offers"),
            value: activeOffers,
            detail: t("pricing.features.recommendations.ui.recommendationListPage.buyer.demand"),
          },
        ]}
      />

      <PageSection title={t("pricing.features.recommendations.ui.recommendationListPage.recommendations")}>
        <Card>
          <Text>
            {t("pricing.features.recommendations.ui.recommendationListPage.advisory.notice")}
          </Text>
        </Card>
        <DataTable
          rows={[...recommendations]}
          getRowId={(row) => row.recommendation_id}
          columns={[
            {
              key: "item",
              header: t("pricing.features.recommendations.ui.recommendationListPage.item"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{title(row)}</Text>
                  {row.catalog_item_subtitle ? (
                    <Text size="sm" tone="secondary">
                      {row.catalog_item_subtitle}
                    </Text>
                  ) : null}
                  <Badge tone={row.catalog_item_status === "active" ? "success" : "neutral"}>
                    {row.catalog_item_status ?? t("pricing.features.recommendations.ui.recommendationListPage.unknown")}
                  </Badge>
                </Stack>
              ),
            },
            {
              key: "market",
              header: t("pricing.features.recommendations.ui.recommendationListPage.market"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{money(row.market_price_amount, row.market_currency)}</Text>
                  <Text size="sm" tone="secondary">
                    {t("pricing.features.recommendations.ui.recommendationListPage.lowest.active", {
                      amount: money(row.lowest_listing_price_amount, row.market_currency),
                    })}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "recommended",
              header: t("pricing.features.recommendations.ui.recommendationListPage.recommended"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{money(row.recommended_list_amount, row.market_currency)}</Text>
                  <Text size="sm" tone="secondary">
                    {row.recommendation_reason ?? t("pricing.features.recommendations.ui.recommendationListPage.no.reason")}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "signals",
              header: t("pricing.features.recommendations.ui.recommendationListPage.signals"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text size="sm">
                    {t("pricing.features.recommendations.ui.recommendationListPage.offer.signal", {
                      offers: row.active_offer_count,
                      highest: money(row.highest_offer_price_amount, row.market_currency),
                    })}
                  </Text>
                  <Text size="sm" tone="secondary">
                    {t("pricing.features.recommendations.ui.recommendationListPage.fulfillment.signal", {
                      delivered: row.delivered_quantity,
                      returned: row.returned_quantity,
                    })}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "stock",
              header: t("pricing.features.recommendations.ui.recommendationListPage.stock"),
              align: "right",
              cell: (row) => (
                <Stack gap={1}>
                  <Text>{row.stock_on_hand_quantity}</Text>
                  <Text size="sm" tone="secondary">
                    {t("pricing.features.recommendations.ui.recommendationListPage.reserved", {
                      quantity: row.stock_reserved_quantity,
                    })}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "actions",
              header: t("pricing.features.recommendations.ui.recommendationListPage.actions"),
              cell: (row) => (
                <LinkButton
                  href={`/account/listings?catalogItemId=${encodeURIComponent(row.catalog_catalog_item_id)}&recommendedPrice=${encodeURIComponent(String(row.recommended_list_amount ?? ""))}`}
                  tone="secondary"
                  size="sm"
                >
                  {t("pricing.features.recommendations.ui.recommendationListPage.use.in.draft")}
                </LinkButton>
              ),
            },
          ]}
          emptyTitle={t("pricing.features.recommendations.ui.recommendationListPage.no.recommendations")}
          emptyDescription={t("pricing.features.recommendations.ui.recommendationListPage.feed.data.will.appear")}
        />
      </PageSection>
    </Page>
  );
}
