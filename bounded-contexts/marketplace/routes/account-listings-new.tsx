import { t } from "@chase-sets/localization";
import type { ActionFunctionArgs, LoaderFunctionArgs, MetaFunction } from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { requireActorFromAuthApi, resolveRequiredActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { Card, LinkButton, Page, PageHeader, PageSection, Stack, Text } from "@chase-sets/design-system";
import {
  defineFormAction,
  loadAfterWrite,
  navigateAfterWriteFromSourcesWithCompactToken,
  type FormActionContext,
  type PlatformPostWriteTelemetry,
} from "@chase-sets/platform-runtime/http";
import {
  createMarketplaceRequestApiClient,
  MarketplaceApiError,
  type MarketplaceAnonymousListingDraftIntent,
  type MarketplaceListingInventoryItemOption,
  type MarketplaceListingTermsPreview,
} from "../support/request-support/api-client";
import {
  resolveMarketplacePostWriteRequest,
  resolveMarketplacePostWriteTokenStore,
} from "../support/route-support/post-write-tokens";
import { readAnonymousListingDraftOwnerId } from "../support/request-support/anonymous-listing-draft";
import { createInventoryRequestApiClient } from "@chase-sets/inventory/server";
import { MarketplaceListingCreatePage } from "../features/listings/ui/listing-create-page";

const DEFAULT_ITEM_QUERY = "limit=100&offset=0";
const LISTING_STOCK_LOCATION_NAME = "Listing stock";
const MARKETPLACE_DESCRIPTION = t("marketplace.routes.accountListingsNew.choose.a.product.price.and.quantity");
const ACCOUNT_LISTINGS_NEW_POST_WRITE_TELEMETRY = {
  boundedContextName: "marketplace",
  surface: "account-listings-new",
  routeId: "account-listings-new",
  routeTemplate: "/account/listings/new",
} as const satisfies PlatformPostWriteTelemetry;

function currentAccountPath(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}`;
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
  return formData.getAll("evidence").filter((entry): entry is File => entry instanceof File && entry.size > 0);
}

function createListingApiForm(listingBody: Record<string, unknown>, listingPhotoFiles: readonly File[]) {
  const apiForm = new FormData();
  for (const [key, value] of Object.entries(listingBody)) {
    apiForm.set(key, typeof value === "object" && value !== null ? JSON.stringify(value) : String(value ?? ""));
  }
  for (const file of listingPhotoFiles) {
    apiForm.append("evidence", file);
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
    throw new Error(t("marketplace.routes.accountListingsNew.inventory.item.preparing"));
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

type AccountListingsNewInventoryPageRead = Readonly<{
  inventoryItemsResponse: Awaited<ReturnType<typeof loadListingInventoryOptions>>;
  hasListingStockLocation: boolean;
}>;

async function navigateToAccountListingsNewAfterWriteFromSources(
  commandResults: readonly unknown[],
  destinationRoute: string,
) {
  return navigateAfterWriteFromSourcesWithCompactToken(commandResults, destinationRoute, {
    postWriteTokenStore: await resolveMarketplacePostWriteTokenStore(),
    telemetry: ACCOUNT_LISTINGS_NEW_POST_WRITE_TELEMETRY,
  });
}

export async function loader({ request }: LoaderFunctionArgs) {
  const actorResult = await resolveRequiredActorFromAuthApi({ request, permission: "listings.view" });
  if (actorResult.kind === "signed-out") {
    throw actorResult.response;
  }
  if (actorResult.kind === "forbidden") {
    return {
      accountAccessRequired: {
        returnTo: currentAccountPath(request),
        title: t("marketplace.routes.accountListingsNew.account.access.required.title"),
        description: t("marketplace.routes.accountListingsNew.account.access.required.description"),
      },
      inventoryItems: [] as MarketplaceListingInventoryItemOption[],
      hasListingStockLocation: false,
      claimError: null,
      createForm: null,
      evidenceReadiness: null,
    };
  }

  const resolvedRequest = await resolveMarketplacePostWriteRequest(request);
  const marketplaceApi = createMarketplaceRequestApiClient(resolvedRequest);
  const searchParams = new URL(resolvedRequest.url).searchParams;
  const selectedInventoryItemId = searchParams.get("inventoryItemId");
  const selectedCatalogItemId = searchParams.get("catalogItemId");
  const selectedOptions = parseSelectedOptions(searchParams.get("selectedOptions"));
  const recommendedPrice = searchParams.get("recommendedPrice") ?? "";
  const claimListingIntentId = searchParams.get("claimListingIntent")?.trim() ?? "";
  let claimedDraft: MarketplaceAnonymousListingDraftIntent | null = null;
  let claimError: string | null = null;
  let inventoryHandoffError: string | null = null;

  if (claimListingIntentId) {
    const anonymousOwnerId = readAnonymousListingDraftOwnerId(resolvedRequest);
    if (!anonymousOwnerId) {
      claimError = t("marketplace.routes.accountListingsNew.listing.draft.not.found");
    } else {
      try {
        claimedDraft = await marketplaceApi.claimAnonymousListingDraftIntent(anonymousOwnerId, claimListingIntentId);
      } catch (error) {
        claimError =
          error instanceof Error ? error.message : t("marketplace.routes.accountListingsNew.listing.draft.not.found");
      }
    }
  }

  const pageRead = await loadAfterWrite<AccountListingsNewInventoryPageRead>({
    request: resolvedRequest,
    isNotFound: () => false,
    load: async () => {
      const [inventoryItemsResponse, hasListingStockLocation] = await Promise.all([
        loadListingInventoryOptions(marketplaceApi, selectedInventoryItemId),
        marketplaceApi.hasSellerSupplyLocationNamed(LISTING_STOCK_LOCATION_NAME),
      ]);

      return { inventoryItemsResponse, hasListingStockLocation };
    },
    telemetry: ACCOUNT_LISTINGS_NEW_POST_WRITE_TELEMETRY,
  });

  let inventoryItemsResponse: Awaited<ReturnType<typeof loadListingInventoryOptions>>;
  let hasListingStockLocation: boolean;
  if (pageRead.kind === "data") {
    ({ inventoryItemsResponse, hasListingStockLocation } = pageRead.data);
  } else if (pageRead.kind === "pending" && "classification" in pageRead) {
    inventoryItemsResponse = { items: [], total: 0, count: 0 };
    hasListingStockLocation = false;
    if (selectedInventoryItemId) {
      inventoryHandoffError = t("marketplace.routes.accountListingsNew.inventory.item.preparing");
    }
  } else if ("error" in pageRead) {
    throw pageRead.error;
  } else {
    throw new Response(t("marketplace.routes.accountListingsNew.create.listing"), { status: 500 });
  }

  const inventoryItems = inventoryItemsResponse.items as MarketplaceListingInventoryItemOption[];
  if (
    selectedInventoryItemId &&
    !inventoryItems.some((inventoryItem) => inventoryItem.item_id === selectedInventoryItemId)
  ) {
    inventoryHandoffError = t("marketplace.routes.accountListingsNew.inventory.item.preparing");
  }
  const selectedInventoryItem = selectedInventoryItemId
    ? inventoryItems.find((inventoryItem) => inventoryItem.item_id === selectedInventoryItemId)
    : selectedCatalogItemId
      ? inventoryItems.find((inventoryItem) => inventoryItem.catalog_catalog_item_id === selectedCatalogItemId)
      : null;
  const initialCreateForm = claimedDraft
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
        : null;
  const evidenceReadiness = initialCreateForm?.inventoryItemId
    ? await marketplaceApi
        .previewListingEvidenceReadiness({
          inventoryItemId: initialCreateForm.inventoryItemId,
          priceAmount: initialCreateForm.priceAmount || "0",
        })
        .catch(() => null)
    : null;

  return {
    accountAccessRequired: null,
    inventoryItems,
    hasListingStockLocation,
    claimError: claimError ?? inventoryHandoffError,
    createForm: initialCreateForm,
    evidenceReadiness,
  };
}

async function handleAction(intent: string, { request, formData }: FormActionContext) {
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
    if (intent === "preview-listing") {
      return {
        createForm,
        createPreview: await api.previewListingTerms({
          priceAmount: createForm.priceAmount,
        }),
        evidenceReadiness: createForm.inventoryItemId
          ? await api.previewListingEvidenceReadiness({
              inventoryItemId: createForm.inventoryItemId,
              priceAmount: createForm.priceAmount,
            })
          : null,
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

      const redirectReceipts: unknown[] = [result];
      let published = false;
      let publicationBlocked = false;
      if (intent === "create-and-publish-listing") {
        try {
          redirectReceipts.push(
            await api.publishListing(result.id, {
              feeQuoteFingerprint: result.feeQuoteFingerprint,
            }),
          );
          published = true;
        } catch (error) {
          if (marketplaceApiErrorCode(error) !== "listing_evidence_incomplete") throw error;
          publicationBlocked = true;
        }
      }

      const evidenceEvent = published
        ? "publication_succeeded"
        : publicationBlocked
          ? "publication_blocked"
          : listingPhotoFiles.length > 0
            ? "upload_completed"
            : null;

      return redirect(
        await navigateToAccountListingsNewAfterWriteFromSources(
          redirectReceipts,
          `/account/listings/${result.id}${
            published ? `?evidenceEvent=${evidenceEvent}` : evidenceEvent ? `?evidenceEvent=${evidenceEvent}` : ""
          }`,
        ),
      );
    }

    return redirect("/account/listings/new");
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

export const action = defineFormAction({
  authorization: { permission: "listings.manage" },
  intents: {
    "preview-listing": (context) => handleAction("preview-listing", context),
    "create-listing": (context) => handleAction("create-listing", context),
    "create-and-publish-listing": (context) => handleAction("create-and-publish-listing", context),
  },
  onUnknownIntent: (context) => handleAction("", context),
});

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: t("marketplace.routes.accountListingsNew.create.listing"),
    description: MARKETPLACE_DESCRIPTION,
  });

export default function MarketplaceAccountListingsNewRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

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
    <MarketplaceListingCreatePage
      inventoryItems={data.inventoryItems}
      hasListingStockLocation={data.hasListingStockLocation}
      createForm={actionData?.createForm ?? data.createForm ?? undefined}
      createPreview={actionData?.createPreview as MarketplaceListingTermsPreview | null | undefined}
      errorMessage={actionData?.error ?? data.claimError ?? null}
      evidenceReadiness={actionData?.evidenceReadiness ?? data.evidenceReadiness}
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
        eyebrow={t("marketplace.routes.accountListingsNew.account.access")}
        title={title}
        description={description}
      />
      <PageSection title={t("marketplace.routes.accountListingsNew.next.step")}>
        <Card elevation="tinted">
          <Stack gap={3}>
            <Text>{t("marketplace.routes.accountListingsNew.use.an.account.with.listing.access")}</Text>
            <Stack direction="row" gap={2}>
              <LinkButton href={`/sign-in?returnTo=${encodeURIComponent(returnTo)}`}>
                {t("marketplace.routes.accountListingsNew.use.a.different.account")}
              </LinkButton>
              <LinkButton href="/account" tone="secondary">
                {t("marketplace.routes.accountListingsNew.view.account")}
              </LinkButton>
            </Stack>
          </Stack>
        </Card>
      </PageSection>
    </Page>
  );
}
