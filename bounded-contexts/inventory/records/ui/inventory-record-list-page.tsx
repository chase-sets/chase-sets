import {
  Card,
  ConditionBadge,
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
import type { InventoryStorageLocation } from "../../storage-locations/ui/contracts";
import type { InventoryRecordListItem } from "./contracts";

function displayItemLabel(record: InventoryRecordListItem) {
  return record.item_title ?? record.catalog_item_id;
}

function displayCost(record: InventoryRecordListItem) {
  return record.acquisition_cost_amount ? `$${record.acquisition_cost_amount}` : "Not set";
}

export function InventoryRecordListPage({
  data,
  locations,
  errorMessage,
}: {
  data: { items: readonly InventoryRecordListItem[] };
  locations: readonly InventoryStorageLocation[];
  errorMessage?: string | null;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow="Seller"
        title="Inventory"
        description="Manage private seller stock, availability, and operational locations."
        actions={
          <LinkButton href="/account/inventory/locations" tone="secondary">
            Manage locations
          </LinkButton>
        }
      />

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title="Create Record">
        <Card>
          <form method="post">
            <Stack gap={3}>
              <input type="hidden" name="intent" value="create-record" />
              <TextInput
                label="Catalog item ID"
                name="catalogItemId"
                required
                placeholder="cat_..."
              />
              <TextInput label="Condition" name="condition" required placeholder="NM" />
              <label>
                <Stack gap={1}>
                  <Text weight="semibold">Storage location</Text>
                  <select
                    name="storageLocationId"
                    required
                    className="min-h-11 rounded-tokenMd border border-border bg-background px-4 py-3 text-sm text-foreground"
                    defaultValue=""
                  >
                    <option value="" disabled>
                      Select a location
                    </option>
                    {locations.map((location) => (
                      <option
                        key={location.storage_location_id}
                        value={location.storage_location_id}
                      >
                        {location.name} ({location.ship_from_code})
                      </option>
                    ))}
                  </select>
                </Stack>
              </label>
              <NumberInput label="Total quantity" name="totalQuantity" required min="1" />
              <TextInput
                label="Acquisition cost"
                name="acquisitionCostAmount"
                placeholder="4.25"
                inputMode="decimal"
              />
              <button type="submit" className="sr-only">
                Create record
              </button>
              <LinkButton href="/account/inventory/locations" tone="ghost">
                Need a location first?
              </LinkButton>
            </Stack>
          </form>
        </Card>
      </PageSection>

      <PageSection title="Current Records">
        <DataTable
          rows={[...data.items]}
          getRowId={(row) => row.record_id}
          columns={[
            {
              key: "item",
              header: "Record",
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{displayItemLabel(row)}</Text>
                  {row.item_subtitle ? (
                    <Text tone="secondary" size="sm">
                      {row.item_subtitle}
                    </Text>
                  ) : null}
                </Stack>
              ),
            },
            {
              key: "condition",
              header: "Condition",
              cell: (row) => <ConditionBadge condition={row.condition as never} />,
            },
            {
              key: "location",
              header: "Location",
              cell: (row) => (
                <Stack gap={1}>
                  <Text>{row.storage_location_name}</Text>
                  <Text tone="secondary" size="sm">
                    {row.ship_from_code}
                  </Text>
                </Stack>
              ),
            },
            {
              key: "quantity",
              header: "Total",
              align: "right",
              cell: (row) => row.total_quantity,
            },
            {
              key: "held",
              header: "Held",
              align: "right",
              cell: (row) => row.held_quantity,
            },
            {
              key: "available",
              header: "Available",
              align: "right",
              cell: (row) => row.available_quantity,
            },
            {
              key: "cost",
              header: "Acquisition Cost",
              cell: (row) => displayCost(row),
            },
            {
              key: "actions",
              header: "Actions",
              cell: (row) => (
                <LinkButton
                  href={`/account/inventory/records/${row.record_id}`}
                  tone="secondary"
                  size="sm"
                >
                  Open
                </LinkButton>
              ),
            },
          ]}
          emptyTitle="No inventory records yet"
          emptyDescription="Create your first inventory record to start tracking availability."
        />
      </PageSection>
    </Page>
  );
}
