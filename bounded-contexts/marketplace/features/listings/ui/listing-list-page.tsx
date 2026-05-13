import { t } from "@chase-sets/localization";
import {
  Badge,
  Banner,
  Button,
  Card,
  DataTable,
  Inline,
  LinkButton,
  MarketplaceDashboardPanel,
  MarketplaceNotice,
  Page,
  PageHeader,
  PageSection,
  PriceBreakdown,
  ProductSelectionSummary,
  Stack,
  Text,
  TextInput,
  NumberInput,
  NativeSelect,
  productSelectionDetailsFromSummary,
} from "@chase-sets/design-system";
import type {
  MarketplaceListingFeeLockReportEntry,
  MarketplaceListingInventoryItemOption,
  MarketplaceListingListItem,
  MarketplaceSellerListingAvailability,
  MarketplaceListingTermsPreview,
} from "./contracts";

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

function ProductSummaryChips({ summary }: { summary: string }) {
  return (
    <ProductSelectionSummary
      selections={productSelectionDetailsFromSummary(summary)}
      summary={summary}
      summaryAsChip
    />
  );
}

export function MarketplaceListingListPage({
  data,
  feeLockReport,
  listingAvailability,
  inventoryItems,
  createForm,
  createPreview,
  errorMessage,
}: {
  data: { items: readonly MarketplaceListingListItem[] };
  feeLockReport?: { items: readonly MarketplaceListingFeeLockReportEntry[] };
  listingAvailability: MarketplaceSellerListingAvailability;
  inventoryItems: readonly MarketplaceListingInventoryItemOption[];
  createForm?: {
    inventoryItemId?: string | null;
    priceAmount?: string | null;
    quantityCap?: string | null;
    maxUnitsPerOrder?: string | null;
    maxUnitsPerDay?: string | null;
    maxUnitsPerCustomerAccount?: string | null;
  };
  createPreview?: MarketplaceListingTermsPreview | null;
  errorMessage?: string | null;
}) {
  const selectedInventory = selectedInventorySummary(
    inventoryItems,
    createForm?.inventoryItemId,
  );
  const hasInventory = inventoryItems.length > 0;
  const activeListings = data.items.filter((item) => item.status === "active").length;
  const draftListings = data.items.filter((item) => item.status === "draft").length;
  const pausedListings = data.items.filter((item) => item.status === "paused").length;
  const pausedListingDetail = t("marketplace.features.listings.ui.listingListPage.paused.listings.detail", {
    count: pausedListings,
    label: pausedListings === 1 ? "listing" : "listings",
  });

  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.features.listings.ui.listingListPage.seller")}
        title={t("marketplace.features.listings.ui.listingListPage.listings")}
        description={t("marketplace.features.listings.ui.listingListPage.create.publish.and.manage.seller.listings")}
        actions={
          <LinkButton href="/account/inventory" tone="secondary">
            {t("marketplace.features.listings.ui.listingListPage.view.inventory")}</LinkButton>
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
            label: t("marketplace.features.listings.ui.listingListPage.inventory"),
            value: inventoryItems.length,
            detail: pausedListingDetail,
          },
        ]}
      />

      <PageSection title={t("marketplace.features.listings.ui.listingListPage.create.listing")}>
        <Card>
          <form method="post">
            <Stack gap={3}>
              {!hasInventory ? (
                <Banner
                  title={t("marketplace.features.listings.ui.listingListPage.no.sellable.inventory.is.available")}
                  description={t("marketplace.features.listings.ui.listingListPage.add.stock.with.available.quantity.before")}
                  actions={
                    <LinkButton href="/account/inventory" tone="secondary" size="sm">
                      {t("marketplace.features.listings.ui.listingListPage.add.inventory")}</LinkButton>
                  }
                />
              ) : (
                <Banner
                  title={t("marketplace.features.listings.ui.listingListPage.preview.fees.before.publishing")}
                  description={t("marketplace.features.listings.ui.listingListPage.choose.inventory.enter.a.price.and.preview")}
                  tone="info"
                />
              )}
              {selectedInventory ? (
                <Banner
                  title={t("marketplace.features.listings.ui.listingListPage.selected.inventory")}
                  description={
                    <>
                      {inventoryLabel(selectedInventory)}
                      <br />
                      {t("marketplace.features.listings.ui.listingListPage.the.listing.will.use.this.inventory")}</>
                  }
                />
              ) : null}
              <NativeSelect
                  label={t("marketplace.features.listings.ui.listingListPage.inventory.item")}
                name="inventoryItemId"
                required
                disabled={!hasInventory}
                defaultValue={createForm?.inventoryItemId ?? ""}
                placeholder={t("marketplace.features.listings.ui.listingListPage.select.inventory")}
                items={inventoryItems.map((inventoryItem) => ({
                  value: inventoryItem.item_id,
                  label: inventoryLabel(inventoryItem),
                }))}
              />
              <TextInput
                label={t("marketplace.features.listings.ui.listingListPage.price")}
                name="priceAmount"
                placeholder="24.99"
                inputMode="decimal"
                defaultValue={createForm?.priceAmount ?? ""}
                required
                disabled={!hasInventory}
              />
              <NumberInput
                label={t("marketplace.features.listings.ui.listingListPage.quantity.cap")}
                name="quantityCap"
                min="1"
                defaultValue={createForm?.quantityCap ?? "1"}
                required
                disabled={!hasInventory}
              />
              <Text size="sm" tone="secondary">
                {t("marketplace.features.listings.ui.listingListPage.quantity.cap.exposure.copy")}
              </Text>
              <Inline>
                <NumberInput
                  label={t("marketplace.features.listings.ui.listingListPage.limit.per.order")}
                  name="maxUnitsPerOrder"
                  min="1"
                  defaultValue={createForm?.maxUnitsPerOrder ?? ""}
                  disabled={!hasInventory}
                />
                <NumberInput
                  label={t("marketplace.features.listings.ui.listingListPage.limit.per.day")}
                  name="maxUnitsPerDay"
                  min="1"
                  defaultValue={createForm?.maxUnitsPerDay ?? ""}
                  disabled={!hasInventory}
                />
                <NumberInput
                  label={t("marketplace.features.listings.ui.listingListPage.limit.per.customer")}
                  name="maxUnitsPerCustomerAccount"
                  min="1"
                  defaultValue={createForm?.maxUnitsPerCustomerAccount ?? ""}
                  disabled={!hasInventory}
                />
              </Inline>
              <Text size="sm" tone="secondary">
                {t("marketplace.features.listings.ui.listingListPage.purchase.limits.copy")}
              </Text>
              <Inline>
                <Button
                  type="submit"
                  name="intent"
                  value="create-and-publish-listing"
                  disabled={!hasInventory}
                >
                  {t("marketplace.features.listings.ui.listingListPage.create.and.publish")}</Button>
                <Button
                  type="submit"
                  name="intent"
                  value="preview-listing"
                  tone="secondary"
                  disabled={!hasInventory}
                >
                  {t("marketplace.features.listings.ui.listingListPage.preview.fees")}</Button>
                <Button
                  type="submit"
                  name="intent"
                  value="create-listing"
                  tone="ghost"
                  disabled={!hasInventory}
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
                    <Badge tone="neutral">{row.item_language_code}</Badge>
                  ) : null}
                  {row.item_subtitle ? (
                    <Text tone="secondary" size="sm">
                      {row.item_subtitle}
                    </Text>
                  ) : null}
                  {row.product_summary ? (
                    <ProductSummaryChips summary={row.product_summary} />
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
                    <ProductSummaryChips summary={row.product_summary} />
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
      </PageSection>
    </Page>
  );
}
