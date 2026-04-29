import { useEffect, useState } from "react";
import {
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
import type { InventoryCatalogItemSnapshot } from "../integrations/catalog/queries";
import {
  getOptionLabel,
  isDimensionActive,
  normalizeSelectedOptionssForSchema,
  type InventoryProductSchema,
} from "../integrations/catalog/versioning";
import type { InventoryStorageLocation } from "../../storage-locations/ui/contracts";
import type { InventoryItemListItem } from "./contracts";

const DEFAULT_CATALOG_ITEM_API_BASE_URL = "/api/inventory/catalog-items";

function displayItemLabel(item: InventoryItemListItem) {
  return item.item_title ?? item.catalog_catalog_item_id;
}

function displayCost(item: InventoryItemListItem) {
  return item.acquisition_cost_amount ? `$${item.acquisition_cost_amount}` : "Not set";
}

function listingHref(item: InventoryItemListItem) {
  return `/account/listings?inventoryItemId=${encodeURIComponent(item.item_id)}`;
}

function getOrderedDimensions(schema: InventoryProductSchema) {
  return schema.canonicalDimensionOrder
    .map((entry) =>
      schema.dimensions.find((dimension) => dimension.dimensionId === entry.dimensionId),
    )
    .filter((dimension): dimension is InventoryProductSchema["dimensions"][number] => dimension !== undefined);
}

export function InventoryItemListPage({
  data,
  locations,
  errorMessage,
  catalogItemApiBaseUrl = DEFAULT_CATALOG_ITEM_API_BASE_URL,
}: {
  data: { items: readonly InventoryItemListItem[] };
  locations: readonly InventoryStorageLocation[];
  errorMessage?: string | null;
  catalogItemApiBaseUrl?: string;
}) {
  const [catalogItemId, setCatalogItemId] = useState("");
  const [catalogItem, setCatalogItem] = useState<InventoryCatalogItemSnapshot | null>(null);
  const [catalogLookupError, setCatalogLookupError] = useState<string | null>(null);
  const [catalogLookupPending, setCatalogLookupPending] = useState(false);
  const [selectedOptionss, setVersionSelections] = useState<Record<string, string>>({});

  useEffect(() => {
    const trimmedCatalogItemId = catalogItemId.trim();
    if (!trimmedCatalogItemId) {
      setCatalogItem(null);
      setCatalogLookupError(null);
      setCatalogLookupPending(false);
      setVersionSelections({});
      return;
    }

    const controller = new AbortController();
    setCatalogLookupPending(true);

    void fetch(
      `${catalogItemApiBaseUrl}/${encodeURIComponent(trimmedCatalogItemId)}`,
      {
        credentials: "include",
        signal: controller.signal,
      },
    )
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(body?.error ?? "Catalog item lookup failed.");
        }

        return response.json() as Promise<InventoryCatalogItemSnapshot>;
      })
      .then((item) => {
        setCatalogItem(item);
        setCatalogLookupError(null);
        setVersionSelections(
          item.product_schema
            ? normalizeSelectedOptionssForSchema(item.product_schema, {})
            : {},
        );
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }

        setCatalogItem(null);
        setVersionSelections({});
        setCatalogLookupError(
          error instanceof Error ? error.message : "Catalog item lookup failed.",
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setCatalogLookupPending(false);
        }
      });

    return () => controller.abort();
  }, [catalogItemApiBaseUrl, catalogItemId]);

  const serializedVersionSelection =
    catalogItem?.product_schema
      ? JSON.stringify(
          getOrderedDimensions(catalogItem.product_schema)
            .map((dimension) => {
              const optionId = selectedOptionss[dimension.dimensionId];
              if (!optionId) {
                return null;
              }

              return {
                dimensionId: dimension.dimensionId,
                optionId,
              };
            })
            .filter((entry): entry is { dimensionId: string; optionId: string } => entry !== null),
        )
      : "[]";

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

      <PageSection title="Create Inventory Item">
        <Card>
          <form method="post">
            <Stack gap={3}>
              <input type="hidden" name="intent" value="create-item" />
              <TextInput
                label="Catalog item ID"
                name="catalogItemId"
                required
                placeholder="cat_..."
                value={catalogItemId}
                onChange={(event) => setCatalogItemId(event.target.value)}
                description="Enter a catalog item ID to load product options."
              />
              <input type="hidden" name="selectedOptions" value={serializedVersionSelection} />
              {catalogLookupPending ? (
                <Text size="sm" tone="secondary">
                  Loading catalog item...
                </Text>
              ) : null}
              {catalogItem ? (
                <Card>
                  <Stack gap={2}>
                    <Text weight="semibold">{catalogItem.title}</Text>
                    {catalogItem.subtitle ? (
                      <Text tone="secondary" size="sm">
                        {catalogItem.subtitle}
                      </Text>
                    ) : null}
                    {catalogItem.product_schema &&
                    catalogItem.product_schema.dimensions.length > 0 ? (
                      getOrderedDimensions(catalogItem.product_schema).map((dimension) => {
                        const active = isDimensionActive(dimension, selectedOptionss);
                        if (!active) {
                          return null;
                        }

                        return (
                          <NativeSelect
                            key={dimension.dimensionId}
                            label={dimension.dimensionName}
                            name={`selectedOptions:${dimension.dimensionId}`}
                            value={selectedOptionss[dimension.dimensionId] ?? ""}
                            onChange={(event) =>
                              setVersionSelections((current) =>
                                normalizeSelectedOptionssForSchema(
                                  catalogItem.product_schema!,
                                  {
                                    ...current,
                                    [dimension.dimensionId]: event.target.value,
                                  },
                                ),
                              )
                            }
                            items={dimension.allowedOptions.map((option) => ({
                              value: option.optionId,
                              label: getOptionLabel(option),
                            }))}
                          />
                        );
                      })
                    ) : (
                      <Text size="sm" tone="secondary">
                        This catalog item does not require product options.
                      </Text>
                    )}
                  </Stack>
                </Card>
              ) : null}
              {catalogLookupError ? (
                <Text size="sm">
                  {catalogLookupError}
                </Text>
              ) : null}
              <NativeSelect
                label="Storage location"
                name="storageLocationId"
                required
                defaultValue=""
                placeholder="Select a location"
                items={locations.map((location) => ({
                  value: location.storage_location_id,
                  label: `${location.name} (${location.ship_from_code})`,
                }))}
              />
              <NumberInput label="Total quantity" name="totalQuantity" required min="1" />
              <TextInput
                label="Acquisition cost"
                name="acquisitionCostAmount"
                placeholder="4.25"
                inputMode="decimal"
              />
              <Button type="submit">Create inventory item</Button>
              <LinkButton href="/account/inventory/locations" tone="ghost">
                Need a location first?
              </LinkButton>
            </Stack>
          </form>
        </Card>
      </PageSection>

      <PageSection title="Current Inventory Items">
        <DataTable
          rows={[...data.items]}
          getRowId={(row) => row.item_id}
          columns={[
            {
              key: "item",
              header: "Inventory Item",
                  cell: (row) => (
                    <Stack gap={1}>
                      <Text weight="semibold">{displayItemLabel(row)}</Text>
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
                <Stack gap={2}>
                  <LinkButton
                    href={`/account/inventory/items/${row.item_id}`}
                    tone="secondary"
                    size="sm"
                  >
                    Open
                  </LinkButton>
                  {row.available_quantity > 0 ? (
                    <LinkButton
                      href={listingHref(row)}
                      tone="ghost"
                      size="sm"
                    >
                      Create listing
                    </LinkButton>
                  ) : null}
                </Stack>
              ),
            },
          ]}
          emptyTitle="No inventory items yet"
          emptyDescription="Create your first inventory item to start tracking availability."
        />
      </PageSection>
    </Page>
  );
}
