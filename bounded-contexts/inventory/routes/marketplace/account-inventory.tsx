import type {
  ActionFunctionArgs,
  LoaderFunctionArgs,
  MetaFunction,
} from "react-router";
import { redirect, useActionData, useLoaderData } from "react-router";
import type { ListResponse } from "@chase-sets/http/responses";
import { buildOpenGraphMeta } from "@chase-sets/bounded-context-runtime";
import { requireActorFromAuthApi } from "@chase-sets/auth-runtime";
import {
  InventoryApiError,
  type InventoryRecordListItem,
  type InventoryStorageLocation,
} from "../../request-support/api-client";
import { createInventoryRequestApiClient } from "../../request-support/api-client";
import { InventoryRecordListPage } from "../../records/ui/inventory-record-list-page";

const DEFAULT_RECORD_QUERY = "limit=100&offset=0";

export async function loader({ request }: LoaderFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "inventory.view",
  });
  const api = createInventoryRequestApiClient(request);

  return {
    records: await api.listRecords(DEFAULT_RECORD_QUERY),
    locations: await api.listStorageLocations(),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  await requireActorFromAuthApi({
    request,
    permission: "inventory.manage",
  });
  const formData = await request.formData();
  const intent = String(formData.get("intent") ?? "");
  const api = createInventoryRequestApiClient(request);

  try {
    if (intent === "create-record") {
      await api.createRecord({
        catalogItemId: formData.get("catalogItemId"),
        versionSelection: formData.get("versionSelection"),
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
  buildOpenGraphMeta({
    title: "Inventory | Marketplace",
    description: "Manage inventory records, stock counts, and storage context for your marketplace account.",
  });

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
