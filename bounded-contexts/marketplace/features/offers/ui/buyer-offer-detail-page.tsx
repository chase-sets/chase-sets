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
import type { MarketplaceBuyerOfferDetail } from "./contracts";

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

export function MarketplaceBuyerOfferDetailPage({
  offer,
  errorMessage,
}: {
  offer: MarketplaceBuyerOfferDetail;
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Buyer"
        title={offer.item_title}
        description="Review the details of your marketplace-wide offer."
        actions={
          <LinkButton href="/account/offers" tone="secondary">
            Back to offers
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
            <Text>Offer price: {formatMoney(offer.price_amount)}</Text>
            <Text>Quantity requested: {offer.quantity_requested}</Text>
            <Text>
              This offer is marketplace-wide. Sellers can review it when they publish
              matching active supply.
            </Text>
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
