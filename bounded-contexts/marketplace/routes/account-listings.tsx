import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import { requireActorFromAuthApi } from "@chase-sets/platform-runtime/auth";
import { buildOpenGraphMeta } from "@chase-sets/platform-runtime/meta";
import type { ListResponse } from "@chase-sets/http/responses";
import {
  createMarketplaceRequestApiClient,
  MarketplaceApiError,
  type MarketplaceListingInventoryRecordOption,
  type MarketplaceListingListItem,
} from "../support/request-support/api-client";
import {
  createInventoryRequestApiClient,
  type InventoryRecordListItem,
} from "@chase-sets/inventory/server";
import {
  MarketplaceListingListPage,
} from "../features/listings/ui/listing-list-page";

const DEFAULT_LISTING_QUERY = "limit=100&offset=0";
const DEFAULT_RECORD_QUERY = "limit=100&offset=0";
const MARKETPLACE_DESCRIPTION =
  "Manage active, draft, paused, and withdrawn listings from your marketplace account.";

function toInventoryOption(
  record: InventoryRecordListItem,
): MarketplaceListingInventoryRecordOption {
  return {
    record_id: record.record_id,
    catalog_item_id: record.catalog_item_id,
    catalog_version_key: record.catalog_version_key,
    item_title: record.item_title,
    item_subtitle: record.item_subtitle,
    version_summary: record.version_summary,
    storage_location_name: record.storage_location_name,
    ship_from_code: record.ship_from_code,
    available_quantity: record.available_quantity,
  };
}

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({ request, permission: "listings.view" });
  const marketplaceApi = createMarketplaceRequestApiClient(request);
  const inventoryApi = createInventoryRequestApiClient(request);

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
  await requireActorFromAuthApi({ request, permission: "listings.manage" });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createMarketplaceRequestApiClient(request);

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
    if (error instanceof MarketplaceApiError || error instanceof Error) {
      return {
        error: error.message,
      };
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildOpenGraphMeta({
    title: "Listings | Marketplace",
    description: MARKETPLACE_DESCRIPTION,
  });

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
