import { t } from "@chase-sets/localization";
import {
  Badge,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
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

function formatMoney(amount: string) {
  return `$${amount}`;
}

export function MarketplaceSubmittedOfferDetailPage({
  offer,
  errorMessage,
}: {
  offer: SubmittedOfferDetail;
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.offers.ui.submittedOfferDetailPage.offers")}
        title={offer.item_title}
        description={t("marketplace.features.offers.ui.submittedOfferDetailPage.review.the.details.of.your.submitted")}
        actions={
          <LinkButton href="/account/offers/submitted" tone="secondary">
            {t("marketplace.features.offers.ui.submittedOfferDetailPage.back.to.submitted.offers")}</LinkButton>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("marketplace.features.offers.ui.submittedOfferDetailPage.submitted.offer.overview")}>
        <Card>
          <Stack gap={2}>
            {offer.item_subtitle ? <Text tone="secondary">{offer.item_subtitle}</Text> : null}
            {offer.product_summary ? (
              <Text size="sm" tone="secondary">
                {offer.product_summary}
              </Text>
            ) : null}
            <Badge tone={statusTone(offer.status)}>{offer.status}</Badge>
            <Text>{t("marketplace.features.offers.ui.submittedOfferDetailPage.offer.price")}{formatMoney(offer.price_amount)}</Text>
            <Text>{t("marketplace.features.offers.ui.submittedOfferDetailPage.quantity.requested")}{offer.quantity_requested}</Text>
            <Text>
              {t("marketplace.features.offers.ui.submittedOfferDetailPage.this.submitted.offer.is.marketplace.wide")}</Text>
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
