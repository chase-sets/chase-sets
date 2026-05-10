import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Card,
  DataTable,
  Inline,
  LinkButton,
  MarketplaceDashboardPanel,
  MarketplaceNotice,
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

function actionLabel(row: AccountRecommendationListItem) {
  switch (row.action_type) {
    case "active-listing-price-update":
      return t("pricing.features.recommendations.ui.recommendationListPage.update.active");
    case "draft-listing-price-update":
      return t("pricing.features.recommendations.ui.recommendationListPage.update.draft");
    case "draft-listing-create":
      return t("pricing.features.recommendations.ui.recommendationListPage.create.draft");
    default:
      return row.action_type;
  }
}

function statusTone(row: AccountRecommendationListItem) {
  switch (row.status) {
    case "applied":
      return "success" as const;
    case "failed":
      return "danger" as const;
    case "dismissed":
      return "neutral" as const;
    default:
      return "info" as const;
  }
}

export function PricingRecommendationListPage({
  recommendations,
  message,
  errorMessage,
}: {
  recommendations: readonly AccountRecommendationListItem[];
  message?: string | null;
  errorMessage?: string | null;
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
            <form method="post">
              <Button
                type="submit"
                name="intent"
                value="refresh-recommendations"
                tone="primary"
              >
                {t("pricing.features.recommendations.ui.recommendationListPage.refresh")}
              </Button>
            </form>
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

      {message ? (
        <MarketplaceNotice
          tone="success"
          title={t("pricing.features.recommendations.ui.recommendationListPage.pricing")}
          description={message}
        />
      ) : null}

      {errorMessage ? (
        <MarketplaceNotice
          tone="error"
          title={t("pricing.features.recommendations.ui.recommendationListPage.pricing")}
          description={errorMessage}
        />
      ) : null}

      <PageSection title={t("pricing.features.recommendations.ui.recommendationListPage.recommendations")}>
        <form method="post">
          <Stack gap={4}>
            <Card>
              <Inline align="center">
                <Text>
                  {t("pricing.features.recommendations.ui.recommendationListPage.batch.notice")}
                </Text>
                <Inline>
                  <Button
                    type="submit"
                    name="intent"
                    value="apply-recommendations"
                    tone="primary"
                  >
                    {t("pricing.features.recommendations.ui.recommendationListPage.apply.selected")}
                  </Button>
                  <Button
                    type="submit"
                    name="intent"
                    value="dismiss-recommendations"
                    tone="ghost"
                  >
                    {t("pricing.features.recommendations.ui.recommendationListPage.dismiss.selected")}
                  </Button>
                </Inline>
              </Inline>
            </Card>
            <DataTable
              rows={[...recommendations]}
              getRowId={(row) => row.recommendation_id}
              columns={[
                {
                  key: "select",
                  header: t("pricing.features.recommendations.ui.recommendationListPage.select"),
                  cell: (row) => (
                    <input
                      aria-label={t("pricing.features.recommendations.ui.recommendationListPage.select.recommendation", {
                        item: title(row),
                      })}
                      type="checkbox"
                      name="recommendationId"
                      value={row.recommendation_id}
                      disabled={row.status === "applied" || row.status === "dismissed"}
                    />
                  ),
                },
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
                      <Inline>
                        <Badge tone={row.catalog_item_status === "active" ? "success" : "neutral"}>
                          {row.catalog_item_status ?? t("pricing.features.recommendations.ui.recommendationListPage.unknown")}
                        </Badge>
                        <Badge tone={statusTone(row)}>{row.status}</Badge>
                      </Inline>
                    </Stack>
                  ),
                },
                {
                  key: "action",
                  header: t("pricing.features.recommendations.ui.recommendationListPage.action"),
                  cell: (row) => (
                    <Stack gap={1}>
                      <Text>{actionLabel(row)}</Text>
                      <Text size="sm" tone="secondary">
                        {row.market_signal_type === "offer"
                          ? t("pricing.features.recommendations.ui.recommendationListPage.offer.anchor")
                          : t("pricing.features.recommendations.ui.recommendationListPage.competition.anchor")}
                      </Text>
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
                        {t("pricing.features.recommendations.ui.recommendationListPage.current.price", {
                          amount: money(row.current_price_amount, row.market_currency),
                        })}
                      </Text>
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
                      {row.last_error ? (
                        <Text size="sm" tone="accent">{row.last_error}</Text>
                      ) : null}
                    </Stack>
                  ),
                },
              ]}
              emptyTitle={t("pricing.features.recommendations.ui.recommendationListPage.no.recommendations")}
              emptyDescription={t("pricing.features.recommendations.ui.recommendationListPage.feed.data.will.appear")}
            />
          </Stack>
        </form>
      </PageSection>
    </Page>
  );
}
