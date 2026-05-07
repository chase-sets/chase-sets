import { t } from "@chase-sets/localization";
import { useEffect, useState, type ReactNode } from "react";
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
  ProductSelectionSummary,
  productSelectionDetailsFromSummary,
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
  return item.acquisition_cost_amount ? `$${item.acquisition_cost_amount}` : t("inventory.features.inventoryItems.ui.inventoryItemListPage.not.set");
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
  feedbackPrompt,
}: {
  data: { items: readonly InventoryItemListItem[] };
  locations: readonly InventoryStorageLocation[];
  errorMessage?: string | null;
  catalogItemApiBaseUrl?: string;
  feedbackPrompt?: ReactNode;
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
          throw new Error(body?.error ?? t("inventory.features.inventoryItems.ui.inventoryItemListPage.catalog.item.lookup.failed"));
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
          error instanceof Error ? error.message : t("inventory.features.inventoryItems.ui.inventoryItemListPage.catalog.item.lookup.failed"),
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
        eyebrow={t("inventory.features.inventoryItems.ui.inventoryItemListPage.seller")}
        title={t("inventory.features.inventoryItems.ui.inventoryItemListPage.inventory")}
        description={t("inventory.features.inventoryItems.ui.inventoryItemListPage.manage.private.seller.stock.availability.and")}
        actions={
          <LinkButton href="/account/inventory/locations" tone="secondary">
            {t("inventory.features.inventoryItems.ui.inventoryItemListPage.manage.locations")}</LinkButton>
        }
      />

      {feedbackPrompt}

      {errorMessage ? (
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("inventory.features.inventoryItems.ui.inventoryItemListPage.create.inventory.item")}>
        <Card>
          <form method="post">
            <Stack gap={3}>
              <input type="hidden" name="intent" value="create-item" />
              <TextInput
                label={t("inventory.features.inventoryItems.ui.inventoryItemListPage.catalog.item.id")}
                name="catalogItemId"
                required
                placeholder={t("inventory.features.inventoryItems.ui.inventoryItemListPage.search.or.paste.catalog.item")}
                value={catalogItemId}
                onChange={(event) => setCatalogItemId(event.target.value)}
                description={t("inventory.features.inventoryItems.ui.inventoryItemListPage.enter.a.catalog.item.id.to")}
              />
              <input type="hidden" name="selectedOptions" value={serializedVersionSelection} />
              {catalogLookupPending ? (
                <Text size="sm" tone="secondary">
                  {t("inventory.features.inventoryItems.ui.inventoryItemListPage.loading.catalog.item")}</Text>
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
                        {t("inventory.features.inventoryItems.ui.inventoryItemListPage.this.catalog.item.does.not.require")}</Text>
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
                label={t("inventory.features.inventoryItems.ui.inventoryItemListPage.storage.location")}
                name="storageLocationId"
                required
                defaultValue=""
                placeholder={t("inventory.features.inventoryItems.ui.inventoryItemListPage.select.a.location")}
                items={locations.map((location) => ({
                  value: location.storage_location_id,
                  label: location.name,
                }))}
              />
              <NumberInput label={t("inventory.features.inventoryItems.ui.inventoryItemListPage.total.quantity")} name="totalQuantity" required min="1" />
              <TextInput
                label={t("inventory.features.inventoryItems.ui.inventoryItemListPage.acquisition.cost")}
                name="acquisitionCostAmount"
                placeholder="4.25"
                inputMode="decimal"
              />
              <Button type="submit">{t("inventory.features.inventoryItems.ui.inventoryItemListPage.create.inventory.item.2")}</Button>
              <LinkButton href="/account/inventory/locations" tone="ghost">
                {t("inventory.features.inventoryItems.ui.inventoryItemListPage.need.a.location.first")}</LinkButton>
            </Stack>
          </form>
        </Card>
      </PageSection>

      <PageSection title={t("inventory.features.inventoryItems.ui.inventoryItemListPage.current.inventory.items")}>
        <DataTable
          rows={[...data.items]}
          getRowId={(row) => row.item_id}
          columns={[
            {
              key: "item",
              header: t("inventory.features.inventoryItems.ui.inventoryItemListPage.inventory.item"),
                  cell: (row) => (
                    <Stack gap={1}>
                      <Text weight="semibold">{displayItemLabel(row)}</Text>
                      {row.item_subtitle ? (
                        <Text tone="secondary" size="sm">
                          {row.item_subtitle}
                        </Text>
                      ) : null}
                      {row.product_summary ? (
                        <ProductSelectionSummary
                          selections={productSelectionDetailsFromSummary(row.product_summary)}
                          summary={row.product_summary}
                          summaryAsChip
                        />
                      ) : null}
                    </Stack>
                  ),
                },
            {
              key: "location",
              header: t("inventory.features.inventoryItems.ui.inventoryItemListPage.location"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text>{row.storage_location_name}</Text>
                </Stack>
              ),
            },
            {
              key: "quantity",
              header: t("inventory.features.inventoryItems.ui.inventoryItemListPage.total"),
              align: "right",
              cell: (row) => row.total_quantity,
            },
            {
              key: "held",
              header: t("inventory.features.inventoryItems.ui.inventoryItemListPage.held"),
              align: "right",
              cell: (row) => row.held_quantity,
            },
            {
              key: "available",
              header: t("inventory.features.inventoryItems.ui.inventoryItemListPage.available"),
              align: "right",
              cell: (row) => row.available_quantity,
            },
            {
              key: "cost",
              header: t("inventory.features.inventoryItems.ui.inventoryItemListPage.acquisition.cost.2"),
              cell: (row) => displayCost(row),
            },
            {
              key: "actions",
              header: t("inventory.features.inventoryItems.ui.inventoryItemListPage.actions"),
              cell: (row) => (
                <Stack gap={2}>
                  <LinkButton
                    href={`/account/inventory/items/${row.item_id}`}
                    tone="secondary"
                    size="sm"
                  >
                    {t("inventory.features.inventoryItems.ui.inventoryItemListPage.open")}</LinkButton>
                  {row.available_quantity > 0 ? (
                    <LinkButton
                      href={listingHref(row)}
                      tone="ghost"
                      size="sm"
                    >
                      {t("inventory.features.inventoryItems.ui.inventoryItemListPage.create.listing")}</LinkButton>
                  ) : null}
                </Stack>
              ),
            },
          ]}
          emptyTitle={t("inventory.features.inventoryItems.ui.inventoryItemListPage.no.inventory.items.yet")}
          emptyDescription={t("inventory.features.inventoryItems.ui.inventoryItemListPage.create.your.first.inventory.item.to")}
        />
      </PageSection>
    </Page>
  );
}
