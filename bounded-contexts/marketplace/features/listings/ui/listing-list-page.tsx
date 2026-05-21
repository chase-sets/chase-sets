import { formatLanguageCodeLabel, t } from "@chase-sets/localization";
import { useEffect, useState } from "react";
import {
  Accordion,
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  FileDropzone,
  Inline,
  LinkButton,
  MarketplaceDashboardPanel,
  MarketplaceNotice,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  ProgressiveDisclosure,
  ProductOptions,
  Stack,
  Text,
  TextInput,
  NumberInput,
  NativeSelect,
  productOptionsFromSummary,
} from "@chase-sets/design-system";
import type {
  MarketplaceListingFeeLockReportEntry,
  MarketplaceListingInventoryItemOption,
  MarketplaceListingListItem,
  MarketplaceSellerListingAvailability,
  MarketplaceListingTermsPreview,
} from "./contracts";

const DEFAULT_CATALOG_ITEM_API_BASE_URL = "/api/inventory/catalog-items";

type ListingCatalogItemSnapshot = Readonly<{
  title: string;
  product_schema: ProductSchema | null;
}>;

type ProductSchema = Readonly<{
  canonicalDimensionOrder: readonly Readonly<{ dimensionId: string }>[];
  dimensions: readonly Readonly<{
    dimensionId: string;
    dimensionName: string;
    allowedOptions: readonly Readonly<{
      optionId: string;
      code: string;
      label: string;
    }>[];
  }>[];
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

function getOrderedDimensions(schema: ProductSchema) {
  return schema.canonicalDimensionOrder
    .map((entry) =>
      schema.dimensions.find((dimension) => dimension.dimensionId === entry.dimensionId),
    )
    .filter((dimension): dimension is ProductSchema["dimensions"][number] => Boolean(dimension));
}

function optionLabel(option: ProductSchema["dimensions"][number]["allowedOptions"][number]) {
  return option.label ?? option.code ?? option.optionId;
}

function normalizeSelections(schema: ProductSchema, current: Record<string, string>) {
  const next: Record<string, string> = {};

  for (const dimension of getOrderedDimensions(schema)) {
    const selected = current[dimension.dimensionId];
    const fallback = dimension.allowedOptions[0]?.optionId ?? "";
    if (selected && dimension.allowedOptions.some((option) => option.optionId === selected)) {
      next[dimension.dimensionId] = selected;
    } else if (fallback) {
      next[dimension.dimensionId] = fallback;
    }
  }

  return next;
}

export function MarketplaceListingListPage({
  data,
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
  const selectedInventory = selectedInventorySummary(
    inventoryItems,
    createForm?.inventoryItemId,
  );
  const hasInventory = inventoryItems.length > 0;
  const [catalogItemId, setCatalogItemId] = useState(createForm?.catalogItemId ?? "");
  const [catalogItem, setCatalogItem] = useState<ListingCatalogItemSnapshot | null>(null);
  const [catalogLookupError, setCatalogLookupError] = useState<string | null>(null);
  const [catalogLookupPending, setCatalogLookupPending] = useState(false);
  const [selectedOptions, setSelectedOptions] = useState<Record<string, string>>({});
  const activeListings = data.items.filter((item) => item.status === "active").length;
  const draftListings = data.items.filter((item) => item.status === "draft").length;
  const pausedListings = data.items.filter((item) => item.status === "paused").length;
  const pausedListingDetail = t("marketplace.features.listings.ui.listingListPage.paused.listings.detail", {
    count: pausedListings,
    label: pausedListings === 1 ? "listing" : "listings",
  });
  const serializedSelectedOptions =
    catalogItem?.product_schema
      ? JSON.stringify(
          getOrderedDimensions(catalogItem.product_schema)
            .map((dimension) => {
              const optionId = selectedOptions[dimension.dimensionId];
              return optionId ? { dimensionId: dimension.dimensionId, optionId } : null;
            })
            .filter((entry): entry is { dimensionId: string; optionId: string } => Boolean(entry)),
        )
      : JSON.stringify(createForm?.selectedOptions ?? []);

  useEffect(() => {
    const trimmedCatalogItemId = catalogItemId.trim();
    if (!trimmedCatalogItemId) {
      setCatalogItem(null);
      setCatalogLookupError(null);
      setCatalogLookupPending(false);
      setSelectedOptions({});
      return;
    }

    const controller = new AbortController();
    setCatalogLookupPending(true);
    void fetch(`${catalogItemApiBaseUrl}/${encodeURIComponent(trimmedCatalogItemId)}`, {
      credentials: "include",
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? t("marketplace.features.listings.ui.listingListPage.catalog.item.lookup.failed"));
        }

        return response.json() as Promise<ListingCatalogItemSnapshot>;
      })
      .then((item) => {
        setCatalogItem(item);
        setCatalogLookupError(null);
        setSelectedOptions(
          item.product_schema
            ? normalizeSelections(
                item.product_schema,
                Object.fromEntries(
                  (createForm?.selectedOptions ?? []).map((entry) => [entry.dimensionId, entry.optionId]),
                ),
              )
            : {},
        );
      })
      .catch((error) => {
        if (controller.signal.aborted) {
          return;
        }
        setCatalogItem(null);
        setSelectedOptions({});
        setCatalogLookupError(error instanceof Error ? error.message : t("marketplace.features.listings.ui.listingListPage.catalog.item.lookup.failed"));
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setCatalogLookupPending(false);
        }
      });

    return () => controller.abort();
  }, [catalogItemApiBaseUrl, catalogItemId, createForm?.selectedOptions]);

  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.listings.ui.listingListPage.seller")}
        title={t("marketplace.features.listings.ui.listingListPage.listings")}
        description={t("marketplace.features.listings.ui.listingListPage.create.publish.and.manage.seller.listings")}
        actions={
          <LinkButton href="/account/inventory/imports" tone="secondary">
            {t("marketplace.features.listings.ui.listingListPage.advanced.import")}</LinkButton>
        }
      />

      {errorMessage ? (
        <MarketplaceNotice tone="error" title={t("marketplace.features.listings.ui.listingListPage.listings")} description={errorMessage} />
      ) : null}

      <PageSection title={t("marketplace.features.listings.ui.listingListPage.seller.listing.availability")}>
        <Card>
          <Stack gap={3}>
            <Inline align="center">
              <Stack gap={1}>
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
                        date: listingAvailability.available_again_on ?? t("marketplace.features.listings.ui.listingListPage.no.return.date"),
                      })}
                </Text>
              </Stack>
              {listingAvailability.status === "unavailable" ? (
                <form method="post">
                  <Button type="submit" name="intent" value="enable-listing-availability">
                    {t("marketplace.features.listings.ui.listingListPage.turn.on.listings")}</Button>
                </form>
              ) : null}
            </Inline>
            {listingAvailability.status === "available" ? (
              <form method="post">
                <Stack gap={3}>
                  <Inline>
                    <NativeSelect
                      label={t("marketplace.features.listings.ui.listingListPage.reason")}
                      name="reasonCategory"
                      defaultValue=""
                      items={[
                        { value: "", label: t("marketplace.features.listings.ui.listingListPage.reason.not.set") },
                        { value: "travel", label: t("marketplace.features.listings.ui.listingListPage.reason.travel") },
                        { value: "audit", label: t("marketplace.features.listings.ui.listingListPage.reason.audit") },
                        { value: "operations", label: t("marketplace.features.listings.ui.listingListPage.reason.operations") },
                        { value: "other", label: t("marketplace.features.listings.ui.listingListPage.reason.other") },
                      ]}
                    />
                    <TextInput
                      label={t("marketplace.features.listings.ui.listingListPage.available.again.on")}
                      name="availableAgainOn"
                      type="date"
                    />
                  </Inline>
                  <Inline>
                    <Button type="submit" name="intent" value="disable-listing-availability" tone="secondary">
                      {t("marketplace.features.listings.ui.listingListPage.turn.off.listings")}</Button>
                  </Inline>
                </Stack>
              </form>
            ) : null}
          </Stack>
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
          <form method="post" encType="multipart/form-data">
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
                      {t("marketplace.features.listings.ui.listingListPage.the.listing.will.use.this.inventory")}</>
                  }
                />
              ) : null}
              <TextInput
                label={t("marketplace.features.listings.ui.listingListPage.catalog.item.id")}
                name="catalogItemId"
                placeholder={t("marketplace.features.listings.ui.listingListPage.search.or.paste.catalog.item")}
                value={catalogItemId}
                onChange={(event) => setCatalogItemId(event.target.value)}
              />
              <input type="hidden" name="selectedOptions" value={serializedSelectedOptions} />
              {catalogLookupPending ? (
                <Text size="sm" tone="secondary">{t("marketplace.features.listings.ui.listingListPage.loading.catalog.item")}</Text>
              ) : null}
              {catalogItem?.product_schema ? (
                <Stack gap={2}>
                  <Text weight="semibold">{catalogItem.title}</Text>
                  {getOrderedDimensions(catalogItem.product_schema).map((dimension) => (
                    <NativeSelect
                      key={dimension.dimensionId}
                      label={dimension.dimensionName}
                      name={`selectedOptions:${dimension.dimensionId}`}
                      value={selectedOptions[dimension.dimensionId] ?? ""}
                      onChange={(event) =>
                        setSelectedOptions((current) =>
                          normalizeSelections(catalogItem.product_schema!, {
                            ...current,
                            [dimension.dimensionId]: event.target.value,
                          }),
                        )
                      }
                      items={dimension.allowedOptions.map((option) => ({
                        value: option.optionId,
                        label: optionLabel(option),
                      }))}
                    />
                  ))}
                </Stack>
              ) : catalogItem ? (
                <Text size="sm" tone="secondary">{catalogItem.title}</Text>
              ) : null}
              {catalogLookupError ? <Text size="sm">{catalogLookupError}</Text> : null}
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
              <Text size="sm" tone="secondary">
                {t("marketplace.features.listings.ui.listingListPage.quantity.cap.exposure.copy")}
              </Text>
              <FileDropzone
                label={t("marketplace.features.listings.ui.listingListPage.listing.photos")}
                description={t("marketplace.features.listings.ui.listingListPage.listing.photos.description")}
                name="listingPhotos"
                accept="image/jpeg,image/png,image/webp"
                multiple
                dropLabel={t("marketplace.features.listings.ui.listingListPage.drop.listing.photos")}
                browseLabel={t("marketplace.features.listings.ui.listingListPage.choose.photos")}
              />
              {!hasListingStockLocation ? (
                <Stack gap={3}>
                  <Text weight="semibold">{t("marketplace.features.listings.ui.listingListPage.ship.from")}</Text>
                  <TextInput label={t("marketplace.features.listings.ui.listingListPage.ship.from.name")} name="shipFromName" />
                  <TextInput label={t("marketplace.features.listings.ui.listingListPage.ship.from.line1")} name="shipFromLine1" />
                  <Inline>
                    <TextInput label={t("marketplace.features.listings.ui.listingListPage.ship.from.city")} name="shipFromCity" />
                    <TextInput label={t("marketplace.features.listings.ui.listingListPage.ship.from.state")} name="shipFromState" />
                  </Inline>
                  <Inline>
                    <TextInput label={t("marketplace.features.listings.ui.listingListPage.ship.from.postal.code")} name="shipFromPostalCode" />
                    <TextInput label={t("marketplace.features.listings.ui.listingListPage.ship.from.country")} name="shipFromCountry" defaultValue="US" />
                  </Inline>
                </Stack>
              ) : null}
              <Accordion
                items={[
                  {
                    value: "advanced",
                    trigger: t("marketplace.features.listings.ui.listingListPage.advanced.inventory.and.limits"),
                    content: (
                      <Stack gap={3}>
                        <Inline>
                          <LinkButton href="/account/inventory" tone="secondary" size="sm">
                            {t("marketplace.features.listings.ui.listingListPage.inventory")}</LinkButton>
                          <LinkButton href="/account/inventory/imports" tone="secondary" size="sm">
                            {t("marketplace.features.listings.ui.listingListPage.import")}</LinkButton>
                          <LinkButton href="/account/inventory/locations" tone="secondary" size="sm">
                            {t("marketplace.features.listings.ui.listingListPage.locations")}</LinkButton>
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
              <Inline>
                <Button
                  type="submit"
                  name="intent"
                  value="create-and-publish-listing"
                >
                  {t("marketplace.features.listings.ui.listingListPage.create.and.publish")}</Button>
                <Button
                  type="submit"
                  name="intent"
                  value="preview-listing"
                  tone="secondary"
                >
                  {t("marketplace.features.listings.ui.listingListPage.preview.fees")}</Button>
                <Button
                  type="submit"
                  name="intent"
                  value="create-listing"
                  tone="ghost"
                >
                  {t("marketplace.features.listings.ui.listingListPage.save.as.draft")}</Button>
              </Inline>
            </Stack>
          </form>
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
                value: createPreview.schedule_id ?? t("marketplace.features.listings.ui.listingListPage.no.schedule.available"),
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
                  <Text>{row.storage_location_name ?? t("marketplace.features.listings.ui.listingListPage.location.unavailable")}</Text>
                  {row.terms_resolved_at ? (
                    <Text size="sm" tone="secondary">
                      {t("marketplace.features.listings.ui.listingListPage.terms.resolved")}{new Date(row.terms_resolved_at).toLocaleString()}
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
                  {t("marketplace.features.listings.ui.listingListPage.open")}</LinkButton>
              ),
            },
          ]}
          emptyTitle={t("marketplace.features.listings.ui.listingListPage.no.listings.yet")}
          emptyDescription={t("marketplace.features.listings.ui.listingListPage.create.a.listing.from.available.inventory")}
        />
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
