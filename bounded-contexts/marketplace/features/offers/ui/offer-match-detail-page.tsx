import { formatBpsPercent, formatDateTime, formatMoney, t } from "@chase-sets/localization";
import {
  HiddenInput,
  Form,
  AccountReputationSummary,
  Badge,
  Button,
  OrderProtectionModule,
  Card,
  Inline,
  KeyValueList,
  LinkButton,
  MarketplaceNotice,
  MarketplaceStatusTimeline,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  ProductOptions,
  Stack,
  StickyCtaBar,
  Text,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import type { OfferMatchDetail } from "./contracts";
import { OfferMatchSellListSnapshotFields } from "./offer-match-sell-list-snapshot-fields";
import { formatPriceGap } from "./price-gap";
import type { MarketplaceListingTermsPreview } from "../../listings/ui/contracts";

function statusTone(status: string) {
  switch (status) {
    case "submitted":
      return "accent";
    default:
      return "neutral";
  }
}

function termsSourceLabel(terms: MarketplaceListingTermsPreview) {
  return terms.agreement_id ? "Seller terms" : t("marketplace.features.offers.ui.offerMatchDetailPage.standard.terms");
}

export function MarketplaceOfferMatchDetailPage({
  offer,
  acceptanceTerms,
  canAccept = false,
  errorMessage,
}: {
  offer: OfferMatchDetail;
  acceptanceTerms?: MarketplaceListingTermsPreview | null;
  canAccept?: boolean;
  errorMessage?: string | null;
}) {
  const canAcceptSubmitted = canAccept && offer.status === "submitted";
  const fulfillmentLabel = offer.can_fulfill
    ? t("marketplace.features.offers.ui.offerMatchDetailPage.can.fulfill")
    : offer.seller_listing_availability_status === "unavailable"
      ? t("marketplace.features.offers.ui.offerMatchDetailPage.listings.unavailable")
      : t("marketplace.features.offers.ui.offerMatchDetailPage.needs.supply");
  const acceptOfferAction = canAcceptSubmitted ? (
    <Form spacing="none" method="post" action="/account/sell-list">
      <HiddenInput type="hidden" name="intent" value="add-selected-offer" />
      <OfferMatchSellListSnapshotFields offer={offer} />
      <Button type="submit" disabled={!offer.can_fulfill}>
        {t("marketplace.features.offers.ui.offerMatchDetailPage.accept.offer.match")}
      </Button>
    </Form>
  ) : null;
  const addToSellListAction = canAcceptSubmitted ? (
    <Form spacing="none" method="post" action="/account/sell-list">
      <HiddenInput type="hidden" name="intent" value="add-selected-offer" />
      <OfferMatchSellListSnapshotFields offer={offer} />
      <Button type="submit" tone="secondary">
        {t("marketplace.features.offers.ui.offerMatchDetailPage.add.to.sell.list")}
      </Button>
    </Form>
  ) : null;
  const declineAction = canAcceptSubmitted ? (
    <Form spacing="none" method="post">
      <HiddenInput type="hidden" name="intent" value="decline-offer" />
      <Button type="submit" tone="secondary" disabled={!offer.can_fulfill}>
        {t("marketplace.features.offers.ui.offerMatchDetailPage.decline")}
      </Button>
    </Form>
  ) : null;
  const muteBuyerAction = canAcceptSubmitted ? (
    <Form spacing="none" method="post">
      <HiddenInput type="hidden" name="intent" value="mute-offer-buyer" />
      <Button type="submit" tone="secondary">
        {t("marketplace.features.offers.ui.offerMatchDetailPage.mute.buyer")}
      </Button>
    </Form>
  ) : null;
  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.offers.ui.offerMatchDetailPage.offer.match")}
        title={offer.item_title}
        description={t("marketplace.features.offers.ui.offerMatchDetailPage.review.an.offer.match.that.matches")}
        actions={
          <LinkButton href="/account/offers/matches" tone="secondary">
            {t("marketplace.features.offers.ui.offerMatchDetailPage.back.to.offer.matches")}
          </LinkButton>
        }
      />

      {errorMessage ? (
        <MarketplaceNotice
          tone="danger"
          title={t("marketplace.features.offers.ui.offerMatchDetailPage.offer.match.overview")}
          description={errorMessage}
        />
      ) : null}

      {offer.seller_listing_availability_status === "unavailable" ? (
        <MarketplaceNotice
          tone="warning"
          title={t("marketplace.features.offers.ui.offerMatchDetailPage.listings.unavailable")}
          description={t("marketplace.features.offers.ui.offerMatchDetailPage.turn.listings.on.before.accepting")}
        />
      ) : null}

      <PageSection title={t("marketplace.features.offers.ui.offerMatchDetailPage.offer.match.overview")}>
        <Stack gap={4}>
          <Card elevation="elevated">
            <Stack gap={4}>
              <Stack gap={2}>
                <Inline>
                  <Badge tone={statusTone(offer.status)}>{offer.status}</Badge>
                  <Badge tone={offer.can_fulfill ? "success" : "warning"}>{fulfillmentLabel}</Badge>
                </Inline>
                <Text size="lg" weight="semibold">
                  {formatMoney(offer.price_amount, "USD")}
                </Text>
                <Text tone="secondary">
                  {t("marketplace.features.offers.ui.offerMatchDetailPage.offer.is.percentage.of.ask", {
                    percentage: formatBpsPercent(offer.offer_to_listing_price_bps),
                    gap: formatPriceGap(offer.offer_price_gap_amount),
                  })}
                </Text>
                <Text weight="semibold">{offer.item_title}</Text>
                {offer.item_subtitle ? <Text tone="secondary">{offer.item_subtitle}</Text> : null}
                {offer.product_summary ? (
                  <ProductOptions options={productOptionsFromSummary(offer.product_summary)} variant="chips" />
                ) : null}
              </Stack>
              <KeyValueList
                density="compact"
                variant="plain"
                items={[
                  {
                    key: t("marketplace.features.offers.ui.offerMatchDetailPage.buyer"),
                    value: (
                      <AccountReputationSummary
                        accountName={offer.buyer_display_name ?? offer.buyer_account_id}
                        averageRating={offer.buyer_average_rating}
                        reviewCount={offer.buyer_review_count ?? 0}
                        ratingLabel={t("marketplace.features.offers.ui.offerMatchDetailPage.buyer.reputation")}
                      />
                    ),
                  },
                  {
                    key: t("marketplace.features.offers.ui.offerMatchDetailPage.listing.price"),
                    value: formatMoney(offer.listing_price_amount, "USD"),
                  },
                  {
                    key: t("marketplace.features.offers.ui.offerMatchDetailPage.offer.vs.ask"),
                    value: formatBpsPercent(offer.offer_to_listing_price_bps),
                  },
                  {
                    key: t("marketplace.features.offers.ui.offerMatchDetailPage.ask.gap"),
                    value: formatPriceGap(offer.offer_price_gap_amount),
                  },
                  {
                    key: t("marketplace.features.offers.ui.offerMatchDetailPage.quantity.requested"),
                    value: offer.quantity_requested,
                  },
                  {
                    key: t("marketplace.features.offers.ui.offerMatchDetailPage.active.supply.available"),
                    value: offer.seller_available_quantity,
                  },
                ]}
              />
              {acceptOfferAction || addToSellListAction || declineAction || muteBuyerAction ? (
                <Inline gap={2}>
                  {acceptOfferAction}
                  {addToSellListAction}
                  {declineAction}
                  {muteBuyerAction}
                </Inline>
              ) : null}
            </Stack>
          </Card>

          {acceptanceTerms ? (
            <PriceBreakdown
              lines={[
                {
                  label: t("marketplace.features.offers.ui.offerMatchDetailPage.offer.price"),
                  value: formatMoney(offer.price_amount, "USD"),
                },
                {
                  label: t("marketplace.features.offers.ui.offerMatchDetailPage.listing.price"),
                  value: formatMoney(offer.listing_price_amount, "USD"),
                },
                {
                  label: t("marketplace.features.offers.ui.offerMatchDetailPage.marketplace.fee"),
                  value: formatMoney(acceptanceTerms.marketplace_sales_fee_unit_amount, "USD"),
                },
                {
                  label: t("marketplace.features.offers.ui.offerMatchDetailPage.shipping.allowance.rate"),
                  value: formatBpsPercent(acceptanceTerms.shipping_allowance_percentage_bps),
                },
                {
                  label: t("marketplace.features.offers.ui.offerMatchDetailPage.terms.source"),
                  value: termsSourceLabel(acceptanceTerms),
                },
              ]}
              total={formatMoney(acceptanceTerms.seller_net_unit_amount, "USD")}
              totalLabel={t("marketplace.features.offers.ui.offerMatchDetailPage.seller.net")}
            />
          ) : null}

          <OrderProtectionModule
            title={t("marketplace.features.offers.ui.offerMatchDetailPage.seller.shipping.allowance")}
            items={[
              {
                title: t("marketplace.features.offers.ui.offerMatchDetailPage.seller.shipping.allowance"),
                description: acceptanceTerms
                  ? t(
                      "marketplace.features.offers.ui.offerMatchDetailPage.accepting.this.offer.earns.percentage.toward.shipping",
                      {
                        percentage: formatBpsPercent(acceptanceTerms.shipping_allowance_percentage_bps),
                      },
                    )
                  : t("marketplace.features.offers.ui.offerMatchDetailPage.standard.terms"),
              },
              {
                title: t("marketplace.features.offers.ui.offerMatchDetailPage.can.fulfill"),
                description: offer.can_fulfill
                  ? t("marketplace.features.offers.ui.offerMatchDetailPage.can.fulfill")
                  : t("marketplace.features.offers.ui.offerMatchDetailPage.needs.supply"),
              },
              {
                title: t("marketplace.features.offers.ui.offerMatchDetailPage.quote.time"),
                description: acceptanceTerms
                  ? formatDateTime(acceptanceTerms.resolved_at)
                  : t("marketplace.features.offers.ui.offerMatchDetailPage.standard.terms"),
              },
            ]}
          />

          <MarketplaceStatusTimeline
            steps={[
              {
                label: offer.status,
                description: t(
                  "marketplace.features.offers.ui.offerMatchDetailPage.review.an.offer.match.that.matches",
                ),
                status: offer.status === "accepted" ? "complete" : "current",
              },
              {
                label: offer.can_fulfill
                  ? t("marketplace.features.offers.ui.offerMatchDetailPage.can.fulfill")
                  : t("marketplace.features.offers.ui.offerMatchDetailPage.needs.supply"),
                description:
                  t("marketplace.features.offers.ui.offerMatchDetailPage.active.supply.available") +
                  offer.seller_available_quantity,
                status: offer.can_fulfill ? "complete" : "issue",
              },
              {
                label: t("marketplace.features.offers.ui.offerMatchDetailPage.accept.offer.match"),
                description:
                  offer.status === "accepted"
                    ? t("marketplace.features.offers.ui.offerMatchDetailPage.this.offer.match.has.already.been")
                    : offer.can_fulfill
                      ? t("marketplace.features.offers.ui.offerMatchDetailPage.accept.this.match.to.create.the.sale")
                      : t(
                          "marketplace.features.offers.ui.offerMatchDetailPage.add.enough.available.supply.before.accepting",
                        ),
                status: offer.status === "accepted" ? "complete" : "upcoming",
              },
            ]}
          />
        </Stack>
      </PageSection>

      {acceptOfferAction ? (
        <StickyCtaBar
          price={formatMoney(offer.price_amount, "USD")}
          context={
            offer.can_fulfill
              ? t("marketplace.features.offers.ui.offerMatchDetailPage.can.fulfill")
              : t("marketplace.features.offers.ui.offerMatchDetailPage.needs.supply")
          }
          primaryAction={acceptOfferAction}
          secondaryAction={addToSellListAction}
        />
      ) : null}
    </Page>
  );
}
