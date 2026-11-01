import { formatBpsPercent, formatMoney as formatMoneyDisplay, t } from "@chase-sets/localization";
import { Form } from "../../../support/ui-support/mutation-form";
import { useEffect, useReducer, useState } from "react";
import {
  HiddenInput,
  Accordion,
  Banner,
  Button,
  Card,
  Combobox,
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
  getOrderedActiveProductSelectionDimensions,
  getOrderedProductSelectionDimensions,
  isProductSelectionDimensionActive,
  normalizeProductSelection,
  productSelectionEntriesToRecord,
  recordToProductSelectionEntries,
  toProductSelectionFields,
  type ProductSelectionRecord,
  type ProductSelectionSchema,
} from "@chase-sets/product-selection";
import type {
  MarketplaceListingEvidenceReadiness,
  MarketplaceListingInventoryItemOption,
  MarketplaceListingTermsPreview,
} from "./contracts";
import { EvidenceReadinessChecklist } from "./listing-evidence-readiness";
import { trackListingEvidenceEvent } from "./listing-evidence-analytics";
import { AuthoredTextGuidance } from "../../reviews/ui/authored-text-guidance";

const CATALOG_SUGGESTION_API_URL = "/api/marketplace/items/suggest";
const CATALOG_ITEM_API_BASE_URL = "/api/inventory/catalog-items";
const DEFAULT_EVIDENCE_READINESS_API_URL = "/api/marketplace/account/listings/evidence-readiness/preview";
const CATALOG_LOOKUP_SETTLE_MS = 250;
const CATALOG_SUGGESTION_MIN_QUERY_LENGTH = 2;
const CATALOG_ITEM_ID_PATTERN = /^cat_\S+$/;

type ListingCatalogItemSnapshot = Readonly<{
  catalog_item_id: string;
  title: string;
  subtitle?: string | null;
  status: string;
  product_schema: ProductSelectionSchema | null;
}>;

type ListingCatalogSuggestion = Readonly<{
  catalogItemId: string;
  title: string;
  subtitle: string | null;
  category: string | null;
}>;

type ListingCatalogCandidate = Readonly<{
  catalogItemId: string;
  label: string;
  description?: string;
  hydratedItem: ListingCatalogItemSnapshot | null;
}>;

type ListingCatalogLookup =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "suggest"; query: string }>
  | Readonly<{ kind: "exact"; purpose: "candidate" | "choice"; catalogItemId: string }>
  | Readonly<{ kind: "exact"; purpose: "restore"; catalogItemId: string; initialOptions: ProductSelectionRecord }>;

type ListingCatalogPickerStatus = "idle" | "loading" | "populated" | "empty" | "error" | "selected";

type ListingCatalogPickerState = Readonly<{
  query: string;
  lookup: ListingCatalogLookup;
  status: ListingCatalogPickerStatus;
  candidates: readonly ListingCatalogCandidate[];
  chosenCatalogItemId: string;
  selectedItem: ListingCatalogItemSnapshot | null;
  selectedOptions: ProductSelectionRecord;
  optionsReset: boolean;
}>;

type ListingCatalogPickerEvent =
  | Readonly<{ type: "edited"; query: string }>
  | Readonly<{ type: "chosen"; catalogItemId: string }>
  | Readonly<{ type: "option-changed"; dimensionId: string; optionId: string }>
  | Readonly<{ type: "suggested"; lookup: ListingCatalogLookup; suggestions: readonly ListingCatalogSuggestion[] }>
  | Readonly<{ type: "hydrated"; lookup: ListingCatalogLookup; item: ListingCatalogItemSnapshot }>
  | Readonly<{ type: "failed"; lookup: ListingCatalogLookup; status: "empty" | "error" }>;

const NO_CATALOG_LOOKUP: ListingCatalogLookup = { kind: "none" };

function initialCatalogPickerState({
  catalogItemId,
  selectedOptions,
}: {
  catalogItemId: string;
  selectedOptions: ProductSelectionRecord;
}): ListingCatalogPickerState {
  return {
    query: catalogItemId,
    lookup: catalogItemId
      ? { kind: "exact", purpose: "restore", catalogItemId, initialOptions: selectedOptions }
      : NO_CATALOG_LOOKUP,
    status: catalogItemId ? "loading" : "idle",
    candidates: [],
    chosenCatalogItemId: "",
    selectedItem: null,
    selectedOptions: {},
    optionsReset: false,
  };
}

function catalogLookupForQuery(query: string): ListingCatalogLookup {
  const trimmed = query.trim();
  if (CATALOG_ITEM_ID_PATTERN.test(trimmed)) {
    return { kind: "exact", purpose: "candidate", catalogItemId: trimmed };
  }

  return trimmed.length < CATALOG_SUGGESTION_MIN_QUERY_LENGTH ? NO_CATALOG_LOOKUP : { kind: "suggest", query: trimmed };
}

function candidateFromSuggestion(suggestion: ListingCatalogSuggestion): ListingCatalogCandidate {
  return {
    catalogItemId: suggestion.catalogItemId,
    label: suggestion.title,
    description: suggestion.subtitle?.trim() || suggestion.category || undefined,
    hydratedItem: null,
  };
}

function candidateFromItem(item: ListingCatalogItemSnapshot): ListingCatalogCandidate {
  return {
    catalogItemId: item.catalog_item_id,
    label: item.title,
    description: item.subtitle?.trim() || undefined,
    hydratedItem: item,
  };
}

// Keeps only selections that are still allowed and active under the current schema. With
// fillRequiredDefaults the shared normalizer also defaults required dimensions; without it a
// cleared dimension stays empty until the seller chooses it.
function reconcileListingOptions(
  schema: ProductSelectionSchema,
  selections: ProductSelectionRecord,
  fillRequiredDefaults: boolean,
): Record<string, string> {
  if (fillRequiredDefaults) {
    return normalizeProductSelection(schema, selections);
  }

  const next: Record<string, string> = {};
  for (const dimension of getOrderedProductSelectionDimensions(schema)) {
    const optionId = selections[dimension.dimensionId];
    if (
      optionId !== undefined &&
      isProductSelectionDimensionActive(dimension, next) &&
      dimension.allowedOptions.some((option) => option.optionId === optionId)
    ) {
      next[dimension.dimensionId] = optionId;
    }
  }

  return next;
}

function restoreListingOptions(schema: ProductSelectionSchema | null, initialOptions: ProductSelectionRecord) {
  if (!schema) {
    return { selectedOptions: {}, optionsReset: false };
  }

  const kept = reconcileListingOptions(schema, initialOptions, false);
  const stale = Object.entries(initialOptions).some(([dimensionId, optionId]) => kept[dimensionId] !== optionId);

  return stale
    ? { selectedOptions: kept, optionsReset: true }
    : { selectedOptions: normalizeProductSelection(schema, initialOptions), optionsReset: false };
}

function chosenListingOptions(item: ListingCatalogItemSnapshot) {
  return {
    selectedOptions: item.product_schema ? normalizeProductSelection(item.product_schema, {}) : {},
    optionsReset: false,
  };
}

function listingOptionsComplete(schema: ProductSelectionSchema | null, selections: ProductSelectionRecord) {
  if (!schema) {
    return true;
  }

  return getOrderedActiveProductSelectionDimensions(schema, selections).every(
    (dimension) =>
      !dimension.required ||
      dimension.allowedOptions.some((option) => option.optionId === selections[dimension.dimensionId]),
  );
}

function selectCatalogItem(
  state: ListingCatalogPickerState,
  item: ListingCatalogItemSnapshot,
  options: { selectedOptions: ProductSelectionRecord; optionsReset: boolean },
): ListingCatalogPickerState {
  return {
    ...state,
    status: "selected",
    chosenCatalogItemId: item.catalog_item_id,
    selectedItem: item,
    selectedOptions: options.selectedOptions,
    optionsReset: options.optionsReset,
  };
}

function reduceCatalogPicker(
  state: ListingCatalogPickerState,
  event: ListingCatalogPickerEvent,
): ListingCatalogPickerState {
  switch (event.type) {
    case "edited": {
      // The Combobox echoes the chosen label back through its input; only a changed value is an edit.
      if (event.query === state.query) {
        return state;
      }

      const lookup = catalogLookupForQuery(event.query);
      return {
        query: event.query,
        lookup,
        status: lookup.kind === "none" ? "idle" : "loading",
        candidates: [],
        chosenCatalogItemId: "",
        selectedItem: null,
        selectedOptions: {},
        optionsReset: false,
      };
    }
    case "chosen": {
      if (event.catalogItemId === state.selectedItem?.catalog_item_id) {
        return state;
      }

      const candidate = state.candidates.find((entry) => entry.catalogItemId === event.catalogItemId);
      if (!candidate) {
        return state;
      }

      const chosenState = { ...state, query: candidate.label, chosenCatalogItemId: candidate.catalogItemId };
      if (candidate.hydratedItem) {
        return selectCatalogItem(
          { ...chosenState, lookup: NO_CATALOG_LOOKUP },
          candidate.hydratedItem,
          chosenListingOptions(candidate.hydratedItem),
        );
      }

      return {
        ...chosenState,
        lookup: { kind: "exact", purpose: "choice", catalogItemId: candidate.catalogItemId },
        status: "loading",
        selectedItem: null,
        selectedOptions: {},
        optionsReset: false,
      };
    }
    case "option-changed": {
      const schema = state.selectedItem?.product_schema;
      if (!schema || !event.optionId) {
        return state;
      }

      return {
        ...state,
        selectedOptions: reconcileListingOptions(
          schema,
          { ...state.selectedOptions, [event.dimensionId]: event.optionId },
          !state.optionsReset,
        ),
      };
    }
    case "suggested": {
      if (event.lookup !== state.lookup) {
        return state;
      }

      const candidates = event.suggestions.map(candidateFromSuggestion);
      return { ...state, candidates, status: candidates.length > 0 ? "populated" : "empty" };
    }
    case "hydrated": {
      const lookup = state.lookup;
      if (event.lookup !== lookup || lookup.kind !== "exact") {
        return state;
      }

      const schema = event.item.product_schema;
      switch (lookup.purpose) {
        case "candidate":
          return { ...state, candidates: [candidateFromItem(event.item)], status: "populated" };
        case "choice":
          return selectCatalogItem(state, event.item, chosenListingOptions(event.item));
        case "restore":
          return selectCatalogItem(
            { ...state, query: event.item.title, candidates: [candidateFromItem(event.item)] },
            event.item,
            restoreListingOptions(schema, lookup.initialOptions),
          );
      }
    }
    case "failed": {
      if (event.lookup !== state.lookup) {
        return state;
      }

      return { ...state, status: event.status, candidates: state.chosenCatalogItemId ? state.candidates : [] };
    }
  }
}

async function runCatalogLookup(
  lookup: Exclude<ListingCatalogLookup, { kind: "none" }>,
  signal: AbortSignal,
): Promise<ListingCatalogPickerEvent> {
  try {
    if (lookup.kind === "suggest") {
      const response = await fetch(`${CATALOG_SUGGESTION_API_URL}?${new URLSearchParams({ q: lookup.query })}`, {
        credentials: "include",
        signal,
      });
      if (!response.ok) {
        return { type: "failed", lookup, status: "error" };
      }

      const body = (await response.json()) as { items?: readonly ListingCatalogSuggestion[] };
      return { type: "suggested", lookup, suggestions: body.items ?? [] };
    }

    const response = await fetch(`${CATALOG_ITEM_API_BASE_URL}/${encodeURIComponent(lookup.catalogItemId)}`, {
      credentials: "include",
      signal,
    });
    if (response.status === 404) {
      return { type: "failed", lookup, status: "empty" };
    }
    if (!response.ok) {
      return { type: "failed", lookup, status: "error" };
    }

    const item = (await response.json()) as ListingCatalogItemSnapshot;
    return item.catalog_item_id === lookup.catalogItemId && item.status === "active"
      ? { type: "hydrated", lookup, item }
      : { type: "failed", lookup, status: "empty" };
  } catch {
    return { type: "failed", lookup, status: "error" };
  }
}

function catalogPickerStatusText(status: ListingCatalogPickerStatus) {
  switch (status) {
    case "idle":
      return t("marketplace.features.listings.ui.listingCreatePage.select.a.catalog.item");
    case "loading":
      return t("marketplace.features.listings.ui.listingCreatePage.searching.catalog.items");
    case "populated":
      return t("marketplace.features.listings.ui.listingCreatePage.choose.the.visible.catalog.item");
    case "empty":
      return t("marketplace.features.listings.ui.listingCreatePage.no.active.catalog.items.matched");
    case "error":
      return t("marketplace.features.listings.ui.listingCreatePage.catalog.item.lookup.failed");
    case "selected":
      return null;
  }
}

function formatMoney(amount: string | null, currencyCode: string) {
  if (!amount || !currencyCode.trim()) {
    return t("marketplace.features.listings.ui.listingCreatePage.not.set");
  }

  return formatMoneyDisplay(amount, currencyCode);
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

export function MarketplaceListingCreatePage({
  inventoryItems,
  createForm,
  createPreview,
  evidenceReadiness: initialEvidenceReadiness,
  errorMessage,
  hasListingStockLocation,
  evidenceReadinessApiUrl = DEFAULT_EVIDENCE_READINESS_API_URL,
  backHref = "/account/listings",
  attemptId: routeAttemptId,
  writesDisabled = false,
}: {
  inventoryItems: readonly MarketplaceListingInventoryItemOption[];
  createForm?: {
    inventoryItemId?: string | null;
    catalogItemId?: string | null;
    selectedOptions?: readonly { dimensionId: string; optionId: string }[] | null;
    priceAmount?: string | null;
    priceCurrencyCode?: string | null;
    quantityCap?: string | null;
    maxUnitsPerOrder?: string | null;
    maxUnitsPerDay?: string | null;
    maxUnitsPerCustomerAccount?: string | null;
  };
  createPreview?: MarketplaceListingTermsPreview | null;
  evidenceReadiness?: MarketplaceListingEvidenceReadiness | null;
  errorMessage?: string | null;
  hasListingStockLocation: boolean;
  evidenceReadinessApiUrl?: string;
  backHref?: string;
  /** One create attempt per page: a resubmitted create returns its first Listing and never mints a second. */
  attemptId?: string;
  /** True while a possibly-sent create is unconfirmed. */
  writesDisabled?: boolean;
}) {
  const [ownAttemptId] = useState(() => crypto.randomUUID());
  const attemptId = routeAttemptId ?? ownAttemptId;
  const [inventoryItemId, setInventoryItemId] = useState(createForm?.inventoryItemId?.trim() ?? "");
  const [priceAmount, setPriceAmount] = useState(createForm?.priceAmount?.trim() ?? "");
  const [priceCurrencyCode, setPriceCurrencyCode] = useState(createForm?.priceCurrencyCode?.trim() ?? "");
  const [evidenceReadiness, setEvidenceReadiness] = useState(initialEvidenceReadiness ?? null);
  const [evidenceReadinessPending, setEvidenceReadinessPending] = useState(false);
  const selectedInventory = selectedInventorySummary(inventoryItems, inventoryItemId);
  const selectedInventoryBlocksPublication =
    selectedInventory !== null && selectedInventory.product_measure_snapshot === null;
  const hasInventory = inventoryItems.length > 0;
  const [catalogPicker, dispatchCatalogPicker] = useReducer(
    reduceCatalogPicker,
    {
      catalogItemId: createForm?.catalogItemId?.trim() ?? "",
      selectedOptions: productSelectionEntriesToRecord(createForm?.selectedOptions ?? []),
    },
    initialCatalogPickerState,
  );
  const catalogLookup = catalogPicker.lookup;
  const selectedCatalogItem = catalogPicker.selectedItem;
  const selectedProductSchema = selectedCatalogItem?.product_schema ?? null;
  const catalogSelectionReady =
    selectedCatalogItem !== null && listingOptionsComplete(selectedProductSchema, catalogPicker.selectedOptions);
  const catalogSelectionBlocksMutation = !inventoryItemId && !catalogSelectionReady;
  const productSelectionFields = toProductSelectionFields(selectedProductSchema, catalogPicker.selectedOptions).map(
    (field) =>
      field.value
        ? field
        : {
            ...field,
            options: [
              { value: "", label: t("marketplace.features.listings.ui.listingCreatePage.choose.product.option") },
              ...field.options,
            ],
          },
  );
  const submittedCatalogItemId = catalogSelectionReady ? selectedCatalogItem.catalog_item_id : "";
  const serializedSelectedOptions = JSON.stringify(
    catalogSelectionReady && selectedProductSchema
      ? recordToProductSelectionEntries(selectedProductSchema, catalogPicker.selectedOptions)
      : [],
  );
  const catalogStatusText = catalogPickerStatusText(catalogPicker.status);

  useEffect(() => {
    if (!inventoryItemId) {
      setEvidenceReadiness(null);
      setEvidenceReadinessPending(false);
      return undefined;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      setEvidenceReadinessPending(true);
      void fetch(evidenceReadinessApiUrl, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inventoryItemId, priceAmount: priceAmount || "0" }),
        signal: controller.signal,
      })
        .then(async (response) => {
          if (!response.ok) throw new Error(String(response.status));
          return response.json() as Promise<MarketplaceListingEvidenceReadiness>;
        })
        .then(setEvidenceReadiness)
        .catch(() => {
          if (!controller.signal.aborted) setEvidenceReadiness(null);
        })
        .finally(() => {
          if (!controller.signal.aborted) setEvidenceReadinessPending(false);
        });
    }, 250);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [evidenceReadinessApiUrl, inventoryItemId, priceAmount]);

  useEffect(() => {
    if (catalogLookup.kind === "none") {
      return undefined;
    }

    const controller = new AbortController();
    const lookUp = () => void runCatalogLookup(catalogLookup, controller.signal).then(dispatchCatalogPicker);
    // Restoring a caller-supplied ID and hydrating an explicit choice run at once; typed or pasted input settles first.
    const settles = catalogLookup.kind === "suggest" || catalogLookup.purpose === "candidate";
    const timeout = settles ? window.setTimeout(lookUp, CATALOG_LOOKUP_SETTLE_MS) : undefined;
    if (!settles) {
      lookUp();
    }

    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [catalogLookup]);

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
        <Card elevation="tinted">
          <Form
            family="listing-stock-ensure"
            targetId="listing-stock"
            enabled={!inventoryItemId}
            mutationIntents={["create-listing", "create-and-publish-listing"]}
            spacing="none"
            method="post"
            encType="multipart/form-data"
            onSubmit={(event) => {
              const photos = new FormData(event.currentTarget).getAll("evidence");
              if (photos.some((photo) => photo instanceof File && photo.size > 0)) {
                trackListingEvidenceEvent("upload_started", { surface: "listing-create" });
              }
            }}
          >
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
              <HiddenInput type="hidden" name="attemptId" value={attemptId} />
              <HiddenInput type="hidden" name="catalogItemId" value={submittedCatalogItemId} />
              <HiddenInput type="hidden" name="selectedOptions" value={serializedSelectedOptions} />
              <Grid columns={{ base: 1, lg: 2 }} gap={5}>
                <Stack gap={3}>
                  <Combobox
                    label={t("marketplace.features.listings.ui.listingCreatePage.search.catalog")}
                    placeholder={t("marketplace.features.listings.ui.listingCreatePage.search.or.paste.catalog.item")}
                    description={t(
                      "marketplace.features.listings.ui.listingCreatePage.search.by.title.or.paste.catalog",
                    )}
                    status={catalogStatusText}
                    noMatchesLabel={
                      catalogStatusText ??
                      t("marketplace.features.listings.ui.listingCreatePage.no.active.catalog.items.matched")
                    }
                    required
                    items={catalogPicker.candidates.map((candidate) => ({
                      value: candidate.catalogItemId,
                      label: candidate.label,
                      description: candidate.description,
                    }))}
                    value={catalogPicker.chosenCatalogItemId}
                    onValueChange={(catalogItemId) => dispatchCatalogPicker({ type: "chosen", catalogItemId })}
                    inputValue={catalogPicker.query}
                    onInputValueChange={(query) => dispatchCatalogPicker({ type: "edited", query })}
                    filterItems={false}
                    openOnInputClick
                  />
                  <Grid columns={{ base: 1, md: 2 }} gap={3}>
                    <CurrencyInput
                      label={t("marketplace.features.listings.ui.listingCreatePage.price")}
                      name="priceAmount"
                      currencyCode={priceCurrencyCode}
                      decrementLabel={t("localization.currency.decreaseAmount")}
                      incrementLabel={t("localization.currency.increaseAmount")}
                      placeholder="24.99"
                      value={priceAmount}
                      onValueChange={(value) => setPriceAmount(value ?? "")}
                      required
                    />
                    <TextInput
                      label={t("marketplace.features.listings.ui.listingCreatePage.price.currency.code")}
                      name="priceCurrencyCode"
                      value={priceCurrencyCode}
                      onChange={(event) => setPriceCurrencyCode(event.target.value)}
                      placeholder={t(
                        "marketplace.features.listings.ui.listingCreatePage.price.currency.code.placeholder",
                      )}
                      minLength={3}
                      maxLength={3}
                      autoCapitalize="characters"
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
                    {selectedCatalogItem?.product_schema ? (
                      <Stack gap={2}>
                        <Text weight="semibold">{selectedCatalogItem.title}</Text>
                        {catalogPicker.optionsReset && !catalogSelectionReady ? (
                          <MarketplaceNotice
                            tone="warning"
                            title={t("marketplace.features.listings.ui.listingCreatePage.product.options.changed")}
                          />
                        ) : null}
                        <ProductSelectionFields
                          fields={productSelectionFields}
                          fieldName={(dimensionId) => `selectedOptions:${dimensionId}`}
                          onFieldChange={(dimensionId, optionId) =>
                            dispatchCatalogPicker({ type: "option-changed", dimensionId, optionId })
                          }
                        />
                      </Stack>
                    ) : selectedCatalogItem ? (
                      <Text size="sm" tone="secondary">
                        {selectedCatalogItem.title}
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
                    name="evidence"
                    accept="image/jpeg,image/png,image/webp"
                    multiple
                    dropLabel={t("marketplace.features.listings.ui.listingCreatePage.drop.listing.photos")}
                    browseLabel={t("marketplace.features.listings.ui.listingCreatePage.choose.photos")}
                    capture="environment"
                  />
                  {evidenceReadiness ? (
                    <EvidenceReadinessChecklist readiness={evidenceReadiness} surface="listing-create" />
                  ) : (
                    <MarketplaceNotice
                      tone="info"
                      title={t("marketplace.features.listings.ui.evidence.readiness.pending.title")}
                      description={
                        evidenceReadinessPending
                          ? t("marketplace.features.listings.ui.evidence.readiness.refreshing")
                          : t("marketplace.features.listings.ui.evidence.readiness.select.inventory")
                      }
                    />
                  )}
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
                            value={inventoryItemId}
                            onChange={(event) => setInventoryItemId(event.target.value)}
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
              <AuthoredTextGuidance />
              <Stack direction={{ base: "column", md: "row" }} align={{ base: "stretch", md: "center" }} gap={2}>
                <Button
                  type="submit"
                  name="intent"
                  value="create-and-publish-listing"
                  disabled={
                    writesDisabled ||
                    catalogSelectionBlocksMutation ||
                    selectedInventoryBlocksPublication ||
                    !evidenceReadiness?.coverage.complete
                  }
                >
                  {t("marketplace.features.listings.ui.listingCreatePage.create.and.publish")}
                </Button>
                <Button
                  type="submit"
                  name="intent"
                  value="preview-listing"
                  tone="secondary"
                  disabled={catalogSelectionBlocksMutation}
                >
                  {t("marketplace.features.listings.ui.listingCreatePage.preview.fees")}
                </Button>
                <Button
                  type="submit"
                  name="intent"
                  value="create-listing"
                  tone="ghost"
                  disabled={writesDisabled || catalogSelectionBlocksMutation}
                >
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
                value: formatMoney(createPreview.basis_amount, priceCurrencyCode),
              },
              {
                label: t("marketplace.features.listings.ui.listingCreatePage.locked.fee"),
                value: formatMoney(createPreview.marketplace_sales_fee_unit_amount, priceCurrencyCode),
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
            total={formatMoney(createPreview.seller_net_unit_amount, priceCurrencyCode)}
            totalLabel={t("marketplace.features.listings.ui.listingCreatePage.listing.fee.preview")}
          />
        ) : null}
      </PageSection>
    </Page>
  );
}
