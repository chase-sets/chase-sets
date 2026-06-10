import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useRouteLoaderData } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import { appendFreshWriteToken, type ListResponse } from "@chase-sets/http/responses";
import {
  createMarketplaceRequestApiClient,
  MarketplaceApiError,
  type MarketplaceAnonymousListingDraftIntent,
  type MarketplaceListingInventoryItemOption,
  type MarketplaceListingFeeLockReportEntry,
  type MarketplaceListingListItem,
  type MarketplaceSellerListingAvailability,
  type MarketplaceListingTermsPreview,
} from "../support/request-support/api-client";
import { readAnonymousListingDraftOwnerId } from "../support/request-support/anonymous-listing-draft";
import { createInventoryRequestApiClient, type InventoryItemListItem } from "@chase-sets/inventory/server";
import { MarketplaceListingListPage } from "../features/listings/ui/listing-list-page";
import { applyMarketplaceListPatch } from "../support/realtime-support/patches";
import { marketplaceRealtimeRouteTopics } from "../support/realtime-support/topics";

const DEFAULT_LISTING_QUERY = "limit=100&offset=0";
const DEFAULT_ITEM_QUERY = "limit=100&offset=0";
const LISTING_STOCK_LOCATION_NAME = "Listing stock";
const MARKETPLACE_DESCRIPTION = t("marketplace.routes.accountListings.manage.active.draft.paused.and.withdrawn");

function toInventoryOption(inventoryItem: InventoryItemListItem): MarketplaceListingInventoryItemOption {
  return {
    item_id: inventoryItem.item_id,
    catalog_catalog_item_id: inventoryItem.catalog_catalog_item_id,
    product_id: inventoryItem.product_id,
    item_language_code: inventoryItem.language_code,
    item_title: inventoryItem.item_title,
    item_subtitle: inventoryItem.item_subtitle,
    selected_options: inventoryItem.selected_options,
    product_summary: inventoryItem.product_summary,
    product_measure_snapshot: null,
    graded_card: inventoryItem.graded_card,
    storage_location_name: inventoryItem.storage_location_name,
    ship_from_code: inventoryItem.ship_from_code,
    ship_from_address: {
      name: "",
      line1: "",
      city: "",
      state: "",
      postalCode: "",
      country: "US",
    },
    available_quantity: inventoryItem.available_quantity,
  };
}

function optionalLimit(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  return text === "" ? null : Number(text);
}

function parseSelectedOptions(value: FormDataEntryValue | null) {
  const text = String(value ?? "").trim();
  if (!text) {
    return [];
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed)
      ? parsed
          .map((entry) =>
            entry && typeof entry === "object"
              ? {
                  dimensionId: String((entry as Record<string, unknown>).dimensionId ?? ""),
                  optionId: String((entry as Record<string, unknown>).optionId ?? ""),
                }
              : null,
          )
          .filter((entry): entry is { dimensionId: string; optionId: string } =>
            Boolean(entry?.dimensionId && entry.optionId),
          )
      : [];
  } catch {
    return [];
  }
}

function shipFromAddressFromForm(formData: FormData) {
  const address = {
    name: String(formData.get("shipFromName") ?? "").trim(),
    line1: String(formData.get("shipFromLine1") ?? "").trim(),
    city: String(formData.get("shipFromCity") ?? "").trim(),
    state: String(formData.get("shipFromState") ?? "").trim(),
    postalCode: String(formData.get("shipFromPostalCode") ?? "").trim(),
    country: String(formData.get("shipFromCountry") ?? "US").trim() || "US",
  };

  if (!address.name && !address.line1 && !address.city && !address.state && !address.postalCode) {
    return null;
  }

  return address;
}

function listingPhotoFilesFromForm(formData: FormData) {
  return formData.getAll("listingPhotos").filter((entry): entry is File => entry instanceof File && entry.size > 0);
}

function createListingApiForm(listingBody: Record<string, unknown>, listingPhotoFiles: readonly File[]) {
  const apiForm = new FormData();
  for (const [key, value] of Object.entries(listingBody)) {
    apiForm.set(key, typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? ""));
  }
  for (const file of listingPhotoFiles) {
    apiForm.append("listingPhotos", file);
  }

  return apiForm;
}

function createFormFromClaimedDraft(draft: MarketplaceAnonymousListingDraftIntent) {
  return {
    inventoryItemId: "",
    catalogItemId: draft.catalog_item_id,
    selectedOptions: draft.selected_options,
    priceAmount: draft.price_amount,
    quantityCap: String(draft.quantity_cap),
    maxUnitsPerOrder: draft.max_units_per_order ? String(draft.max_units_per_order) : "",
    maxUnitsPerDay: draft.max_units_per_day ? String(draft.max_units_per_day) : "",
    maxUnitsPerCustomerAccount: draft.max_units_per_customer_account
      ? String(draft.max_units_per_customer_account)
      : "",
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "listings.view" });
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const inventoryApi = createInventoryRequestApiClient(request);
  const searchParams = new URL(request.url).searchParams;
  const selectedInventoryItemId = searchParams.get("inventoryItemId");
  const selectedCatalogItemId = searchParams.get("catalogItemId");
  const recommendedPrice = searchParams.get("recommendedPrice") ?? "";
  const claimListingIntentId = searchParams.get("claimListingIntent")?.trim() ?? "";
  let claimedDraft: MarketplaceAnonymousListingDraftIntent | null = null;
  let claimError: string | null = null;

  const [listings, feeLockReport, items, storageLocations] = await Promise.all([
    marketplaceApi.listSellerListings(DEFAULT_LISTING_QUERY),
    marketplaceApi.listSellerListingFeeLockReport(DEFAULT_LISTING_QUERY),
    inventoryApi.listItems(DEFAULT_ITEM_QUERY),
    inventoryApi.listStorageLocations("limit=100&offset=0"),
  ]);

  if (claimListingIntentId) {
    const anonymousOwnerId = readAnonymousListingDraftOwnerId(request);
    if (!anonymousOwnerId) {
      claimError = t("marketplace.routes.accountListings.listing.draft.not.found");
    } else {
      try {
        claimedDraft = await marketplaceApi.claimAnonymousListingDraftIntent(anonymousOwnerId, claimListingIntentId);
      } catch (error) {
        claimError =
          error instanceof Error ? error.message : t("marketplace.routes.accountListings.listing.draft.not.found");
      }
    }
  }

  const listingAvailability = await marketplaceApi.getSellerListingAvailability();
  const inventoryItems = (items.items as InventoryItemListItem[])
    .filter((inventoryItem) => inventoryItem.available_quantity > 0)
    .map(toInventoryOption);
  const selectedInventoryItem = selectedInventoryItemId
    ? inventoryItems.find((inventoryItem) => inventoryItem.item_id === selectedInventoryItemId)
    : selectedCatalogItemId
      ? inventoryItems.find((inventoryItem) => inventoryItem.catalog_catalog_item_id === selectedCatalogItemId)
      : null;

  return {
    listings,
    feeLockReport,
    listingAvailability,
    inventoryItems,
    hasListingStockLocation: storageLocations.items.some((location) => location.name === LISTING_STOCK_LOCATION_NAME),
    claimError,
    createForm: claimedDraft
      ? createFormFromClaimedDraft(claimedDraft)
      : selectedInventoryItem
        ? {
            inventoryItemId: selectedInventoryItem.item_id,
            catalogItemId: selectedInventoryItem.catalog_catalog_item_id,
            selectedOptions: selectedInventoryItem.selected_options,
            priceAmount: recommendedPrice,
            quantityCap: "1",
            maxUnitsPerOrder: "",
            maxUnitsPerDay: "",
            maxUnitsPerCustomerAccount: "",
          }
        : selectedCatalogItemId
          ? {
              inventoryItemId: "",
              catalogItemId: selectedCatalogItemId,
              selectedOptions: [],
              priceAmount: recommendedPrice,
              quantityCap: "1",
              maxUnitsPerOrder: "",
              maxUnitsPerDay: "",
              maxUnitsPerCustomerAccount: "",
            }
          : null,
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "listings.manage" });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createMarketplaceRequestApiClient(request);
  const inventoryApi = createInventoryRequestApiClient(request);
  const createForm = {
    inventoryItemId: String(formData.get("inventoryItemId") ?? ""),
    catalogItemId: String(formData.get("catalogItemId") ?? ""),
    selectedOptions: parseSelectedOptions(formData.get("selectedOptions")),
    priceAmount: String(formData.get("priceAmount") ?? ""),
    quantityCap: String(formData.get("quantityCap") ?? ""),
    maxUnitsPerOrder: String(formData.get("maxUnitsPerOrder") ?? ""),
    maxUnitsPerDay: String(formData.get("maxUnitsPerDay") ?? ""),
    maxUnitsPerCustomerAccount: String(formData.get("maxUnitsPerCustomerAccount") ?? ""),
  };

  try {
    if (intent === "disable-listing-availability") {
      return redirect(
        appendFreshWriteToken(
          "/account/listings",
          await api.disableSellerListingAvailability({
            reasonCategory: String(formData.get("reasonCategory") ?? ""),
            availableAgainOn: String(formData.get("availableAgainOn") ?? ""),
          }),
        ),
      );
    }

    if (intent === "enable-listing-availability") {
      return redirect(appendFreshWriteToken("/account/listings", await api.enableSellerListingAvailability()));
    }

    if (intent === "preview-listing") {
      return {
        createForm,
        createPreview: await api.previewListingTerms({
          priceAmount: createForm.priceAmount,
        }),
      };
    }

    if (intent === "create-listing" || intent === "create-and-publish-listing") {
      const purchaseLimits = {
        maxUnitsPerOrder: optionalLimit(formData.get("maxUnitsPerOrder")),
        maxUnitsPerDay: optionalLimit(formData.get("maxUnitsPerDay")),
        maxUnitsPerCustomerAccount: optionalLimit(formData.get("maxUnitsPerCustomerAccount")),
      };
      const listingPhotoFiles = listingPhotoFilesFromForm(formData);
      const quantityCap = Number(createForm.quantityCap ?? 0);
      const listingBody = createForm.inventoryItemId
        ? {
            inventoryItemId: createForm.inventoryItemId,
            priceAmount: createForm.priceAmount,
            quantityCap,
            purchaseLimits,
          }
        : {
            inventoryItemId: "",
            priceAmount: createForm.priceAmount,
            quantityCap,
            purchaseLimits,
            inventorySnapshot: (
              await inventoryApi.ensureListingStock({
                catalogItemId: createForm.catalogItemId,
                selectedOptions: createForm.selectedOptions,
                quantity: quantityCap,
                shipFromAddress: shipFromAddressFromForm(formData),
              })
            ).snapshot,
          };
      const result = (
        listingPhotoFiles.length > 0
          ? await api.createListingWithPhotos(createListingApiForm(listingBody, listingPhotoFiles))
          : await api.createListing(listingBody)
      ) as { id: string; feeQuoteFingerprint?: string };

      const redirectReceipt =
        intent === "create-and-publish-listing"
          ? await api.publishListing(result.id, {
              feeQuoteFingerprint: result.feeQuoteFingerprint,
            })
          : result;

      return redirect(
        appendFreshWriteToken(
          intent === "create-and-publish-listing"
            ? `/account/listings/${result.id}?feedbackWorkflow=listing-publish`
            : `/account/listings/${result.id}`,
          redirectReceipt,
        ),
      );
    }

    return redirect("/account/listings");
  } catch (error) {
    if (error instanceof MarketplaceApiError || error instanceof Error) {
      return {
        createForm,
        error: error.message,
      };
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("marketplace.routes.accountListings.listings.marketplace"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountListingsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const rootData = useRouteLoaderData("root") as { actor?: { accountId?: string } | null } | undefined;
  const accountId = rootData?.actor?.accountId ?? null;

  return (
    <MarketplaceAccountListingsRealtimeView
      key={[
        accountId ?? "anonymous",
        data.listings.total,
        data.listings.items.map((item) => item.listing_id).join("|"),
        data.feeLockReport.total,
        data.feeLockReport.items.map((item) => item.listing_id).join("|"),
        data.listingAvailability.status,
        data.listingAvailability.updated_at,
      ].join("\n")}
      data={data}
      actionData={actionData}
      accountId={accountId}
    />
  );
}

function MarketplaceAccountListingsRealtimeView({
  data,
  actionData,
  accountId,
}: {
  data: Awaited<ReturnType<typeof loader>>;
  actionData: Exclude<Awaited<ReturnType<typeof action>>, Response> | undefined;
  accountId: string | null;
}) {
  const topics = accountId ? marketplaceRealtimeRouteTopics.accountListings(accountId).topics : [];
  const listings = useRealtimePatchedSnapshot<ListResponse<MarketplaceListingListItem>>({
    initialSnapshot: data.listings as ListResponse<MarketplaceListingListItem>,
    snapshotKey: JSON.stringify(data.listings),
    topics,
    applyPatch: (current, patch) =>
      applyMarketplaceListPatch(current, patch, {
        entity: "marketplace.sellerListing",
        idField: "listing_id",
      }),
    onSyncRequired: reloadForRealtimeSync,
  });
  const feeLockReport = useRealtimePatchedSnapshot<ListResponse<MarketplaceListingFeeLockReportEntry>>({
    initialSnapshot: data.feeLockReport as ListResponse<MarketplaceListingFeeLockReportEntry>,
    snapshotKey: JSON.stringify(data.feeLockReport),
    topics,
    applyPatch: (current, patch) =>
      applyMarketplaceListPatch(current, patch, {
        entity: "marketplace.sellerListing",
        idField: "listing_id",
      }),
    onSyncRequired: reloadForRealtimeSync,
  });

  return (
    <MarketplaceListingListPage
      data={listings}
      feeLockReport={feeLockReport}
      listingAvailability={data.listingAvailability as MarketplaceSellerListingAvailability}
      inventoryItems={data.inventoryItems}
      hasListingStockLocation={data.hasListingStockLocation}
      createForm={actionData?.createForm ?? data.createForm ?? undefined}
      createPreview={actionData?.createPreview as MarketplaceListingTermsPreview | null | undefined}
      errorMessage={actionData?.error ?? data.claimError ?? null}
    />
  );
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
