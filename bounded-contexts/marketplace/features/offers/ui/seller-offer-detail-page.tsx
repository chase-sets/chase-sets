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
import type { BuyerOfferMatchDetail } from "./contracts";

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

export function MarketplaceBuyerOfferMatchDetailPage({
  offer,
  canAccept = false,
  errorMessage,
}: {
  offer: BuyerOfferMatchDetail;
  canAccept?: boolean;
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Seller"
        title={offer.item_title}
        description="Review a buyer offer match that matches your active supply."
        actions={
          <LinkButton href="/account/offers/matches" tone="secondary">
            Back to buyer offer matches
          </LinkButton>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Buyer Offer Match Overview">
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
            <Text>Buyer offer price: {formatMoney(offer.price_amount)}</Text>
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
                  Accept buyer offer match
                </Button>
              </form>
            ) : (
              <Text>
                {offer.status === "accepted"
                  ? "This buyer offer match has already been accepted and converted into a sale."
                  : "This view is read-only for now."}
              </Text>
            )}
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
