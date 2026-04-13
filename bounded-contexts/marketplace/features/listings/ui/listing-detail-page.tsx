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
  TextInput,
  NumberInput,
} from "@chase-sets/design-system";
import type { MarketplaceListingDetail } from "./contracts";

function formatMoney(amount: string) {
  return `$${amount}`;
}

function statusTone(status: string) {
  switch (status) {
    case "active":
      return "accent";
    case "paused":
      return "warning";
    case "withdrawn":
      return "danger";
    default:
      return "neutral";
  }
}

export function MarketplaceListingDetailPage({
  listing,
  errorMessage,
}: {
  listing: MarketplaceListingDetail;
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Seller"
        title={listing.item_title ?? listing.catalog_item_id}
        description="Manage seller listing pricing, quantity caps, and publication state."
        actions={
          <LinkButton href="/account/listings" tone="secondary">
            Back to listings
          </LinkButton>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Listing Overview">
        <Card>
          <Stack gap={2}>
            {listing.item_subtitle ? (
              <Text tone="secondary">{listing.item_subtitle}</Text>
            ) : null}
            {listing.version_summary ? (
              <Text size="sm" tone="secondary">
                {listing.version_summary}
              </Text>
            ) : null}
            <Badge tone={statusTone(listing.status)}>{listing.status}</Badge>
            <Text>Price: {formatMoney(listing.price_amount)}</Text>
            <Text>Quantity cap: {listing.quantity_cap}</Text>
            <Text>
              Inventory: {listing.storage_location_name ?? "Unknown location"}{" "}
              {listing.ship_from_code ? `(${listing.ship_from_code})` : ""}
            </Text>
          </Stack>
        </Card>
      </PageSection>

      <PageSection title="Update Listing">
        <Stack gap={4}>
          <Card>
            <form method="post">
              <Stack gap={3}>
                <input type="hidden" name="intent" value="update-price" />
                <TextInput
                  label="Price"
                  name="priceAmount"
                  defaultValue={listing.price_amount}
                  inputMode="decimal"
                  required
                />
                <Button type="submit" tone="secondary">
                  Save price
                </Button>
              </Stack>
            </form>
          </Card>

          <Card>
            <form method="post">
              <Stack gap={3}>
                <input type="hidden" name="intent" value="update-quantity-cap" />
                <NumberInput
                  label="Quantity cap"
                  name="quantityCap"
                  defaultValue={String(listing.quantity_cap)}
                  min="1"
                  required
                />
                <Button type="submit" tone="secondary">
                  Save quantity cap
                </Button>
              </Stack>
            </form>
          </Card>

          <Card>
            <Stack gap={3}>
              <form method="post">
                <input type="hidden" name="intent" value="publish" />
                <Button type="submit" disabled={listing.status === "active" || listing.status === "withdrawn"}>
                  Publish listing
                </Button>
              </form>
              <form method="post">
                <input type="hidden" name="intent" value="pause" />
                <Button type="submit" tone="secondary" disabled={listing.status !== "active"}>
                  Pause listing
                </Button>
              </form>
              <form method="post">
                <input type="hidden" name="intent" value="withdraw" />
                <Button type="submit" tone="danger" disabled={listing.status === "withdrawn"}>
                  Withdraw listing
                </Button>
              </form>
            </Stack>
          </Card>
        </Stack>
      </PageSection>
    </Page>
  );
}
