import { formatBpsPercent, formatMoney as formatMoneyDisplay, t } from "@chase-sets/localization";
import { useEffect, useState } from "react";
import {
  HiddenInput,
  Form,
  Accordion,
  Banner,
  Button,
  Card,
  FileDropzone,
  Grid,
  Inline,
  Inset,
  LinkButton,
  MarketplaceNotice,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  ProductSelectionFields,
  Stack,
  Text,
  TextInput,
  CurrencyInput,
  NumberField,
  NativeSelect,
} from "@chase-sets/design-system";
import {
  normalizeProductSelection,
  productSelectionEntriesToRecord,
  recordToProductSelectionEntries,
  toProductSelectionFields,
  type ProductSelectionSchema,
} from "@chase-sets/product-selection";
import type { MarketplaceListingInventoryItemOption, MarketplaceListingTermsPreview } from "./contracts";

const DEFAULT_CATALOG_ITEM_API_BASE_URL = "/api/inventory/catalog-items";

type ListingCatalogItemSnapshot = Readonly<{
  catalog_item_id: string;
  title: string;
  subtitle?: string | null;
  product_schema: ProductSelectionSchema | null;
}>;

type ListingCatalogItemSearchResponse = Readonly<{
  items?: readonly ListingCatalogItemSnapshot[];
}>;

function formatMoney(amount: string | null) {
  if (!amount) {
    return t("marketplace.features.listings.ui.listingCreatePage.not.set");
  }

  return formatMoneyDisplay(amount, "USD");
}

function inventoryLabel(inventoryItem: MarketplaceListingInventoryItemOption) {
  const segments = [
    inventoryItem.item_title ?? inventoryItem.catalog_catalog_item_id,
    inventoryItem.item_subtitle,
    inventoryItem.product_summary?.replaceAll(" | ", ", "),
    inventoryItem.product_measure_snapshot
      ? null
      : t("marketplace.features.listings.ui.listingCreatePage.shipping.measure.missing"),
    t("marketplace.features.listings.ui.listingCreatePage.quantity.available", {
      quantity: inventoryItem.available_quantity,
    }),
    inventoryItem.storage_location_name,
  ].filter(Boolean);

  return segments.join(" - ");
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

function catalogItemOptionLabel(item: ListingCatalogItemSnapshot) {
  return [item.title, item.subtitle].filter(Boolean).join(" - ");
}

export function MarketplaceListingCreatePage({
  inventoryItems,
  createForm,
  createPreview,
  errorMessage,
  hasListingStockLocation,
  catalogItemApiBaseUrl = DEFAULT_CATALOG_ITEM_API_BASE_URL,
  backHref = "/account/listings",
}: {
  inventoryItems: readonly MarketplaceListingInventoryItemOption[];
  createForm?: {
    inventoryItemId?: string | null;
    catalogItemId?: string | null;
    selectedOptions?: readonly { dimensionId: string; optionId: string }[] | null;
    priceAmount?: string | null;
    quantityCap?: string | null;
    maxUnitsPerOrder?: string | null;
    maxUnitsPerDay?: string | null;
    maxUnitsPerCustomerAccount?: string | null;
  };
  createPreview?: MarketplaceListingTermsPreview | null;
  errorMessage?: string | null;
  hasListingStockLocation: boolean;
  catalogItemApiBaseUrl?: string;
  backHref?: string;
}) {
  const selectedInventory = selectedInventorySummary(inventoryItems, createForm?.inventoryItemId);
  const selectedInventoryBlocksPublication =
    selectedInventory !== null && selectedInventory.product_measure_snapshot === null;
  const hasInventory = inventoryItems.length > 0;
  const [initialCatalogItemId] = useState(() => createForm?.catalogItemId?.trim() ?? "");
  const [initialSelectedOptions] = useState(() => productSelectionEntriesToRecord(createForm?.selectedOptions ?? []));
  const [catalogItemSearch, setCatalogItemSearch] = useState(initialCatalogItemId);
  const [catalogSearchResults, setCatalogSearchResults] = useState<readonly ListingCatalogItemSnapshot[]>([]);
  const [catalogItemId, setCatalogItemId] = useState(initialCatalogItemId);
  const [catalogItem, setCatalogItem] = useState<ListingCatalogItemSnapshot | null>(null);
  const [catalogLookupError, setCatalogLookupError] = useState<string | null>(null);
  const [catalogLookupPending, setCatalogLookupPending] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const productSelectionFields = toProductSelectionFields(catalogItem?.product_schema ?? null, selectedOptions);
  const serializedSelectedOptions = catalogItem?.product_schema
    ? JSON.stringify(recordToProductSelectionEntries(catalogItem.product_schema, selectedOptions))
    : JSON.stringify(createForm?.selectedOptions ?? []);

  useEffect(() => {
    const search = catalogItemSearch.trim();
    if (search.length < 2) {
      setCatalogSearchResults([]);
      setCatalogLookupError(null);
      setCatalogLookupPending(false);
      return undefined;
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
            message ?? t("marketplace.features.listings.ui.listingCreatePage.catalog.item.lookup.failed"),
          );
        }

        return response.json() as Promise<ListingCatalogItemSearchResponse>;
      })
      .then((result) => {
        const items = result.items ?? [];
        setCatalogSearchResults(items);
        setCatalogLookupError(
          items.length === 0
            ? t("marketplace.features.listings.ui.listingCreatePage.no.active.catalog.items.matched")
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
                  ? normalizeProductSelection(
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
            : t("marketplace.features.listings.ui.listingCreatePage.catalog.item.lookup.failed"),
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
        ? normalizeProductSelection(
            item.product_schema,
            nextCatalogItemId === initialCatalogItemId ? initialSelectedOptions : {},
          )
        : {},
    );
  }

  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.listings.ui.listingCreatePage.seller")}
        title={t("marketplace.features.listings.ui.listingCreatePage.create.listing")}
        description={t("marketplace.features.listings.ui.listingCreatePage.choose.a.product.price.and.quantity")}
        actions={
          <LinkButton href={backHref} tone="secondary">
            {t("marketplace.features.listings.ui.listingCreatePage.back.to.listings")}
          </LinkButton>
        }
      />

      {errorMessage ? (
        <MarketplaceNotice
          tone="danger"
          title={t("marketplace.features.listings.ui.listingCreatePage.create.listing")}
          description={errorMessage}
        />
      ) : null}

      <PageSection title={t("marketplace.features.listings.ui.listingCreatePage.create.listing")}>
        <Card>
          <Form spacing="none" method="post" encType="multipart/form-data">
            <Stack gap={3}>
              <Banner
                title={t("marketplace.features.listings.ui.listingCreatePage.list.without.managing.inventory")}
                description={t(
                  "marketplace.features.listings.ui.listingCreatePage.choose.a.product.price.and.quantity",
                )}
                tone="info"
              />
              {selectedInventory ? (
                <Banner
                  title={t("marketplace.features.listings.ui.listingCreatePage.advanced.inventory.selected")}
                  description={
                    <>
                      {inventoryLabel(selectedInventory)}
                      <br />
                      {t("marketplace.features.listings.ui.listingCreatePage.the.listing.will.use.this.inventory")}
                    </>
                  }
                />
              ) : null}
              {selectedInventoryBlocksPublication ? (
                <MarketplaceNotice
                  tone="warning"
                  title={t("marketplace.features.listings.ui.listingCreatePage.shipping.measure.missing")}
                  description={t(
                    "marketplace.features.listings.ui.listingCreatePage.publish.requires.shipping.measure",
                  )}
                />
              ) : null}
              <HiddenInput type="hidden" name="selectedOptions" value={serializedSelectedOptions} />
              <Grid columns={{ base: 1, lg: 2 }} gap={5}>
                <Stack gap={3}>
                  <TextInput
                    label={t("marketplace.features.listings.ui.listingCreatePage.search.catalog")}
                    placeholder={t("marketplace.features.listings.ui.listingCreatePage.search.or.paste.catalog.item")}
                    value={catalogItemSearch}
                    onChange={(event) => resetCatalogItemSelection(event.target.value)}
                    description={t(
                      "marketplace.features.listings.ui.listingCreatePage.search.by.title.or.paste.catalog",
                    )}
                  />
                  <NativeSelect
                    label={t("marketplace.features.listings.ui.listingCreatePage.catalog.item")}
                    name="catalogItemId"
                    required
                    value={catalogItemId}
                    onChange={(event) => selectCatalogItem(event.target.value)}
                    disabled={catalogSearchResults.length === 0}
                    placeholder={
                      catalogLookupPending
                        ? t("marketplace.features.listings.ui.listingCreatePage.searching.catalog.items")
                        : t("marketplace.features.listings.ui.listingCreatePage.select.a.catalog.item")
                    }
                    items={catalogSearchResults.map((item) => ({
                      value: item.catalog_item_id,
                      label: catalogItemOptionLabel(item),
                    }))}
                    description={t(
                      "marketplace.features.listings.ui.listingCreatePage.choose.the.visible.catalog.item",
                    )}
                  />
                  {catalogLookupPending ? (
                    <Text size="sm" tone="secondary">
                      {t("marketplace.features.listings.ui.listingCreatePage.searching.catalog.items")}
                    </Text>
                  ) : null}
                  {catalogLookupError ? <Text size="sm">{catalogLookupError}</Text> : null}
                  <Grid columns={{ base: 1, md: 2 }} gap={3}>
                    <CurrencyInput
                      label={t("marketplace.features.listings.ui.listingCreatePage.price")}
                      name="priceAmount"
                      currencyCode="USD"
                      placeholder="24.99"
                      defaultValue={createForm?.priceAmount ?? undefined}
                      required
                    />
                    <NumberField
                      label={t("marketplace.features.listings.ui.listingCreatePage.quantity.cap")}
                      name="quantityCap"
                      min={1}
                      defaultValue={createForm?.quantityCap ? Number(createForm.quantityCap) : 1}
                      required
                    />
                  </Grid>
                  <Text size="sm" tone="secondary">
                    {t("marketplace.features.listings.ui.listingCreatePage.quantity.cap.exposure.copy")}
                  </Text>
                  {!hasListingStockLocation ? (
                    <Stack gap={3}>
                      <Text weight="semibold">{t("marketplace.features.listings.ui.listingCreatePage.ship.from")}</Text>
                      <TextInput
                        label={t("marketplace.features.listings.ui.listingCreatePage.ship.from.name")}
                        name="shipFromName"
                      />
                      <TextInput
                        label={t("marketplace.features.listings.ui.listingCreatePage.ship.from.line1")}
                        name="shipFromLine1"
                      />
                      <Grid columns={{ base: 1, md: 2 }} gap={3}>
                        <TextInput
                          label={t("marketplace.features.listings.ui.listingCreatePage.ship.from.city")}
                          name="shipFromCity"
                        />
                        <TextInput
                          label={t("marketplace.features.listings.ui.listingCreatePage.ship.from.state")}
                          name="shipFromState"
                        />
                        <TextInput
                          label={t("marketplace.features.listings.ui.listingCreatePage.ship.from.postal.code")}
                          name="shipFromPostalCode"
                        />
                        <TextInput
                          label={t("marketplace.features.listings.ui.listingCreatePage.ship.from.country")}
                          name="shipFromCountry"
                          defaultValue="US"
                        />
                      </Grid>
                    </Stack>
                  ) : null}
                </Stack>
                <Stack gap={3}>
                  <Inset>
                    {catalogItem?.product_schema ? (
                      <Stack gap={2}>
                        <Text weight="semibold">{catalogItem.title}</Text>
                        <ProductSelectionFields
                          fields={productSelectionFields}
                          fieldName={(dimensionId) => `selectedOptions:${dimensionId}`}
                          onFieldChange={(dimensionId, optionId) =>
                            setSelectedOptions((current) =>
                              normalizeProductSelection(catalogItem.product_schema!, {
                                ...current,
                                [dimensionId]: optionId,
                              }),
                            )
                          }
                        />
                      </Stack>
                    ) : catalogItem ? (
                      <Text size="sm" tone="secondary">
                        {catalogItem.title}
                      </Text>
                    ) : (
                      <Text tone="secondary">
                        {t("marketplace.features.listings.ui.listingCreatePage.search.or.paste.catalog.item")}
                      </Text>
                    )}
                  </Inset>
                  <FileDropzone
                    label={t("marketplace.features.listings.ui.listingCreatePage.listing.photos")}
                    description={t("marketplace.features.listings.ui.listingCreatePage.listing.photos.description")}
                    name="listingPhotos"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    dropLabel={t("marketplace.features.listings.ui.listingCreatePage.drop.listing.photos")}
                    browseLabel={t("marketplace.features.listings.ui.listingCreatePage.choose.photos")}
                  />
                </Stack>
              </Grid>
              <Accordion
                items={[
                  {
                    value: "advanced",
                    trigger: t("marketplace.features.listings.ui.listingCreatePage.advanced.inventory.and.limits"),
                    content: (
                      <Stack gap={3}>
                        <Inline>
                          <LinkButton href="/account/inventory" tone="secondary" size="sm">
                            {t("marketplace.features.listings.ui.listingCreatePage.inventory")}
                          </LinkButton>
                          <LinkButton href="/account/inventory/imports" tone="secondary" size="sm">
                            {t("marketplace.features.listings.ui.listingCreatePage.import")}
                          </LinkButton>
                          <LinkButton href="/account/inventory/locations" tone="secondary" size="sm">
                            {t("marketplace.features.listings.ui.listingCreatePage.locations")}
                          </LinkButton>
                        </Inline>
                        {hasInventory ? (
                          <NativeSelect
                            label={t("marketplace.features.listings.ui.listingCreatePage.use.existing.inventory")}
                            name="inventoryItemId"
                            defaultValue={createForm?.inventoryItemId ?? ""}
                            placeholder={t(
                              "marketplace.features.listings.ui.listingCreatePage.automatic.listing.stock",
                            )}
                            items={inventoryItems.map((inventoryItem) => ({
                              value: inventoryItem.item_id,
                              label: inventoryLabel(inventoryItem),
                            }))}
                          />
                        ) : (
                          <Text size="sm" tone="secondary">
                            {t("marketplace.features.listings.ui.listingCreatePage.no.advanced.inventory.available")}
                          </Text>
                        )}
                        <Inline>
                          <NumberField
                            label={t("marketplace.features.listings.ui.listingCreatePage.limit.per.order")}
                            name="maxUnitsPerOrder"
                            min={1}
                            defaultValue={
                              createForm?.maxUnitsPerOrder ? Number(createForm.maxUnitsPerOrder) : undefined
                            }
                          />
                          <NumberField
                            label={t("marketplace.features.listings.ui.listingCreatePage.limit.per.day")}
                            name="maxUnitsPerDay"
                            min={1}
                            defaultValue={createForm?.maxUnitsPerDay ? Number(createForm.maxUnitsPerDay) : undefined}
                          />
                          <NumberField
                            label={t("marketplace.features.listings.ui.listingCreatePage.limit.per.customer")}
                            name="maxUnitsPerCustomerAccount"
                            min={1}
                            defaultValue={
                              createForm?.maxUnitsPerCustomerAccount
                                ? Number(createForm.maxUnitsPerCustomerAccount)
                                : undefined
                            }
                          />
                        </Inline>
                        <Text size="sm" tone="secondary">
                          {t("marketplace.features.listings.ui.listingCreatePage.purchase.limits.copy")}
                        </Text>
                      </Stack>
                    ),
                  },
                ]}
              />
              <Stack direction={{ base: "column", md: "row" }} align={{ base: "stretch", md: "center" }} gap={2}>
                <Button
                  type="submit"
                  name="intent"
                  value="create-and-publish-listing"
                  disabled={selectedInventoryBlocksPublication}
                >
                  {t("marketplace.features.listings.ui.listingCreatePage.create.and.publish")}
                </Button>
                <Button type="submit" name="intent" value="preview-listing" tone="secondary">
                  {t("marketplace.features.listings.ui.listingCreatePage.preview.fees")}
                </Button>
                <Button type="submit" name="intent" value="create-listing" tone="ghost">
                  {t("marketplace.features.listings.ui.listingCreatePage.save.as.draft")}
                </Button>
              </Stack>
            </Stack>
          </Form>
        </Card>
        {createPreview ? (
          <PriceBreakdown
            lines={[
              {
                label: t("marketplace.features.listings.ui.listingCreatePage.account.type"),
                value: createPreview.account_type,
              },
              {
                label: t("marketplace.features.listings.ui.listingCreatePage.basis.amount"),
                value: formatMoney(createPreview.basis_amount),
              },
              {
                label: t("marketplace.features.listings.ui.listingCreatePage.locked.fee"),
                value: formatMoney(createPreview.marketplace_sales_fee_unit_amount),
              },
              {
                label: t("marketplace.features.listings.ui.listingCreatePage.buyer.shipping.credit.summary", {
                  percentage: formatBpsPercent(createPreview.shipping_allowance_percentage_bps),
                }),
                value: t("marketplace.features.listings.ui.listingCreatePage.if.you.create.the.listing.now"),
              },
              {
                label: t("marketplace.features.listings.ui.listingCreatePage.terms.schedule"),
                value:
                  createPreview.schedule_id ??
                  t("marketplace.features.listings.ui.listingCreatePage.no.schedule.available"),
              },
            ]}
            total={formatMoney(createPreview.seller_net_unit_amount)}
            totalLabel={t("marketplace.features.listings.ui.listingCreatePage.listing.fee.preview")}
          />
        ) : null}
      </PageSection>
    </Page>
  );
}
