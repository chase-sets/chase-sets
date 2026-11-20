import { formatLanguageCodeLabel, formatMoney, t } from "@chase-sets/localization";
import { useEffect, useReducer, useRef, useState } from "react";
import { useNavigation } from "react-router";
import {
  HiddenInput,
  Button,
  Badge,
  Card,
  Combobox,
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
  type SelectItem,
} from "@chase-sets/design-system";
import type { InventoryCatalogItemSnapshot } from "../integrations/catalog/queries";
import {
  normalizeSelectedOptionsForSchema,
  isDimensionActive,
  recordToSelectionEntries,
  toInventoryProductSelectionFields,
  validateSelectedOptions,
} from "../integrations/catalog/versioning";
import type { InventoryStorageLocation } from "../../storage-locations/ui/contracts";
import type { InventoryItemListItem } from "./contracts";
import { inventoryListingHref } from "./listing-handoff";
import { OfflineSaleForm, OfflineSaleResult } from "./offline-sale-form";
import { InventoryMutationRouterForm as Form } from "../../../support/request-support/mutation-form";

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

// "draft" restores the create-item handoff; "candidate" loads a pasted ID that stays unselected;
// "choice" loads an explicitly chosen catalog item before its Options render.
type CatalogItemLookup =
  | Readonly<{ kind: "suggestions"; query: string }>
  | Readonly<{ kind: "draft" | "candidate" | "choice"; catalogItemId: string }>;

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
  draft: Readonly<{ catalogItemId: string; selectedOptions: Record<string, string> }> | null;
  lookup: CatalogItemLookup | null;
}>;

type CatalogItemPickerAction =
  | Readonly<{ type: "input-changed"; text: string }>
  | Readonly<{ type: "catalog-item-chosen"; catalogItemId: string; label: string }>
  | Readonly<{ type: "suggestions-loaded"; lookup: CatalogItemLookup; items: readonly CatalogItemSuggestion[] }>
  | Readonly<{ type: "catalog-item-loaded"; lookup: CatalogItemLookup; item: InventoryCatalogItemSnapshot }>
  | Readonly<{ type: "lookup-failed"; lookup: CatalogItemLookup; message: string }>
  | Readonly<{ type: "option-changed"; dimensionId: string; optionId: string }>;

function initialCatalogItemPickerState(
  draft: Readonly<{ catalogItemId: string; selectedOptions: Record<string, string> }> | null,
): CatalogItemPickerState {
  return {
    query: "",
    status: draft ? "hydrating" : "idle",
    errorMessage: null,
    suggestions: [],
    candidate: null,
    choice: null,
    catalogItem: null,
    selectedOptions: {},
    draft,
    lookup: draft ? { kind: "draft", catalogItemId: draft.catalogItemId } : null,
  };
}

function selectCatalogItem(
  state: CatalogItemPickerState,
  item: InventoryCatalogItemSnapshot,
  selectedOptions: Record<string, string>,
): CatalogItemPickerState {
  const label = catalogItemOptionLabel(item);
  return {
    ...state,
    query: label,
    status: "selected",
    errorMessage: null,
    candidate: null,
    choice: { catalogItemId: item.catalog_item_id, label },
    catalogItem: item,
    selectedOptions: item.product_schema ? normalizeSelectedOptionsForSchema(item.product_schema, selectedOptions) : {},
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
    query: lookup.kind === "draft" ? "" : state.query,
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
      // An edit also drops the draft's saved Options, so only the initial restore reuses them.
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
        draft: null,
        lookup,
      };
    }
    case "catalog-item-chosen": {
      if (state.choice?.catalogItemId === action.catalogItemId) {
        return state;
      }
      const restoredOptions = state.draft?.catalogItemId === action.catalogItemId ? state.draft.selectedOptions : {};
      if (state.candidate?.catalog_item_id === action.catalogItemId) {
        return selectCatalogItem(state, state.candidate, restoredOptions);
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
    }
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
      if (lookup.kind === "draft" && state.draft && hasStaleSelectedOptions(item, state.draft.selectedOptions)) {
        return {
          ...state,
          query: catalogItemOptionLabel(item),
          status: "error",
          errorMessage: t("inventory.features.inventoryItems.ui.inventoryItemListPage.catalog.item.options.stale"),
          candidate: item,
          draft: null,
        };
      }
      return selectCatalogItem(
        state,
        item,
        state.draft?.catalogItemId === item.catalog_item_id ? state.draft.selectedOptions : {},
      );
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

function useCatalogItemPicker(
  draft: Readonly<{ catalogItemId: string; selectedOptions: Record<string, string> }> | null,
) {
  const [state, dispatch] = useReducer(catalogItemPickerReducer, draft, initialCatalogItemPickerState);

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
    if (lookup.kind === "draft" || lookup.kind === "choice") {
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

/** Inventory names the Graded option identities; the page only checks whether the current choice is one of them. */
function selectsGradedOption(item: InventoryCatalogItemSnapshot | null, selectedOptions: Record<string, string>) {
  const dimensions = item?.product_schema?.dimensions ?? [];
  return (item?.graded_selections ?? []).some(
    (pair) =>
      selectedOptions[pair.dimensionId] === pair.optionId &&
      dimensions.some(
        (dimension) => dimension.dimensionId === pair.dimensionId && isDimensionActive(dimension, selectedOptions),
      ),
  );
}

function displayItemLabel(item: InventoryItemListItem) {
  return item.item_title ?? item.catalog_catalog_item_id;
}

function displayCost(item: InventoryItemListItem) {
  if (!item.acquisition_cost_amount) {
    return t("inventory.features.inventoryItems.ui.inventoryItemListPage.not.set");
  }
  return item.acquisition_cost_currency_code
    ? formatMoney(item.acquisition_cost_amount, item.acquisition_cost_currency_code)
    : t("inventory.features.inventoryItems.ui.inventoryItemListPage.acquisition.cost.currency.not.recorded", {
        amount: item.acquisition_cost_amount,
      });
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
  const [certificationNumber, setCertificationNumber] = useState("");
  const pageSize = pagination?.limit ?? data.items.length;
  const currentPage = pagination && pageSize > 0 ? Math.floor(pagination.offset / pageSize) + 1 : 1;
  const totalPages = pagination && pageSize > 0 ? Math.max(1, Math.ceil(pagination.total / pageSize)) : 1;
  const showPagination = Boolean(pagination && (pagination.total > pageSize || pagination.offset > 0));
  const draftCatalogItemId = createItemDraft?.catalogItemId?.trim() ?? "";
  const [picker, dispatchPicker] = useCatalogItemPicker(
    draftCatalogItemId
      ? {
          catalogItemId: draftCatalogItemId,
          selectedOptions: selectedOptionsFromEntries(createItemDraft?.selectedOptions ?? []),
        }
      : null,
  );
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

  const { catalogItem, selectedOptions } = picker;
  const catalogItemEntries = catalogItemPickerEntries(picker);
  const pickerStatusMessage = catalogItemPickerStatusMessage(picker.status);
  const asksCertificationNumber = selectsGradedOption(catalogItem, selectedOptions);
  const canCreateItem = catalogItem !== null && hasCompleteSelectedOptions(catalogItem, selectedOptions);
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
          <Form family="item-create" targetId="draft" spacing="none" method="post">
            <Grid columns={{ base: 1, lg: 2 }} gap={5}>
              <HiddenInput type="hidden" name="intent" value="create-item" />
              <Stack gap={3}>
                {createItemDraft?.returnTo ? (
                  <HiddenInput type="hidden" name="returnTo" value={createItemDraft.returnTo} />
                ) : null}
                <Combobox
                  label={t("inventory.features.inventoryItems.ui.inventoryItemListPage.catalog.item")}
                  required
                  placeholder={t(
                    "inventory.features.inventoryItems.ui.inventoryItemListPage.search.or.paste.catalog.item",
                  )}
                  description={t(
                    "inventory.features.inventoryItems.ui.inventoryItemListPage.search.by.title.or.paste.catalog",
                  )}
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
                <HiddenInput type="hidden" name="catalogItemId" value={catalogItem?.catalog_item_id ?? ""} />
                <HiddenInput type="hidden" name="selectedOptions" value={serializedVersionSelection} />
                {asksCertificationNumber ? (
                  <TextInput
                    label={t("inventory.features.inventoryItems.ui.inventoryItemListPage.certification.number")}
                    name="certificationNumber"
                    value={certificationNumber}
                    onChange={(event) => setCertificationNumber(event.target.value)}
                  />
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
                <Grid columns={{ base: 1, md: 3 }} gap={3}>
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
                  <TextInput
                    label={t(
                      "inventory.features.inventoryItems.ui.inventoryItemListPage.acquisition.cost.currency.code",
                    )}
                    name="acquisitionCostCurrencyCode"
                    placeholder="USD"
                    maxLength={3}
                  />
                </Grid>
                <Stack direction={{ base: "column", md: "row" }} align={{ base: "stretch", md: "center" }} gap={2}>
                  <Button type="submit" disabled={!canCreateItem}>
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
                          dispatchPicker({ type: "option-changed", dimensionId, optionId })
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
