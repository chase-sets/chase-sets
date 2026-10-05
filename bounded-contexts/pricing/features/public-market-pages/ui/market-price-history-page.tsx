import { formatDate, formatMoney, t } from "@chase-sets/localization";
import { Fragment } from "react";
import {
  Badge,
  Breadcrumbs,
  ChaseRoot,
  Container,
  Grid,
  Heading,
  LinkButton,
  NumericValue,
  Page,
  PageSection,
  Stack,
  Text,
  TimeSeriesChart,
  type TimeSeriesSeries,
} from "@chase-sets/design-system";
import type { PublicMarketPageData } from "../read-model/queries";

function money(amount: string | null, currencyCode: string | undefined): string {
  return amount && currencyCode
    ? formatMoney(amount, currencyCode)
    : t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.no.data");
}

function percent(ratio: string | null): string | null {
  if (!ratio) {
    return null;
  }
  const value = Number(ratio);
  return Number.isFinite(value) ? `${Math.round(value * 100)}%` : null;
}

function toChartSeries(
  series: PublicMarketPageData["series"],
  label: string,
  currencyCode: string | undefined,
): TimeSeriesSeries {
  return {
    id: "median-price",
    name: label,
    tone: "accent",
    points: series
      .filter((point) => point.medianPriceAmount !== null || point.lastPriceAmount !== null)
      .map((point) => ({
        timestamp: Date.parse(`${point.day}T00:00:00.000Z`),
        value: Number(point.medianPriceAmount ?? point.lastPriceAmount),
        label: t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.chart.point", {
          date: formatDate(point.day),
          amount: money(point.medianPriceAmount ?? point.lastPriceAmount, currencyCode),
        }),
      })),
    band: series
      .filter((point) => point.minPriceAmount !== null && point.maxPriceAmount !== null)
      .map((point) => ({
        timestamp: Date.parse(`${point.day}T00:00:00.000Z`),
        min: Number(point.minPriceAmount),
        max: Number(point.maxPriceAmount),
      })),
  };
}

export type MarketPriceHistoryPageProps = Readonly<{
  page: PublicMarketPageData;
  /** Absolute marketplace item-detail URL for the "view listings" / "sell yours" / "create alert" CTAs. */
  marketplaceItemUrl: string;
}>;

export function MarketPriceHistoryPage({ page, marketplaceItemUrl }: MarketPriceHistoryPageProps) {
  const { title, subtitle, aggregates, marketState, series } = page;
  // Preserve the original empty chart/stats furniture when there is no trade-derived currency.
  const displays = aggregates.length ? aggregates : [null];

  return (
    <ChaseRoot>
      <Stack as="main" gap={0}>
        <Page width="wide">
          <Container width="content">
            <Stack gap={6}>
              <Breadcrumbs
                items={[
                  { label: t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.home"), href: "/" },
                  { label: title },
                ]}
              />

              <Stack gap={2}>
                <Heading level={1} visualSize={1}>
                  {title}
                </Heading>
                {subtitle ? (
                  <Text size="md" tone="secondary">
                    {subtitle}
                  </Text>
                ) : null}
              </Stack>

              {displays.map((aggregate, index) => {
                const currencyCode = aggregate?.currencyCode;
                const chartSeries = toChartSeries(
                  series.filter((point) => point.currencyCode === currencyCode),
                  title,
                  currencyCode,
                );
                const sellThrough30d = percent(aggregate?.sellThroughRate ?? null);
                return (
                  <Fragment key={currencyCode ?? "no-trades"}>
                    <PageSection
                      data-testid="market-price-history-chart-furniture"
                      title={
                        aggregates.length > 1
                          ? t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.price.history.currency", {
                              currencyCode,
                            })
                          : t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.price.history")
                      }
                    >
                      <TimeSeriesChart
                        series={[chartSeries]}
                        label={t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.chart.label", {
                          item: title,
                        })}
                        formatValue={(value) => money(value.toFixed(2), currencyCode)}
                        minimumSamples={2}
                      />
                    </PageSection>

                    <PageSection
                      data-testid="market-price-history-stats-furniture"
                      title={
                        aggregates.length > 1
                          ? t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.market.stats.currency", {
                              currencyCode,
                            })
                          : t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.market.stats")
                      }
                    >
                      <Grid columns={{ base: 1, sm: 2, lg: 4 }} gap={4}>
                        <Stack gap={1}>
                          <Text size="sm" tone="secondary">
                            {t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.last.sold")}
                          </Text>
                          <Heading level={2} visualSize={4}>
                            {aggregate?.lastSoldPriceAmount ? (
                              <NumericValue>{money(aggregate.lastSoldPriceAmount, currencyCode)}</NumericValue>
                            ) : (
                              money(null, currencyCode)
                            )}
                          </Heading>
                          {aggregate?.lastSoldAt ? (
                            <Text size="sm" tone="secondary">
                              {formatDate(aggregate.lastSoldAt)}
                            </Text>
                          ) : null}
                        </Stack>
                        <Stack gap={1}>
                          <Text size="sm" tone="secondary">
                            {t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.median.30.day")}
                          </Text>
                          <Heading level={2} visualSize={4}>
                            {aggregate?.medianPrice30d ? (
                              <NumericValue>{money(aggregate.medianPrice30d, currencyCode)}</NumericValue>
                            ) : (
                              money(null, currencyCode)
                            )}
                          </Heading>
                          <Text size="sm" tone="secondary">
                            {t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.trades.count", {
                              count: aggregate?.tradeCount30d ?? 0,
                            })}
                          </Text>
                        </Stack>
                        <Stack gap={1}>
                          <Text size="sm" tone="secondary">
                            {t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.median.90.day")}
                          </Text>
                          <Heading level={2} visualSize={4}>
                            {aggregate?.medianPrice90d ? (
                              <NumericValue>{money(aggregate.medianPrice90d, currencyCode)}</NumericValue>
                            ) : (
                              money(null, currencyCode)
                            )}
                          </Heading>
                          <Text size="sm" tone="secondary">
                            {t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.trades.count", {
                              count: aggregate?.tradeCount90d ?? 0,
                            })}
                          </Text>
                        </Stack>
                        <Stack gap={1}>
                          <Text size="sm" tone="secondary">
                            {t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.active.listings")}
                          </Text>
                          <Heading level={2} visualSize={4}>
                            {marketState?.activeListingCount ?? 0}
                          </Heading>
                          {index === 0 ? (
                            page.liveAsks.length ? (
                              page.liveAsks.map((ask) => (
                                <Text key={ask.currencyCode} size="sm" tone="secondary">
                                  {t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.starting.at", {
                                    amount: money(ask.minAskAmount, ask.currencyCode),
                                  })}
                                </Text>
                              ))
                            ) : (
                              <Text size="sm" tone="secondary">
                                {page.unpricedBuyableListingCount > 0
                                  ? t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.price.unavailable")
                                  : t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.no.live.asks")}
                              </Text>
                            )
                          ) : null}
                        </Stack>
                      </Grid>
                      {sellThrough30d ? (
                        <Badge tone="info">
                          {t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.sell.through", {
                            rate: sellThrough30d,
                          })}
                        </Badge>
                      ) : null}
                    </PageSection>
                  </Fragment>
                );
              })}

              <PageSection title={t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.buy.or.sell")}>
                <Stack gap={3} direction={{ base: "column", sm: "row" }}>
                  <LinkButton href={marketplaceItemUrl} tone="primary">
                    {t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.view.active.listings")}
                  </LinkButton>
                  <LinkButton href={marketplaceItemUrl} tone="secondary">
                    {t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.create.a.price.alert")}
                  </LinkButton>
                  <LinkButton href={marketplaceItemUrl} tone="secondary">
                    {t("pricing.features.publicMarketPages.ui.marketPriceHistoryPage.sell.yours")}
                  </LinkButton>
                </Stack>
              </PageSection>
            </Stack>
          </Container>
        </Page>
      </Stack>
    </ChaseRoot>
  );
}
