import { formatDateTime, formatMoney as formatMoneyDisplay, t } from "@chase-sets/localization";
import { useEffect, useReducer, useState, type ReactNode } from "react";
import { navigateAfterWrite } from "@chase-sets/http/responses";
import { subscribeDurableJobStatus } from "@chase-sets/platform-runtime/durable-job-web";
import {
  HiddenInput,
  Form,
  Badge,
  Button,
  Card,
  Combobox,
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
  type SelectItem,
} from "@chase-sets/design-system";
import type { InventoryImportBatch, InventoryImportBatchDetail, InventoryImportBatchRow } from "../read-model/queries";
import type { InventoryImportBatchJobStatus } from "../api/runtime";
import type { InventoryCatalogItemSnapshot } from "../../inventory-items/integrations/catalog/queries";
import type { InventoryStorageLocation } from "../../storage-locations/api/contracts";
import { listInventoryImportSources } from "../domain/import-source-adapters";
import { appendInventoryHandoffSearch, inventoryListingHref } from "../../inventory-items/ui/listing-handoff";
import { InventoryMutationForm } from "../../../support/ui-support/mutation-recovery";
import {
  normalizeSelectedOptionsForSchema,
  recordToSelectionEntries,
  selectionEntriesToRecord,
  toInventoryProductSelectionFields,
  validateSelectedOptions,
} from "../../inventory-items/integrations/catalog/versioning";

const CATALOG_ITEM_SUGGESTIONS_URL = "/api/marketplace/items/suggest";
const CATALOG_ITEM_API_BASE_URL = "/api/inventory/catalog-items";
const CATALOG_ITEM_SUGGESTION_SETTLE_MS = 250;
const CATALOG_ITEM_SUGGESTION_MIN_LENGTH = 2;
const CATALOG_ITEM_ID_PATTERN = /^cat_\S+$/;

type CatalogItemSuggestion = Readonly<{
  catalogItemId: string;
  title: string;
  subtitle: string | null;
}>;

// "row" restores the Import row's catalog item; "candidate" loads a pasted ID that stays unselected;
// "choice" loads an explicitly chosen catalog item before its Options render.
type CatalogItemLookup =
  | Readonly<{ kind: "suggestions"; query: string }>
  | Readonly<{ kind: "row" | "candidate" | "choice"; catalogItemId: string }>;

type CatalogItemPickerStatus =
  | "idle"
  | "loading"
  | "populated"
  | "empty"
  | "candidate"
  | "hydrating"
  | "selected"
  | "error";

type CatalogItemPickerState = Readonly<{
  query: string;
  status: CatalogItemPickerStatus;
  errorMessage: string | null;
  suggestions: readonly CatalogItemSuggestion[];
  candidate: InventoryCatalogItemSnapshot | null;
  choice: Readonly<{ catalogItemId: string; label: string }> | null;
  catalogItem: InventoryCatalogItemSnapshot | null;
  selectedOptions: Record<string, string>;
  rowSelectedOptions: Record<string, string>;
  lookup: CatalogItemLookup | null;
}>;

type CatalogItemPickerAction =
  | Readonly<{ type: "input-changed"; text: string }>
  | Readonly<{ type: "catalog-item-chosen"; catalogItemId: string; label: string }>
  | Readonly<{ type: "suggestions-loaded"; lookup: CatalogItemLookup; items: readonly CatalogItemSuggestion[] }>
  | Readonly<{ type: "catalog-item-loaded"; lookup: CatalogItemLookup; item: InventoryCatalogItemSnapshot }>
  | Readonly<{ type: "lookup-failed"; lookup: CatalogItemLookup; message: string }>
  | Readonly<{ type: "option-changed"; dimensionId: string; optionId: string }>;

// A row's Catalog item ID outranks its source text; otherwise the platform display name, then the row
// note, seed an editable query that stays request-free until the seller edits it.
function initialCatalogItemPickerState(row: InventoryImportBatchRow): CatalogItemPickerState {
  return {
    query: row.catalog_item_id ? "" : row.external_reference?.displayName?.trim() || row.row_note?.trim() || "",
    status: row.catalog_item_id ? "hydrating" : "idle",
    errorMessage: null,
    suggestions: [],
    candidate: null,
    choice: null,
    catalogItem: null,
    selectedOptions: {},
    rowSelectedOptions: selectionEntriesToRecord(row.selected_options),
    lookup: row.catalog_item_id ? { kind: "row", catalogItemId: row.catalog_item_id } : null,
  };
}

function selectCatalogItem(state: CatalogItemPickerState, item: InventoryCatalogItemSnapshot): CatalogItemPickerState {
  const label = catalogItemOptionLabel(item);
  return {
    ...state,
    query: label,
    status: "selected",
    errorMessage: null,
    candidate: null,
    choice: { catalogItemId: item.catalog_item_id, label },
    catalogItem: item,
    selectedOptions: item.product_schema
      ? normalizeSelectedOptionsForSchema(item.product_schema, state.rowSelectedOptions)
      : {},
  };
}

function failCatalogItemLookup(
  state: CatalogItemPickerState,
  lookup: CatalogItemLookup,
  message: string,
): CatalogItemPickerState {
  const failed = { ...state, status: "error" as const, errorMessage: message, candidate: null };
  if (lookup.kind === "suggestions" || lookup.kind === "candidate") {
    return failed;
  }
  return {
    ...failed,
    query: lookup.kind === "row" ? "" : state.query,
    choice: null,
    catalogItem: null,
    selectedOptions: {},
  };
}

function hasStaleSelectedOptions(item: InventoryCatalogItemSnapshot, savedOptions: Record<string, string>) {
  const saved = Object.entries(savedOptions);
  if (saved.length === 0) {
    return false;
  }
  if (!item.product_schema) {
    return true;
  }
  const normalized = normalizeSelectedOptionsForSchema(item.product_schema, savedOptions);
  return (
    Object.keys(normalized).length !== saved.length ||
    saved.some(([dimensionId, optionId]) => normalized[dimensionId] !== optionId)
  );
}

function catalogItemPickerReducer(
  state: CatalogItemPickerState,
  action: CatalogItemPickerAction,
): CatalogItemPickerState {
  switch (action.type) {
    case "input-changed": {
      // The combobox echoes the chosen label into the input; only a different text is an edit.
      if (state.choice && action.text === state.choice.label) {
        return state.query === action.text ? state : { ...state, query: action.text };
      }
      const text = action.text.trim();
      const lookup: CatalogItemLookup | null = CATALOG_ITEM_ID_PATTERN.test(text)
        ? { kind: "candidate", catalogItemId: text }
        : text.length >= CATALOG_ITEM_SUGGESTION_MIN_LENGTH
          ? { kind: "suggestions", query: text }
          : null;
      // An edit also drops the row's saved Options, so only the initial restore reuses them.
      return {
        ...state,
        query: action.text,
        status: lookup ? "loading" : "idle",
        errorMessage: null,
        suggestions: [],
        candidate: null,
        choice: null,
        catalogItem: null,
        selectedOptions: {},
        rowSelectedOptions: {},
        lookup,
      };
    }
    case "catalog-item-chosen":
      if (state.choice?.catalogItemId === action.catalogItemId) {
        return state;
      }
      if (state.candidate?.catalog_item_id === action.catalogItemId) {
        return selectCatalogItem(state, state.candidate);
      }
      return {
        ...state,
        query: action.label,
        status: "hydrating",
        errorMessage: null,
        choice: { catalogItemId: action.catalogItemId, label: action.label },
        catalogItem: null,
        selectedOptions: {},
        lookup: { kind: "choice", catalogItemId: action.catalogItemId },
      };
    case "suggestions-loaded":
      if (action.lookup !== state.lookup) {
        return state;
      }
      return { ...state, suggestions: action.items, status: action.items.length > 0 ? "populated" : "empty" };
    case "catalog-item-loaded": {
      const { lookup, item } = action;
      if (lookup !== state.lookup || lookup.kind === "suggestions") {
        return state;
      }
      if (item.status !== "active") {
        return failCatalogItemLookup(
          state,
          lookup,
          t("inventory.features.inventoryItems.ui.inventoryItemListPage.catalog.item.not.active"),
        );
      }
      if (lookup.kind === "candidate") {
        return { ...state, status: "candidate", candidate: item };
      }
      if (lookup.kind === "row" && hasStaleSelectedOptions(item, state.rowSelectedOptions)) {
        return {
          ...state,
          query: catalogItemOptionLabel(item),
          status: "error",
          errorMessage: t("inventory.features.inventoryItems.ui.inventoryItemListPage.catalog.item.options.stale"),
          candidate: item,
          rowSelectedOptions: {},
        };
      }
      return selectCatalogItem(state, item);
    }
    case "lookup-failed":
      return action.lookup === state.lookup ? failCatalogItemLookup(state, action.lookup, action.message) : state;
    case "option-changed":
      if (!state.catalogItem?.product_schema) {
        return state;
      }
      return {
        ...state,
        selectedOptions: normalizeSelectedOptionsForSchema(state.catalogItem.product_schema, {
          ...state.selectedOptions,
          [action.dimensionId]: action.optionId,
        }),
      };
  }
}

async function catalogItemLookupError(response: Response) {
  const body = (await response.json().catch(() => null)) as { error?: string | { message?: string } } | null;
  const message = typeof body?.error === "string" ? body.error : body?.error?.message;
  return new Error(
    message ?? t("inventory.features.inventoryItems.ui.inventoryItemListPage.catalog.item.lookup.failed"),
  );
}

async function fetchCatalogItemSuggestions(query: string, signal: AbortSignal) {
  const response = await fetch(`${CATALOG_ITEM_SUGGESTIONS_URL}?${new URLSearchParams({ q: query }).toString()}`, {
    credentials: "include",
    signal,
  });
  if (!response.ok) {
    throw await catalogItemLookupError(response);
  }
  const body = (await response.json()) as { items?: readonly CatalogItemSuggestion[] };
  return body.items ?? [];
}

async function fetchCatalogItem(catalogItemId: string, signal: AbortSignal) {
  const response = await fetch(`${CATALOG_ITEM_API_BASE_URL}/${encodeURIComponent(catalogItemId)}`, {
    credentials: "include",
    signal,
  });
  if (!response.ok) {
    throw await catalogItemLookupError(response);
  }
  return (await response.json()) as InventoryCatalogItemSnapshot;
}

function useCatalogItemPicker(row: InventoryImportBatchRow) {
  const [state, dispatch] = useReducer(catalogItemPickerReducer, row, initialCatalogItemPickerState);

  useEffect(() => {
    const lookup = state.lookup;
    if (!lookup) {
      return undefined;
    }

    const controller = new AbortController();
    const run = () => {
      const request: Promise<CatalogItemPickerAction> =
        lookup.kind === "suggestions"
          ? fetchCatalogItemSuggestions(lookup.query, controller.signal).then((items) => ({
              type: "suggestions-loaded",
              lookup,
              items,
            }))
          : fetchCatalogItem(lookup.catalogItemId, controller.signal).then((item) => ({
              type: "catalog-item-loaded",
              lookup,
              item,
            }));
      request.then(dispatch, (error: unknown) => {
        if (!controller.signal.aborted) {
          dispatch({
            type: "lookup-failed",
            lookup,
            message:
              error instanceof Error
                ? error.message
                : t("inventory.features.inventoryItems.ui.inventoryItemListPage.catalog.item.lookup.failed"),
          });
        }
      });
    };

    // Typed text settles before it requests; restored and chosen IDs load at once.
    if (lookup.kind === "row" || lookup.kind === "choice") {
      run();
      return () => controller.abort();
    }
    const timer = window.setTimeout(run, CATALOG_ITEM_SUGGESTION_SETTLE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [state.lookup]);

  return [state, dispatch] as const;
}

function catalogItemPickerEntries(state: CatalogItemPickerState): SelectItem[] {
  const suggestions = state.suggestions.map((suggestion) => ({
    value: suggestion.catalogItemId,
    label:
      state.choice?.catalogItemId === suggestion.catalogItemId
        ? state.choice.label
        : [suggestion.title, suggestion.subtitle].filter(Boolean).join(" - "),
  }));
  const pinned = [
    state.choice ? { value: state.choice.catalogItemId, label: state.choice.label } : null,
    state.candidate ? { value: state.candidate.catalog_item_id, label: catalogItemOptionLabel(state.candidate) } : null,
  ].filter(
    (entry): entry is SelectItem =>
      entry !== null && !suggestions.some((suggestion) => suggestion.value === entry.value),
  );
  return [...pinned, ...suggestions];
}

function catalogItemPickerStatusMessage(status: CatalogItemPickerStatus) {
  switch (status) {
    case "loading":
      return t("inventory.features.inventoryItems.ui.inventoryItemListPage.searching.catalog.items");
    case "hydrating":
      return t("inventory.features.inventoryItems.ui.inventoryItemListPage.loading.catalog.item");
    case "populated":
    case "candidate":
      return t("inventory.features.inventoryItems.ui.inventoryItemListPage.choose.the.visible.catalog.item");
    case "empty":
      return t("inventory.features.inventoryItems.ui.inventoryItemListPage.no.active.catalog.items.matched");
    default:
      return undefined;
  }
}

function hasCompleteSelectedOptions(item: InventoryCatalogItemSnapshot, selectedOptions: Record<string, string>) {
  try {
    validateSelectedOptions(
      item.product_schema,
      item.product_schema ? recordToSelectionEntries(item.product_schema, selectedOptions) : [],
    );
    return true;
  } catch {
    return false;
  }
}

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

function money(amount: string | null, currencyCode: string | null) {
  if (amount && !currencyCode) {
    return t("inventory.features.importBatches.ui.importBatchPage.listing.price.incomplete");
  }
  return amount && currencyCode
    ? formatMoneyDisplay(amount, currencyCode)
    : t("inventory.features.importBatches.ui.importBatchPage.not.set");
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
}: {
  row: InventoryImportBatchRow;
  storageLocations: readonly InventoryStorageLocation[];
}) {
  const [picker, dispatchPicker] = useCatalogItemPicker(row);
  const { catalogItem } = picker;
  const catalogItemEntries = catalogItemPickerEntries(picker);
  const pickerStatusMessage = catalogItemPickerStatusMessage(picker.status);
  const canApplyRowFix = catalogItem !== null && hasCompleteSelectedOptions(catalogItem, picker.selectedOptions);
  const productSelectionFields = toInventoryProductSelectionFields(
    catalogItem?.product_schema ?? null,
    picker.selectedOptions,
  );
  const selectedOptions = catalogItem?.product_schema
    ? recordToSelectionEntries(catalogItem.product_schema, picker.selectedOptions)
    : [];

  return (
    <Form spacing="none" method="post">
      <Stack gap={2}>
        <HiddenInput type="hidden" name="intent" value="resolve-row" />
        <HiddenInput type="hidden" name="batchId" value={row.batch_id} />
        <HiddenInput type="hidden" name="rowId" value={row.row_id} />
        <HiddenInput type="hidden" name="catalogItemId" value={catalogItem?.catalog_item_id ?? ""} />
        <HiddenInput type="hidden" name="selectedOptions" value={JSON.stringify(selectedOptions)} />
        <Combobox
          label={t("inventory.features.inventoryItems.ui.inventoryItemListPage.catalog.item")}
          required
          placeholder={t("inventory.features.inventoryItems.ui.inventoryItemListPage.search.or.paste.catalog.item")}
          description={t("inventory.features.inventoryItems.ui.inventoryItemListPage.search.by.title.or.paste.catalog")}
          items={catalogItemEntries}
          value={picker.choice?.catalogItemId ?? ""}
          onValueChange={(catalogItemId) =>
            dispatchPicker({
              type: "catalog-item-chosen",
              catalogItemId,
              label: catalogItemEntries.find((entry) => entry.value === catalogItemId)?.label ?? catalogItemId,
            })
          }
          inputValue={picker.query}
          onInputValueChange={(text) => dispatchPicker({ type: "input-changed", text })}
          filterItems={false}
          openOnInputClick
          noMatchesLabel={
            pickerStatusMessage ??
            picker.errorMessage ??
            t("inventory.features.inventoryItems.ui.inventoryItemListPage.search.by.title.or.paste.catalog")
          }
          status={pickerStatusMessage}
          error={picker.status === "error" ? picker.errorMessage : undefined}
        />
        {catalogItem?.product_schema && catalogItem.product_schema.dimensions.length > 0 ? (
          <ProductSelectionFields
            fields={productSelectionFields}
            onFieldChange={(dimensionId, optionId) => dispatchPicker({ type: "option-changed", dimensionId, optionId })}
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
        <Button type="submit" size="sm" disabled={!canApplyRowFix}>
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
}: {
  batches: readonly InventoryImportBatch[];
  storageLocations: readonly InventoryStorageLocation[];
  detail: InventoryImportBatchDetail | null;
  activeJobId?: string | null;
  currentPath?: string | null;
  errorMessage?: string | null;
  detailLoadMessage?: string | null;
}) {
  const canCommit = detail?.can_commit === true;
  const latestBatchId = detail?.batch_id ?? batches[0]?.batch_id ?? null;
  const activeJob = useInventoryImportBatchJob(activeJobId);
  const unresolvedRowIds = detail ? detail.rows.filter((row) => row.needs_seller).map((row) => row.row_id) : [];
  const selectedRowId = selectedResolveRowId(currentPath);
  const resolveRow = detail?.rows.find((row) => row.row_id === selectedRowId && row.needs_seller) ?? null;
  const resolveRowPosition = resolveRow ? unresolvedRowIds.indexOf(resolveRow.row_id) + 1 : 0;
  const rawOffset = Number(new URLSearchParams(currentPath?.split("?")[1] ?? "").get("offset") ?? 0);
  const rowOffset = Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;

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

      <MarketplaceNotice
        tone="info"
        title={t("inventory.import.resume.title")}
        description={t("inventory.import.resume.description")}
      />
      {detail?.status === "expired" ? (
        <MarketplaceNotice
          tone="warning"
          title={t("inventory.import.expired.title")}
          description={t("inventory.import.expired.description")}
        />
      ) : null}

      {detail ? (
        <PageSection title={t("inventory.features.importBatches.ui.importBatchPage.batch.summary")}>
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
        </PageSection>
      ) : null}

      <PageSection title={t("inventory.features.importBatches.ui.importBatchPage.upload.csv")}>
        <Card elevation="tinted" data-elevation-role="furniture">
          <InventoryMutationForm
            family="import-create"
            targetId="draft"
            spacing="none"
            method="post"
            encType="multipart/form-data"
          >
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
          </InventoryMutationForm>
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
              <Card elevation="tinted" data-elevation-role="furniture">
                <Form spacing="none" method="post">
                  <HiddenInput type="hidden" name="intent" value="commit-batch" />
                  <HiddenInput type="hidden" name="batchId" value={detail.batch_id} />
                  <Inline>
                    <Text>
                      {t("inventory.features.importBatches.ui.importBatchPage.accepted.rows.ready", {
                        count: detail.commit_ready_count,
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
                      <Text>{money(row.listing_price_amount, row.listing_price_currency_code)}</Text>
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
                      {row.needs_seller ? (
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
            <Inline>
              {rowOffset > 0 ? (
                <LinkButton
                  href={`/account/inventory/imports/${encodeURIComponent(detail.batch_id)}?offset=${Math.max(0, rowOffset - 100)}`}
                >
                  {t("inventory.import.rows.previous")}
                </LinkButton>
              ) : null}
              {rowOffset + detail.rows.length < detail.total_count ? (
                <LinkButton
                  href={`/account/inventory/imports/${encodeURIComponent(detail.batch_id)}?offset=${rowOffset + 100}`}
                >
                  {t("inventory.import.rows.next")}
                </LinkButton>
              ) : null}
            </Inline>
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
                    <Text weight="semibold">{row.batch_id}</Text>
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
            <ImportRowResolutionForm key={resolveRow.row_id} row={resolveRow} storageLocations={storageLocations} />
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
          const batchId = nextJob.result?.batch?.batch_id;
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
