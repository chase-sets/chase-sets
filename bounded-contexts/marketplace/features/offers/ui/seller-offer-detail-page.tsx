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
import type { MarketplaceSellerOfferDetail } from "./contracts";

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

export function MarketplaceSellerOfferDetailPage({
  offer,
  canAccept = false,
  errorMessage,
}: {
  offer: MarketplaceSellerOfferDetail;
  canAccept?: boolean;
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Seller"
        title={offer.item_title}
        description="Review marketplace-wide buyer demand that matches your active supply."
        actions={
          <LinkButton href="/account/market-offers" tone="secondary">
            Back to market offers
          </LinkButton>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Offer Overview">
        <Card>
          <Stack gap={2}>
            {offer.item_subtitle ? <Text tone="secondary">{offer.item_subtitle}</Text> : null}
            {offer.product_summary ? (
              <Text size="sm" tone="secondary">
                {offer.product_summary}
              </Text>
            ) : null}
            <Badge tone={statusTone(offer.status)}>{offer.status}</Badge>
            <Text>Buyer: {offer.buyer_display_name ?? offer.buyer_account_id}</Text>
            <Text>Offer price: {formatMoney(offer.price_amount)}</Text>
            <Text>Quantity requested: {offer.quantity_requested}</Text>
            <Text>Active supply available: {offer.seller_available_quantity}</Text>
            <Badge tone={offer.can_fulfill ? "success" : "warning"}>
              {offer.can_fulfill ? "Can fulfill" : "Needs supply"}
            </Badge>
            {canAccept && offer.status === "submitted" ? (
              <form method="post">
                <Button
                  type="submit"
                  name="intent"
                  value="accept-offer"
                  disabled={!offer.can_fulfill}
                >
                  Accept offer
                </Button>
              </form>
            ) : (
              <Text>
                {offer.status === "accepted"
                  ? "This offer has already been accepted and converted into an order."
                  : "This view is read-only for now."}
              </Text>
            )}
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
