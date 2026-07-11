import { formatMoney, t } from "@chase-sets/localization";
import type { ReactNode } from "react";
import {
  AccountReputationSummary,
  Badge,
  OrderProtectionModule,
  LinkButton,
  MarketplaceNotice,
  MarketplaceStatusTimeline,
  OfferCard,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  ProductOptions,
  Stack,
  Text,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import type { SubmittedOfferDetail } from "./contracts";

function statusTone(status: string) {
  switch (status) {
    case "submitted":
      return "accent";
    default:
      return "neutral";
  }
}

export function MarketplaceSubmittedOfferDetailPage({
  offer,
  errorMessage,
  feedbackPrompt,
}: {
  offer: SubmittedOfferDetail;
  errorMessage?: string | null;
  feedbackPrompt?: ReactNode;
}) {
  const showAcceptedSellerReputation = offer.accepted_seller_account_id !== null && offer.status === "accepted";

  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.offers.ui.submittedOfferDetailPage.offers")}
        title={offer.item_title}
        description={t("marketplace.features.offers.ui.submittedOfferDetailPage.review.the.details.of.your.submitted")}
        actions={
          <LinkButton href="/account/offers/submitted" tone="secondary">
            {t("marketplace.features.offers.ui.submittedOfferDetailPage.back.to.submitted.offers")}
          </LinkButton>
        }
      />

      {errorMessage ? (
        <MarketplaceNotice
          tone="danger"
          title={t("marketplace.features.offers.ui.submittedOfferDetailPage.submitted.offer.overview")}
          description={errorMessage}
        />
      ) : null}

      {feedbackPrompt}

      <PageSection title={t("marketplace.features.offers.ui.submittedOfferDetailPage.submitted.offer.overview")}>
        <Stack gap={4}>
          <OfferCard
            title={offer.item_title}
            amount={formatMoney(offer.price_amount, "USD")}
            status={<Badge tone={statusTone(offer.status)}>{offer.status}</Badge>}
            details={
              <Stack gap={2}>
                {offer.item_subtitle ? <Text tone="secondary">{offer.item_subtitle}</Text> : null}
                {offer.product_summary ? (
                  <ProductOptions options={productOptionsFromSummary(offer.product_summary)} variant="chips" />
                ) : null}
                <Text>
                  {t("marketplace.features.offers.ui.submittedOfferDetailPage.quantity.requested")}
                  {offer.quantity_requested}
                </Text>
                <Text>
                  {t(
                    "marketplace.features.offers.ui.submittedOfferDetailPage.this.submitted.offer.is.marketplace.wide",
                  )}
                </Text>
                {showAcceptedSellerReputation ? (
                  <AccountReputationSummary
                    accountName={offer.accepted_seller_account_id}
                    averageRating={offer.accepted_seller_average_rating}
                    reviewCount={offer.accepted_seller_review_count ?? 0}
                    ratingLabel={t("marketplace.features.offers.ui.submittedOfferDetailPage.seller.reputation")}
                  />
                ) : null}
              </Stack>
            }
          />

          <PriceBreakdown
            lines={[
              {
                label: t("marketplace.features.offers.ui.submittedOfferDetailPage.offer.price"),
                value: formatMoney(offer.price_amount, "USD"),
              },
              {
                label: t("marketplace.features.offers.ui.submittedOfferDetailPage.quantity.requested"),
                value: offer.quantity_requested,
              },
            ]}
            total={formatMoney(offer.price_amount, "USD")}
            totalLabel={t("marketplace.features.offers.ui.submittedOfferDetailPage.offer.price")}
          />

          <OrderProtectionModule
            title={t("marketplace.features.offers.ui.submittedOfferDetailPage.offers")}
            items={[
              {
                title: t(
                  "marketplace.features.offers.ui.submittedOfferDetailPage.this.submitted.offer.is.marketplace.wide",
                ),
                description: t(
                  "marketplace.features.offers.ui.submittedOfferDetailPage.review.the.details.of.your.submitted",
                ),
              },
              {
                title: t("marketplace.features.offers.ui.submittedOfferDetailPage.quantity.requested"),
                description: String(offer.quantity_requested),
              },
              {
                title: t("marketplace.features.offers.ui.submittedOfferDetailPage.back.to.submitted.offers"),
                description: t(
                  "marketplace.features.offers.ui.submittedOfferDetailPage.review.the.details.of.your.submitted",
                ),
              },
            ]}
          />

          <MarketplaceStatusTimeline
            steps={[
              {
                label: offer.status,
                description: t(
                  "marketplace.features.offers.ui.submittedOfferDetailPage.this.submitted.offer.is.marketplace.wide",
                ),
                status: offer.status === "submitted" ? "current" : "complete",
              },
              {
                label: t("marketplace.features.offers.ui.submittedOfferDetailPage.submitted.offer.overview"),
                description: t(
                  "marketplace.features.offers.ui.submittedOfferDetailPage.review.the.details.of.your.submitted",
                ),
                status: "upcoming",
              },
            ]}
          />
        </Stack>
      </PageSection>
    </Page>
  );
}
