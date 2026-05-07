import { t } from "@chase-sets/localization";
import type { ReactNode } from "react";
import {
  Badge,
  Button,
  BuyerProtectionModule,
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
  ProductSelectionSummary,
  Stack,
  StickyCtaBar,
  Text,
  productSelectionDetailsFromSummary,
} from "@chase-sets/design-system";
import type { OfferMatchDetail } from "./contracts";
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

function termsSourceLabel(terms: MarketplaceListingTermsPreview) {
  return terms.agreement_id
    ? "Seller terms"
    : t("marketplace.features.offers.ui.offerMatchDetailPage.standard.terms");
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

export function MarketplaceOfferMatchDetailPage({
  offer,
  acceptanceTerms,
  canAccept = false,
  errorMessage,
  feedbackPrompt,
}: {
  offer: OfferMatchDetail;
  acceptanceTerms?: MarketplaceListingTermsPreview | null;
  canAccept?: boolean;
  errorMessage?: string | null;
  feedbackPrompt?: ReactNode;
}) {
  const canAcceptSubmitted = canAccept && offer.status === "submitted";
  const fulfillmentLabel = offer.can_fulfill
    ? t("marketplace.features.offers.ui.offerMatchDetailPage.can.fulfill")
    : t("marketplace.features.offers.ui.offerMatchDetailPage.needs.supply");
  const acceptOfferAction = canAcceptSubmitted ? (
      <form method="post">
        <input
          type="hidden"
          name="feeQuoteFingerprint"
          value={acceptanceTerms?.fee_quote_fingerprint ?? ""}
        />
        <Button
          type="submit"
          name="intent"
          value="accept-offer"
          disabled={!offer.can_fulfill}
        >
          {t("marketplace.features.offers.ui.offerMatchDetailPage.accept.offer.match")}
        </Button>
      </form>
    ) : null;

  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.offers.ui.offerMatchDetailPage.offer.match")}
        title={offer.item_title}
        description={t("marketplace.features.offers.ui.offerMatchDetailPage.review.an.offer.match.that.matches")}
        actions={
          <LinkButton href="/account/offers/matches" tone="secondary">
            {t("marketplace.features.offers.ui.offerMatchDetailPage.back.to.offer.matches")}</LinkButton>
        }
      />

      {errorMessage ? (
        <MarketplaceNotice tone="error" title={t("marketplace.features.offers.ui.offerMatchDetailPage.offer.match.overview")} description={errorMessage} />
      ) : null}

      {feedbackPrompt}

      <PageSection title={t("marketplace.features.offers.ui.offerMatchDetailPage.offer.match.overview")}>
        <Stack gap={4}>
          <Card>
            <Stack gap={4}>
              <Stack gap={2}>
                <Inline>
                  <Badge tone={statusTone(offer.status)}>{offer.status}</Badge>
                  <Badge tone={offer.can_fulfill ? "success" : "warning"}>
                    {fulfillmentLabel}
                  </Badge>
                </Inline>
                <Text size="lg" weight="semibold">{formatMoney(offer.price_amount)}</Text>
                <Text weight="semibold">{offer.item_title}</Text>
                {offer.item_subtitle ? <Text tone="secondary">{offer.item_subtitle}</Text> : null}
                {offer.product_summary ? (
                  <ProductSummaryChips summary={offer.product_summary} />
                ) : null}
              </Stack>
              <KeyValueList
                density="compact"
                variant="plain"
                items={[
                  {
                    key: t("marketplace.features.offers.ui.offerMatchDetailPage.buyer"),
                    value: offer.buyer_display_name ?? offer.buyer_account_id,
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
              {acceptOfferAction}
            </Stack>
          </Card>

          {acceptanceTerms ? (
            <PriceBreakdown
              lines={[
                {
                  label: t("marketplace.features.offers.ui.offerMatchDetailPage.offer.price"),
                  value: formatMoney(offer.price_amount),
                },
                {
                  label: t("marketplace.features.offers.ui.offerMatchDetailPage.marketplace.fee"),
                  value: formatMoney(acceptanceTerms.marketplace_sales_fee_unit_amount),
                },
                {
                  label: t("marketplace.features.offers.ui.offerMatchDetailPage.shipping.allowance.rate"),
                  value: formatAllowancePercentage(acceptanceTerms.shipping_allowance_percentage_bps),
                },
                {
                  label: t("marketplace.features.offers.ui.offerMatchDetailPage.terms.source"),
                  value: termsSourceLabel(acceptanceTerms),
                },
              ]}
              total={formatMoney(acceptanceTerms.seller_net_unit_amount)}
              totalLabel={t("marketplace.features.offers.ui.offerMatchDetailPage.seller.net")}
            />
          ) : null}

          <BuyerProtectionModule
            title={t("marketplace.features.offers.ui.offerMatchDetailPage.seller.shipping.allowance")}
            items={[
              {
                title: t("marketplace.features.offers.ui.offerMatchDetailPage.seller.shipping.allowance"),
                description: acceptanceTerms
                  ? t("marketplace.features.offers.ui.offerMatchDetailPage.accepting.this.offer.earns.percentage.toward.shipping", {
                      percentage: formatAllowancePercentage(acceptanceTerms.shipping_allowance_percentage_bps),
                    })
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
                  ? new Date(acceptanceTerms.resolved_at).toLocaleString()
                  : t("marketplace.features.offers.ui.offerMatchDetailPage.standard.terms"),
              },
            ]}
          />

          <MarketplaceStatusTimeline
            steps={[
              {
                label: offer.status,
                description: t("marketplace.features.offers.ui.offerMatchDetailPage.review.an.offer.match.that.matches"),
                status: offer.status === "accepted" ? "complete" : "current",
              },
              {
                label: offer.can_fulfill
                  ? t("marketplace.features.offers.ui.offerMatchDetailPage.can.fulfill")
                  : t("marketplace.features.offers.ui.offerMatchDetailPage.needs.supply"),
                description: t("marketplace.features.offers.ui.offerMatchDetailPage.active.supply.available") + offer.seller_available_quantity,
                status: offer.can_fulfill ? "complete" : "issue",
              },
              {
                label: t("marketplace.features.offers.ui.offerMatchDetailPage.accept.offer.match"),
                description: offer.status === "accepted"
                  ? t("marketplace.features.offers.ui.offerMatchDetailPage.this.offer.match.has.already.been")
                  : offer.can_fulfill
                    ? t("marketplace.features.offers.ui.offerMatchDetailPage.accept.this.match.to.create.the.sale")
                    : t("marketplace.features.offers.ui.offerMatchDetailPage.add.enough.available.supply.before.accepting"),
                status: offer.status === "accepted" ? "complete" : "upcoming",
              },
            ]}
          />
        </Stack>
      </PageSection>

      {acceptOfferAction ? (
        <StickyCtaBar
          price={formatMoney(offer.price_amount)}
          context={offer.can_fulfill
            ? t("marketplace.features.offers.ui.offerMatchDetailPage.can.fulfill")
            : t("marketplace.features.offers.ui.offerMatchDetailPage.needs.supply")}
          primaryAction={acceptOfferAction}
          secondaryAction={
            <LinkButton href="/account/offers/matches" tone="secondary">
              {t("marketplace.features.offers.ui.offerMatchDetailPage.back.to.offer.matches")}
            </LinkButton>
          }
        />
      ) : null}
    </Page>
  );
}
