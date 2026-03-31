import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import {
  ApiError as InventoryApiError,
  type InventoryRecordListItem,
} from "@chase-sets/inventory/web";
import {
  ApiError as MarketplaceApiError,
  MarketplaceListingListPage,
  type MarketplaceListingInventoryRecordOption,
  type MarketplaceListingListItem,
} from "@chase-sets/marketplace-context/web";
import { createMarketplaceInventoryApiClient, createMarketplaceServerApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

const DEFAULT_LISTING_QUERY = "limit=100&offset=0";
const DEFAULT_RECORD_QUERY = "limit=100&offset=0";

function toInventoryOption(
  record: InventoryRecordListItem,
): MarketplaceListingInventoryRecordOption {
  return {
    record_id: record.record_id,
    catalog_item_id: record.catalog_item_id,
    item_title: record.item_title,
    item_subtitle: record.item_subtitle,
    version_summary: record.version_summary,
    condition: record.condition,
    storage_location_name: record.storage_location_name,
    ship_from_code: record.ship_from_code,
    available_quantity: record.available_quantity,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireMarketplaceActor(request, "listings.view");
  const marketplaceApi = createMarketplaceServerApiClient(request);
  const inventoryApi = createMarketplaceInventoryApiClient(request);

  const [listings, records] = await Promise.all([
    marketplaceApi.listSellerListings(DEFAULT_LISTING_QUERY),
    inventoryApi.listRecords(DEFAULT_RECORD_QUERY),
  ]);

  return {
    listings,
    inventoryRecords: (records.items as InventoryRecordListItem[])
      .filter((record) => record.available_quantity > 0)
      .map(toInventoryOption),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireMarketplaceActor(request, "listings.manage");
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createMarketplaceServerApiClient(request);

  try {
    if (intent === "create-listing") {
      await api.createListing({
        inventoryRecordId: formData.get("inventoryRecordId"),
        priceAmount: formData.get("priceAmount"),
        quantityCap: Number(formData.get("quantityCap") ?? 0),
      });
    }

    return redirect("/account/listings");
  } catch (error) {
    if (error instanceof MarketplaceApiError || error instanceof InventoryApiError) {
      return {
        error: error.message,
      };
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Listings | Marketplace" });

export default function MarketplaceAccountListingsRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <MarketplaceListingListPage
      data={data.listings as ListResponse<MarketplaceListingListItem>}
      inventoryRecords={data.inventoryRecords}
      errorMessage={actionData?.error ?? null}
    />
  );
}
