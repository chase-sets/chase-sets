import { t } from "@chase-sets/localization";
import {
  Badge,
  Button,
  Card,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
} from "@chase-sets/design-system";
import type { OfferMatchDetail } from "./contracts";

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

export function MarketplaceOfferMatchDetailPage({
  offer,
  canAccept = false,
  errorMessage,
}: {
  offer: OfferMatchDetail;
  canAccept?: boolean;
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.offers.ui.offerMatchDetailPage.inventory")}
        title={offer.item_title}
        description={t("marketplace.features.offers.ui.offerMatchDetailPage.review.an.offer.match.that.matches")}
        actions={
          <LinkButton href="/account/offers/matches" tone="secondary">
            {t("marketplace.features.offers.ui.offerMatchDetailPage.back.to.offer.matches")}</LinkButton>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("marketplace.features.offers.ui.offerMatchDetailPage.offer.match.overview")}>
        <Card>
          <Stack gap={2}>
            {offer.item_subtitle ? <Text tone="secondary">{offer.item_subtitle}</Text> : null}
            {offer.product_summary ? (
              <Text size="sm" tone="secondary">
                {offer.product_summary}
              </Text>
            ) : null}
            <Badge tone={statusTone(offer.status)}>{offer.status}</Badge>
            <Text>{t("marketplace.features.offers.ui.offerMatchDetailPage.buyer")}{offer.buyer_display_name ?? offer.buyer_account_id}</Text>
            <Text>{t("marketplace.features.offers.ui.offerMatchDetailPage.offer.price")}{formatMoney(offer.price_amount)}</Text>
            <Text>{t("marketplace.features.offers.ui.offerMatchDetailPage.quantity.requested")}{offer.quantity_requested}</Text>
            <Text>{t("marketplace.features.offers.ui.offerMatchDetailPage.active.supply.available")}{offer.seller_available_quantity}</Text>
            <Badge tone={offer.can_fulfill ? "success" : "warning"}>
              {offer.can_fulfill ? t("marketplace.features.offers.ui.offerMatchDetailPage.can.fulfill") : t("marketplace.features.offers.ui.offerMatchDetailPage.needs.supply")}
            </Badge>
            {canAccept && offer.status === "submitted" ? (
              <form method="post">
                <Button
                  type="submit"
                  name="intent"
                  value="accept-offer"
                  disabled={!offer.can_fulfill}
                >
                  {t("marketplace.features.offers.ui.offerMatchDetailPage.accept.offer.match")}</Button>
              </form>
            ) : (
              <Text>
                {offer.status === "accepted"
                  ? t("marketplace.features.offers.ui.offerMatchDetailPage.this.offer.match.has.already.been")
                  : t("marketplace.features.offers.ui.offerMatchDetailPage.this.view.is.read.only.for")}
              </Text>
            )}
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
