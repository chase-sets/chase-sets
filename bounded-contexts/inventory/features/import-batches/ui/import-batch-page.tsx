import { formatDateTime, formatMoney as formatMoneyDisplay, t } from "@chase-sets/localization";
import { useEffect, useState, type ReactNode } from "react";
import { navigateAfterWrite } from "@chase-sets/http/responses";
import { subscribeDurableJobStatus } from "@chase-sets/platform-runtime/durable-job-web";
import {
  HiddenInput,
  Form,
  Badge,
  Button,
  Card,
  DataTable,
  Inline,
  LinkButton,
  MarketplaceDashboardPanel,
  MarketplaceNotice,
  NativeSelect,
  Page,
  PageHeader,
  PageSection,
  ProductSelectionFields,
  SideSheet,
  Stack,
  Text,
  TextInput,
  Textarea,
} from "@chase-sets/design-system";
import type { InventoryImportBatch, InventoryImportBatchDetail, InventoryImportBatchRow } from "../read-model/queries";
import type { InventoryImportBatchJobStatus } from "../api/runtime";
import type { InventoryCatalogItemSnapshot } from "../../inventory-items/integrations/catalog/queries";
import type { InventoryStorageLocation } from "../../storage-locations/api/contracts";
import { listInventoryImportSources } from "../domain/import-source-adapters";
import { appendInventoryHandoffSearch, inventoryListingHref } from "../../inventory-items/ui/listing-handoff";
import { activeResolutionRow, rowNeedsResolution, unresolvedResolutionRowIds } from "./resolution-flow";
import {
  normalizeSelectedOptionsForSchema,
  recordToSelectionEntries,
  selectionEntriesToRecord,
  toInventoryProductSelectionFields,
} from "../../inventory-items/integrations/catalog/versioning";

const DEFAULT_CATALOG_ITEM_API_BASE_URL = "/api/inventory/catalog-items";

type CatalogItemSearchResponse = Readonly<{
  items?: readonly InventoryCatalogItemSnapshot[];
}>;

function statusTone(status: string) {
  switch (status) {
    case "accepted":
    case "committed":
      return "success";
    case "rejected":
      return "danger";
    default:
      return "neutral";
  }
}

function money(amount: string | null) {
  return amount ? formatMoneyDisplay(amount, "USD") : t("inventory.features.importBatches.ui.importBatchPage.not.set");
}

function catalogItemOptionLabel(item: InventoryCatalogItemSnapshot) {
  return [item.title, item.subtitle].filter(Boolean).join(" - ");
}

const RESOLVE_ROW_SEARCH_KEY = "resolveRowId";

function resolveRowHref(currentPath: string | null | undefined, rowId: string) {
  const [pathname = "", rawQuery = ""] = (currentPath ?? "").split("?");
  const params = new URLSearchParams(rawQuery);
  params.set(RESOLVE_ROW_SEARCH_KEY, rowId);
  return `${pathname || "."}?${params.toString()}`;
}

function closeResolveRowHref(currentPath: string | null | undefined) {
  const [pathname = "", rawQuery = ""] = (currentPath ?? "").split("?");
  const params = new URLSearchParams(rawQuery);
  params.delete(RESOLVE_ROW_SEARCH_KEY);
  const query = params.toString();
  return `${pathname || "."}${query ? `?${query}` : ""}`;
}

function selectedResolveRowId(currentPath: string | null | undefined) {
  const [, rawQuery = ""] = (currentPath ?? "").split("?");
  return new URLSearchParams(rawQuery).get(RESOLVE_ROW_SEARCH_KEY);
}

function localizedImportSourceLabel(sourceKey: ReturnType<typeof listInventoryImportSources>[number]["sourceKey"]) {
  switch (sourceKey) {
    case "saved-list":
      return t("inventory.features.importBatches.ui.importBatchPage.saved.list");
    case "tcgplayer-csv":
      return t("inventory.features.importBatches.ui.importBatchPage.tcgplayer.csv");
    case "ebay-csv":
      return t("inventory.features.importBatches.ui.importBatchPage.ebay.csv");
    case "shopify-csv":
      return t("inventory.features.importBatches.ui.importBatchPage.shopify.csv");
    case "whatnot-csv":
      return t("inventory.features.importBatches.ui.importBatchPage.whatnot.csv");
    case "cardtrader-csv":
      return t("inventory.features.importBatches.ui.importBatchPage.cardtrader.csv");
    case "native-csv":
      return t("inventory.features.importBatches.ui.importBatchPage.chase.sets.csv");
  }
}

function rowOutcome(row: InventoryImportBatchRow, currentPath?: string | null): ReactNode {
  if (!row.committed_inventory_item_id && !row.committed_listing_id) {
    return (
      <Text size="sm" tone="secondary">
        {t("inventory.features.importBatches.ui.importBatchPage.no.outcome.yet")}
      </Text>
    );
  }

  return (
    <Stack gap={1}>
      {row.committed_inventory_item_id ? (
        <Inline>
          <Text size="sm" tone="secondary">
            {t("inventory.features.importBatches.ui.importBatchPage.inventory.item.created", {
              id: row.committed_inventory_item_id,
            })}
          </Text>
          {!row.committed_listing_id ? (
            <LinkButton
              href={inventoryListingHref(row.committed_inventory_item_id, currentPath)}
              tone="ghost"
              size="sm"
            >
              {t("inventory.features.inventoryItems.ui.inventoryItemListPage.create.listing")}
            </LinkButton>
          ) : null}
        </Inline>
      ) : null}
      {row.committed_listing_id ? (
        <Text size="sm" tone="secondary">
          {t("inventory.features.importBatches.ui.importBatchPage.draft.listing.created", {
            id: row.committed_listing_id,
          })}
        </Text>
      ) : null}
    </Stack>
  );
}

const importSourceOptions = listInventoryImportSources()
  .filter((source) => source.kind === "csv")
  .map((source) => ({
    value: source.sourceKey,
    label: localizedImportSourceLabel(source.sourceKey),
  }));

function ImportRowResolutionForm({
  row,
  storageLocations,
  catalogItemApiBaseUrl,
}: {
  row: InventoryImportBatchRow;
  storageLocations: readonly InventoryStorageLocation[];
  catalogItemApiBaseUrl: string;
}) {
  const [initialSelectedOptions] = useState(() => selectionEntriesToRecord(row.selected_options));
  const [catalogItemSearch, setCatalogItemSearch] = useState(row.catalog_item_id ?? "");
  const [catalogSearchResults, setCatalogSearchResults] = useState<readonly InventoryCatalogItemSnapshot[]>([]);
  const [catalogItemId, setCatalogItemId] = useState(row.catalog_item_id ?? "");
  const [catalogItem, setCatalogItem] = useState<InventoryCatalogItemSnapshot | null>(null);
  const [catalogLookupError, setCatalogLookupError] = useState<string | null>(null);
  const [catalogLookupPending, setCatalogLookupPending] = useState(false);
  const [selectedOptionsByDimension, setSelectedOptionsByDimension] = useState<Record<string, string>>({});

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
              setSelectedOptionsByDimension(
                selectedItem.product_schema
                  ? normalizeSelectedOptionsForSchema(selectedItem.product_schema, initialSelectedOptions)
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
  }, [catalogItemApiBaseUrl, catalogItemId, catalogItemSearch, initialSelectedOptions]);

  function resetCatalogItemSelection(nextSearch: string) {
    setCatalogItemSearch(nextSearch);
    setCatalogItemId("");
    setCatalogItem(null);
    setSelectedOptionsByDimension({});
  }

  function selectCatalogItem(nextCatalogItemId: string) {
    const item = catalogSearchResults.find((candidate) => candidate.catalog_item_id === nextCatalogItemId);
    setCatalogItemId(nextCatalogItemId);
    setCatalogItem(item ?? null);
    setCatalogLookupError(null);
    setCatalogItemSearch(item?.title ?? catalogItemSearch);
    setSelectedOptionsByDimension(
      item?.product_schema ? normalizeSelectedOptionsForSchema(item.product_schema, initialSelectedOptions) : {},
    );
  }

  const productSelectionFields = toInventoryProductSelectionFields(
    catalogItem?.product_schema ?? null,
    selectedOptionsByDimension,
  );
  const selectedOptions = catalogItem?.product_schema
    ? recordToSelectionEntries(catalogItem.product_schema, selectedOptionsByDimension)
    : [];

  return (
    <Form spacing="none" method="post">
      <Stack gap={2}>
        <HiddenInput type="hidden" name="intent" value="resolve-row" />
        <HiddenInput type="hidden" name="batchId" value={row.batch_id} />
        <HiddenInput type="hidden" name="rowId" value={row.row_id} />
        <HiddenInput type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
        <TextInput
          label={t("inventory.features.inventoryItems.ui.inventoryItemListPage.search.catalog")}
          placeholder={t("inventory.features.inventoryItems.ui.inventoryItemListPage.search.or.paste.catalog.item")}
          value={catalogItemSearch}
          onChange={(event) => resetCatalogItemSelection(event.target.value)}
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
        />
        {catalogLookupPending ? (
          <Text size="sm" tone="secondary">
            {t("inventory.features.inventoryItems.ui.inventoryItemListPage.searching.catalog.items")}
          </Text>
        ) : null}
        {catalogLookupError ? <Text size="sm">{catalogLookupError}</Text> : null}
        {catalogItem?.product_schema && catalogItem.product_schema.dimensions.length > 0 ? (
          <ProductSelectionFields
            fields={productSelectionFields}
            onFieldChange={(dimensionId, optionId) =>
              setSelectedOptionsByDimension((current) =>
                normalizeSelectedOptionsForSchema(catalogItem.product_schema!, {
                  ...current,
                  [dimensionId]: optionId,
                }),
              )
            }
          />
        ) : catalogItem ? (
          <Text size="sm" tone="secondary">
            {t("inventory.features.inventoryItems.ui.inventoryItemListPage.this.catalog.item.does.not.require")}
          </Text>
        ) : null}
        <NativeSelect
          label={t("inventory.features.inventoryItems.ui.inventoryItemListPage.storage.location")}
          name="storageLocationId"
          required
          defaultValue={row.storage_location_id ?? ""}
          placeholder={t("inventory.features.inventoryItems.ui.inventoryItemListPage.select.a.location")}
          items={storageLocations.map((location) => ({
            value: location.storage_location_id,
            label: location.name,
          }))}
        />
        <Button type="submit" size="sm">
          {t("inventory.features.importBatches.ui.importBatchPage.apply.row.fix")}
        </Button>
      </Stack>
    </Form>
  );
}

export function InventoryImportBatchPage({
  batches,
  storageLocations,
  detail,
  activeJobId,
  currentPath,
  errorMessage,
  detailLoadMessage,
  catalogItemApiBaseUrl = DEFAULT_CATALOG_ITEM_API_BASE_URL,
}: {
  batches: readonly InventoryImportBatch[];
  storageLocations: readonly InventoryStorageLocation[];
  detail: InventoryImportBatchDetail | null;
  activeJobId?: string | null;
  currentPath?: string | null;
  errorMessage?: string | null;
  detailLoadMessage?: string | null;
  catalogItemApiBaseUrl?: string;
}) {
  const canCommit = Boolean(detail && detail.accepted_count > detail.committed_count);
  const latestBatchId = detail?.batch_id ?? batches[0]?.batch_id ?? null;
  const activeJob = useInventoryImportBatchJob(activeJobId);
  const unresolvedRowIds = detail ? unresolvedResolutionRowIds(detail) : [];
  const resolveRow = activeResolutionRow(detail, selectedResolveRowId(currentPath));
  const resolveRowPosition = resolveRow ? unresolvedRowIds.indexOf(resolveRow.row_id) + 1 : 0;

  return (
    <Page>
      <PageHeader
        eyebrow={t("inventory.features.importBatches.ui.importBatchPage.seller")}
        title={t("inventory.features.importBatches.ui.importBatchPage.inventory.import")}
        description={t("inventory.features.importBatches.ui.importBatchPage.upload.review.and.commit.csv")}
        actions={
          <Inline>
            <LinkButton href={appendInventoryHandoffSearch("/account/inventory", currentPath)} tone="secondary">
              {t("inventory.features.importBatches.ui.importBatchPage.inventory")}
            </LinkButton>
            <LinkButton href="/account/listings" tone="secondary">
              {t("inventory.features.importBatches.ui.importBatchPage.listings")}
            </LinkButton>
            <LinkButton href="/account/repricing" tone="ghost">
              {t("inventory.features.importBatches.ui.importBatchPage.pricing")}
            </LinkButton>
          </Inline>
        }
      />

      {errorMessage ? (
        <MarketplaceNotice
          tone="danger"
          title={t("inventory.features.importBatches.ui.importBatchPage.import.failed")}
          description={errorMessage}
        />
      ) : null}

      {detailLoadMessage ? (
        <MarketplaceNotice
          tone="info"
          title={t("inventory.features.importBatches.ui.importBatchPage.import.still.updating")}
          description={detailLoadMessage}
        />
      ) : null}

      {activeJob ? (
        <MarketplaceNotice
          tone={activeJob.status === "failed" ? "danger" : "info"}
          title={t("inventory.features.importBatches.ui.importBatchPage.import.job.running")}
          description={
            activeJob.errorMessage ??
            activeJob.progress.message ??
            t("inventory.features.importBatches.ui.importBatchPage.import.job.waiting")
          }
        />
      ) : null}

      <MarketplaceDashboardPanel
        title={t("inventory.features.importBatches.ui.importBatchPage.batch.summary")}
        description={t("inventory.features.importBatches.ui.importBatchPage.review.row.outcomes.before.creating")}
        metrics={[
          {
            label: t("inventory.features.importBatches.ui.importBatchPage.total.rows"),
            value: detail?.total_count ?? 0,
            detail: t("inventory.features.importBatches.ui.importBatchPage.csv.rows"),
          },
          {
            label: t("inventory.features.importBatches.ui.importBatchPage.accepted"),
            value: detail?.accepted_count ?? 0,
            detail: t("inventory.features.importBatches.ui.importBatchPage.ready.to.commit"),
          },
          {
            label: t("inventory.features.importBatches.ui.importBatchPage.rejected"),
            value: detail?.rejected_count ?? 0,
            detail: t("inventory.features.importBatches.ui.importBatchPage.needs.row.fixes"),
          },
          {
            label: t("inventory.features.importBatches.ui.importBatchPage.committed"),
            value: detail?.committed_count ?? 0,
            detail: t("inventory.features.importBatches.ui.importBatchPage.items.created"),
          },
          {
            label: t("inventory.features.importBatches.ui.importBatchPage.source"),
            value: detail
              ? localizedImportSourceLabel(detail.source_key)
              : t("inventory.features.importBatches.ui.importBatchPage.chase.sets"),
            detail: detail
              ? t("inventory.features.importBatches.ui.importBatchPage.adapter.version", {
                  version: detail.adapter_version,
                })
              : t("inventory.features.importBatches.ui.importBatchPage.not.set"),
          },
          {
            label: t("inventory.features.importBatches.ui.importBatchPage.mode"),
            value: detail?.quantity_mode ?? t("inventory.features.importBatches.ui.importBatchPage.add.stock"),
            detail:
              detail?.default_storage_location_id ??
              t("inventory.features.importBatches.ui.importBatchPage.no.default.location"),
          },
        ]}
      />

      <PageSection title={t("inventory.features.importBatches.ui.importBatchPage.upload.csv")}>
        <Card>
          <Form spacing="none" method="post" encType="multipart/form-data">
            <Stack gap={3}>
              <HiddenInput type="hidden" name="intent" value="create-batch" />
              <Inline>
                <NativeSelect
                  label={t("inventory.features.importBatches.ui.importBatchPage.import.source")}
                  name="sourceKey"
                  defaultValue="native-csv"
                  items={importSourceOptions}
                />
                <NativeSelect
                  label={t("inventory.features.importBatches.ui.importBatchPage.quantity.mode")}
                  name="quantityMode"
                  defaultValue="add"
                  items={[
                    {
                      value: "add",
                      label: t("inventory.features.importBatches.ui.importBatchPage.add.stock"),
                    },
                    {
                      value: "replace",
                      label: t("inventory.features.importBatches.ui.importBatchPage.replace.stock"),
                    },
                  ]}
                />
              </Inline>
              <NativeSelect
                label={t("inventory.features.importBatches.ui.importBatchPage.default.storage.location")}
                name="defaultStorageLocationId"
                placeholder={t("inventory.features.importBatches.ui.importBatchPage.choose.location")}
                items={storageLocations.map((location) => ({
                  value: location.storage_location_id,
                  label: location.name,
                }))}
              />
              <TextInput
                label={t("inventory.features.importBatches.ui.importBatchPage.source.filename")}
                name="sourceFilename"
                placeholder={t("inventory.features.importBatches.ui.importBatchPage.source.filename.placeholder")}
              />
              <TextInput
                label={t("inventory.features.importBatches.ui.importBatchPage.csv.file")}
                name="file"
                type="file"
              />
              <Textarea
                label={t("inventory.features.importBatches.ui.importBatchPage.csv.rows.input")}
                name="csvText"
                rows={8}
                placeholder={t("inventory.features.importBatches.ui.importBatchPage.csv.placeholder")}
                description={t("inventory.features.importBatches.ui.importBatchPage.csv.description")}
              />
              <Inline>
                <Button type="submit">
                  {t("inventory.features.importBatches.ui.importBatchPage.validate.import")}
                </Button>
                {latestBatchId ? (
                  <LinkButton href={`/account/inventory/imports/${latestBatchId}`} tone="ghost">
                    {t("inventory.features.importBatches.ui.importBatchPage.latest.batch")}
                  </LinkButton>
                ) : null}
                <LinkButton href="/api/inventory/import-batches/templates/native-csv" tone="ghost" download>
                  {t("inventory.features.importBatches.ui.importBatchPage.download.native.template")}
                </LinkButton>
                <LinkButton href="/api/inventory/import-batches/exports/native-csv" tone="ghost" download>
                  {t("inventory.features.importBatches.ui.importBatchPage.export.current.inventory")}
                </LinkButton>
              </Inline>
            </Stack>
          </Form>
        </Card>
      </PageSection>

      {detail ? (
        <PageSection title={t("inventory.features.importBatches.ui.importBatchPage.review.batch")}>
          <Stack gap={3}>
            {unresolvedRowIds.length > 0 ? (
              <MarketplaceNotice
                tone="warning"
                title={t("inventory.features.importBatches.ui.importBatchPage.rows.need.you", {
                  count: unresolvedRowIds.length,
                })}
                description={t("inventory.features.importBatches.ui.importBatchPage.resolve.rows.in.place")}
                action={
                  <LinkButton href={resolveRowHref(currentPath, unresolvedRowIds[0]!)} size="sm">
                    {t("inventory.features.importBatches.ui.importBatchPage.resolve.rows")}
                  </LinkButton>
                }
              />
            ) : null}
            {canCommit ? (
              <Card>
                <Form spacing="none" method="post">
                  <HiddenInput type="hidden" name="intent" value="commit-batch" />
                  <HiddenInput type="hidden" name="batchId" value={detail.batch_id} />
                  <Inline>
                    <Text>
                      {t("inventory.features.importBatches.ui.importBatchPage.accepted.rows.ready", {
                        count: detail.accepted_count - detail.committed_count,
                      })}
                    </Text>
                    <Button type="submit">
                      {t("inventory.features.importBatches.ui.importBatchPage.commit.accepted.rows")}
                    </Button>
                  </Inline>
                </Form>
              </Card>
            ) : null}
            <DataTable
              rows={[...detail.rows]}
              getRowId={(row) => row.row_id}
              columns={[
                {
                  key: "row",
                  header: t("inventory.features.importBatches.ui.importBatchPage.row"),
                  cell: (row) => row.row_number,
                },
                {
                  key: "status",
                  header: t("inventory.features.importBatches.ui.importBatchPage.status"),
                  cell: (row) => (
                    <Stack gap={1}>
                      <Badge tone={statusTone(row.status)}>{row.status}</Badge>
                      <Text size="sm" tone="secondary">
                        {row.resolution_status}
                      </Text>
                    </Stack>
                  ),
                },
                {
                  key: "source",
                  header: t("inventory.features.importBatches.ui.importBatchPage.source"),
                  cell: (row) => (
                    <Stack gap={1}>
                      <Text weight="semibold">
                        {row.external_reference?.displayName ??
                          row.external_reference?.externalKey ??
                          t("inventory.features.importBatches.ui.importBatchPage.native.row")}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {row.external_reference
                          ? t("inventory.features.importBatches.ui.importBatchPage.external.reference", {
                              provider: row.external_reference.providerKey,
                              key: row.external_reference.externalKey,
                            })
                          : row.row_fingerprint}
                      </Text>
                    </Stack>
                  ),
                },
                {
                  key: "catalogItem",
                  header: t("inventory.features.importBatches.ui.importBatchPage.catalog.item"),
                  cell: (row) => (
                    <Stack gap={1}>
                      <Text weight="semibold">
                        {row.catalog_item_id ?? t("inventory.features.importBatches.ui.importBatchPage.not.set")}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {row.product_id ?? t("inventory.features.importBatches.ui.importBatchPage.product.unresolved")}
                      </Text>
                    </Stack>
                  ),
                },
                {
                  key: "quantity",
                  header: t("inventory.features.importBatches.ui.importBatchPage.quantity"),
                  align: "right",
                  cell: (row) => (
                    <Stack gap={1}>
                      <Text>
                        {row.set_quantity ??
                          row.quantity_delta ??
                          row.total_quantity ??
                          t("inventory.features.importBatches.ui.importBatchPage.not.set")}
                      </Text>
                      <Text size="sm" tone="secondary">
                        {row.quantity_mode}
                      </Text>
                    </Stack>
                  ),
                },
                {
                  key: "listing",
                  header: t("inventory.features.importBatches.ui.importBatchPage.listing.draft"),
                  cell: (row) => (
                    <Stack gap={1}>
                      <Text>{money(row.listing_price_amount)}</Text>
                      <Text size="sm" tone="secondary">
                        {row.listing_quantity_cap
                          ? t("inventory.features.importBatches.ui.importBatchPage.cap.quantity", {
                              quantity: row.listing_quantity_cap,
                            })
                          : t("inventory.features.importBatches.ui.importBatchPage.no.draft")}
                      </Text>
                    </Stack>
                  ),
                },
                {
                  key: "errors",
                  header: t("inventory.features.importBatches.ui.importBatchPage.errors.and.outcomes"),
                  cell: (row) => (
                    <Stack gap={1}>
                      {rowNeedsResolution(row, detail.source_key) ? (
                        <LinkButton href={resolveRowHref(currentPath, row.row_id)} size="sm">
                          {t("inventory.features.importBatches.ui.importBatchPage.resolve.row")}
                        </LinkButton>
                      ) : null}
                      {row.validation_errors.length > 0
                        ? row.validation_errors.map((message) => (
                            <Text key={message} size="sm">
                              {message}
                            </Text>
                          ))
                        : rowOutcome(row, currentPath)}
                    </Stack>
                  ),
                },
              ]}
              emptyTitle={t("inventory.features.importBatches.ui.importBatchPage.no.rows")}
              emptyDescription={t("inventory.features.importBatches.ui.importBatchPage.upload.csv.to.review.rows")}
            />
          </Stack>
        </PageSection>
      ) : (
        <PageSection title={t("inventory.features.importBatches.ui.importBatchPage.recent.imports")}>
          <DataTable
            rows={[...batches]}
            getRowId={(row) => row.batch_id}
            columns={[
              {
                key: "batch",
                header: t("inventory.features.importBatches.ui.importBatchPage.batch"),
                cell: (row) => (
                  <Stack gap={1}>
                    <Text weight="semibold">{row.source_filename ?? row.batch_id}</Text>
                    <Text size="sm" tone="secondary">
                      {formatDateTime(row.updated_at)}
                    </Text>
                  </Stack>
                ),
              },
              {
                key: "status",
                header: t("inventory.features.importBatches.ui.importBatchPage.status"),
                cell: (row) => <Badge tone={row.status === "committed" ? "success" : "neutral"}>{row.status}</Badge>,
              },
              {
                key: "accepted",
                header: t("inventory.features.importBatches.ui.importBatchPage.accepted"),
                align: "right",
                cell: (row) => row.accepted_count,
              },
              {
                key: "rejected",
                header: t("inventory.features.importBatches.ui.importBatchPage.rejected"),
                align: "right",
                cell: (row) => row.rejected_count,
              },
              {
                key: "actions",
                header: t("inventory.features.importBatches.ui.importBatchPage.actions"),
                cell: (row) => (
                  <LinkButton href={`/account/inventory/imports/${row.batch_id}`} tone="secondary" size="sm">
                    {t("inventory.features.importBatches.ui.importBatchPage.open")}
                  </LinkButton>
                ),
              },
            ]}
            emptyTitle={t("inventory.features.importBatches.ui.importBatchPage.no.imports.yet")}
            emptyDescription={t("inventory.features.importBatches.ui.importBatchPage.upload.csv.to.start")}
          />
        </PageSection>
      )}

      {resolveRow ? (
        <SideSheet
          open
          onOpenChange={(next) => {
            if (!next && typeof window !== "undefined") {
              window.location.assign(closeResolveRowHref(currentPath));
            }
          }}
          width="lg"
          title={t("inventory.features.importBatches.ui.importBatchPage.resolve.import.row", {
            row: resolveRow.row_number,
          })}
          description={t("inventory.features.importBatches.ui.importBatchPage.resolve.progress", {
            position: resolveRowPosition,
            total: unresolvedRowIds.length,
          })}
          closeLabel={t("inventory.features.importBatches.ui.importBatchPage.close")}
          footer={
            <LinkButton href={closeResolveRowHref(currentPath)} tone="secondary" size="sm">
              {t("inventory.features.importBatches.ui.importBatchPage.close")}
            </LinkButton>
          }
        >
          <Stack gap={3}>
            {resolveRow.validation_errors.length > 0 ? (
              <Stack gap={1}>
                {resolveRow.validation_errors.map((message) => (
                  <Text key={message} size="sm" tone="secondary">
                    {message}
                  </Text>
                ))}
              </Stack>
            ) : null}
            <ImportRowResolutionForm
              row={resolveRow}
              storageLocations={storageLocations}
              catalogItemApiBaseUrl={catalogItemApiBaseUrl}
            />
          </Stack>
        </SideSheet>
      ) : null}
    </Page>
  );
}

function useInventoryImportBatchJob(jobId?: string | null) {
  const [job, setJob] = useState<InventoryImportBatchJobStatus | null>(null);

  useEffect(() => {
    if (!jobId) {
      setJob(null);
      return undefined;
    }

    const subscription = subscribeDurableJobStatus<InventoryImportBatchJobStatus>({
      url: `/api/inventory/import-batches/jobs/${encodeURIComponent(jobId)}/events`,
      onStatus: setJob,
      onTerminal: (nextJob) => {
        if (nextJob.status === "completed") {
          const batchId = nextJob.result?.batch.batch_id;
          const destination = batchId
            ? `/account/inventory/imports/${encodeURIComponent(batchId)}`
            : "/account/inventory/imports";
          window.location.replace(nextJob.result ? navigateAfterWrite(nextJob.result, destination) : destination);
        }
      },
    });
    return () => {
      subscription.close();
    };
  }, [jobId]);

  return job;
}
