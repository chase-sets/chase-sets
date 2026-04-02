import { useEffect, useState } from "react";
import {
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
import type { InventoryCatalogItemSnapshot } from "../../catalog-items/queries";
import {
  getChoiceLabel,
  isDimensionActive,
  normalizeSelectionsForSchema,
  type InventoryVersionSchema,
} from "../../catalog-items/versioning";
import type { InventoryStorageLocation } from "../../storage-locations/ui/contracts";
import type { InventoryRecordListItem } from "./contracts";

const DEFAULT_CATALOG_ITEM_API_BASE_URL = "/api/inventory/catalog-items";

function displayItemLabel(record: InventoryRecordListItem) {
  return record.item_title ?? record.catalog_item_id;
}

function displayCost(record: InventoryRecordListItem) {
  return record.acquisition_cost_amount ? `$${record.acquisition_cost_amount}` : "Not set";
}

function getOrderedDimensions(schema: InventoryVersionSchema) {
  return schema.canonicalDimensionOrder
    .map((entry) =>
      schema.dimensions.find((dimension) => dimension.dimensionId === entry.dimensionId),
    )
    .filter((dimension): dimension is InventoryVersionSchema["dimensions"][number] => dimension !== undefined);
}

export function InventoryRecordListPage({
  data,
  locations,
  errorMessage,
  catalogItemApiBaseUrl = DEFAULT_CATALOG_ITEM_API_BASE_URL,
}: {
  data: { items: readonly InventoryRecordListItem[] };
  locations: readonly InventoryStorageLocation[];
  errorMessage?: string | null;
  catalogItemApiBaseUrl?: string;
}) {
  const [catalogItemId, setCatalogItemId] = useState("");
  const [catalogItem, setCatalogItem] = useState<InventoryCatalogItemSnapshot | null>(null);
  const [catalogLookupError, setCatalogLookupError] = useState<string | null>(null);
  const [catalogLookupPending, setCatalogLookupPending] = useState(false);
  const [versionSelections, setVersionSelections] = useState<Record<string, string>>({});

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
          item.version_schema
            ? normalizeSelectionsForSchema(item.version_schema, {})
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
    catalogItem?.version_schema
      ? JSON.stringify(
          getOrderedDimensions(catalogItem.version_schema)
            .map((dimension) => {
              const choiceId = versionSelections[dimension.dimensionId];
              if (!choiceId) {
                return null;
              }

              return {
                dimensionId: dimension.dimensionId,
                choiceId,
              };
            })
            .filter((entry): entry is { dimensionId: string; choiceId: string } => entry !== null),
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
                value={catalogItemId}
                onChange={(event) => setCatalogItemId(event.target.value)}
                description="Enter a catalog item ID to load version choices."
              />
              <input type="hidden" name="versionSelection" value={serializedVersionSelection} />
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
                    {catalogItem.version_schema &&
                    catalogItem.version_schema.dimensions.length > 0 ? (
                      getOrderedDimensions(catalogItem.version_schema).map((dimension) => {
                        const active = isDimensionActive(dimension, versionSelections);
                        if (!active) {
                          return null;
                        }

                        return (
                          <label key={dimension.dimensionId}>
                            <Stack gap={1}>
                              <Text weight="semibold">{dimension.dimensionName}</Text>
                              <select
                                name={`versionSelection:${dimension.dimensionId}`}
                                className="min-h-11 rounded-tokenMd border border-border bg-background px-4 py-3 text-sm text-foreground"
                                value={versionSelections[dimension.dimensionId] ?? ""}
                                onChange={(event) =>
                                  setVersionSelections((current) =>
                                    normalizeSelectionsForSchema(
                                      catalogItem.version_schema!,
                                      {
                                        ...current,
                                        [dimension.dimensionId]: event.target.value,
                                      },
                                    ),
                                  )
                                }
                              >
                                {dimension.allowedChoices.map((choice) => (
                                  <option key={choice.choiceId} value={choice.choiceId}>
                                    {getChoiceLabel(choice)}
                                  </option>
                                ))}
                              </select>
                            </Stack>
                          </label>
                        );
                      })
                    ) : (
                      <Text size="sm" tone="secondary">
                        This catalog item does not require a version selection.
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
                      {row.version_summary ? (
                        <Text tone="secondary" size="sm">
                          {row.version_summary}
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
