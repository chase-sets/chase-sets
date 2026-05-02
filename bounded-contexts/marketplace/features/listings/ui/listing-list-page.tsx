import { t } from "@chase-sets/localization";
import {
  Badge,
  Banner,
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
import type {
  MarketplaceListingInventoryItemOption,
  MarketplaceListingListItem,
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

function inventoryLabel(inventoryItem: MarketplaceListingInventoryItemOption) {
  const segments = [
    inventoryItem.item_title ?? inventoryItem.catalog_catalog_item_id,
    inventoryItem.item_subtitle,
    inventoryItem.product_summary,
    t("marketplace.features.listings.ui.listingListPage.quantity.available", {
      quantity: inventoryItem.available_quantity,
    }),
    inventoryItem.storage_location_name,
  ].filter(Boolean);

  return segments.join(" | ");
}

function renderFeeSummary(listing: MarketplaceListingListItem) {
  if (!listing.marketplace_fee_amount && !listing.payment_fee_amount && !listing.seller_net_amount) {
    return t("marketplace.features.listings.ui.listingListPage.fee.quote.unavailable");
  }

  const segments = [
    t("marketplace.features.listings.ui.listingListPage.marketplace.fee.summary", {
      amount: formatMoney(listing.marketplace_fee_amount),
    }),
    t("marketplace.features.listings.ui.listingListPage.payment.fee.summary", {
      amount: formatMoney(listing.payment_fee_amount),
    }),
    t("marketplace.features.listings.ui.listingListPage.net.summary", {
      amount: formatMoney(listing.seller_net_amount),
    }),
  ];

  return segments.join(" | ");
}

function renderPreviewSummary(preview: MarketplaceListingTermsPreview) {
  return [
    t("marketplace.features.listings.ui.listingListPage.marketplace.fee.summary", {
      amount: formatMoney(preview.marketplace_fee_amount),
    }),
    t("marketplace.features.listings.ui.listingListPage.payment.fee.summary", {
      amount: formatMoney(preview.payment_fee_amount),
    }),
    t("marketplace.features.listings.ui.listingListPage.net.summary", {
      amount: formatMoney(preview.seller_net_amount),
    }),
  ].join(" | ");
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

export function MarketplaceListingListPage({
  data,
  inventoryItems,
  createForm,
  createPreview,
  errorMessage,
}: {
  data: { items: readonly MarketplaceListingListItem[] };
  inventoryItems: readonly MarketplaceListingInventoryItemOption[];
  createForm?: {
    inventoryItemId?: string | null;
    priceAmount?: string | null;
    quantityCap?: string | null;
  };
  createPreview?: MarketplaceListingTermsPreview | null;
  errorMessage?: string | null;
}) {
  const selectedInventory = selectedInventorySummary(
    inventoryItems,
    createForm?.inventoryItemId,
  );
  const hasInventory = inventoryItems.length > 0;

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
        <Card>
          <Text>{errorMessage}</Text>
        </Card>
      ) : null}

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
              ) : null}
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
              <Stack gap={2}>
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
                  value="create-listing"
                  tone="secondary"
                  disabled={!hasInventory}
                >
                  {t("marketplace.features.listings.ui.listingListPage.save.as.draft")}</Button>
                <Button
                  type="submit"
                  name="intent"
                  value="preview-listing"
                  tone="secondary"
                  disabled={!hasInventory}
                >
                  {t("marketplace.features.listings.ui.listingListPage.preview.fees")}</Button>
              </Stack>
            </Stack>
          </form>
        </Card>
        {createPreview ? (
          <Card>
            <Stack gap={2}>
              <Text weight="semibold">{t("marketplace.features.listings.ui.listingListPage.listing.fee.preview")}</Text>
              <Text size="sm" tone="secondary">
                {t("marketplace.features.listings.ui.listingListPage.account.type")}{createPreview.account_type}
              </Text>
              <Text size="sm" tone="secondary">
                {renderPreviewSummary(createPreview)}
              </Text>
              <Text size="sm" tone="secondary">
                {t("marketplace.features.listings.ui.listingListPage.basis.amount")}{formatMoney(createPreview.basis_amount)}
              </Text>
              <Text size="sm" tone="secondary">
                {t("marketplace.features.listings.ui.listingListPage.terms.schedule")}{createPreview.schedule_id ?? t("marketplace.features.listings.ui.listingListPage.no.schedule.available")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("marketplace.features.listings.ui.listingListPage.agreement.override")}{createPreview.agreement_id ?? t("marketplace.features.listings.ui.listingListPage.none")}
              </Text>
              <Text size="sm" tone="secondary">
                {t("marketplace.features.listings.ui.listingListPage.if.you.create.the.listing.now")}</Text>
            </Stack>
          </Card>
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
                  <Text size="sm" tone="secondary">
                    {row.ship_from_code ?? row.inventory_item_id}
                  </Text>
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
    </Page>
  );
}
