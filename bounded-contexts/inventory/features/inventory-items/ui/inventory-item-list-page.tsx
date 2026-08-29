import { formatLanguageCodeLabel, formatMoney, t } from "@chase-sets/localization";
import { useEffect, useRef, useState } from "react";
import { useNavigation } from "react-router";
import {
  HiddenInput,
  Form,
  Button,
  Badge,
  Card,
  DataTable,
  Grid,
  Inset,
  LinkButton,
  Page,
  PageHeader,
  PageSection,
  Pagination,
  ProductSelectionFields,
  Stack,
  Text,
  TextInput,
  NumberField,
  NativeSelect,
  ProductOptions,
  ResponsiveEditSheet,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import type { InventoryCatalogItemSnapshot } from "../integrations/catalog/queries";
import {
  normalizeSelectedOptionsForSchema,
  recordToSelectionEntries,
  toInventoryProductSelectionFields,
} from "../integrations/catalog/versioning";
import type { InventoryStorageLocation } from "../../storage-locations/ui/contracts";
import type { InventoryItemListItem } from "./contracts";
import { inventoryListingHref } from "./listing-handoff";
import { OfflineSaleForm, OfflineSaleResult } from "./offline-sale-form";

const DEFAULT_CATALOG_ITEM_API_BASE_URL = "/api/inventory/catalog-items";

type CatalogItemSearchResponse = Readonly<{
  items?: readonly InventoryCatalogItemSnapshot[];
}>;

function displayItemLabel(item: InventoryItemListItem) {
  return item.item_title ?? item.catalog_catalog_item_id;
}

function displayCost(item: InventoryItemListItem) {
  return item.acquisition_cost_amount
    ? formatMoney(item.acquisition_cost_amount, "USD")
    : t("inventory.features.inventoryItems.ui.inventoryItemListPage.not.set");
}

function catalogItemOptionLabel(item: InventoryCatalogItemSnapshot) {
  return [item.title, item.subtitle].filter(Boolean).join(" - ");
}

function navigateToInventoryItemListPage(page: number, pageSize: number) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("offset", String((page - 1) * pageSize));
  window.location.assign(`${url.pathname}${url.search}${url.hash}`);
}

function selectedOptionsFromEntries(entries: readonly { dimensionId: string; optionId: string }[]) {
  return Object.fromEntries(entries.map((entry) => [entry.dimensionId, entry.optionId]));
}

export function InventoryItemListPage({
  data,
  pagination,
  locations,
  errorMessage,
  offlineSaleErrorMessage,
  catalogItemApiBaseUrl = DEFAULT_CATALOG_ITEM_API_BASE_URL,
  createItemDraft,
  currentPath,
  canRecordOfflineSale = false,
  canHonorOffline = false,
  offlineSaleFormTokens = {},
  offlineSaleResult,
  offlineSaleFreshness,
  offlineSaleAuthoritativeAvailableQuantity,
}: {
  data: { items: readonly InventoryItemListItem[] };
  pagination?: Readonly<{ limit: number; offset: number; total: number }>;
  locations: readonly InventoryStorageLocation[];
  errorMessage?: string | null;
  offlineSaleErrorMessage?: string | null;
  catalogItemApiBaseUrl?: string;
  createItemDraft?: {
    catalogItemId?: string | null;
    selectedOptions?: readonly { dimensionId: string; optionId: string }[];
    returnTo?: string | null;
  } | null;
  currentPath?: string | null;
  canRecordOfflineSale?: boolean;
  canHonorOffline?: boolean;
  offlineSaleFormTokens?: Readonly<Record<string, string>>;
  offlineSaleResult?: import("../../../client").InventoryOfflineSaleResult | null;
  offlineSaleFreshness?: Readonly<{ itemId: string; state: "fresh" | "pending" | "unverified" }> | null;
  offlineSaleAuthoritativeAvailableQuantity?: number;
}) {
  const navigation = useNavigation();
  const pageSize = pagination?.limit ?? data.items.length;
  const currentPage = pagination && pageSize > 0 ? Math.floor(pagination.offset / pageSize) + 1 : 1;
  const totalPages = pagination && pageSize > 0 ? Math.max(1, Math.ceil(pagination.total / pageSize)) : 1;
  const showPagination = Boolean(pagination && (pagination.total > pageSize || pagination.offset > 0));
  const [initialCatalogItemId] = useState(() => createItemDraft?.catalogItemId?.trim() ?? "");
  const [initialSelectedOptions] = useState(() => selectedOptionsFromEntries(createItemDraft?.selectedOptions ?? []));
  const [catalogItemSearch, setCatalogItemSearch] = useState(initialCatalogItemId);
  const [catalogSearchResults, setCatalogSearchResults] = useState<readonly InventoryCatalogItemSnapshot[]>([]);
  const [catalogItemId, setCatalogItemId] = useState(initialCatalogItemId);
  const [catalogItem, setCatalogItem] = useState<InventoryCatalogItemSnapshot | null>(null);
  const [catalogLookupError, setCatalogLookupError] = useState<string | null>(null);
  const [catalogLookupPending, setCatalogLookupPending] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const [openOfflineSaleItemId, setOpenOfflineSaleItemId] = useState<string | null>(null);
  const [invokingOfflineSaleItemId, setInvokingOfflineSaleItemId] = useState<string | null>(null);
  const invokingOfflineSaleTriggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreOfflineSaleFocusRef = useRef(false);

  useEffect(() => {
    if (navigation.state !== "submitting") {
      return;
    }

    if (navigation.formData?.get("intent") !== "record-offline-sale") {
      setInvokingOfflineSaleItemId(null);
      return;
    }

    setInvokingOfflineSaleItemId(String(navigation.formData.get("itemId") ?? ""));
  }, [navigation.formData, navigation.state]);

  useEffect(() => {
    if (!offlineSaleResult) {
      return;
    }

    restoreOfflineSaleFocusRef.current = true;
    setOpenOfflineSaleItemId(null);
  }, [offlineSaleResult]);

  useEffect(() => {
    if (openOfflineSaleItemId !== null || !restoreOfflineSaleFocusRef.current) {
      return;
    }

    restoreOfflineSaleFocusRef.current = false;
    invokingOfflineSaleTriggerRef.current?.focus();
  }, [openOfflineSaleItemId]);

  useEffect(() => {
    const search = catalogItemSearch.trim();
    if (search.length < 2) {
      setCatalogSearchResults([]);
      setCatalogLookupError(null);
      setCatalogLookupPending(false);
      return;
    }

    const controller = new AbortController();
    setCatalogLookupPending(true);
    const query = new URLSearchParams({ search, status: "active", limit: "10" });

    void fetch(`${catalogItemApiBaseUrl}?${query.toString()}`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string | { message?: string } } | null;
          const message = typeof body?.error === "string" ? body.error : body?.error?.message;
          throw new Error(
            message ?? t("inventory.features.inventoryItems.ui.inventoryItemListPage.catalog.item.lookup.failed"),
          );
        }

        return response.json() as Promise<CatalogItemSearchResponse>;
      })
      .then((result) => {
        const items = result.items ?? [];
        setCatalogSearchResults(items);
        setCatalogLookupError(
          items.length === 0
            ? t("inventory.features.inventoryItems.ui.inventoryItemListPage.no.active.catalog.items.matched")
            : null,
        );

        if (catalogItemId) {
          const selectedItem = items.find((item) => item.catalog_item_id === catalogItemId);
          if (selectedItem) {
            setCatalogItem(selectedItem);
            if (catalogItemSearch.trim() === catalogItemId) {
              setCatalogItemSearch(selectedItem.title);
              setSelectedOptions(
                selectedItem.product_schema
                  ? normalizeSelectedOptionsForSchema(
                      selectedItem.product_schema,
                      catalogItemId === initialCatalogItemId ? initialSelectedOptions : {},
                    )
                  : {},
              );
            }
          }
        }
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }

        setCatalogSearchResults([]);
        setCatalogLookupError(
          error instanceof Error
            ? error.message
            : t("inventory.features.inventoryItems.ui.inventoryItemListPage.catalog.item.lookup.failed"),
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setCatalogLookupPending(false);
        }
      });

    return () => controller.abort();
  }, [catalogItemApiBaseUrl, catalogItemId, catalogItemSearch, initialCatalogItemId, initialSelectedOptions]);

  function resetCatalogItemSelection(nextSearch: string) {
    setCatalogItemSearch(nextSearch);
    setCatalogItemId("");
    setCatalogItem(null);
    setSelectedOptions({});
  }

  function selectCatalogItem(nextCatalogItemId: string) {
    const item = catalogSearchResults.find((candidate) => candidate.catalog_item_id === nextCatalogItemId);
    setCatalogItemId(nextCatalogItemId);
    setCatalogItem(item ?? null);
    setCatalogLookupError(null);
    setCatalogItemSearch(item?.title ?? catalogItemSearch);
    setSelectedOptions(
      item?.product_schema
        ? normalizeSelectedOptionsForSchema(
            item.product_schema,
            nextCatalogItemId === initialCatalogItemId ? initialSelectedOptions : {},
          )
        : {},
    );
  }

  const productSelectionFields = toInventoryProductSelectionFields(
    catalogItem?.product_schema ?? null,
    selectedOptions,
  );
  const serializedVersionSelection = catalogItem?.product_schema
    ? JSON.stringify(recordToSelectionEntries(catalogItem.product_schema, selectedOptions))
    : "[]";
  const openOfflineSaleItem = openOfflineSaleItemId
    ? (data.items.find((item) => item.item_id === openOfflineSaleItemId) ?? null)
    : null;

  function openOfflineSale(itemId: string, trigger: HTMLButtonElement) {
    invokingOfflineSaleTriggerRef.current = trigger;
    setOpenOfflineSaleItemId(itemId);
  }

  function closeOfflineSale() {
    restoreOfflineSaleFocusRef.current = true;
    setOpenOfflineSaleItemId(null);
  }

  return (
    <Page>
      <PageHeader
        eyebrow={t("inventory.features.inventoryItems.ui.inventoryItemListPage.seller")}
        title={t("inventory.features.inventoryItems.ui.inventoryItemListPage.inventory")}
        description={t(
          "inventory.features.inventoryItems.ui.inventoryItemListPage.manage.private.seller.stock.availability.and",
        )}
        actions={
          <LinkButton href="/account/inventory/locations" tone="secondary">
            {t("inventory.features.inventoryItems.ui.inventoryItemListPage.manage.locations")}
          </LinkButton>
        }
      />

      {errorMessage ? (
        <Card elevation="tinted" data-elevation-role="furniture">
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

      <PageSection title={t("inventory.features.inventoryItems.ui.inventoryItemListPage.create.inventory.item")}>
        <Card elevation="tinted" data-elevation-role="furniture">
          <Form spacing="none" method="post">
            <Grid columns={{ base: 1, lg: 2 }} gap={5}>
              <HiddenInput type="hidden" name="intent" value="create-item" />
              <Stack gap={3}>
                {createItemDraft?.returnTo ? (
                  <HiddenInput type="hidden" name="returnTo" value={createItemDraft.returnTo} />
                ) : null}
                <TextInput
                  label={t("inventory.features.inventoryItems.ui.inventoryItemListPage.search.catalog")}
                  placeholder={t(
                    "inventory.features.inventoryItems.ui.inventoryItemListPage.search.or.paste.catalog.item",
                  )}
                  value={catalogItemSearch}
                  onChange={(event) => resetCatalogItemSelection(event.target.value)}
                  description={t(
                    "inventory.features.inventoryItems.ui.inventoryItemListPage.search.by.title.or.paste.catalog",
                  )}
                />
                <NativeSelect
                  label={t("inventory.features.inventoryItems.ui.inventoryItemListPage.catalog.item")}
                  name="catalogItemId"
                  required
                  value={catalogItemId}
                  onChange={(event) => selectCatalogItem(event.target.value)}
                  disabled={catalogSearchResults.length === 0}
                  placeholder={
                    catalogLookupPending
                      ? t("inventory.features.inventoryItems.ui.inventoryItemListPage.searching.catalog.items")
                      : t("inventory.features.inventoryItems.ui.inventoryItemListPage.select.a.catalog.item")
                  }
                  items={catalogSearchResults.map((item) => ({
                    value: item.catalog_item_id,
                    label: catalogItemOptionLabel(item),
                  }))}
                  description={t(
                    "inventory.features.inventoryItems.ui.inventoryItemListPage.choose.the.visible.catalog.item",
                  )}
                />
                <HiddenInput type="hidden" name="selectedOptions" value={serializedVersionSelection} />
                {catalogLookupPending ? (
                  <Text size="sm" tone="secondary">
                    {t("inventory.features.inventoryItems.ui.inventoryItemListPage.searching.catalog.items")}
                  </Text>
                ) : null}
                {catalogLookupError ? <Text size="sm">{catalogLookupError}</Text> : null}
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
                <Grid columns={{ base: 1, md: 2 }} gap={3}>
                  <NumberField
                    label={t("inventory.features.inventoryItems.ui.inventoryItemListPage.total.quantity")}
                    name="totalQuantity"
                    required
                    min={1}
                  />
                  <TextInput
                    label={t("inventory.features.inventoryItems.ui.inventoryItemListPage.acquisition.cost")}
                    name="acquisitionCostAmount"
                    placeholder="4.25"
                    inputMode="decimal"
                  />
                </Grid>
                <Stack direction={{ base: "column", md: "row" }} align={{ base: "stretch", md: "center" }} gap={2}>
                  <Button type="submit">
                    {t("inventory.features.inventoryItems.ui.inventoryItemListPage.create.inventory.item.2")}
                  </Button>
                  <LinkButton href="/account/inventory/locations" tone="ghost">
                    {t("inventory.features.inventoryItems.ui.inventoryItemListPage.need.a.location.first")}
                  </LinkButton>
                </Stack>
              </Stack>
              <Inset>
                {catalogItem ? (
                  <Stack gap={2}>
                    <Text weight="semibold">{catalogItem.title}</Text>
                    {catalogItem.subtitle ? (
                      <Text tone="secondary" size="sm">
                        {catalogItem.subtitle}
                      </Text>
                    ) : null}
                    {catalogItem.product_schema && catalogItem.product_schema.dimensions.length > 0 ? (
                      <ProductSelectionFields
                        fields={productSelectionFields}
                        fieldName={(dimensionId) => `selectedOptions:${dimensionId}`}
                        onFieldChange={(dimensionId, optionId) =>
                          setSelectedOptions((current) =>
                            normalizeSelectedOptionsForSchema(catalogItem.product_schema!, {
                              ...current,
                              [dimensionId]: optionId,
                            }),
                          )
                        }
                      />
                    ) : (
                      <Text size="sm" tone="secondary">
                        {t(
                          "inventory.features.inventoryItems.ui.inventoryItemListPage.this.catalog.item.does.not.require",
                        )}
                      </Text>
                    )}
                  </Stack>
                ) : (
                  <Text tone="secondary">
                    {t("inventory.features.inventoryItems.ui.inventoryItemListPage.search.for.a.catalog.item.then")}
                  </Text>
                )}
              </Inset>
            </Grid>
          </Form>
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
                  {row.language_code ? (
                    <Badge tone="neutral">{formatLanguageCodeLabel(row.language_code)}</Badge>
                  ) : null}
                  {row.item_subtitle ? (
                    <Text tone="secondary" size="sm">
                      {row.item_subtitle}
                    </Text>
                  ) : null}
                  {row.product_summary ? (
                    <ProductOptions options={productOptionsFromSummary(row.product_summary)} variant="chips" />
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
                  <LinkButton href={`/account/inventory/items/${row.item_id}`} tone="secondary" size="sm">
                    {t("inventory.features.inventoryItems.ui.inventoryItemListPage.open")}
                  </LinkButton>
                  {row.available_quantity > 0 ? (
                    <LinkButton href={inventoryListingHref(row.item_id, currentPath)} tone="ghost" size="sm">
                      {t("inventory.features.inventoryItems.ui.inventoryItemListPage.create.listing")}
                    </LinkButton>
                  ) : null}
                  {canRecordOfflineSale && offlineSaleFormTokens[row.item_id] ? (
                    <Button
                      size="sm"
                      tone="secondary"
                      onClick={(event) => openOfflineSale(row.item_id, event.currentTarget)}
                    >
                      {t("inventory.features.inventoryItems.ui.offlineSaleForm.trigger")}
                    </Button>
                  ) : null}
                </Stack>
              ),
            },
          ]}
          emptyTitle={t("inventory.features.inventoryItems.ui.inventoryItemListPage.no.inventory.items.yet")}
          emptyDescription={t(
            "inventory.features.inventoryItems.ui.inventoryItemListPage.create.your.first.inventory.item.to",
          )}
        />
        <ResponsiveEditSheet
          open={openOfflineSaleItem !== null}
          onOpenChange={(open) => {
            if (!open) {
              closeOfflineSale();
            }
          }}
          title={t("inventory.features.inventoryItems.ui.offlineSaleForm.title")}
          description={
            openOfflineSaleItem
              ? t("inventory.features.inventoryItems.ui.offlineSaleForm.sheet.description", {
                  item: displayItemLabel(openOfflineSaleItem),
                })
              : undefined
          }
          closeLabel={t("inventory.features.inventoryItems.ui.offlineSaleForm.close")}
        >
          {openOfflineSaleItem ? (
            <OfflineSaleForm
              initialIdempotencyKey={offlineSaleFormTokens[openOfflineSaleItem.item_id]!}
              canHonorOffline={canHonorOffline}
              result={null}
              confirmedResult={offlineSaleResult?.itemId === openOfflineSaleItem.item_id ? offlineSaleResult : null}
              itemId={openOfflineSaleItem.item_id}
              errorMessage={invokingOfflineSaleItemId === openOfflineSaleItem.item_id ? offlineSaleErrorMessage : null}
            />
          ) : null}
        </ResponsiveEditSheet>
        {offlineSaleResult ? (
          <OfflineSaleResult
            result={offlineSaleResult}
            authoritativeAvailableQuantity={offlineSaleAuthoritativeAvailableQuantity}
            verificationState={
              offlineSaleFreshness?.itemId === offlineSaleResult.itemId ? offlineSaleFreshness.state : "unverified"
            }
          />
        ) : null}
        {showPagination ? (
          <Pagination
            page={currentPage}
            totalPages={totalPages}
            onPageChange={(page) => navigateToInventoryItemListPage(page, pageSize)}
          />
        ) : null}
      </PageSection>
    </Page>
  );
}
