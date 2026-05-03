import { t } from "@chase-sets/localization";
import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData, useRouteLoaderData } from "react-router";
import { useEffect, useState } from "react";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import { subscribeRealtimePatches } from "@chase-sets/platform-runtime/realtime-web";
import type { ListResponse } from "@chase-sets/http/responses";
import {
  createMarketplaceRequestApiClient,
  MarketplaceApiError,
  type MarketplaceListingInventoryItemOption,
  type MarketplaceListingFeeLockReportEntry,
  type MarketplaceListingListItem,
  type MarketplaceListingTermsPreview,
} from "../support/request-support/api-client";
import {
  createInventoryRequestApiClient,
  type InventoryItemListItem,
} from "@chase-sets/inventory/server";
import {
  MarketplaceListingListPage,
} from "../features/listings/ui/listing-list-page";
import { applyMarketplaceListPatch } from "../support/realtime-support/patches";
import { marketplaceRealtimeRouteTopics } from "../support/realtime-support/topics";

const DEFAULT_LISTING_QUERY = "limit=100&offset=0";
const DEFAULT_ITEM_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION =
  t("marketplace.routes.accountListings.manage.active.draft.paused.and.withdrawn");

function toInventoryOption(
  inventoryItem: InventoryItemListItem,
): MarketplaceListingInventoryItemOption {
  return {
    item_id: inventoryItem.item_id,
    catalog_catalog_item_id: inventoryItem.catalog_catalog_item_id,
    product_id: inventoryItem.product_id,
    item_title: inventoryItem.item_title,
    item_subtitle: inventoryItem.item_subtitle,
    selected_options: inventoryItem.selected_options,
    product_summary: inventoryItem.product_summary,
    graded_card: inventoryItem.graded_card,
    storage_location_name: inventoryItem.storage_location_name,
    ship_from_code: inventoryItem.ship_from_code,
    available_quantity: inventoryItem.available_quantity,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "listings.view" });
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const inventoryApi = createInventoryRequestApiClient(request);
  const selectedInventoryItemId = new URL(request.url).searchParams.get("inventoryItemId");

  const [listings, feeLockReport, items] = await Promise.all([
    marketplaceApi.listSellerListings(DEFAULT_LISTING_QUERY),
    marketplaceApi.listSellerListingFeeLockReport(DEFAULT_LISTING_QUERY),
    inventoryApi.listItems(DEFAULT_ITEM_QUERY),
  ]);
  const inventoryItems = (items.items as InventoryItemListItem[])
    .filter((inventoryItem) => inventoryItem.available_quantity > 0)
    .map(toInventoryOption);
  const selectedInventoryItem = selectedInventoryItemId
    ? inventoryItems.find((inventoryItem) => inventoryItem.item_id === selectedInventoryItemId)
    : null;

  return {
    listings,
    feeLockReport,
    inventoryItems,
    createForm: selectedInventoryItem
      ? {
          inventoryItemId: selectedInventoryItem.item_id,
          priceAmount: "",
          quantityCap: "1",
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
    priceAmount: String(formData.get("priceAmount") ?? ""),
    quantityCap: String(formData.get("quantityCap") ?? ""),
  };

  try {
    if (intent === "preview-listing") {
      return {
        createForm,
        createPreview: await api.previewListingTerms({
          priceAmount: createForm.priceAmount,
        }),
      };
    }

    if (intent === "create-listing" || intent === "create-and-publish-listing") {
      const result = await api.createListing({
        inventoryItemId: createForm.inventoryItemId,
        priceAmount: createForm.priceAmount,
        quantityCap: Number(createForm.quantityCap ?? 0),
      }) as { id: string; feeQuoteFingerprint?: string };

      if (intent === "create-and-publish-listing") {
        await api.publishListing(result.id, {
          feeQuoteFingerprint: result.feeQuoteFingerprint,
        });
      }

      return redirect(`/account/listings/${result.id}`);
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
  const rootData = useRouteLoaderData("root") as
    | { actor?: { accountId?: string } | null }
    | undefined;
  const [listings, setListings] = useState(data.listings as ListResponse<MarketplaceListingListItem>);
  const [feeLockReport, setFeeLockReport] = useState(
    data.feeLockReport as ListResponse<MarketplaceListingFeeLockReportEntry>,
  );

  useEffect(() => {
    setListings(data.listings as ListResponse<MarketplaceListingListItem>);
    setFeeLockReport(data.feeLockReport as ListResponse<MarketplaceListingFeeLockReportEntry>);
  }, [data.feeLockReport, data.listings]);

  useEffect(() => {
    const accountId = rootData?.actor?.accountId;
    if (!accountId) {
      return;
    }

    const subscription = subscribeRealtimePatches({
      preset: marketplaceRealtimeRouteTopics.accountListings(accountId),
      onPatch: (patch) => {
        setListings((current) =>
          applyMarketplaceListPatch(current, patch, {
            entity: "marketplace.sellerListing",
            idField: "listing_id",
          }),
        );
        setFeeLockReport((current) =>
          applyMarketplaceListPatch(current, patch, {
            entity: "marketplace.sellerListing",
            idField: "listing_id",
          }),
        );
      },
      onSyncRequired: reloadForRealtimeSync,
    });

    return () => subscription.close();
  }, [rootData?.actor?.accountId]);

  return (
    <MarketplaceListingListPage
      data={listings}
      feeLockReport={feeLockReport}
      inventoryItems={data.inventoryItems}
      createForm={actionData?.createForm ?? data.createForm ?? undefined}
      createPreview={actionData?.createPreview as MarketplaceListingTermsPreview | null | undefined}
      errorMessage={actionData?.error ?? null}
    />
  );
}

function reloadForRealtimeSync() {
  if (typeof window !== "undefined") {
    window.location.reload();
  }
}
