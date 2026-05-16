import { t } from "@chase-sets/localization";
import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  LinkButton,
  MarketplaceDashboardPanel,
  MarketplaceNotice,
  Page,
  PageHeader,
  PageSection,
  ProductSelectionSummary,
  Stack,
  Text,
  productSelectionDetailsFromSummary,
} from "@chase-sets/design-system";
import type { OfferMatchListItem } from "./contracts";
import type { MarketplaceListingTermsPreview } from "../../listings/ui/contracts";

function statusTone(status: string) {
  switch (status) {
    case "submitted":
      return "accent";
    default:
      return "neutral";
  }
}

function formatMoney(amount: string) {
  return `$${amount}`;
}

function formatAllowancePercentage(bps: number) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(bps / 100)}%`;
}

function formatPriceGap(amount: string) {
  const value = Number(amount);

  if (Number.isNaN(value)) {
    return t("marketplace.features.offers.ui.offerMatchListPage.ask.gap.unknown");
  }

  if (value > 0) {
    return t("marketplace.features.offers.ui.offerMatchListPage.below.ask", {
      amount: formatMoney(value.toFixed(2)),
    });
  }

  if (value < 0) {
    return t("marketplace.features.offers.ui.offerMatchListPage.over.ask", {
      amount: formatMoney(Math.abs(value).toFixed(2)),
    });
  }

  return t("marketplace.features.offers.ui.offerMatchListPage.meets.ask");
}

function termsSource(terms: MarketplaceListingTermsPreview) {
  if (terms.agreement_id) {
    return "Seller terms";
  }

  return terms.schedule_id
    ? "Standard seller terms"
    : t("marketplace.features.offers.ui.offerMatchListPage.standard.terms");
}

function formatTimestamp(value: string) {
  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function ProductSummaryChips({ summary }: { summary: string }) {
  return (
    <ProductSelectionSummary
      selections={productSelectionDetailsFromSummary(summary)}
      summary={summary}
      summaryAsChip
    />
  );
}

export function MarketplaceOfferMatchListPage({
  data,
  cartData,
  cartTermsByOfferId,
  errorMessage,
}: {
  data: { items: readonly OfferMatchListItem[] };
  cartData?: { items: readonly OfferMatchListItem[] };
  cartTermsByOfferId?: Readonly<Record<string, MarketplaceListingTermsPreview>>;
  errorMessage?: string | null;
}) {
  const queuedCount = cartData?.items.length ?? 0;
  const fulfillableCount = data.items.filter((item) => item.can_fulfill).length;
  const atOrAboveAskCount = data.items.filter(
    (item) => item.offer_to_listing_price_bps >= 10000,
  ).length;
  const bestMatchPercentage = data.items.length
    ? formatAllowancePercentage(
        Math.max(...data.items.map((item) => item.offer_to_listing_price_bps)),
      )
    : "0%";
  const listingsUnavailable = data.items.some(
    (item) => item.seller_listing_availability_status === "unavailable",
  );
  const nextAcceptableOffer = data.items.find((item) => item.can_fulfill && item.status === "submitted")
    ?? data.items.find((item) => item.status === "submitted")
    ?? data.items[0];

  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.offers.ui.offerMatchListPage.seller")}
        title={t("marketplace.features.offers.ui.offerMatchListPage.offer.matches")}
        description={t("marketplace.features.offers.ui.offerMatchListPage.compare.best.offers.to.your.listing")}
        actions={
          <LinkButton href="/account/listings" tone="secondary">
            {t("marketplace.features.offers.ui.offerMatchListPage.view.listings")}</LinkButton>
        }
      />

      <MarketplaceDashboardPanel
        title={t("marketplace.features.offers.ui.offerMatchListPage.best.match.snapshot")}
        description={t("marketplace.features.offers.ui.offerMatchListPage.best.match.snapshot.description")}
        metrics={[
          { label: t("marketplace.features.offers.ui.offerMatchListPage.active.matches"), value: data.items.length },
          { label: t("marketplace.features.offers.ui.offerMatchListPage.ready.to.accept"), value: fulfillableCount },
          { label: t("marketplace.features.offers.ui.offerMatchListPage.at.or.above.ask"), value: atOrAboveAskCount },
          { label: t("marketplace.features.offers.ui.offerMatchListPage.best.match"), value: bestMatchPercentage },
          { label: t("marketplace.features.offers.ui.offerMatchListPage.queued"), value: queuedCount },
        ]}
      />

      {errorMessage ? (
        <MarketplaceNotice
          tone="error"
          title={t("marketplace.features.offers.ui.offerMatchListPage.offer.match.issue")}
          description={errorMessage}
        />
      ) : null}

      {listingsUnavailable ? (
        <MarketplaceNotice
          tone="warning"
          title={t("marketplace.features.offers.ui.offerMatchListPage.listings.unavailable")}
          description={t("marketplace.features.offers.ui.offerMatchListPage.turn.listings.on.before.accepting")}
        />
      ) : null}

      <PageSection title={t("marketplace.features.offers.ui.offerMatchListPage.sell.list")}>
        <Card>
          <Stack gap={3}>
            <Banner
              title={t("marketplace.features.offers.ui.offerMatchListPage.seller.shipping.allowance")}
              description={t("marketplace.features.offers.ui.offerMatchListPage.offers.earn.five.percent.of.accepted.value.toward.shipping")}
            />
            <Text tone="secondary" size="sm">
              {queuedCount} offer
              {queuedCount === 1 ? "" : "s"} {t("marketplace.features.offers.ui.offerMatchListPage.queued.in.your.sell.list")}</Text>
            {cartData?.items.length ? (
              <Stack gap={2}>
                {cartData.items.map((item) => {
                  const terms = cartTermsByOfferId?.[item.offer_id] ?? null;

                  return (
                    <Stack key={item.offer_id} gap={1}>
                      <Text size="sm" weight="semibold">{item.item_title}</Text>
                      <Text size="sm" tone="secondary">
                        {t("marketplace.features.offers.ui.offerMatchListPage.sell.list.offer.price", {
                          price: formatMoney(item.price_amount),
                        })}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {t("marketplace.features.offers.ui.offerMatchListPage.sell.list.listing.price", {
                          price: formatMoney(item.listing_price_amount),
                        })}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {t("marketplace.features.offers.ui.offerMatchListPage.sell.list.offer.to.ask", {
                          percentage: formatAllowancePercentage(item.offer_to_listing_price_bps),
                        })}
                      </Text>
                      {terms ? (
                        <>
                          <Text size="sm" tone="secondary">
                            {t("marketplace.features.offers.ui.offerMatchListPage.sell.list.marketplace.fee", {
                              amount: formatMoney(terms.marketplace_sales_fee_unit_amount),
                            })}
                          </Text>
                          <Text size="sm" tone="secondary">
                            {t("marketplace.features.offers.ui.offerMatchListPage.sell.list.seller.net", {
                              amount: formatMoney(terms.seller_net_unit_amount),
                            })}
                          </Text>
                          <Text size="sm" tone="secondary">
                            {t("marketplace.features.offers.ui.offerMatchListPage.sell.list.shipping.allowance", {
                              percentage: formatAllowancePercentage(terms.shipping_allowance_percentage_bps),
                            })}
                          </Text>
                          <Text size="sm" tone="secondary">
                            {t("marketplace.features.offers.ui.offerMatchListPage.sell.list.terms.source", {
                              source: termsSource(terms),
                            })}
                          </Text>
                          <Text size="sm" tone="secondary">
                            {t("marketplace.features.offers.ui.offerMatchListPage.sell.list.quote.time", {
                              time: new Date(terms.resolved_at).toLocaleString(),
                            })}
                          </Text>
                        </>
                      ) : null}
                    </Stack>
                  );
                })}
              </Stack>
            ) : null}
            <form method="post">
              {cartData?.items.map((item) => (
                <input
                  key={item.offer_id}
                  type="hidden"
                  name={`feeQuoteFingerprint:${item.offer_id}`}
                  value={
                    cartTermsByOfferId?.[item.offer_id]?.fee_quote_fingerprint ?? ""
                  }
                />
              ))}
              {cartData && cartData.items.length > 0 ? (
                <Button
                  type="submit"
                  name="intent"
                  value="accept-sell-list"
                  disabled={cartData.items.some((item) => item.seller_listing_availability_status === "unavailable")}
                >
                  {t("marketplace.features.offers.ui.offerMatchListPage.accept.sell.list")}</Button>
              ) : nextAcceptableOffer ? (
                <LinkButton
                  href={`/account/offers/matches/${nextAcceptableOffer.offer_id}`}
                  tone="secondary"
                >
                  {t("marketplace.features.offers.ui.offerMatchListPage.open.next.match.to.accept")}</LinkButton>
              ) : (
                <Button type="submit" disabled>
                  {t("marketplace.features.offers.ui.offerMatchListPage.no.offers.ready")}
                </Button>
              )}
            </form>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title={t("marketplace.features.offers.ui.offerMatchListPage.best.offer.matches")}>
        <DataTable
          rows={[...data.items]}
          getRowId={(row) => row.offer_id}
          columns={[
            {
              key: "item",
              header: t("marketplace.features.offers.ui.offerMatchListPage.item"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{row.item_title}</Text>
                  {row.item_subtitle ? (
                    <Text tone="secondary" size="sm">
                      {row.item_subtitle}
                    </Text>
                  ) : null}
                  {row.product_summary ? (
                    <ProductSummaryChips summary={row.product_summary} />
                  ) : null}
                </Stack>
              ),
            },
            {
              key: "listing",
              header: t("marketplace.features.offers.ui.offerMatchListPage.your.listing"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{formatMoney(row.listing_price_amount)}</Text>
                  <Text size="sm" tone="secondary">
                    {t("marketplace.features.offers.ui.offerMatchListPage.listing.quantity", {
                      visible: row.listing_visible_quantity,
                      cap: row.listing_quantity_cap,
                    })}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "best-offer",
              header: t("marketplace.features.offers.ui.offerMatchListPage.best.offer"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{formatMoney(row.price_amount)}</Text>
                  <Text size="sm" tone="secondary">
                    {row.buyer_display_name ?? row.buyer_account_id}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "gap",
              header: t("marketplace.features.offers.ui.offerMatchListPage.offer.vs.ask"),
              cell: (row) => (
                <Stack gap={1}>
                  <Badge tone={row.offer_to_listing_price_bps >= 10000 ? "success" : "accent"}>
                    {formatAllowancePercentage(row.offer_to_listing_price_bps)}
                  </Badge>
                  <Text size="sm" tone="secondary">
                    {formatPriceGap(row.offer_price_gap_amount)}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "quantity",
              header: t("marketplace.features.offers.ui.offerMatchListPage.quantity"),
              align: "right",
              cell: (row) => (
                <Stack gap={1}>
                  <Text>{t("marketplace.features.offers.ui.offerMatchListPage.requested.quantity", {
                    quantity: row.quantity_requested,
                  })}</Text>
                  <Text size="sm" tone="secondary">
                    {t("marketplace.features.offers.ui.offerMatchListPage.available.quantity", {
                      quantity: row.seller_available_quantity,
                    })}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "status",
              header: t("marketplace.features.offers.ui.offerMatchListPage.status"),
              cell: (row) => (
                <Stack gap={1}>
                  <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                  <Badge tone={row.can_fulfill ? "success" : "warning"}>
                    {row.seller_listing_availability_status === "unavailable"
                      ? t("marketplace.features.offers.ui.offerMatchListPage.listings.unavailable")
                      : row.can_fulfill ? t("marketplace.features.offers.ui.offerMatchListPage.can.fulfill") : t("marketplace.features.offers.ui.offerMatchListPage.needs.supply")}
                  </Badge>
                  {row.in_sell_list ? <Badge tone="accent">{t("marketplace.features.offers.ui.offerMatchListPage.in.sell.list")}</Badge> : null}
                </Stack>
              ),
            },
            {
              key: "updated",
              header: t("marketplace.features.offers.ui.offerMatchListPage.updated"),
              cell: (row) => formatTimestamp(row.updated_at),
            },
            {
              key: "actions",
              header: t("marketplace.features.offers.ui.offerMatchListPage.actions"),
              cell: (row) => (
                <LinkButton href={`/account/offers/matches/${row.offer_id}`} tone="secondary" size="sm">
                  {t("marketplace.features.offers.ui.offerMatchListPage.open")}</LinkButton>
              ),
            },
          ]}
          emptyTitle={t("marketplace.features.offers.ui.offerMatchListPage.no.offer.matches")}
          emptyDescription={t("marketplace.features.offers.ui.offerMatchListPage.offer.matches.appear.here.when.submitted")}
        />
      </PageSection>
    </Page>
  );
}
