import {
  Badge,
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
} from "@chase-sets/design-system";
import type {
  MarketplaceListingInventoryRecordOption,
  MarketplaceListingListItem,
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

function inventoryLabel(record: MarketplaceListingInventoryRecordOption) {
  const segments = [
    record.item_title ?? record.catalog_item_id,
    record.item_subtitle,
    record.version_summary,
    `${record.available_quantity} available`,
    record.storage_location_name,
  ].filter(Boolean);

  return segments.join(" | ");
}

export function MarketplaceListingListPage({
  data,
  inventoryRecords,
  errorMessage,
}: {
  data: { items: readonly MarketplaceListingListItem[] };
  inventoryRecords: readonly MarketplaceListingInventoryRecordOption[];
  errorMessage?: string | null;
}) {
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
              <input type="hidden" name="intent" value="create-listing" />
              <label>
                <Stack gap={1}>
                  <Text weight="semibold">Inventory record</Text>
                  <select
                    name="inventoryRecordId"
                    required
                    defaultValue=""
                    className="min-h-11 rounded-tokenMd border border-border bg-background px-4 py-3 text-sm text-foreground"
                  >
                    <option value="" disabled>
                      Select inventory
                    </option>
                    {inventoryRecords.map((record) => (
                      <option key={record.record_id} value={record.record_id}>
                        {inventoryLabel(record)}
                      </option>
                    ))}
                  </select>
                </Stack>
              </label>
              <TextInput
                label="Price"
                name="priceAmount"
                placeholder="24.99"
                inputMode="decimal"
                required
              />
              <NumberInput
                label="Quantity cap"
                name="quantityCap"
                min="1"
                required
              />
              <Button type="submit">Create listing</Button>
            </Stack>
          </form>
        </Card>
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
                  <Text weight="semibold">{row.item_title ?? row.catalog_item_id}</Text>
                  {row.item_subtitle ? (
                    <Text tone="secondary" size="sm">
                      {row.item_subtitle}
                    </Text>
                  ) : null}
                  {row.version_summary ? (
                    <Text tone="secondary" size="sm">
                      {row.version_summary}
                    </Text>
                  ) : null}
                </Stack>
              ),
            },
            {
              key: "price",
              header: "Price",
              cell: (row) => formatMoney(row.price_amount),
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
                    {row.ship_from_code ?? row.inventory_record_id}
                  </Text>
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
