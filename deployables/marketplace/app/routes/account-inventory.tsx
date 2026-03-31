import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import {
  ApiError as InventoryApiError,
  InventoryRecordListPage,
  type InventoryRecordListItem,
  type InventoryStorageLocation,
} from "@chase-sets/inventory/web";
import type { ListResponse } from "@chase-sets/http/responses";
import { createMarketplaceInventoryApiClient } from "../api.server";
import { requireMarketplaceActor } from "../auth.server";
import { buildMarketplaceMeta } from "../seo";

const DEFAULT_RECORD_QUERY = "limit=100&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireMarketplaceActor(request, "inventory.view");
  const api = createMarketplaceInventoryApiClient(request);

  return {
    records: await api.listRecords(DEFAULT_RECORD_QUERY),
    locations: await api.listStorageLocations(),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireMarketplaceActor(request, "inventory.manage");
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createMarketplaceInventoryApiClient(request);

  try {
    if (intent === "create-record") {
      await api.createRecord({
        catalogItemId: formData.get("catalogItemId"),
        condition: formData.get("condition"),
        storageLocationId: formData.get("storageLocationId"),
        totalQuantity: Number(formData.get("totalQuantity") ?? 0),
        acquisitionCostAmount:
          String(formData.get("acquisitionCostAmount") ?? "").trim() || null,
      });
    }

    return redirect("/account/inventory");
  } catch (error) {
    if (error instanceof InventoryApiError) {
      return {
        error: error.message,
      };
    }

    throw error;
  }
}

export const meta: MetaFunction = () =>
  buildMarketplaceMeta({ title: "Inventory | Marketplace" });

export default function MarketplaceInventoryRoute() {
  const data = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();

  return (
    <InventoryRecordListPage
      data={data.records as ListResponse<InventoryRecordListItem>}
      locations={(data.locations as ListResponse<InventoryStorageLocation>).items}
      errorMessage={actionData?.error ?? null}
    />
  );
}
