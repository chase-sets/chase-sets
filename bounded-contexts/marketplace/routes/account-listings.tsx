import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData, useRouteLoaderData } from "react-router";
import { requireActorFromAuthApi, resolveRequiredActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { useRealtimePatchedSnapshot } from "@chase-sets/platform-runtime/realtime-react";
import { type FreshWriteReadErrorClassification, type ListResponse } from "@chase-sets/http/responses";
import { Card, LinkButton, Page, PageHeader, PageSection, Stack, Text } from "@chase-sets/design-system";
import {
  loadAfterWrite,
  navigateAfterWriteFromSourcesWithCompactToken,
  navigateAfterWriteWithCompactToken,
  type PlatformPostWriteTelemetry,
} from "@chase-sets/platform-runtime/http";
import {
  createMarketplaceRequestApiClient,
  MarketplaceApiError,
  type MarketplaceAnonymousListingDraftIntent,
  type MarketplaceListingInventoryItemOption,
  type MarketplaceListingFeeLockReportEntry,
  type MarketplaceListingListItem,
  type MarketplaceSellerListingAvailability,
  type MarketplaceSellerListingStatusCounts,
  type MarketplaceListingTermsPreview,
} from "../support/request-support/api-client";
import {
  resolveMarketplacePostWriteRequest,
  resolveMarketplacePostWriteTokenStore,
} from "../support/route-support/post-write-tokens";
import { readAnonymousListingDraftOwnerId } from "../support/request-support/anonymous-listing-draft";
import { createInventoryRequestApiClient } from "@chase-sets/inventory/server";
import { MarketplaceListingListPage } from "../features/listings/ui/listing-list-page";
import { applyMarketplaceListPatch } from "../support/realtime-support/patches";
import { marketplaceRealtimeRouteTopics } from "../support/realtime-support/topics";
import { sellerListingPageQuery } from "../support/request-support/list-pagination";

const DEFAULT_ITEM_QUERY = "limit=100&offset=0";
const DEFAULT_FEE_LOCK_QUERY = "limit=100&offset=0";
const LISTING_STOCK_LOCATION_NAME = "Listing stock";
const MARKETPLACE_DESCRIPTION = t("marketplace.routes.accountListings.manage.active.draft.paused.and.withdrawn");
const AVAILABILITY_ACTION_PARAM = "availabilityAction";
const ACCOUNT_LISTINGS_POST_WRITE_TELEMETRY = {
  boundedContextName: "marketplace",
  surface: "account-listings",
  routeId: "account-listings",
  routeTemplate: "/account/listings",
} as const satisfies PlatformPostWriteTelemetry;

function currentAccountPath(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
}

function accountAccessRequired(returnTo: string) {
  return {
    accountAccessRequired: {
      returnTo,
      title: t("marketplace.routes.accountListings.account.access.required.title"),
      description: t("marketplace.routes.accountListings.account.access.required.description"),
    },
    listings: emptyListingsResponse(),
    feeLockReport: emptyListResponse<MarketplaceListingFeeLockReportEntry>(),
    listingAvailability: {
      account_id: "",
      status: "available" as const,
      disabled_reason_category: null,
      available_again_on: null,
      disabled_at: null,
      enabled_at: null,
      updated_at: "1970-01-01T00:00:00.000Z",
    },
    inventoryItems: [],
    hasListingStockLocation: false,
    claimError: null,
    createForm: null,
  };
}

function marketplaceApiErrorStatus(error: unknown) {
  return error instanceof MarketplaceApiError ? error.status : null;
}

function marketplaceApiErrorCode(error: unknown) {
  if (!(error instanceof MarketplaceApiError) || typeof error.body !== "object" || error.body === null) {
    return null;
  }

  const apiError = (error.body as { error?: unknown }).error;
  if (typeof apiError !== "object" || apiError === null || !("code" in apiError)) {
    return null;
  }

  const code = (apiError as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
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

function inventorySnapshotFromMarketplaceSupplyItem(item: MarketplaceListingInventoryItemOption) {
  return {
    inventoryItemId: item.item_id,
    catalogItemId: item.catalog_catalog_item_id,
    productId: item.product_id,
    selectedOptions: item.selected_options,
    gradedCard: item.graded_card,
    storageLocationId: item.storage_location_id,
    storageLocationName: item.storage_location_name,
    shipFromCode: item.ship_from_code,
    shipFromAddress: item.ship_from_address,
    totalQuantity: item.total_quantity,
    availableQuantity: item.available_quantity,
    acquisitionCostAmount: item.acquisition_cost_amount,
  };
}

type MarketplaceListingListResponse = ListResponse<MarketplaceListingListItem> &
  Readonly<{
    limit: number;
    offset: number;
    statusCounts: MarketplaceSellerListingStatusCounts;
  }>;

type AccountListingsPageReads = Readonly<{
  listings: MarketplaceListingListResponse;
  feeLockReport: ListResponse<MarketplaceListingFeeLockReportEntry>;
  inventoryItemsResponse: ListResponse<MarketplaceListingInventoryItemOption>;
  hasListingStockLocation: boolean;
  listingAvailability: MarketplaceSellerListingAvailability;
}>;

function emptyListResponse<T>(): ListResponse<T> {
  return { items: [], total: 0, count: 0 };
}

function emptyListingsResponse(): MarketplaceListingListResponse {
  return {
    ...emptyListResponse<MarketplaceListingListItem>(),
    limit: 100,
    offset: 0,
    statusCounts: { active: 0, draft: 0, paused: 0, withdrawn: 0 },
  };
}

function createFreshWriteRecoveryPageReads(
  accountId: string,
  availabilityStatus: MarketplaceSellerListingAvailability["status"] = "available",
): AccountListingsPageReads {
  return {
    listings: emptyListingsResponse(),
    feeLockReport: emptyListResponse(),
    inventoryItemsResponse: emptyListResponse(),
    hasListingStockLocation: false,
    listingAvailability: {
      account_id: accountId,
      status: availabilityStatus,
      disabled_reason_category: null,
      available_again_on: null,
      disabled_at: null,
      enabled_at: null,
      updated_at: "1970-01-01T00:00:00.000Z",
    },
  };
}

async function loadListingInventoryOptions(
  marketplaceApi: ReturnType<typeof createMarketplaceRequestApiClient>,
  selectedInventoryItemId: string | null,
) {
  const inventoryItemsResponse = await marketplaceApi.listSellerListingInventory(DEFAULT_ITEM_QUERY);
  if (
    !selectedInventoryItemId ||
    inventoryItemsResponse.items.some((item) => item.item_id === selectedInventoryItemId)
  ) {
    return inventoryItemsResponse;
  }

  const selectedItemResponse = await marketplaceApi.listSellerListingInventory(
    new URLSearchParams({ inventoryItemId: selectedInventoryItemId, limit: "1", offset: "0" }).toString(),
  );
  const selectedItem = selectedItemResponse.items.find((item) => item.item_id === selectedInventoryItemId);
  if (selectedItem) {
    return {
      ...inventoryItemsResponse,
      items: [selectedItem, ...inventoryItemsResponse.items],
      total: Math.max(inventoryItemsResponse.total, inventoryItemsResponse.items.length + 1),
      count: inventoryItemsResponse.count + 1,
    };
  }

  return inventoryItemsResponse;
}

async function loadSelectedMarketplaceSupplyItem(
  api: ReturnType<typeof createMarketplaceRequestApiClient>,
  inventoryItemId: string,
) {
  const response = await api.listSellerListingInventory(
    new URLSearchParams({ inventoryItemId, limit: "1", offset: "0" }).toString(),
  );

  return response.items.find((item) => item.item_id === inventoryItemId) ?? null;
}

async function createListingFromMarketplaceSupplySnapshot(
  api: ReturnType<typeof createMarketplaceRequestApiClient>,
  createForm: Readonly<{
    inventoryItemId: string;
    priceAmount: string;
    quantityCap: string;
  }>,
  purchaseLimits: Readonly<{
    maxUnitsPerOrder: number | null;
    maxUnitsPerDay: number | null;
    maxUnitsPerCustomerAccount: number | null;
  }>,
  listingPhotoFiles: readonly File[],
) {
  const quantityCap = Number(createForm.quantityCap ?? 0);
  const inventoryItem = await loadSelectedMarketplaceSupplyItem(api, createForm.inventoryItemId);
  if (!inventoryItem) {
    throw new Error(t("marketplace.routes.accountListings.inventory.item.preparing"));
  }

  const listingBody = {
    inventoryItemId: createForm.inventoryItemId,
    priceAmount: createForm.priceAmount,
    quantityCap,
    purchaseLimits,
    inventorySnapshot: inventorySnapshotFromMarketplaceSupplyItem(inventoryItem),
  };

  return (
    listingPhotoFiles.length > 0
      ? await api.createListingWithPhotos(createListingApiForm(listingBody, listingPhotoFiles))
      : await api.createListing(listingBody)
  ) as { id: string; feeQuoteFingerprint?: string };
}

function hasMarketplaceFreshWriteSource(classification: FreshWriteReadErrorClassification) {
  return classification.receipt?.sources.some((source) => source.sourceContextName === "marketplace") ?? false;
}

function availabilityStatusFromAction(value: string | null): MarketplaceSellerListingAvailability["status"] | null {
  if (value === "disabled") {
    return "unavailable";
  }
  if (value === "enabled") {
    return "available";
  }
  return null;
}

async function navigateToAccountListingsAfterWrite(commandResult: unknown, destinationRoute: string) {
  return navigateAfterWriteWithCompactToken(commandResult, destinationRoute, {
    postWriteTokenStore: await resolveMarketplacePostWriteTokenStore(),
    telemetry: ACCOUNT_LISTINGS_POST_WRITE_TELEMETRY,
  });
}

async function navigateToAccountListingsAfterWriteFromSources(
  commandResults: readonly unknown[],
  destinationRoute: string,
) {
  return navigateAfterWriteFromSourcesWithCompactToken(commandResults, destinationRoute, {
    postWriteTokenStore: await resolveMarketplacePostWriteTokenStore(),
    telemetry: ACCOUNT_LISTINGS_POST_WRITE_TELEMETRY,
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const actorResult = await resolveRequiredActorFromAuthApi({ request, permission: "listings.view" });
  if (actorResult.kind === "signed-out") {
    throw actorResult.response;
  }
  if (actorResult.kind === "forbidden") {
    return accountAccessRequired(currentAccountPath(request));
  }
  const actor = actorResult.actor;
  const resolvedRequest = await resolveMarketplacePostWriteRequest(request);
  const marketplaceApi = createMarketplaceRequestApiClient(resolvedRequest);
  const listingsPageQuery = sellerListingPageQuery(resolvedRequest);
  const searchParams = new URL(resolvedRequest.url).searchParams;
  const selectedInventoryItemId = searchParams.get("inventoryItemId");
  const selectedCatalogItemId = searchParams.get("catalogItemId");
  const selectedOptions = parseSelectedOptions(searchParams.get("selectedOptions"));
  const recommendedPrice = searchParams.get("recommendedPrice") ?? "";
  const claimListingIntentId = searchParams.get("claimListingIntent")?.trim() ?? "";
  const pendingAvailabilityStatus = availabilityStatusFromAction(searchParams.get(AVAILABILITY_ACTION_PARAM));
  let claimedDraft: MarketplaceAnonymousListingDraftIntent | null = null;
  let claimError: string | null = null;
  let inventoryHandoffError: string | null = null;

  if (claimListingIntentId) {
    const anonymousOwnerId = readAnonymousListingDraftOwnerId(resolvedRequest);
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

  const pageRead = await loadAfterWrite<AccountListingsPageReads>({
    request: resolvedRequest,
    isNotFound: (error) => marketplaceApiErrorStatus(error) === 404,
    load: async () => {
      const [listings, feeLockReport, inventoryItemsResponse, hasListingStockLocation, listingAvailability] =
        await Promise.all([
          marketplaceApi.listSellerListings(listingsPageQuery),
          marketplaceApi.listSellerListingFeeLockReport(DEFAULT_FEE_LOCK_QUERY),
          loadListingInventoryOptions(marketplaceApi, selectedInventoryItemId),
          marketplaceApi.hasSellerSupplyLocationNamed(LISTING_STOCK_LOCATION_NAME),
          marketplaceApi.getSellerListingAvailability(),
        ]);

      return { listings, feeLockReport, inventoryItemsResponse, hasListingStockLocation, listingAvailability };
    },
    telemetry: ACCOUNT_LISTINGS_POST_WRITE_TELEMETRY,
  });

  let pageReads: AccountListingsPageReads;
  if (pageRead.kind === "data") {
    pageReads = pageRead.data;
  } else if (pageRead.kind === "pending" && "classification" in pageRead) {
    const { classification } = pageRead;
    if (
      claimListingIntentId &&
      claimedDraft &&
      classification.transient &&
      !hasMarketplaceFreshWriteSource(classification)
    ) {
      pageReads = createFreshWriteRecoveryPageReads(actor.accountId);
    } else if (
      pendingAvailabilityStatus &&
      classification.transient &&
      hasMarketplaceFreshWriteSource(classification)
    ) {
      pageReads = createFreshWriteRecoveryPageReads(actor.accountId, pendingAvailabilityStatus);
    } else if (selectedInventoryItemId && classification.transient && !hasMarketplaceFreshWriteSource(classification)) {
      const [listings, feeLockReport, listingAvailability] = await Promise.all([
        marketplaceApi.listSellerListings(listingsPageQuery),
        marketplaceApi.listSellerListingFeeLockReport(DEFAULT_FEE_LOCK_QUERY),
        marketplaceApi.getSellerListingAvailability(),
      ]);
      pageReads = {
        listings,
        feeLockReport,
        inventoryItemsResponse: emptyListResponse(),
        hasListingStockLocation: false,
        listingAvailability,
      };
      inventoryHandoffError = t("marketplace.routes.accountListings.inventory.item.preparing");
    } else {
      throw pageRead.error;
    }
  } else if ("error" in pageRead) {
    throw pageRead.error;
  } else {
    throw new Response(t("marketplace.routes.accountListings.listings.marketplace"), { status: 500 });
  }

  const { listings, feeLockReport, inventoryItemsResponse, hasListingStockLocation, listingAvailability } = pageReads;
  const inventoryItems = inventoryItemsResponse.items as MarketplaceListingInventoryItemOption[];
  if (
    selectedInventoryItemId &&
    !inventoryItems.some((inventoryItem) => inventoryItem.item_id === selectedInventoryItemId)
  ) {
    inventoryHandoffError = t("marketplace.routes.accountListings.inventory.item.preparing");
  }
  const selectedInventoryItem = selectedInventoryItemId
    ? inventoryItems.find((inventoryItem) => inventoryItem.item_id === selectedInventoryItemId)
    : selectedCatalogItemId
      ? inventoryItems.find((inventoryItem) => inventoryItem.catalog_catalog_item_id === selectedCatalogItemId)
      : null;

  return {
    accountAccessRequired: null,
    listings,
    feeLockReport,
    listingAvailability,
    inventoryItems,
    hasListingStockLocation,
    claimError: claimError ?? inventoryHandoffError,
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
              selectedOptions,
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
        await navigateToAccountListingsAfterWrite(
          await api.disableSellerListingAvailability({
            reasonCategory: String(formData.get("reasonCategory") ?? ""),
            availableAgainOn: String(formData.get("availableAgainOn") ?? ""),
          }),
          `/account/listings?${AVAILABILITY_ACTION_PARAM}=disabled`,
        ),
      );
    }

    if (intent === "enable-listing-availability") {
      return redirect(
        await navigateToAccountListingsAfterWrite(
          await api.enableSellerListingAvailability(),
          `/account/listings?${AVAILABILITY_ACTION_PARAM}=enabled`,
        ),
      );
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
              await createInventoryRequestApiClient(request).ensureListingStock({
                catalogItemId: createForm.catalogItemId,
                selectedOptions: createForm.selectedOptions,
                quantity: quantityCap,
                shipFromAddress: shipFromAddressFromForm(formData),
              })
            ).snapshot,
          };
      let result: { id: string; feeQuoteFingerprint?: string };
      try {
        result = (
          listingPhotoFiles.length > 0
            ? await api.createListingWithPhotos(createListingApiForm(listingBody, listingPhotoFiles))
            : await api.createListing(listingBody)
        ) as { id: string; feeQuoteFingerprint?: string };
      } catch (error) {
        if (!createForm.inventoryItemId || marketplaceApiErrorCode(error) !== "inventory_item_not_found") {
          throw error;
        }

        result = await createListingFromMarketplaceSupplySnapshot(
          api,
          {
            inventoryItemId: createForm.inventoryItemId,
            priceAmount: createForm.priceAmount,
            quantityCap: createForm.quantityCap,
          },
          purchaseLimits,
          listingPhotoFiles,
        );
      }

      const redirectReceipts =
        intent === "create-and-publish-listing"
          ? [
              result,
              await api.publishListing(result.id, {
                feeQuoteFingerprint: result.feeQuoteFingerprint,
              }),
            ]
          : [result];

      return redirect(
        await navigateToAccountListingsAfterWriteFromSources(
          redirectReceipts,
          intent === "create-and-publish-listing"
            ? `/account/listings/${result.id}?feedbackWorkflow=listing-publish`
            : `/account/listings/${result.id}`,
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

  if (data.accountAccessRequired) {
    return (
      <AccountAccessRequiredPage
        title={data.accountAccessRequired.title}
        description={data.accountAccessRequired.description}
        returnTo={data.accountAccessRequired.returnTo}
      />
    );
  }

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

function AccountAccessRequiredPage({
  title,
  description,
  returnTo,
}: {
  title: string;
  description: string;
  returnTo: string;
}) {
  return (
    <Page>
      <PageHeader
        eyebrow={t("marketplace.routes.accountListings.account.access")}
        title={title}
        description={description}
      />
      <PageSection title={t("marketplace.routes.accountListings.next.step")}>
        <Card>
          <Stack gap={3}>
            <Text>{t("marketplace.routes.accountListings.use.an.account.with.listing.access")}</Text>
            <Stack direction="row" gap={2}>
              <LinkButton href={`/sign-in?returnTo=${encodeURIComponent(returnTo)}`}>
                {t("marketplace.routes.accountListings.use.a.different.account")}
              </LinkButton>
              <LinkButton href="/account" tone="secondary">
                {t("marketplace.routes.accountListings.view.account")}
              </LinkButton>
            </Stack>
          </Stack>
        </Card>
      </PageSection>
    </Page>
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
  const listings = useRealtimePatchedSnapshot<MarketplaceListingListResponse>({
    initialSnapshot: data.listings as MarketplaceListingListResponse,
    snapshotKey: JSON.stringify(data.listings),
    topics,
    applyPatch: (current, patch) =>
      applyMarketplaceListPatch(current, patch, {
        entity: "marketplace.sellerListing",
        idField: "listing_id",
      }) as MarketplaceListingListResponse,
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
      statusCounts={listings.statusCounts}
      pagination={{ limit: listings.limit, offset: listings.offset, total: listings.total }}
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
