import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Stack,
  Text,
  TextInput,
  NumberInput,
  NativeSelect,
} from "@chase-sets/design-system";
import type {
  MarketplaceListingInventoryItemOption,
  MarketplaceListingListItem,
  MarketplaceListingTermsPreview,
} from "./contracts";

function formatMoney(amount: string | null) {
  if (!amount) {
    return "Not set";
  }

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

function inventoryLabel(inventoryItem: MarketplaceListingInventoryItemOption) {
  const segments = [
    inventoryItem.item_title ?? inventoryItem.catalog_catalog_item_id,
    inventoryItem.item_subtitle,
    inventoryItem.product_summary,
    `${inventoryItem.available_quantity} available`,
    inventoryItem.storage_location_name,
  ].filter(Boolean);

  return segments.join(" | ");
}

function renderFeeSummary(listing: MarketplaceListingListItem) {
  if (!listing.marketplace_fee_amount && !listing.payment_fee_amount && !listing.seller_net_amount) {
    return "Fee quote unavailable";
  }

  const segments = [
    `Marketplace ${formatMoney(listing.marketplace_fee_amount)}`,
    `Payment ${formatMoney(listing.payment_fee_amount)}`,
    `Net ${formatMoney(listing.seller_net_amount)}`,
  ];

  return segments.join(" | ");
}

function renderPreviewSummary(preview: MarketplaceListingTermsPreview) {
  return [
    `Marketplace ${formatMoney(preview.marketplace_fee_amount)}`,
    `Payment ${formatMoney(preview.payment_fee_amount)}`,
    `Net ${formatMoney(preview.seller_net_amount)}`,
  ].join(" | ");
}

function selectedInventorySummary(
  inventoryItems: readonly MarketplaceListingInventoryItemOption[],
  inventoryItemId?: string | null,
) {
  if (!inventoryItemId) {
    return null;
  }

  return inventoryItems.find((inventoryItem) => inventoryItem.item_id === inventoryItemId) ?? null;
}

export function MarketplaceListingListPage({
  data,
  inventoryItems,
  createForm,
  createPreview,
  errorMessage,
}: {
  data: { items: readonly MarketplaceListingListItem[] };
  inventoryItems: readonly MarketplaceListingInventoryItemOption[];
  createForm?: {
    inventoryItemId?: string | null;
    priceAmount?: string | null;
    quantityCap?: string | null;
  };
  createPreview?: MarketplaceListingTermsPreview | null;
  errorMessage?: string | null;
}) {
  const selectedInventory = selectedInventorySummary(
    inventoryItems,
    createForm?.inventoryItemId,
  );
  const hasInventory = inventoryItems.length > 0;

  return (
    <Page>
      <PageHeader
        eyebrow="Seller"
        title="Listings"
        description="Create, publish, and manage seller listings backed by inventory."
        actions={
          <LinkButton href="/account/inventory" tone="secondary">
            View inventory
          </LinkButton>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Create Listing">
        <Card>
          <form method="post">
            <Stack gap={3}>
              {!hasInventory ? (
                <Banner
                  title="No sellable inventory is available"
                  description="Add stock with available quantity before creating a listing."
                  actions={
                    <LinkButton href="/account/inventory" tone="secondary" size="sm">
                      Add inventory
                    </LinkButton>
                  }
                />
              ) : null}
              {selectedInventory ? (
                <Banner
                  title="Selected inventory"
                  description={
                    <>
                      {inventoryLabel(selectedInventory)}
                      <br />
                      The listing will use this inventory item's product, location, and available quantity.
                    </>
                  }
                />
              ) : null}
              <NativeSelect
                  label="Inventory item"
                name="inventoryItemId"
                required
                disabled={!hasInventory}
                defaultValue={createForm?.inventoryItemId ?? ""}
                placeholder="Select inventory"
                items={inventoryItems.map((inventoryItem) => ({
                  value: inventoryItem.item_id,
                  label: inventoryLabel(inventoryItem),
                }))}
              />
              <TextInput
                label="Price"
                name="priceAmount"
                placeholder="24.99"
                inputMode="decimal"
                defaultValue={createForm?.priceAmount ?? ""}
                required
                disabled={!hasInventory}
              />
              <NumberInput
                label="Quantity cap"
                name="quantityCap"
                min="1"
                defaultValue={createForm?.quantityCap ?? "1"}
                required
                disabled={!hasInventory}
              />
              <Stack gap={2}>
                <Button
                  type="submit"
                  name="intent"
                  value="create-and-publish-listing"
                  disabled={!hasInventory}
                >
                  Create and publish
                </Button>
                <Button
                  type="submit"
                  name="intent"
                  value="create-listing"
                  tone="secondary"
                  disabled={!hasInventory}
                >
                  Save as draft
                </Button>
                <Button
                  type="submit"
                  name="intent"
                  value="preview-listing"
                  tone="secondary"
                  disabled={!hasInventory}
                >
                  Preview fees
                </Button>
              </Stack>
            </Stack>
          </form>
        </Card>
        {createPreview ? (
          <Card>
            <Stack gap={2}>
              <Text weight="semibold">Listing fee preview</Text>
              <Text size="sm" tone="secondary">
                Account type: {createPreview.account_type}
              </Text>
              <Text size="sm" tone="secondary">
                {renderPreviewSummary(createPreview)}
              </Text>
              <Text size="sm" tone="secondary">
                Basis amount: {formatMoney(createPreview.basis_amount)}
              </Text>
              <Text size="sm" tone="secondary">
                Terms schedule: {createPreview.schedule_id ?? "No schedule available"}
              </Text>
              <Text size="sm" tone="secondary">
                Agreement override: {createPreview.agreement_id ?? "None"}
              </Text>
              <Text size="sm" tone="secondary">
                If you create the listing now, this quote will be frozen on the listing.
              </Text>
            </Stack>
          </Card>
        ) : null}
      </PageSection>

      <PageSection title="Current Listings">
        <DataTable
          rows={[...data.items]}
          getRowId={(row) => row.listing_id}
          columns={[
            {
              key: "listing",
              header: "Listing",
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{row.item_title ?? row.catalog_catalog_item_id}</Text>
                  {row.item_subtitle ? (
                    <Text tone="secondary" size="sm">
                      {row.item_subtitle}
                    </Text>
                  ) : null}
                  {row.product_summary ? (
                    <Text tone="secondary" size="sm">
                      {row.product_summary}
                    </Text>
                  ) : null}
                </Stack>
              ),
            },
            {
              key: "price",
              header: "Price",
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{formatMoney(row.price_amount)}</Text>
                  <Text size="sm" tone="secondary">
                    {renderFeeSummary(row)}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "quantityCap",
              header: "Cap",
              align: "right",
              cell: (row) => row.quantity_cap,
            },
            {
              key: "status",
              header: "Status",
              cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
            },
            {
              key: "location",
              header: "Inventory",
              cell: (row) => (
                <Stack gap={1}>
                  <Text>{row.storage_location_name ?? "Location unavailable"}</Text>
                  <Text size="sm" tone="secondary">
                    {row.ship_from_code ?? row.inventory_item_id}
                  </Text>
                  {row.terms_resolved_at ? (
                    <Text size="sm" tone="secondary">
                      Terms resolved {new Date(row.terms_resolved_at).toLocaleString()}
                    </Text>
                  ) : null}
                </Stack>
              ),
            },
            {
              key: "actions",
              header: "Actions",
              cell: (row) => (
                <LinkButton href={`/account/listings/${row.listing_id}`} tone="secondary" size="sm">
                  Open
                </LinkButton>
              ),
            },
          ]}
          emptyTitle="No listings yet"
          emptyDescription="Create a listing from available inventory to start publishing market supply."
        />
      </PageSection>
    </Page>
  );
}
