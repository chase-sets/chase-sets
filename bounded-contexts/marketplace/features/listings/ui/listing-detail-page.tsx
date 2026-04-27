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
import type { MarketplaceListingDetail, MarketplaceListingTermsPreview } from "./contracts";

function formatMoney(amount: string) {
  return `$${amount}`;
}

function formatOptionalMoney(amount: string | null) {
  return amount ? formatMoney(amount) : "Not set";
}

function renderPreviewSummary(preview: MarketplaceListingTermsPreview) {
  return [
    `Marketplace ${formatMoney(preview.marketplace_fee_amount)}`,
    `Payment ${formatMoney(preview.payment_fee_amount)}`,
    `Net ${formatMoney(preview.seller_net_amount)}`,
  ].join(" | ");
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
  priceDraftAmount,
  pricePreview,
  errorMessage,
}: {
  listing: MarketplaceListingDetail;
  priceDraftAmount?: string | null;
  pricePreview?: MarketplaceListingTermsPreview | null;
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Seller"
        title={listing.item_title ?? listing.catalog_catalog_item_id}
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
            {listing.product_summary ? (
              <Text size="sm" tone="secondary">
                {listing.product_summary}
              </Text>
            ) : null}
            <Badge tone={statusTone(listing.status)}>{listing.status}</Badge>
            <Text>Price: {formatMoney(listing.price_amount)}</Text>
            <Text>Marketplace fee: {formatOptionalMoney(listing.marketplace_fee_amount)}</Text>
            <Text>Payment fee: {formatOptionalMoney(listing.payment_fee_amount)}</Text>
            <Text>Seller net: {formatOptionalMoney(listing.seller_net_amount)}</Text>
            <Text>
              Terms schedule: {listing.terms_schedule_id ?? "Default fallback unavailable"}
            </Text>
            <Text>Agreement override: {listing.terms_agreement_id ?? "None"}</Text>
            <Text>
              Terms resolved at:{" "}
              {listing.terms_resolved_at
                ? new Date(listing.terms_resolved_at).toLocaleString()
                : "Not set"}
            </Text>
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
                <TextInput
                  label="Price"
                  name="priceAmount"
                  defaultValue={priceDraftAmount ?? listing.price_amount}
                  inputMode="decimal"
                  required
                />
                <Stack gap={2}>
                  <Button type="submit" name="intent" value="update-price" tone="secondary">
                    Save price
                  </Button>
                  <Button type="submit" name="intent" value="preview-price" tone="secondary">
                    Preview fees
                  </Button>
                </Stack>
              </Stack>
            </form>
            {pricePreview ? (
              <Stack gap={2}>
                <Text weight="semibold">Updated fee preview</Text>
                <Text size="sm" tone="secondary">
                  Account type: {pricePreview.account_type}
                </Text>
                <Text size="sm" tone="secondary">
                  {renderPreviewSummary(pricePreview)}
                </Text>
                <Text size="sm" tone="secondary">
                  Basis amount: {formatMoney(pricePreview.basis_amount)}
                </Text>
                <Text size="sm" tone="secondary">
                  Terms schedule: {pricePreview.schedule_id ?? "No schedule available"}
                </Text>
                <Text size="sm" tone="secondary">
                  Agreement override: {pricePreview.agreement_id ?? "None"}
                </Text>
              </Stack>
            ) : null}
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
