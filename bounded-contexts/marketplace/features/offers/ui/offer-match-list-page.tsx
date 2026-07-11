import { formatMoney, t } from "@chase-sets/localization";
import {
  HiddenInput,
  Form,
  AccountReputationSummary,
  Badge,
  Banner,
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
  ProductOptions,
  Stack,
  Text,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import type { OfferBuyerMute, OfferMatchListItem } from "./contracts";
import { OfferMatchSellListSnapshotFields } from "./offer-match-sell-list-snapshot-fields";

function statusTone(status: string) {
  switch (status) {
    case "submitted":
      return "accent";
    default:
      return "neutral";
  }
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
      amount: formatMoney(value.toFixed(2), "USD"),
    });
  }

  if (value < 0) {
    return t("marketplace.features.offers.ui.offerMatchListPage.over.ask", {
      amount: formatMoney(Math.abs(value).toFixed(2), "USD"),
    });
  }

  return t("marketplace.features.offers.ui.offerMatchListPage.meets.ask");
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

export function MarketplaceOfferMatchListPage({
  data,
  buyerMutes,
  errorMessage,
}: {
  data: { items: readonly OfferMatchListItem[] };
  buyerMutes?: { items: readonly OfferBuyerMute[] };
  errorMessage?: string | null;
}) {
  const fulfillableCount = data.items.filter((item) => item.can_fulfill).length;
  const atOrAboveAskCount = data.items.filter((item) => item.offer_to_listing_price_bps >= 10000).length;
  const bestMatchPercentage = data.items.length
    ? formatAllowancePercentage(Math.max(...data.items.map((item) => item.offer_to_listing_price_bps)))
    : "0%";
  const listingsUnavailable = data.items.some((item) => item.seller_listing_availability_status === "unavailable");
  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.offers.ui.offerMatchListPage.seller")}
        title={t("marketplace.features.offers.ui.offerMatchListPage.offer.matches")}
        description={t("marketplace.features.offers.ui.offerMatchListPage.compare.best.offers.to.your.listing")}
        actions={
          <LinkButton href="/account/listings" tone="secondary">
            {t("marketplace.features.offers.ui.offerMatchListPage.view.listings")}
          </LinkButton>
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
          {
            label: t("marketplace.features.offers.ui.offerMatchListPage.source.list"),
            value: t("marketplace.features.offers.ui.offerMatchListPage.checkout.sell.list"),
          },
        ]}
      />

      {errorMessage ? (
        <MarketplaceNotice
          tone="danger"
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
              title={t("marketplace.features.offers.ui.offerMatchListPage.checkout.sell.list")}
              description={t(
                "marketplace.features.offers.ui.offerMatchListPage.offer.matches.source.checkout.sell.list",
              )}
            />
            <Text tone="secondary" size="sm">
              {t("marketplace.features.offers.ui.offerMatchListPage.add.selected.offers.then.review")}
            </Text>
            <Inline gap={2}>
              <LinkButton href="/account/sell-list">
                {t("marketplace.features.offers.ui.offerMatchListPage.review.checkout.sell.list")}
              </LinkButton>
              <LinkButton href="/account/listings" tone="secondary">
                {t("marketplace.features.offers.ui.offerMatchListPage.view.listings")}
              </LinkButton>
            </Inline>
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
                    <ProductOptions options={productOptionsFromSummary(row.product_summary)} variant="chips" />
                  ) : null}
                </Stack>
              ),
            },
            {
              key: "listing",
              header: t("marketplace.features.offers.ui.offerMatchListPage.your.listing"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{formatMoney(row.listing_price_amount, "USD")}</Text>
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
                  <Text weight="semibold">{formatMoney(row.price_amount, "USD")}</Text>
                  <AccountReputationSummary
                    accountName={row.buyer_display_name ?? row.buyer_account_id}
                    averageRating={row.buyer_average_rating}
                    reviewCount={row.buyer_review_count ?? 0}
                    ratingLabel={t("marketplace.features.offers.ui.offerMatchListPage.buyer.reputation")}
                  />
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
                  <Text>
                    {t("marketplace.features.offers.ui.offerMatchListPage.requested.quantity", {
                      quantity: row.quantity_requested,
                    })}
                  </Text>
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
                      : row.can_fulfill
                        ? t("marketplace.features.offers.ui.offerMatchListPage.can.fulfill")
                        : t("marketplace.features.offers.ui.offerMatchListPage.needs.supply")}
                  </Badge>
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
                <Stack gap={2}>
                  <Form spacing="none" method="post" action="/account/sell-list">
                    <HiddenInput type="hidden" name="intent" value="add-selected-offer" />
                    <OfferMatchSellListSnapshotFields offer={row} />
                    <Button
                      type="submit"
                      tone="secondary"
                      size="sm"
                      disabled={!row.can_fulfill || row.status !== "submitted"}
                    >
                      {t("marketplace.features.offers.ui.offerMatchListPage.add.to.sell.list")}
                    </Button>
                  </Form>
                  <LinkButton href={`/account/offers/matches/${row.offer_id}`} tone="secondary" size="sm">
                    {t("marketplace.features.offers.ui.offerMatchListPage.open")}
                  </LinkButton>
                  <Form spacing="none" method="post" action={`/account/offers/matches/${row.offer_id}`}>
                    <HiddenInput type="hidden" name="intent" value="decline-offer" />
                    <Button type="submit" tone="secondary" size="sm" disabled={row.status !== "submitted"}>
                      {t("marketplace.features.offers.ui.offerMatchListPage.decline")}
                    </Button>
                  </Form>
                  <Form spacing="none" method="post" action={`/account/offers/matches/${row.offer_id}`}>
                    <HiddenInput type="hidden" name="intent" value="mute-offer-buyer" />
                    <Button type="submit" tone="secondary" size="sm" disabled={row.status !== "submitted"}>
                      {t("marketplace.features.offers.ui.offerMatchListPage.mute.buyer")}
                    </Button>
                  </Form>
                </Stack>
              ),
            },
          ]}
          emptyTitle={t("marketplace.features.offers.ui.offerMatchListPage.no.offer.matches")}
          emptyDescription={t(
            "marketplace.features.offers.ui.offerMatchListPage.offer.matches.appear.here.when.submitted",
          )}
        />
      </PageSection>

      <PageSection title={t("marketplace.features.offers.ui.offerMatchListPage.muted.buyers")}>
        <DataTable
          rows={[...(buyerMutes?.items ?? [])]}
          getRowId={(row) => `${row.listing_id}:${row.buyer_account_id}`}
          columns={[
            {
              key: "buyer",
              header: t("marketplace.features.offers.ui.offerMatchListPage.buyer"),
              cell: (row) => row.buyer_display_name ?? row.buyer_account_id,
            },
            {
              key: "listing",
              header: t("marketplace.features.offers.ui.offerMatchListPage.listing"),
              cell: (row) => row.listing_id,
            },
            {
              key: "muted",
              header: t("marketplace.features.offers.ui.offerMatchListPage.muted.on"),
              cell: (row) => formatTimestamp(row.muted_at),
            },
            {
              key: "actions",
              header: t("marketplace.features.offers.ui.offerMatchListPage.actions"),
              cell: (row) => (
                <Form spacing="none" method="post">
                  <HiddenInput type="hidden" name="intent" value="unmute-offer-buyer" />
                  <HiddenInput type="hidden" name="listingId" value={row.listing_id} />
                  <HiddenInput type="hidden" name="buyerAccountId" value={row.buyer_account_id} />
                  <Button type="submit" tone="secondary" size="sm">
                    {t("marketplace.features.offers.ui.offerMatchListPage.unmute")}
                  </Button>
                </Form>
              ),
            },
          ]}
          emptyTitle={t("marketplace.features.offers.ui.offerMatchListPage.no.muted.buyers")}
          emptyDescription={t("marketplace.features.offers.ui.offerMatchListPage.muted.buyers.appear.here")}
        />
      </PageSection>
    </Page>
  );
}
