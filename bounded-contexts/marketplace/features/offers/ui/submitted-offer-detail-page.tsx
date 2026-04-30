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
        eyebrow="Offers"
        title={offer.item_title}
        description="Review the details of your submitted offer."
        actions={
          <LinkButton href="/account/offers/submitted" tone="secondary">
            Back to submitted offers
          </LinkButton>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Submitted Offer Overview">
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
              This submitted offer is marketplace-wide. Accounts can review it when they publish
              matching active supply.
            </Text>
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
