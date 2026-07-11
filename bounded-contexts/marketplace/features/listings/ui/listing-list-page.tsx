import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import { useEffect, useState } from "react";
import {
  HiddenInput,
  Form,
  Accordion,
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  FileDropzone,
  Grid,
  Inline,
  Inset,
  LinkButton,
  MarketplaceDashboardPanel,
  MarketplaceNotice,
  Page,
  PageHeader,
  PageSection,
  Pagination,
  PriceBreakdown,
  ProgressiveDisclosure,
  ProductOptions,
  ProductSelectionFields,
  Stack,
  Text,
  TextInput,
  NumberInput,
  NativeSelect,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import {
  normalizeProductSelection,
  productSelectionEntriesToRecord,
  recordToProductSelectionEntries,
  toProductSelectionFields,
  type ProductSelectionSchema,
} from "@chase-sets/product-selection";
import type {
  MarketplaceListingFeeLockReportEntry,
  MarketplaceListingInventoryItemOption,
  MarketplaceListingListItem,
  MarketplaceSellerListingAvailability,
  MarketplaceSellerListingStatusCounts,
  MarketplaceListingTermsPreview,
} from "./contracts";

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
    return t("marketplace.features.listings.ui.listingListPage.not.set");
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

function formatAllowancePercentage(bps: number) {
  return `${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(bps / 100)}%`;
}

function inventoryLabel(inventoryItem: MarketplaceListingInventoryItemOption) {
  const segments = [
    inventoryItem.item_title ?? inventoryItem.catalog_catalog_item_id,
    inventoryItem.item_subtitle,
    inventoryItem.product_summary?.replaceAll(" | ", ", "),
    inventoryItem.product_measure_snapshot
      ? null
      : t("marketplace.features.listings.ui.listingListPage.shipping.measure.missing"),
    t("marketplace.features.listings.ui.listingListPage.quantity.available", {
      quantity: inventoryItem.available_quantity,
    }),
    inventoryItem.storage_location_name,
  ].filter(Boolean);

  return segments.join(" - ");
}

function renderFeeSummary(listing: MarketplaceListingListItem) {
  if (!listing.marketplace_sales_fee_unit_amount && !listing.seller_net_unit_amount) {
    return t("marketplace.features.listings.ui.listingListPage.fee.quote.unavailable");
  }

  const segments = [
    t("marketplace.features.listings.ui.listingListPage.marketplace.fee.summary", {
      amount: formatMoney(listing.marketplace_sales_fee_unit_amount),
    }),
    t("marketplace.features.listings.ui.listingListPage.net.summary", {
      amount: formatMoney(listing.seller_net_unit_amount),
    }),
    t("marketplace.features.listings.ui.listingListPage.buyer.shipping.credit.summary", {
      percentage: formatAllowancePercentage(listing.shipping_allowance_percentage_bps),
    }),
  ];

  return segments.join(". ");
}

function renderPreviewSummary(preview: MarketplaceListingTermsPreview) {
  return [
    t("marketplace.features.listings.ui.listingListPage.marketplace.fee.summary", {
      amount: formatMoney(preview.marketplace_sales_fee_unit_amount),
    }),
    t("marketplace.features.listings.ui.listingListPage.net.summary", {
      amount: formatMoney(preview.seller_net_unit_amount),
    }),
    t("marketplace.features.listings.ui.listingListPage.buyer.shipping.credit.summary", {
      percentage: formatAllowancePercentage(preview.shipping_allowance_percentage_bps),
    }),
  ].join(". ");
}

function purchaseLimitSummary({
  maxUnitsPerOrder,
  maxUnitsPerDay,
  maxUnitsPerCustomerAccount,
}: {
  maxUnitsPerOrder?: string | number | null;
  maxUnitsPerDay?: string | number | null;
  maxUnitsPerCustomerAccount?: string | number | null;
}) {
  const limits = [
    maxUnitsPerOrder
      ? t("marketplace.features.listings.ui.listingListPage.purchase.limit.order.summary", {
          limit: maxUnitsPerOrder,
        })
      : null,
    maxUnitsPerDay
      ? t("marketplace.features.listings.ui.listingListPage.purchase.limit.day.summary", {
          limit: maxUnitsPerDay,
        })
      : null,
    maxUnitsPerCustomerAccount
      ? t("marketplace.features.listings.ui.listingListPage.purchase.limit.customer.summary", {
          limit: maxUnitsPerCustomerAccount,
        })
      : null,
  ].filter(Boolean);

  return limits.length > 0
    ? t("marketplace.features.listings.ui.listingListPage.active.purchase.limits", { limits: limits.join(", ") })
    : t("marketplace.features.listings.ui.listingListPage.no.seller.purchase.limits");
}

function termsSource(row: MarketplaceListingFeeLockReportEntry) {
  if (row.terms_agreement_id) {
    return "Seller terms";
  }

  return row.terms_schedule_id
    ? "Standard seller terms"
    : t("marketplace.features.listings.ui.listingListPage.source.unavailable");
}

function formatTimestamp(value: string | null) {
  return value ? new Date(value).toLocaleString() : t("marketplace.features.listings.ui.listingListPage.not.set");
}

function availabilityTone(status: MarketplaceSellerListingAvailability["status"]) {
  return status === "available" ? "success" : "warning";
}

function availabilityReasonLabel(reason: string | null) {
  switch (reason) {
    case "travel":
      return t("marketplace.features.listings.ui.listingListPage.reason.travel");
    case "audit":
      return t("marketplace.features.listings.ui.listingListPage.reason.audit");
    case "operations":
      return t("marketplace.features.listings.ui.listingListPage.reason.operations");
    case "other":
      return t("marketplace.features.listings.ui.listingListPage.reason.other");
    default:
      return t("marketplace.features.listings.ui.listingListPage.reason.not.set");
  }
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

function navigateToListingListPage(page: number, pageSize: number) {
  if (typeof window === "undefined") {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("limit", String(pageSize));
  url.searchParams.set("offset", String((page - 1) * pageSize));
  window.location.assign(`${url.pathname}${url.search}${url.hash}`);
}

function catalogItemOptionLabel(item: ListingCatalogItemSnapshot) {
  return [item.title, item.subtitle].filter(Boolean).join(" - ");
}

export function MarketplaceListingListPage({
  data,
  statusCounts,
  pagination,
  feeLockReport,
  listingAvailability,
  inventoryItems,
  createForm,
  createPreview,
  errorMessage,
  hasListingStockLocation,
  catalogItemApiBaseUrl = DEFAULT_CATALOG_ITEM_API_BASE_URL,
}: {
  data: { items: readonly MarketplaceListingListItem[] };
  statusCounts?: MarketplaceSellerListingStatusCounts;
  pagination?: Readonly<{ limit: number; offset: number; total: number }>;
  feeLockReport?: { items: readonly MarketplaceListingFeeLockReportEntry[] };
  listingAvailability: MarketplaceSellerListingAvailability;
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
  const activeListings = statusCounts
    ? statusCounts.active
    : data.items.filter((item) => item.status === "active").length;
  const draftListings = statusCounts ? statusCounts.draft : data.items.filter((item) => item.status === "draft").length;
  const pausedListings = statusCounts
    ? statusCounts.paused
    : data.items.filter((item) => item.status === "paused").length;
  const pausedListingDetail = t("marketplace.features.listings.ui.listingListPage.paused.listings.detail", {
    count: pausedListings,
    label: pausedListings === 1 ? "listing" : "listings",
  });
  const pageSize = pagination?.limit ?? data.items.length;
  const currentPage = pagination && pageSize > 0 ? Math.floor(pagination.offset / pageSize) + 1 : 1;
  const totalPages = pagination && pageSize > 0 ? Math.max(1, Math.ceil(pagination.total / pageSize)) : 1;
  const showPagination = Boolean(pagination && (pagination.total > pageSize || pagination.offset > 0));
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
          throw new Error(message ?? t("marketplace.features.listings.ui.listingListPage.catalog.item.lookup.failed"));
        }

        return response.json() as Promise<ListingCatalogItemSearchResponse>;
      })
      .then((result) => {
        const items = result.items ?? [];
        setCatalogSearchResults(items);
        setCatalogLookupError(
          items.length === 0
            ? t("marketplace.features.listings.ui.listingListPage.no.active.catalog.items.matched")
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
            : t("marketplace.features.listings.ui.listingListPage.catalog.item.lookup.failed"),
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
        eyebrow={t("marketplace.features.listings.ui.listingListPage.seller")}
        title={t("marketplace.features.listings.ui.listingListPage.listings")}
        description={t("marketplace.features.listings.ui.listingListPage.create.publish.and.manage.seller.listings")}
        actions={
          <LinkButton href="/account/inventory/imports" tone="secondary">
            {t("marketplace.features.listings.ui.listingListPage.advanced.import")}
          </LinkButton>
        }
      />

      {errorMessage ? (
        <MarketplaceNotice
          tone="danger"
          title={t("marketplace.features.listings.ui.listingListPage.listings")}
          description={errorMessage}
        />
      ) : null}

      <PageSection title={t("marketplace.features.listings.ui.listingListPage.seller.listing.availability")}>
        <Card>
          <Grid columns={{ base: 1, lg: 2 }} gap={5}>
            <Stack gap={3}>
              <Inline align="center">
                <Badge tone={availabilityTone(listingAvailability.status)}>
                  {listingAvailability.status === "available"
                    ? t("marketplace.features.listings.ui.listingListPage.listings.available")
                    : t("marketplace.features.listings.ui.listingListPage.listings.unavailable")}
                </Badge>
                <Text weight="semibold">
                  {t("marketplace.features.listings.ui.listingListPage.account.wide.listing.control")}
                </Text>
              </Inline>
              <Text tone="secondary">
                {listingAvailability.status === "available"
                  ? t("marketplace.features.listings.ui.listingListPage.availability.available.description")
                  : t("marketplace.features.listings.ui.listingListPage.availability.unavailable.description", {
                      reason: availabilityReasonLabel(listingAvailability.disabled_reason_category),
                      date:
                        listingAvailability.available_again_on ??
                        t("marketplace.features.listings.ui.listingListPage.no.return.date"),
                    })}
              </Text>
              {listingAvailability.status === "unavailable" ? (
                <Form spacing="none" method="post">
                  <Button type="submit" name="intent" value="enable-listing-availability">
                    {t("marketplace.features.listings.ui.listingListPage.turn.on.listings")}
                  </Button>
                </Form>
              ) : null}
            </Stack>
            {listingAvailability.status === "available" ? (
              <Form spacing="none" method="post">
                <Stack gap={3}>
                  <Grid columns={{ base: 1, md: 2 }} gap={3}>
                    <NativeSelect
                      label={t("marketplace.features.listings.ui.listingListPage.reason")}
                      name="reasonCategory"
                      defaultValue=""
                      items={[
                        { value: "", label: t("marketplace.features.listings.ui.listingListPage.reason.not.set") },
                        { value: "travel", label: t("marketplace.features.listings.ui.listingListPage.reason.travel") },
                        { value: "audit", label: t("marketplace.features.listings.ui.listingListPage.reason.audit") },
                        {
                          value: "operations",
                          label: t("marketplace.features.listings.ui.listingListPage.reason.operations"),
                        },
                        { value: "other", label: t("marketplace.features.listings.ui.listingListPage.reason.other") },
                      ]}
                    />
                    <TextInput
                      label={t("marketplace.features.listings.ui.listingListPage.available.again.on")}
                      name="availableAgainOn"
                      type="date"
                    />
                  </Grid>
                  <Inline>
                    <Button type="submit" name="intent" value="disable-listing-availability" tone="secondary">
                      {t("marketplace.features.listings.ui.listingListPage.turn.off.listings")}
                    </Button>
                  </Inline>
                </Stack>
              </Form>
            ) : null}
          </Grid>
        </Card>
      </PageSection>

      <MarketplaceDashboardPanel
        title={t("marketplace.features.listings.ui.listingListPage.listing.health")}
        description={t("marketplace.features.listings.ui.listingListPage.track.active.supply.drafts.and.sellable")}
        metrics={[
          {
            label: t("marketplace.features.listings.ui.listingListPage.active.listings"),
            value: activeListings,
            detail: t("marketplace.features.listings.ui.listingListPage.visible.to.buyers"),
          },
          {
            label: t("marketplace.features.listings.ui.listingListPage.draft.listings"),
            value: draftListings,
            detail: t("marketplace.features.listings.ui.listingListPage.not.visible.yet"),
          },
          {
            label: t("marketplace.features.listings.ui.listingListPage.advanced.stock"),
            value: inventoryItems.length,
            detail: pausedListingDetail,
          },
        ]}
      />

      <PageSection title={t("marketplace.features.listings.ui.listingListPage.create.listing")}>
        <Card>
          <Form spacing="none" method="post" encType="multipart/form-data">
            <Stack gap={3}>
              <Banner
                title={t("marketplace.features.listings.ui.listingListPage.list.without.managing.inventory")}
                description={t("marketplace.features.listings.ui.listingListPage.choose.a.product.price.and.quantity")}
                tone="info"
              />
              {selectedInventory ? (
                <Banner
                  title={t("marketplace.features.listings.ui.listingListPage.advanced.inventory.selected")}
                  description={
                    <>
                      {inventoryLabel(selectedInventory)}
                      <br />
                      {t("marketplace.features.listings.ui.listingListPage.the.listing.will.use.this.inventory")}
                    </>
                  }
                />
              ) : null}
              {selectedInventoryBlocksPublication ? (
                <MarketplaceNotice
                  tone="warning"
                  title={t("marketplace.features.listings.ui.listingListPage.shipping.measure.missing")}
                  description={t("marketplace.features.listings.ui.listingListPage.publish.requires.shipping.measure")}
                />
              ) : null}
              <HiddenInput type="hidden" name="selectedOptions" value={serializedSelectedOptions} />
              <Grid columns={{ base: 1, lg: 2 }} gap={5}>
                <Stack gap={3}>
                  <TextInput
                    label={t("marketplace.features.listings.ui.listingListPage.search.catalog")}
                    placeholder={t("marketplace.features.listings.ui.listingListPage.search.or.paste.catalog.item")}
                    value={catalogItemSearch}
                    onChange={(event) => resetCatalogItemSelection(event.target.value)}
                    description={t("marketplace.features.listings.ui.listingListPage.search.by.title.or.paste.catalog")}
                  />
                  <NativeSelect
                    label={t("marketplace.features.listings.ui.listingListPage.catalog.item")}
                    name="catalogItemId"
                    required
                    value={catalogItemId}
                    onChange={(event) => selectCatalogItem(event.target.value)}
                    disabled={catalogSearchResults.length === 0}
                    placeholder={
                      catalogLookupPending
                        ? t("marketplace.features.listings.ui.listingListPage.searching.catalog.items")
                        : t("marketplace.features.listings.ui.listingListPage.select.a.catalog.item")
                    }
                    items={catalogSearchResults.map((item) => ({
                      value: item.catalog_item_id,
                      label: catalogItemOptionLabel(item),
                    }))}
                    description={t("marketplace.features.listings.ui.listingListPage.choose.the.visible.catalog.item")}
                  />
                  {catalogLookupPending ? (
                    <Text size="sm" tone="secondary">
                      {t("marketplace.features.listings.ui.listingListPage.searching.catalog.items")}
                    </Text>
                  ) : null}
                  {catalogLookupError ? <Text size="sm">{catalogLookupError}</Text> : null}
                  <Grid columns={{ base: 1, md: 2 }} gap={3}>
                    <TextInput
                      label={t("marketplace.features.listings.ui.listingListPage.price")}
                      name="priceAmount"
                      placeholder="24.99"
                      inputMode="decimal"
                      defaultValue={createForm?.priceAmount ?? ""}
                      required
                    />
                    <NumberInput
                      label={t("marketplace.features.listings.ui.listingListPage.quantity.cap")}
                      name="quantityCap"
                      min="1"
                      defaultValue={createForm?.quantityCap ?? "1"}
                      required
                    />
                  </Grid>
                  <Text size="sm" tone="secondary">
                    {t("marketplace.features.listings.ui.listingListPage.quantity.cap.exposure.copy")}
                  </Text>
                  {!hasListingStockLocation ? (
                    <Stack gap={3}>
                      <Text weight="semibold">{t("marketplace.features.listings.ui.listingListPage.ship.from")}</Text>
                      <TextInput
                        label={t("marketplace.features.listings.ui.listingListPage.ship.from.name")}
                        name="shipFromName"
                      />
                      <TextInput
                        label={t("marketplace.features.listings.ui.listingListPage.ship.from.line1")}
                        name="shipFromLine1"
                      />
                      <Grid columns={{ base: 1, md: 2 }} gap={3}>
                        <TextInput
                          label={t("marketplace.features.listings.ui.listingListPage.ship.from.city")}
                          name="shipFromCity"
                        />
                        <TextInput
                          label={t("marketplace.features.listings.ui.listingListPage.ship.from.state")}
                          name="shipFromState"
                        />
                        <TextInput
                          label={t("marketplace.features.listings.ui.listingListPage.ship.from.postal.code")}
                          name="shipFromPostalCode"
                        />
                        <TextInput
                          label={t("marketplace.features.listings.ui.listingListPage.ship.from.country")}
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
                        {t("marketplace.features.listings.ui.listingListPage.search.or.paste.catalog.item")}
                      </Text>
                    )}
                  </Inset>
                  <FileDropzone
                    label={t("marketplace.features.listings.ui.listingListPage.listing.photos")}
                    description={t("marketplace.features.listings.ui.listingListPage.listing.photos.description")}
                    name="listingPhotos"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    dropLabel={t("marketplace.features.listings.ui.listingListPage.drop.listing.photos")}
                    browseLabel={t("marketplace.features.listings.ui.listingListPage.choose.photos")}
                  />
                </Stack>
              </Grid>
              <Accordion
                items={[
                  {
                    value: "advanced",
                    trigger: t("marketplace.features.listings.ui.listingListPage.advanced.inventory.and.limits"),
                    content: (
                      <Stack gap={3}>
                        <Inline>
                          <LinkButton href="/account/inventory" tone="secondary" size="sm">
                            {t("marketplace.features.listings.ui.listingListPage.inventory")}
                          </LinkButton>
                          <LinkButton href="/account/inventory/imports" tone="secondary" size="sm">
                            {t("marketplace.features.listings.ui.listingListPage.import")}
                          </LinkButton>
                          <LinkButton href="/account/inventory/locations" tone="secondary" size="sm">
                            {t("marketplace.features.listings.ui.listingListPage.locations")}
                          </LinkButton>
                        </Inline>
                        {hasInventory ? (
                          <NativeSelect
                            label={t("marketplace.features.listings.ui.listingListPage.use.existing.inventory")}
                            name="inventoryItemId"
                            defaultValue={createForm?.inventoryItemId ?? ""}
                            placeholder={t("marketplace.features.listings.ui.listingListPage.automatic.listing.stock")}
                            items={inventoryItems.map((inventoryItem) => ({
                              value: inventoryItem.item_id,
                              label: inventoryLabel(inventoryItem),
                            }))}
                          />
                        ) : (
                          <Text size="sm" tone="secondary">
                            {t("marketplace.features.listings.ui.listingListPage.no.advanced.inventory.available")}
                          </Text>
                        )}
                        <Inline>
                          <NumberInput
                            label={t("marketplace.features.listings.ui.listingListPage.limit.per.order")}
                            name="maxUnitsPerOrder"
                            min="1"
                            defaultValue={createForm?.maxUnitsPerOrder ?? ""}
                          />
                          <NumberInput
                            label={t("marketplace.features.listings.ui.listingListPage.limit.per.day")}
                            name="maxUnitsPerDay"
                            min="1"
                            defaultValue={createForm?.maxUnitsPerDay ?? ""}
                          />
                          <NumberInput
                            label={t("marketplace.features.listings.ui.listingListPage.limit.per.customer")}
                            name="maxUnitsPerCustomerAccount"
                            min="1"
                            defaultValue={createForm?.maxUnitsPerCustomerAccount ?? ""}
                          />
                        </Inline>
                        <Text size="sm" tone="secondary">
                          {t("marketplace.features.listings.ui.listingListPage.purchase.limits.copy")}
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
                  {t("marketplace.features.listings.ui.listingListPage.create.and.publish")}
                </Button>
                <Button type="submit" name="intent" value="preview-listing" tone="secondary">
                  {t("marketplace.features.listings.ui.listingListPage.preview.fees")}
                </Button>
                <Button type="submit" name="intent" value="create-listing" tone="ghost">
                  {t("marketplace.features.listings.ui.listingListPage.save.as.draft")}
                </Button>
              </Stack>
            </Stack>
          </Form>
        </Card>
        {createPreview ? (
          <PriceBreakdown
            lines={[
              {
                label: t("marketplace.features.listings.ui.listingListPage.account.type"),
                value: createPreview.account_type,
              },
              {
                label: t("marketplace.features.listings.ui.listingListPage.basis.amount"),
                value: formatMoney(createPreview.basis_amount),
              },
              {
                label: t("marketplace.features.listings.ui.listingListPage.locked.fee"),
                value: formatMoney(createPreview.marketplace_sales_fee_unit_amount),
              },
              {
                label: t("marketplace.features.listings.ui.listingListPage.buyer.shipping.credit.summary", {
                  percentage: formatAllowancePercentage(createPreview.shipping_allowance_percentage_bps),
                }),
                value: t("marketplace.features.listings.ui.listingListPage.if.you.create.the.listing.now"),
              },
              {
                label: t("marketplace.features.listings.ui.listingListPage.terms.schedule"),
                value:
                  createPreview.schedule_id ??
                  t("marketplace.features.listings.ui.listingListPage.no.schedule.available"),
              },
            ]}
            total={formatMoney(createPreview.seller_net_unit_amount)}
            totalLabel={t("marketplace.features.listings.ui.listingListPage.listing.fee.preview")}
          />
        ) : null}
      </PageSection>

      <PageSection title={t("marketplace.features.listings.ui.listingListPage.current.listings")}>
        <DataTable
          rows={[...data.items]}
          getRowId={(row) => row.listing_id}
          columns={[
            {
              key: "listing",
              header: t("marketplace.features.listings.ui.listingListPage.listing"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text weight="semibold">{row.item_title ?? row.catalog_catalog_item_id}</Text>
                  {row.item_language_code ? (
                    <Badge tone="neutral">{formatLanguageCodeLabel(row.item_language_code)}</Badge>
                  ) : null}
                  {row.item_subtitle ? (
                    <Text tone="secondary" size="sm">
                      {row.item_subtitle}
                    </Text>
                  ) : null}
                  {row.product_summary ? (
                    <ProductOptions options={productOptionsFromSummary(row.product_summary)} variant="chips" />
                  ) : null}
                  {row.product_measure_snapshot ? null : (
                    <Badge tone="warning">
                      {t("marketplace.features.listings.ui.listingListPage.shipping.measure.missing")}
                    </Badge>
                  )}
                  {row.listing_photos.length > 0 ? (
                    <Text tone="secondary" size="sm">
                      {t("marketplace.features.listings.ui.listingListPage.photo.count", {
                        count: row.listing_photos.length,
                      })}
                    </Text>
                  ) : null}
                </Stack>
              ),
            },
            {
              key: "price",
              header: t("marketplace.features.listings.ui.listingListPage.price.2"),
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
              header: t("marketplace.features.listings.ui.listingListPage.cap"),
              align: "right",
              cell: (row) => row.quantity_cap,
            },
            {
              key: "status",
              header: t("marketplace.features.listings.ui.listingListPage.status"),
              cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
            },
            {
              key: "location",
              header: t("marketplace.features.listings.ui.listingListPage.inventory"),
              cell: (row) => (
                <Stack gap={1}>
                  <Text>
                    {row.storage_location_name ??
                      t("marketplace.features.listings.ui.listingListPage.location.unavailable")}
                  </Text>
                  {row.terms_resolved_at ? (
                    <Text size="sm" tone="secondary">
                      {t("marketplace.features.listings.ui.listingListPage.terms.resolved")}
                      {new Date(row.terms_resolved_at).toLocaleString()}
                    </Text>
                  ) : null}
                </Stack>
              ),
            },
            {
              key: "actions",
              header: t("marketplace.features.listings.ui.listingListPage.actions"),
              cell: (row) => (
                <LinkButton href={`/account/listings/${row.listing_id}`} tone="secondary" size="sm">
                  {t("marketplace.features.listings.ui.listingListPage.open")}
                </LinkButton>
              ),
            },
          ]}
          emptyTitle={t("marketplace.features.listings.ui.listingListPage.no.listings.yet")}
          emptyDescription={t(
            "marketplace.features.listings.ui.listingListPage.create.a.listing.from.available.inventory",
          )}
        />
        {showPagination ? (
          <Pagination
            page={currentPage}
            totalPages={totalPages}
            onPageChange={(page) => navigateToListingListPage(page, pageSize)}
          />
        ) : null}
      </PageSection>

      <PageSection title={t("marketplace.features.listings.ui.listingListPage.fee.lock.report")}>
        <ProgressiveDisclosure
          title={t("marketplace.features.listings.ui.listingListPage.fee.lock.report")}
          summary={t("marketplace.features.listings.ui.listingListPage.fee.lock.records.summary", {
            count: feeLockReport?.items.length ?? 0,
          })}
          tone={(feeLockReport?.items.length ?? 0) > 0 ? "info" : "neutral"}
        >
          <DataTable
            rows={[...(feeLockReport?.items ?? [])]}
            getRowId={(row) => row.listing_id}
            columns={[
              {
                key: "listing",
                header: t("marketplace.features.listings.ui.listingListPage.listing"),
                cell: (row) => (
                  <Stack gap={1}>
                    <Text weight="semibold">{row.item_title ?? row.inventory_item_id}</Text>
                    {row.product_summary ? (
                      <ProductOptions options={productOptionsFromSummary(row.product_summary)} variant="chips" />
                    ) : null}
                  </Stack>
                ),
              },
              {
                key: "fee",
                header: t("marketplace.features.listings.ui.listingListPage.locked.fee"),
                cell: (row) => (
                  <Stack gap={1}>
                    <Text>{formatMoney(row.marketplace_sales_fee_unit_amount)}</Text>
                    <Text size="sm" tone="secondary">
                      {t("marketplace.features.listings.ui.listingListPage.seller.net.report", {
                        amount: formatMoney(row.seller_net_unit_amount),
                      })}
                    </Text>
                  </Stack>
                ),
              },
              {
                key: "source",
                header: t("marketplace.features.listings.ui.listingListPage.terms.source"),
                cell: (row) => (
                  <Stack gap={1}>
                    <Text>{termsSource(row)}</Text>
                    <Text size="sm" tone="secondary">
                      {formatTimestamp(row.terms_resolved_at)}
                    </Text>
                  </Stack>
                ),
              },
              {
                key: "status",
                header: t("marketplace.features.listings.ui.listingListPage.status"),
                cell: (row) => <Badge tone={statusTone(row.status)}>{row.status}</Badge>,
              },
              {
                key: "quantityCap",
                header: t("marketplace.features.listings.ui.listingListPage.cap"),
                align: "right",
                cell: (row) => row.quantity_cap,
              },
              {
                key: "updated",
                header: t("marketplace.features.listings.ui.listingListPage.updated"),
                cell: (row) => formatTimestamp(row.updated_at),
              },
            ]}
            emptyTitle={t("marketplace.features.listings.ui.listingListPage.no.fee.locks")}
            emptyDescription={t("marketplace.features.listings.ui.listingListPage.fee.lock.report.empty")}
          />
        </ProgressiveDisclosure>
      </PageSection>
    </Page>
  );
}
